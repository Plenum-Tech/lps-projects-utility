import type { Request, Response } from "express";
import mongoose from "mongoose";
import { cached } from "./refCache.js";
import { Meeting } from "../models/Meeting.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";
import type { ITask, TaskStatus } from "../models/Task.js";
import { TaskComment } from "../models/TaskComment.js";
import { TaskFile } from "../models/TaskFile.js";
import { TaskHistory } from "../models/TaskHistory.js";
import { TimeLog } from "../models/TimeLog.js";
import type { TaskHistoryAction } from "../models/TaskHistory.js";
import type { IUser } from "../models/User.js";
import { User } from "../models/User.js";
import { canCreateProjectTasks, canManageProject, canViewProject, departmentUserIds } from "./projectAccess.js";
import { pearityTagsByTask } from "./pearity.js";
import type { TaskLike } from "./pearity.js";
import { createEvent, pushToUsers } from "./sse.js";

// ---------------------------------------------------------------------------
// Shared request helpers (used by every task controller)
// ---------------------------------------------------------------------------

export function isInvalidObjectId(id: string): boolean {
  return !mongoose.isValidObjectId(id);
}

/** Express 5 types params as `string | string[] | undefined` — normalize to a single value. */
export function param(req: Request, name: string): string | undefined {
  const value = req.params[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * Loads `:id` as a task or responds 404. Tasks of an archived project are
 * read-only: every non-GET request on them gets 409.
 */
export async function getTaskOr404(req: Request, res: Response): Promise<ITask | undefined> {
  const id = param(req, "id");
  if (!id || isInvalidObjectId(id)) {
    res.status(404).json({ error: "Task not found" });
    return undefined;
  }
  const task = await Task.findById(id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return undefined;
  }
  if (task.project && req.method !== "GET") {
    const project = await Project.findById(task.project).select("archivedAt").lean();
    if (project?.archivedAt) {
      res.status(409).json({ error: "This task belongs to an archived project and is read-only" });
      return undefined;
    }
  }
  return task;
}

/**
 * canViewTask, plus heads whose department any assignee belongs to (the stored
 * `task.department` only follows the first assignee), or (for project tasks)
 * anyone who can view the project.
 */
export async function canViewTaskAsync(user: AccessUser, task: AccessTask & { project?: mongoose.Types.ObjectId | null }): Promise<boolean> {
  if (canViewTask(user, task)) return true;
  if (
    user.role === "head" &&
    user.department &&
    task.assignees.length > 0 &&
    (await User.exists({ _id: { $in: task.assignees }, department: user.department }))
  ) {
    return true;
  }
  if (!task.project) return false;
  const project = await Project.findById(task.project).select("manager members createdBy departments isPublic archivedAt");
  return Boolean(project && canViewProject(user, project));
}

/** Loads `:id` and enforces view access (404 / 403). */
export async function getViewableTaskOr404(
  req: Request,
  res: Response
): Promise<ITask | undefined> {
  const task = await getTaskOr404(req, res);
  if (!task) return undefined;
  if (!(await canViewTaskAsync(req.user!, task))) {
    res.status(403).json({ error: "You don't have access to this task" });
    return undefined;
  }
  return task;
}

/** Strict "YYYY-MM-DD" → UTC-midnight Date (null when invalid). */
export function parseDateOnly(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  if (date.toISOString().slice(0, 10) !== value) return null;
  return date;
}

/** Populate paths for a task in API responses (list, board and detail). */
export const TASK_POPULATE = [
  { path: "assignees", select: "name email role department" },
  { path: "assignedBy", select: "name email" },
  { path: "department", select: "name" },
  { path: "labels", select: "name color" },
  { path: "category", select: "name" },
  { path: "subtasks.assignee", select: "name email" },
  { path: "reviewedBy", select: "name" },
  { path: "project", select: "name code archivedAt requireTaskApproval" },
  { path: "milestone", select: "title endDate status" },
  { path: "reworkOf", select: "title shortCode number status" },
];

// ---------------------------------------------------------------------------
// Permission checks
// ---------------------------------------------------------------------------

type AccessUser = Pick<IUser, "_id" | "role" | "department">;
type AccessTask = Pick<ITask, "assignees" | "assignedBy" | "department"> & {
  /** Optional so lean/partial task shapes still type-check; subtask assignees can view the task. */
  subtasks?: ReadonlyArray<{ assignee?: mongoose.Types.ObjectId | null }>;
};

export function isAssignee(user: AccessUser, task: AccessTask): boolean {
  return task.assignees.some((id) => id.equals(user._id));
}

/** Assigned at least one subtask of this task. */
export function isSubtaskAssignee(user: AccessUser, task: AccessTask): boolean {
  return (task.subtasks ?? []).some((sub) => Boolean(sub.assignee && sub.assignee.equals(user._id)));
}

/**
 * May add/edit/delete any subtask: whoever manages the task, plus the head of
 * the task's department. (Task assignees may add subtasks and edit their own.)
 */
export function canManageSubtasks(
  user: AccessUser,
  task: AccessTask,
  ctx: { projectManager?: boolean } = {}
): boolean {
  if (canManageTask(user, task, ctx)) return true;
  return Boolean(
    user.role === "head" && user.department && task.department && task.department.equals(user.department)
  );
}

export function isCreator(user: AccessUser, task: AccessTask): boolean {
  return task.assignedBy.equals(user._id);
}

/**
 * Admin, the task creator, or (for project tasks) whoever manages the project:
 * edit, delete, subtasks, review, remind, delete others' comments/files.
 * `ctx.projectManager` is the precomputed project check; controllers should use
 * `canManageTaskAsync` (or `taskProjectFlags`) which computes it.
 */
export function canManageTask(
  user: AccessUser,
  task: AccessTask,
  ctx: { projectManager?: boolean } = {}
): boolean {
  return user.role === "admin" || isCreator(user, task) || Boolean(ctx.projectManager);
}

/** True when `user` manages the task's project (manager, head creator, admin). */
export async function managesTaskProject(
  user: AccessUser,
  task: { project?: mongoose.Types.ObjectId | null }
): Promise<boolean> {
  if (!task.project) return false;
  const project = await Project.findById(task.project).select("manager createdBy members departments isPublic archivedAt");
  return Boolean(project && canManageProject(user, project));
}

/** The single shared "may manage this task" check (creator/admin/project manager). */
export async function canManageTaskAsync(
  user: AccessUser,
  task: AccessTask & { project?: mongoose.Types.ObjectId | null }
): Promise<boolean> {
  if (canManageTask(user, task)) return true;
  return managesTaskProject(user, task);
}

/**
 * - admin: everything
 * - head: tasks they created or are assigned to, plus tasks of their department
 *   (`task.department`, or — given `departments` from `taskDepartmentIds` — any
 *   assignee's department)
 * - employee: tasks they are assigned to or created
 * Heads by assignee and project viewers are added by `canViewTaskAsync`.
 */
export function canViewTask(
  user: AccessUser,
  task: AccessTask,
  departments?: ReadonlyArray<mongoose.Types.ObjectId>
): boolean {
  if (user.role === "admin") return true;
  // Subtask assignees can open the parent task (detail, comments, files), but
  // it stays off their board / "Assigned to me" (taskVisibilityFilter below).
  if (isCreator(user, task) || isAssignee(user, task) || isSubtaskAssignee(user, task)) return true;
  if (user.role === "head" && user.department) {
    if (task.department && task.department.equals(user.department)) return true;
    return Boolean(departments?.some((id) => id.equals(user.department!)));
  }
  return false;
}

/**
 * Every department a task belongs to for head visibility: `task.department`
 * plus each assignee's department (one query).
 */
export async function taskDepartmentIds(
  task: Pick<ITask, "assignees" | "department">
): Promise<mongoose.Types.ObjectId[]> {
  const byId = new Map<string, mongoose.Types.ObjectId>();
  if (task.department) byId.set(task.department.toString(), task.department);
  if (task.assignees.length > 0) {
    const rows = await User.find({ _id: { $in: task.assignees }, department: { $ne: null } })
      .select("department")
      .lean();
    for (const row of rows) {
      if (row.department) byId.set(row.department.toString(), row.department);
    }
  }
  return [...byId.values()];
}

/**
 * Mongo filter for a head's department tasks: `task.department` is theirs, or
 * any assignee is a member of that department (member ids resolved once).
 */
export async function headDepartmentTaskFilter(
  departmentId: mongoose.Types.ObjectId
): Promise<Record<string, unknown>> {
  const members = await departmentUserIds(departmentId);
  const or: Record<string, unknown>[] = [{ department: departmentId }];
  if (members.length > 0) or.push({ assignees: { $in: members } });
  return { $or: or };
}

/** Projects `user` manages (any status): manager, or the head who created it. */
async function managedProjectIdsFor(user: AccessUser): Promise<mongoose.Types.ObjectId[]> {
  // Cached 15 s per user+role; dropped on any project write (lib/refCache.ts).
  const ids = await cached(`project:managed:${String(user._id)}:${user.role}`, 15_000, async () => {
    const rows = await Project.find({
      $or: [{ manager: user._id }, ...(user.role === "head" ? [{ createdBy: user._id }] : [])],
    })
      .select("_id")
      .lean();
    return rows.map((r) => r._id as mongoose.Types.ObjectId);
  });
  return [...ids];
}

/**
 * Mongo filter matching every task the user sees in lists, boards, calendar and
 * exports: assigned/created, the head's department (incl. tasks with any
 * assignee from it) and tasks of projects they manage.
 */
export async function taskVisibilityFilter(user: AccessUser): Promise<Record<string, unknown>> {
  if (user.role === "admin") return {};
  const or: Record<string, unknown>[] = [{ assignees: user._id }, { assignedBy: user._id }];
  const head = user.role === "head" && Boolean(user.department);
  const [managed, department] = await Promise.all([
    managedProjectIdsFor(user),
    head ? headDepartmentTaskFilter(user.department!) : Promise.resolve(null),
  ]);
  if (department) or.push(department);
  if (managed.length > 0) or.push({ project: { $in: managed } });
  return { $or: or };
}

/** Transitions an assignee may make on their own task (no skipping review). */
export const ASSIGNEE_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: ["in_progress"],
  in_progress: ["todo", "in_review"],
  in_review: ["in_progress"],
  rejected: ["in_progress"],
  completed: [],
};

export interface TransitionOptions {
  /** Caller manages the task's project (treated like the creator). */
  projectManager?: boolean;
  /**
   * The task's project has `requireTaskApproval: false`: work skips `in_review`
   * and assignees may complete it directly (Worksuite need_approval_by_admin).
   */
  skipReview?: boolean;
}

/**
 * Whether `user` may move `task` to `to`.
 * - Creator/admin: any move, except `completed` / `rejected` can only be set from `in_review`
 *   (with `skipReview`, `completed` may be set from any status).
 * - Assignee: the transitions in ASSIGNEE_TRANSITIONS (with `skipReview`, also straight to `completed`).
 */
export function canTransition(
  user: AccessUser,
  task: AccessTask & { status: TaskStatus },
  to: TaskStatus,
  options: TransitionOptions = {}
): boolean {
  if (task.status === to) return true;
  if (canManageTask(user, task, options)) {
    if (to === "completed" && options.skipReview) return true;
    if (to === "completed" || to === "rejected") return task.status === "in_review";
    return true;
  }
  if (isAssignee(user, task)) {
    if (options.skipReview && to === "completed") {
      return ["todo", "in_progress", "rejected", "in_review"].includes(task.status);
    }
    return ASSIGNEE_TRANSITIONS[task.status].includes(to);
  }
  return false;
}

/** All statuses `user` may move `task` to (for error messages / the frontend). */
export function allowedTransitions(
  user: AccessUser,
  task: AccessTask & { status: TaskStatus },
  options: TransitionOptions = {}
): TaskStatus[] {
  // Projects without task approval only use To do / In progress / Completed.
  const all: TaskStatus[] = options.skipReview
    ? ["todo", "in_progress", "completed"]
    : ["todo", "in_progress", "in_review", "completed", "rejected"];
  return all.filter((to) => to !== task.status && canTransition(user, task, to, options));
}

/**
 * Project flags that change task behaviour: approval skip, archived (read-only)
 * and, when `user` is given, whether they manage the project.
 */
export async function taskProjectFlags(
  task: { project?: mongoose.Types.ObjectId | null },
  user?: AccessUser
): Promise<{ skipReview: boolean; archived: boolean; projectManager: boolean; canCreateTasks: boolean }> {
  if (!task.project) return { skipReview: false, archived: false, projectManager: false, canCreateTasks: false };
  const project = await Project.findById(task.project).select(
    "requireTaskApproval archivedAt manager createdBy members departments isPublic"
  );
  return {
    skipReview: project ? project.requireTaskApproval === false : false,
    archived: Boolean(project?.archivedAt),
    projectManager: Boolean(project && user && canManageProject(user, project)),
    canCreateTasks: Boolean(project && user && !project.archivedAt && canCreateProjectTasks(user, project)),
  };
}

// ---------------------------------------------------------------------------
// Serialization — populated JSON + comment/file counts (+ caller permissions)
// ---------------------------------------------------------------------------

async function countByTask(
  model: mongoose.Model<any>,
  ids: mongoose.Types.ObjectId[]
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await model.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
    { $match: { task: { $in: ids } } },
    { $group: { _id: "$task", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [r._id.toString(), r.count]));
}

/**
 * Minutes logged per task: finished logs that are pending or approved (rejected
 * and running timers excluded). One aggregation for the whole page — never N+1.
 */
export async function loggedMinutesByTask(ids: mongoose.Types.ObjectId[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await TimeLog.aggregate<{ _id: mongoose.Types.ObjectId; minutes: number }>([
    { $match: { task: { $in: ids }, endTime: { $ne: null }, status: { $in: ["pending", "approved"] } } },
    { $group: { _id: "$task", minutes: { $sum: "$durationMinutes" } } },
  ]);
  return new Map(rows.map((r) => [r._id.toString(), r.minutes]));
}

/**
 * Adds `commentCount`, `fileCount`, `loggedMinutes` and (with a `viewer`)
 * `pinned` to each (already populated) task; `number` / `estimateMinutes` /
 * `completedAt` are always present (null when unset).
 */
/** A task loaded with `.lean()` (plain object, populated refs as plain objects). */
export type LeanTask = Record<string, unknown> & { _id: mongoose.Types.ObjectId };

/** Top-level schema defaults, applied to lean tasks the way hydration would. */
const TASK_DEFAULTS: Array<[string, () => unknown]> = Object.entries(Task.schema.paths)
  .map(([path, type]) => [path, (type as unknown as { defaultValue?: unknown }).defaultValue] as const)
  .filter(([path, value]) => !path.includes(".") && path !== "_id" && path !== "__v" && value !== undefined)
  .map(([path, value]) => {
    return [path, typeof value === "function" ? (value as () => unknown) : () => structuredClone(value)];
  });

/**
 * Same JSON as `ITask#toJSON()` for a lean task (list/board pages skip mongoose
 * hydration, which dominated their CPU time under load): schema defaults for
 * missing fields + the Task toJSON transform (no __v, no subtask pendingNotify).
 */
export function leanTaskJson(task: LeanTask): Record<string, unknown> {
  const json: Record<string, unknown> = { ...task };
  for (const [path, value] of TASK_DEFAULTS) if (json[path] === undefined) json[path] = value();
  delete json.__v;
  if (Array.isArray(json.subtasks)) {
    json.subtasks = (json.subtasks as Array<Record<string, unknown>>).map(({ pendingNotify: _omit, ...sub }) => sub);
  }
  return json;
}

export async function serializeTasks(
  tasks: Array<ITask | LeanTask>,
  viewer?: { pinnedTasks?: mongoose.Types.ObjectId[] } | null
): Promise<Record<string, unknown>[]> {
  const ids = tasks.map((t) => t._id as mongoose.Types.ObjectId);
  const [comments, files, logged, pearityTags] = await Promise.all([
    countByTask(TaskComment, ids),
    countByTask(TaskFile, ids),
    loggedMinutesByTask(ids),
    pearityTagsByTask(tasks as unknown as TaskLike[]),
  ]);
  const pinned = new Set((viewer?.pinnedTasks ?? []).map((id) => id.toString()));
  return tasks.map((t) => {
    const id = t._id.toString();
    const json =
      typeof (t as ITask).toJSON === "function"
        ? ((t as ITask).toJSON() as Record<string, unknown>)
        : leanTaskJson(t as LeanTask);
    return {
      ...json,
      number: json.number ?? null,
      estimateMinutes: json.estimateMinutes ?? null,
      completedAt: json.completedAt ?? null,
      commentCount: comments.get(id) ?? 0,
      fileCount: files.get(id) ?? 0,
      loggedMinutes: logged.get(id) ?? 0,
      pinned: pinned.has(id),
      /** Pearity tag `{ tagId, tagName, createdAt, createdBy }` or null (lib/pearity.ts). */
      pearityTag: pearityTags.get(id) ?? null,
    };
  });
}

/** What the current user may do with a task — drives the detail sheet UI. */
export function taskPermissions(
  user: AccessUser,
  task: AccessTask & { status: TaskStatus; project?: mongoose.Types.ObjectId | null },
  flags: { skipReview?: boolean; archived?: boolean; projectManager?: boolean; canCreateTasks?: boolean } = {}
) {
  const manage = canManageTask(user, task, flags) && !flags.archived;
  const assignee = isAssignee(user, task) && !flags.archived;
  const manageSubtasks = canManageSubtasks(user, task, flags) && !flags.archived;
  const subtaskAssignee = isSubtaskAssignee(user, task) && !flags.archived;
  return {
    canEdit: manage,
    canDelete: manage,
    canReview: manage && task.status === "in_review",
    canRemind: manage,
    /** Add/edit/delete any subtask. */
    canManageSubtasks: manageSubtasks,
    /** Add subtasks (managers + task assignees); assignees edit/delete only their own. */
    canAddSubtasks: manageSubtasks || assignee,
    /** Toggle done — non-managers only on subtasks assigned to them or unassigned. */
    canToggleSubtasks: manageSubtasks || assignee || subtaskAssignee,
    canSubmit:
      (assignee || (manage && Boolean(flags.skipReview))) && ["todo", "in_progress", "rejected"].includes(task.status),
    allowedStatuses: flags.archived
      ? []
      : allowedTransitions(user, task, { skipReview: flags.skipReview, projectManager: flags.projectManager }),
    /** Copy the task: project tasks need create rights in the project; standalone ones heads/admins. */
    canDuplicate: !flags.archived && (task.project ? Boolean(flags.canCreateTasks) : user.role !== "employee"),
    /** Start a timer / log time on this task (server re-checks project rules). */
    // Comments, files and time stay editable after completion.
    canLogTime: manage || assignee,
    /** Edit Actual start / end (filled from the time logs): the task's managers and assignees. */
    canEditActualDates: manageSubtasks || assignee,
    /** Submitting completes the task directly (project.requireTaskApproval = false). */
    skipsReview: Boolean(flags.skipReview),
    /** The task belongs to an archived project. */
    readOnly: Boolean(flags.archived),
  };
}

/** Loads a populated task detail for `user`: `{ task, permissions }`. */
export async function loadTaskDetail(
  taskId: mongoose.Types.ObjectId,
  user: AccessUser & { pinnedTasks?: mongoose.Types.ObjectId[] }
): Promise<{ task: Record<string, unknown>; permissions: ReturnType<typeof taskPermissions> } | null> {
  const raw = await Task.findById(taskId);
  if (!raw) return null;
  const permissions = taskPermissions(user, raw, await taskProjectFlags(raw, user));
  const populated = await Task.findById(taskId).populate(TASK_POPULATE);
  if (!populated) return null;
  const [task] = await serializeTasks([populated], user);
  task!.sourceMeeting = await sourceMeetingDetail(raw);
  return { task: task!, permissions };
}

/**
 * "From meeting" link for the task detail sheet:
 * `{ meeting: { _id, title }, segmentIdx, start }` (null when not from a meeting
 * or the meeting is gone). `start` = the segment's offset in seconds (or null).
 */
async function sourceMeetingDetail(
  task: Pick<ITask, "sourceMeeting">
): Promise<{ meeting: { _id: string; title: string }; segmentIdx: number | null; start: number | null } | null> {
  const source = task.sourceMeeting;
  if (!source?.meeting) return null;
  const segmentIdx = source.segmentIdx ?? null;
  const projection: Record<string, unknown> = { title: 1 };
  if (segmentIdx !== null) projection.segments = { $elemMatch: { idx: segmentIdx } };
  const meeting = await Meeting.findById(source.meeting, projection).lean();
  if (!meeting) return null;
  const segment = segmentIdx !== null ? meeting.segments?.[0] : undefined;
  return {
    meeting: { _id: meeting._id.toString(), title: meeting.title },
    segmentIdx,
    start: segment?.start ?? null,
  };
}

// ---------------------------------------------------------------------------
// Shared side effects — history rows + SSE fan-out
// ---------------------------------------------------------------------------

/** Writes a TaskHistory row — fire-and-forget, never breaks the request. */
export function recordTaskHistory(
  taskId: mongoose.Types.ObjectId,
  actor: IUser | null | undefined,
  action: TaskHistoryAction,
  details?: unknown
): void {
  void TaskHistory.create({
    task: taskId,
    actor: actor ? actor._id : null,
    action,
    details,
  }).catch(() => undefined);
}

/**
 * Users who should receive a task's `task-updated` SSE event: assignees, the
 * creator, every admin, and the heads of the task's department.
 */
async function taskAudience(task: AccessTask & { project?: mongoose.Types.ObjectId | null }): Promise<string[]> {
  const ids = new Set<string>([
    ...task.assignees.map((id) => id.toString()),
    task.assignedBy.toString(),
  ]);
  for (const sub of task.subtasks ?? []) {
    if (sub.assignee) ids.add(sub.assignee.toString());
  }
  // Project boards: every member and the manager see the project's tasks
  if (task.project) {
    const project = await Project.findById(task.project).select("members.user manager").lean();
    for (const m of project?.members ?? []) ids.add(m.user.toString());
    if (project?.manager) ids.add(project.manager.toString());
  }
  const or: Record<string, unknown>[] = [{ role: "admin" }];
  const departments = await taskDepartmentIds(task);
  if (departments.length > 0) or.push({ role: "head", department: { $in: departments } });
  // Admins + department heads: cached 15 s per department set (dropped on user writes).
  const key = `user:watchers:${departments.map(String).sort().join(",")}`;
  const watchers = await cached(key, 15_000, () => User.find({ $or: or }).select("_id").lean());
  for (const watcher of watchers) ids.add(watcher._id.toString());
  return [...ids];
}

/** Pushes `task-updated` to everyone who can see the task — fire-and-forget. */
export function pushTaskUpdate(
  task: AccessTask & {
    _id: mongoose.Types.ObjectId;
    title: string;
    status: TaskStatus;
    project?: mongoose.Types.ObjectId | null;
  },
  action: string,
  extra: Record<string, unknown> = {},
  /** Extra recipients (e.g. assignees removed by this edit). */
  alsoNotify: Array<mongoose.Types.ObjectId | string> = []
): void {
  void taskAudience(task)
    .then((ids) => {
      pushToUsers(
        [...ids, ...alsoNotify.map((id) => id.toString())],
        createEvent("task-updated", {
          taskId: task._id.toString(),
          action,
          title: task.title,
          status: task.status,
          projectId: task.project ? task.project.toString() : null,
          ...extra,
        })
      );
    })
    .catch(() => undefined);
}
