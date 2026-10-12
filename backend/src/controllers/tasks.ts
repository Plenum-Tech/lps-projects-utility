import type { Request, Response } from "express";
import mongoose from "mongoose";
import { getDeliverySettings } from "../lib/delivery/settings.js";
import { syncActualDatesFromLogs } from "../lib/actualDates.js";
import { isProjectApproved, notApprovedMessage } from "../lib/projectApproval.js";
import { scheduleTaskTag } from "../lib/tagAssign.js";
import { isProjectExpired, PROJECT_CLOSED_MESSAGE } from "../lib/projectExpiry.js";
import { logActivity } from "../lib/activityLog.js";
import { deleteFromGridFs } from "../lib/gridfs.js";
import { notifyTask } from "../lib/notifications.js";
import { csvDate, csvDateTime, csvHours, EXPORT_ROW_LIMIT, parseIdList, sendCsv, toCsv } from "../lib/csv.js";
import {
  applyAutoActualDates,
  applyManualActualDates,
  hasActualDates,
  initialActualDates,
  varianceDays,
  type ActualDateChange,
} from "../lib/actualDates.js";
import { parsePagination, searchRegex } from "../lib/pagination.js";
import { naturalSortKey } from "../lib/naturalSort.js";
import {
  allowedTransitions,
  canManageSubtasks,
  canManageTask,
  canManageTaskAsync,
  canTransition,
  canViewTaskAsync,
  getTaskOr404,
  getViewableTaskOr404,
  isAssignee,
  isInvalidObjectId,
  loadTaskDetail,
  loggedMinutesByTask,
  parseDateOnly,
  pushTaskUpdate,
  recordTaskHistory,
  serializeTasks,
  type LeanTask,
  TASK_POPULATE,
  taskDepartmentIds,
  taskProjectFlags,
  taskVisibilityFilter,
} from "../lib/taskAccess.js";
import { addDays, appDateKey, appToday, nextRunAfter } from "../lib/taskJobs.js";
import { appDayStart } from "../lib/appTime.js";
import { notifyUsers } from "../lib/notifications.js";
import {
  canCreateProjectTasks,
  canManageProject,
  canViewProject,
  isProjectMember,
  projectLink,
  projectVisibilityFilter,
  pushProjectUpdate,
  recordProjectActivity,
} from "../lib/projectAccess.js";
import { scheduleProgressRecalc } from "../lib/projectProgress.js";
import { nextShortCode, nextTaskNumber } from "../lib/taskNumbers.js";
import { Milestone } from "../models/Milestone.js";
import type { IMilestone } from "../models/Milestone.js";
import { Notification } from "../models/Notification.js";
import { archivedProjectIds, Project } from "../models/Project.js";
import type { IProject } from "../models/Project.js";
import type { PipelineStage } from "mongoose";
import { TimeLog } from "../models/TimeLog.js";
import { WeeklyTimesheet } from "../models/WeeklyTimesheet.js";
import { Task, TASK_ITERATIONS, TASK_TITLE_LIMITS, composeTaskTitle } from "../models/Task.js";
import type { ITask, ITaskRecurrence, ITaskSourceMeeting, RecurrenceUnit, TaskPriority, TaskStatus, ITaskTitleParts, TaskIteration } from "../models/Task.js";
import { RECURRENCE_UNITS, TASK_LIMITS, TASK_PRIORITIES, TASK_STATUSES } from "../models/Task.js";
import { TaskCategory } from "../models/TaskCategory.js";
import { TaskComment } from "../models/TaskComment.js";
import { scheduleBriefCheck } from "../lib/briefCheck.js";
import { TaskFile } from "../models/TaskFile.js";
import { TaskHistory } from "../models/TaskHistory.js";
import type { TaskHistoryAction } from "../models/TaskHistory.js";
import { PearityTag } from "../models/PearityTag.js";
import { TaskLabel } from "../models/TaskLabel.js";
import { TaskNote } from "../models/TaskNote.js";
import type { IUser } from "../models/User.js";
import { User } from "../models/User.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_ERROR = "status must be one of: todo, in_progress, in_review, completed, rejected";
const PRIORITY_ERROR = "priority must be one of: low, medium, high, urgent";
const BOARD_COLUMN_LIMIT = 200;
const MANUAL_REMINDER_COOLDOWN_MS = 60 * 60 * 1000;
/** Positions closer than this trigger a column re-normalisation. */
const MIN_POSITION_GAP = 1e-6;

/** Validation failure carried back to the controller as `res.status(status).json({ error })`. */
export interface Invalid {
  status: number;
  error: string;
}

export function isInvalid(value: unknown): value is Invalid {
  return typeof value === "object" && value !== null && "error" in value && "status" in value;
}

/**
 * Validates an assignee list (1-20 unique user ids). Heads may only assign
 * members of their own department. Returns the users in the given order.
 */
async function resolveAssignees(
  actor: IUser,
  raw: unknown,
  options: { skipDepartmentCheck?: boolean } = {}
): Promise<IUser[] | Invalid> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { status: 400, error: "assignees must be a non-empty array of user IDs" };
  }
  if (raw.some((id) => typeof id !== "string" || isInvalidObjectId(id))) {
    return { status: 400, error: "assignees must be valid user IDs" };
  }
  const ids = [...new Set(raw as string[])];
  if (ids.length > TASK_LIMITS.maxAssignees) {
    return { status: 400, error: `A task can have at most ${TASK_LIMITS.maxAssignees} assignees` };
  }

  const users = await User.find({ _id: { $in: ids } });
  if (users.length !== ids.length) {
    return { status: 404, error: "Assignee not found" };
  }

  // Heads can only assign to members of their own department (project tasks
  // follow the project-membership rule instead).
  if (actor.role === "head" && !options.skipDepartmentCheck) {
    if (!actor.department) {
      return { status: 403, error: "You must be assigned to a department to assign tasks" };
    }
    const outside = users.some((u) => !u.department || !u.department.equals(actor.department!));
    if (outside) {
      return { status: 403, error: "You can only assign tasks to members of your department" };
    }
  }

  const byId = new Map(users.map((u) => [u._id.toString(), u]));
  return ids.map((id) => byId.get(id)!);
}

async function resolveLabels(raw: unknown): Promise<mongoose.Types.ObjectId[] | Invalid> {
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string" || isInvalidObjectId(id))) {
    return { status: 400, error: "labels must be an array of label IDs" };
  }
  const ids = [...new Set(raw as string[])];
  if (ids.length > TASK_LIMITS.maxLabels) {
    return { status: 400, error: `A task can have at most ${TASK_LIMITS.maxLabels} labels` };
  }
  const count = await TaskLabel.countDocuments({ _id: { $in: ids } });
  if (count !== ids.length) return { status: 404, error: "Label not found" };
  return ids.map((id) => new mongoose.Types.ObjectId(id));
}

async function resolveCategory(raw: unknown): Promise<mongoose.Types.ObjectId | null | Invalid> {
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string" || isInvalidObjectId(raw)) {
    return { status: 400, error: "category must be a valid category ID or null" };
  }
  const exists = await TaskCategory.exists({ _id: raw });
  if (!exists) return { status: 404, error: "Category not found" };
  return new mongoose.Types.ObjectId(raw);
}

/** Optional date-only field: undefined = untouched, null/"" = cleared. */
function parseOptionalDate(raw: unknown, field: string): Date | null | undefined | Invalid {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const parsed = parseDateOnly(raw);
  if (!parsed) return { status: 400, error: `${field} must be a valid date (YYYY-MM-DD)` };
  return parsed;
}

/** Optional estimate in minutes: undefined = untouched, null/"" = cleared, else an integer 0-100000. */
function parseEstimate(raw: unknown): number | null | undefined | Invalid {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > TASK_LIMITS.maxEstimateMinutes) {
    return { status: 400, error: `estimateMinutes must be a whole number between 0 and ${TASK_LIMITS.maxEstimateMinutes}` };
  }
  return raw;
}

interface RecurrenceInput {
  every?: unknown;
  unit?: unknown;
  cycles?: unknown;
}

/** Validates `{ every, unit, cycles }` and computes the first `nextRunAt` after now. */
function parseRecurrence(
  raw: unknown,
  startDate: Date | null | undefined,
  previous?: ITaskRecurrence | null
): ITaskRecurrence | null | Invalid {
  if (raw === null) return null;
  if (typeof raw !== "object") return { status: 400, error: "recurrence must be an object or null" };
  const { every, unit, cycles } = raw as RecurrenceInput;

  if (typeof every !== "number" || !Number.isInteger(every) || every < 1 || every > 365) {
    return { status: 400, error: "recurrence.every must be an integer between 1 and 365" };
  }
  if (typeof unit !== "string" || !RECURRENCE_UNITS.includes(unit as RecurrenceUnit)) {
    return { status: 400, error: "recurrence.unit must be one of: day, week, month" };
  }
  if (typeof cycles !== "number" || !Number.isInteger(cycles) || (cycles !== -1 && (cycles < 1 || cycles > 1000))) {
    return { status: 400, error: "recurrence.cycles must be -1 (forever) or between 1 and 1000" };
  }

  const now = new Date();
  const from = startDate ?? appToday(now);
  return {
    every,
    unit: unit as RecurrenceUnit,
    cycles,
    generated: previous?.generated ?? 0,
    nextRunAt: nextRunAfter(from, every, unit as RecurrenceUnit, now),
  };
}

interface SubtaskInput {
  title?: unknown;
  description?: unknown;
  assignee?: unknown;
  dueDate?: unknown;
}

/** Initial subtasks on create: strings or `{ title, assignee?, dueDate? }`. */
function parseInitialSubtasks(
  raw: unknown,
  assigneeIds: Set<string>,
  actorId: mongoose.Types.ObjectId
): Array<Record<string, unknown>> | Invalid {
  if (!Array.isArray(raw)) return { status: 400, error: "subtasks must be an array" };
  if (raw.length > TASK_LIMITS.maxSubtasks) {
    return { status: 400, error: `A task can have at most ${TASK_LIMITS.maxSubtasks} subtasks` };
  }
  const result: Array<Record<string, unknown>> = [];
  for (const item of raw) {
    const input: SubtaskInput = typeof item === "string" ? { title: item } : ((item ?? {}) as SubtaskInput);
    if (typeof input.title !== "string" || !input.title.trim() || input.title.trim().length > 200) {
      return { status: 400, error: "Each subtask needs a title of 200 characters or fewer" };
    }
    let assignee: mongoose.Types.ObjectId | null = null;
    if (input.assignee !== undefined && input.assignee !== null && input.assignee !== "") {
      if (typeof input.assignee !== "string" || !assigneeIds.has(input.assignee)) {
        return { status: 400, error: "A subtask assignee must be one of the task's assignees" };
      }
      assignee = new mongoose.Types.ObjectId(input.assignee);
    }
    const dueDate = parseOptionalDate(input.dueDate, "subtask dueDate");
    if (isInvalid(dueDate)) return dueDate;
    if (input.description !== undefined && input.description !== null && (typeof input.description !== "string" || input.description.trim().length > 2000)) {
      return { status: 400, error: "A subtask description must be 2000 characters or fewer" };
    }
    result.push({
      title: input.title.trim(),
      description: typeof input.description === "string" ? input.description.trim() : "",
      done: false,
      assignee,
      dueDate: dueDate ?? null,
      createdBy: actorId,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Project integration helpers
// ---------------------------------------------------------------------------

/** Loads a project a task may be created in / moved to (exists, not archived, caller may add tasks). */
async function resolveTaskProject(actor: IUser, raw: unknown): Promise<IProject | Invalid> {
  if (typeof raw !== "string" || isInvalidObjectId(raw)) {
    return { status: 400, error: "project must be a valid project ID or null" };
  }
  const project = await Project.findById(raw);
  if (!project) return { status: 404, error: "Project not found" };
  if (project.archivedAt) return { status: 409, error: "This project is archived and read-only" };
  if (!canCreateProjectTasks(actor, project)) {
    return { status: 403, error: "You can't create tasks in this project" };
  }
  return project;
}

/** Validates a milestone id against the task's project (null/"" clears it). */
async function resolveMilestone(raw: unknown, project: IProject | null): Promise<IMilestone | null | Invalid> {
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string" || isInvalidObjectId(raw)) {
    return { status: 400, error: "milestone must be a valid milestone ID or null" };
  }
  if (!project) return { status: 400, error: "A milestone requires the task to belong to a project" };
  const milestone = await Milestone.findOne({ _id: raw, project: project._id });
  if (!milestone) return { status: 400, error: "Milestone not found in this project" };
  return milestone;
}

/**
 * Project tasks may only be assigned to project members. Non-members are
 * auto-added when the actor can manage the project or add tasks to it; otherwise 400.
 * Returns the users that were added as members.
 */
async function ensureProjectMembers(
  actor: IUser,
  project: IProject,
  assignees: IUser[],
  sendEmail = true
): Promise<IUser[] | Invalid> {
  const outsiders = assignees.filter((u) => !isProjectMember(u, project));
  if (outsiders.length === 0) return [];
  // Anyone who may add tasks to the project may bring a colleague in as an assignee.
  if (!canManageProject(actor, project) && !canCreateProjectTasks(actor, project)) {
    return {
      status: 400,
      error: `${outsiders.map((u) => u.name).join(", ")} ${outsiders.length === 1 ? "is" : "are"} not a member of this project`,
    };
  }
  for (const u of outsiders) project.members.push({ user: u._id, hourlyRate: 0, addedAt: new Date() });
  await project.save();
  const projectId = project._id as mongoose.Types.ObjectId;
  recordProjectActivity(projectId, actor, "member_added", { users: outsiders.map((u) => u._id.toString()), viaTask: true });
  notifyUsers({
    recipients: outsiders.map((u) => u._id),
    actor,
    type: "project_member_added",
    title: "Added to a project",
    message: `${actor.name} added you to ${project.code} · ${project.name}.`,
    link: projectLink(projectId),
    project: projectId,
    skipEmail: !sendEmail,
    email: {
      subject: `📁 You were added to ${project.name}`,
      heading: "Added to a Project",
      intro: `${actor.name} added you to this project.`,
      cardTitle: `${project.code} · ${project.name}`,
      buttonLabel: "Open Project",
    },
  });
  pushProjectUpdate(project, "members-changed", { added: outsiders.map((u) => u._id.toString()) });
  return outsiders;
}


/** "due date after milestone end" is a warning, not an error. */
function milestoneWarnings(dueDate: Date | null | undefined, milestone: IMilestone | null): string[] {
  if (milestone?.endDate && dueDate && dueDate.getTime() > milestone.endDate.getTime()) {
    return [`The due date is after the milestone "${milestone.title}" end date`];
  }
  return [];
}

/** Ids of archived projects — their tasks are hidden from boards and lists. */

/**
 * Every task `user` may open: `taskVisibilityFilter` plus subtask assignments
 * and tasks of projects they can view (mirrors `canViewTaskAsync`). Used where
 * the caller names specific tasks (pins, export by ids).
 */
async function extendedVisibilityFilter(user: IUser): Promise<Record<string, unknown>> {
  if (user.role === "admin") return {};
  const projects = await Project.find(projectVisibilityFilter(user)).select("_id").lean();
  return {
    $or: [
      await taskVisibilityFilter(user),
      { "subtasks.assignee": user._id },
      { project: { $in: projects.map((p) => p._id) } },
    ],
  };
}

/**
 * Tasks waiting for the caller's review: `in_review` tasks they may review —
 * admin: all; others: tasks they created + tasks of projects they manage
 * (manager, or the head who created the project). Mirrors `canManageTaskAsync`.
 */
async function approvalsFilter(user: IUser): Promise<Record<string, unknown>> {
  if (user.role === "admin") return { status: "in_review" };
  const managed = await Project.find({
    archivedAt: null,
    $or: [{ manager: user._id }, ...(user.role === "head" ? [{ createdBy: user._id }] : [])],
  })
    .select("_id")
    .lean();
  const or: Record<string, unknown>[] = [{ assignedBy: user._id }];
  if (managed.length > 0) or.push({ project: { $in: managed.map((p) => p._id) } });
  return { status: "in_review", $or: or };
}

/** Whether the caller can review anything at all (drives the "Waiting approval" view). */
async function isReviewer(user: IUser): Promise<boolean> {
  if (user.role !== "employee") return true;
  const [managed, created] = await Promise.all([
    Project.exists({ manager: user._id }),
    Task.exists({ assignedBy: user._id }),
  ]);
  return Boolean(managed || created);
}

/** Strict optional "YYYY-MM-DD" query param. */
function queryDate(raw: unknown, name: string): Date | undefined | Invalid {
  if (raw === undefined || raw === "") return undefined;
  const parsed = parseDateOnly(raw);
  return parsed ?? { status: 400, error: `${name} must be a valid date (YYYY-MM-DD)` };
}

/** Optional inclusive date-only range from two query params (null when both are absent). */
function dayRangeQuery(
  req: Request,
  fromName: string,
  toName: string
): { from?: Date; to?: Date } | null | Invalid {
  const from = queryDate(req.query[fromName], fromName);
  if (isInvalid(from)) return from;
  const to = queryDate(req.query[toName], toName);
  if (isInvalid(to)) return to;
  if (from && to && from.getTime() > to.getTime()) {
    return { status: 400, error: `${fromName} must be on or before ${toName}` };
  }
  return from || to ? { from, to } : null;
}

interface ListFilterOptions {
  /** The calendar applies its own overlap range — `from`/`to` are not a due-date filter there. */
  calendar?: boolean;
}

/**
 * Adds the scope / filter query params shared by the list, board, calendar and export.
 * `forProject` (GET /api/projects/:id/tasks, or ?project= the caller can view)
 * shows every task of the project instead of the role-scoped visibility.
 */
async function buildListFilter(
  req: Request,
  forProject?: IProject,
  options: ListFilterOptions = {}
): Promise<Record<string, unknown>[] | Invalid> {
  const user = req.user!;
  const and: Record<string, unknown>[] = [];
  const { scope, assignee, department, label, category, priority, due } = req.query;

  if (scope !== undefined && scope !== "" && !["assigned", "created", "all", "approvals"].includes(scope as string)) {
    return { status: 400, error: "scope must be one of: assigned, created, all, approvals" };
  }
  const approvals = scope === "approvals";
  const pinnedOnly = req.query.pinned === "true";

  let project = forProject ?? null;
  const rawProject = req.query.project;
  const noProject = !forProject && rawProject === "none";
  if (!project && rawProject !== undefined && rawProject !== "" && !noProject) {
    if (typeof rawProject !== "string" || isInvalidObjectId(rawProject)) {
      return { status: 400, error: "project must be a valid ID or \"none\"" };
    }
    const found = await Project.findById(rawProject);
    if (found && canViewProject(user, found)) project = found;
    else and.push(await taskVisibilityFilter(user), { project: new mongoose.Types.ObjectId(rawProject) });
  }
  if (project) {
    and.push({ project: project._id });
  } else if (rawProject === undefined || rawProject === "" || noProject) {
    // Reviewers see what they may review (approvalsFilter); pinned tasks include
    // project tasks visible through the project.
    if (!approvals) and.push(pinnedOnly ? await extendedVisibilityFilter(user) : await taskVisibilityFilter(user));
    if (noProject) {
      and.push({ project: null });
    } else {
      // Archived projects' tasks are hidden from boards and lists
      const archived = await archivedProjectIds();
      if (archived.length > 0) and.push({ project: { $nin: archived } });
    }
  }
  if (approvals) and.push(await approvalsFilter(user));
  if (pinnedOnly) and.push({ _id: { $in: user.pinnedTasks ?? [] } });

  const milestone = req.query.milestone;
  if (milestone !== undefined && milestone !== "") {
    if (milestone === "none") and.push({ milestone: null });
    else if (typeof milestone !== "string" || isInvalidObjectId(milestone)) {
      return { status: 400, error: "milestone must be a valid ID" };
    } else and.push({ milestone: new mongoose.Types.ObjectId(milestone) });
  }

  if (scope === "assigned") and.push({ assignees: user._id });
  else if (scope === "created") and.push({ assignedBy: user._id });

  const idFilters: Array<[unknown, string, string]> = [
    [assignee, "assignees", "assignee"],
    [department, "department", "department"],
    [label, "labels", "label"],
    [category, "category", "category"],
    [req.query.recurringParent, "recurringParent", "recurringParent"],
  ];
  for (const [value, field, name] of idFilters) {
    if (value === undefined || value === "") continue;
    if (typeof value !== "string" || isInvalidObjectId(value)) {
      return { status: 400, error: `${name} must be a valid ID` };
    }
    and.push({ [field]: new mongoose.Types.ObjectId(value) });
  }

  if (req.query.recurring === "true") and.push({ recurrence: { $ne: null } });

  // `?pearityTag=has|none` — tasks with / without a Pearity tag.
  const pearityTag = req.query.pearityTag;
  if (pearityTag !== undefined && pearityTag !== "") {
    if (pearityTag !== "has" && pearityTag !== "none") {
      return { status: 400, error: "pearityTag must be one of: has, none" };
    }
    const tagged = (await PearityTag.find().select("task").lean()).map((t) => t.task);
    and.push({ _id: pearityTag === "has" ? { $in: tagged } : { $nin: tagged } });
  }

  // `?iteration=new|rework` — new work (incl. older tasks without the marker) or rework.
  const iterationFilter = req.query.iteration;
  if (iterationFilter !== undefined && iterationFilter !== "") {
    if (iterationFilter === "rework") and.push({ iteration: "rework" });
    else if (iterationFilter === "new") and.push({ iteration: { $ne: "rework" } });
    else return { status: 400, error: "iteration must be one of: new, rework" };
  }

  if (priority !== undefined && priority !== "") {
    if (typeof priority !== "string" || !TASK_PRIORITIES.includes(priority as TaskPriority)) {
      return { status: 400, error: PRIORITY_ERROR };
    }
    and.push({ priority });
  }

  const today = appToday();
  if (due !== undefined && due !== "") {
    if (due === "overdue") {
      and.push({ dueDate: { $lt: today }, status: { $ne: "completed" } });
    } else if (due === "today") {
      and.push({ dueDate: today });
    } else if (due === "week") {
      and.push({ dueDate: { $gte: today, $lt: addDays(today, 7) } });
    } else {
      return { status: 400, error: "due must be one of: overdue, today, week" };
    }
  }
  if (req.query.overdue === "true") {
    and.push({ dueDate: { $lt: today }, status: { $ne: "completed" } });
  }

  if (!options.calendar) {
    const from = queryDate(req.query.from, "from");
    if (isInvalid(from)) return from;
    const to = queryDate(req.query.to, "to");
    if (isInvalid(to)) return to;
    if (from && to && from.getTime() > to.getTime()) return { status: 400, error: "from must be on or before to" };
    if (from || to) {
      and.push({ dueDate: { $ne: null, ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } });
    }
  }

  // `?statusIn=todo,in_progress` — any of several statuses (My dashboard links).
  const statusIn = req.query.statusIn;
  if (statusIn !== undefined && statusIn !== "") {
    const list = typeof statusIn === "string" ? statusIn.split(",").map((s) => s.trim()).filter(Boolean) : [];
    if (list.length === 0 || list.some((s) => !TASK_STATUSES.includes(s as TaskStatus))) {
      return { status: 400, error: `statusIn must be a comma-separated list of: ${TASK_STATUSES.join(", ")}` };
    }
    and.push({ status: { $in: [...new Set(list)] } });
  }

  // `?createdOrDueFrom/To` — created (app-timezone day) or due within the range.
  const createdOrDue = dayRangeQuery(req, "createdOrDueFrom", "createdOrDueTo");
  if (isInvalid(createdOrDue)) return createdOrDue;
  if (createdOrDue) {
    const { from, to } = createdOrDue;
    and.push({
      $or: [
        { createdAt: { ...(from ? { $gte: appDayStart(from) } : {}), ...(to ? { $lt: appDayStart(addDays(to, 1)) } : {}) } },
        { dueDate: { $ne: null, ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } },
      ],
    });
  }

  // `?completedFrom/To` — completed (completedAt, app-timezone day) within the range.
  const completed = dayRangeQuery(req, "completedFrom", "completedTo");
  if (isInvalid(completed)) return completed;
  if (completed) {
    const { from, to } = completed;
    and.push({
      status: "completed",
      completedAt: {
        $ne: null,
        ...(from ? { $gte: appDayStart(from) } : {}),
        ...(to ? { $lt: appDayStart(addDays(to, 1)) } : {}),
      },
    });
  }

  const search = searchRegex(req.query.search);
  if (search) {
    // Search over title/code/description and assignee names/emails
    const matchingUsers = await User.find({ $or: [{ name: search }, { email: search }] }).select("_id");
    const or: Record<string, unknown>[] = [
      { title: search },
      { shortCode: search },
      { description: search },
      { assignees: { $in: matchingUsers.map((u) => u._id) } },
    ];
    // "#12" / "12" → task number
    const numeric = typeof req.query.search === "string" ? /^#?(\d{1,9})$/.exec(req.query.search.trim()) : null;
    if (numeric) or.push({ number: Number(numeric[1]) });
    and.push({ $or: or });
  }

  return and;
}

/** `?status=` (validated) — shared by every list-style endpoint. */
function applyStatusFilter(req: Request, and: Record<string, unknown>[]): Invalid | null {
  const status = req.query.status;
  if (status === undefined || status === "") return null;
  if (typeof status !== "string" || !TASK_STATUSES.includes(status as TaskStatus)) {
    return { status: 400, error: STATUS_ERROR };
  }
  and.push({ status });
  return null;
}

// ---------------------------------------------------------------------------
// Sorting (server-side, pagination-safe)
// ---------------------------------------------------------------------------

export const TASK_SORT_FIELDS = [
  "createdAt",
  "code",
  "title",
  "startDate",
  "dueDate",
  "actualStartAt",
  "actualEndAt",
  "estimate",
  "loggedMinutes",
  "status",
  "priority",
] as const;
type TaskSortField = (typeof TASK_SORT_FIELDS)[number];

interface TaskSort {
  field: TaskSortField;
  dir: 1 | -1;
}

/** `?sort=<field>&dir=asc|desc` — default newest first. */
function parseTaskSort(req: Request): TaskSort | Invalid {
  const { sort, dir } = req.query;
  if (dir !== undefined && dir !== "" && dir !== "asc" && dir !== "desc") {
    return { status: 400, error: "dir must be asc or desc" };
  }
  if (sort === undefined || sort === "") return { field: "createdAt", dir: dir === "asc" ? 1 : -1 };
  if (typeof sort !== "string" || !TASK_SORT_FIELDS.includes(sort as TaskSortField)) {
    return { status: 400, error: `sort must be one of: ${TASK_SORT_FIELDS.join(", ")}` };
  }
  return { field: sort as TaskSortField, dir: dir === "desc" ? -1 : 1 };
}

/** Sort key that puts missing values last in either direction. */
function missingLast(field: string): Record<string, unknown> {
  return { $cond: [{ $eq: [{ $ifNull: [`$${field}`, null] }, null] }, 1, 0] };
}

/**
 * Ids of one page of tasks matching `filter`, in `sort` order. Computed sorts
 * (hours logged, workflow status order, priority rank) run in the aggregation,
 * so skip/limit stay correct across pages. `_id` breaks ties for stable paging.
 */
async function sortedTaskIds(
  filter: Record<string, unknown>,
  sort: TaskSort,
  limit: number | null,
  offset: number
): Promise<mongoose.Types.ObjectId[]> {
  const d = sort.dir;
  const pipeline: PipelineStage[] = [{ $match: filter }];
  let order: Record<string, 1 | -1>;
  switch (sort.field) {
    case "code":
      // Project tasks by short code; standalone tasks ("#12") by number.
      // Natural (PEAR-2 < PEAR-12), case-insensitive — see lib/naturalSort.ts.
      pipeline.push({ $addFields: { _sortKey: naturalSortKey("$shortCode") } });
      order = { _sortKey: d, number: d, _id: d };
      break;
    case "title":
      pipeline.push({ $addFields: { _sortKey: naturalSortKey("$title") } });
      order = { _sortKey: d, _id: d };
      break;
    case "startDate":
    case "dueDate":
    case "actualStartAt":
    case "actualEndAt":
      pipeline.push({ $addFields: { _missing: missingLast(sort.field) } });
      order = { _missing: 1, [sort.field]: d, _id: d };
      break;
    case "estimate":
      pipeline.push({ $addFields: { _missing: missingLast("estimateMinutes") } });
      order = { _missing: 1, estimateMinutes: d, _id: d };
      break;
    case "loggedMinutes":
      pipeline.push(
        {
          $lookup: {
            from: TimeLog.collection.name,
            let: { taskId: "$_id" },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ["$task", "$$taskId"] },
                  endTime: { $ne: null },
                  status: { $in: ["pending", "approved"] },
                },
              },
              { $group: { _id: null, minutes: { $sum: "$durationMinutes" } } },
            ],
            as: "_logged",
          },
        },
        { $addFields: { _loggedMinutes: { $ifNull: [{ $arrayElemAt: ["$_logged.minutes", 0] }, 0] } } }
      );
      order = { _loggedMinutes: d, _id: d };
      break;
    case "status":
      pipeline.push({ $addFields: { _rank: { $indexOfArray: [[...TASK_STATUSES], "$status"] } } });
      order = { _rank: d, _id: d };
      break;
    case "priority":
      pipeline.push({ $addFields: { _rank: { $indexOfArray: [[...TASK_PRIORITIES], "$priority"] } } });
      order = { _rank: d, _id: d };
      break;
    default:
      order = { createdAt: d, _id: d };
  }
  pipeline.push({ $sort: order });
  if (offset > 0) pipeline.push({ $skip: offset });
  if (limit !== null) pipeline.push({ $limit: limit });
  pipeline.push({ $project: { _id: 1 } });

  const rows = await Task.aggregate<{ _id: mongoose.Types.ObjectId }>(pipeline);
  return rows.map((r) => r._id);
}

/** Loads `ids` (populated, lean — read-only list rows) preserving their order. */
async function loadTasksInOrder(ids: mongoose.Types.ObjectId[]): Promise<LeanTask[]> {
  if (ids.length === 0) return [];
  const docs = await Task.find({ _id: { $in: ids } }).populate(TASK_POPULATE).lean<LeanTask[]>();
  const byId = new Map(docs.map((t) => [t._id.toString(), t]));
  return ids.flatMap((id) => byId.get(id.toString()) ?? []);
}

/** Copies generated per recurring parent (recurring list "copies" column). */
async function copyCounts(ids: mongoose.Types.ObjectId[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await Task.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
    { $match: { recurringParent: { $in: ids } } },
    { $group: { _id: "$recurringParent", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [r._id.toString(), r.count]));
}

/** Shared list responder for `/`, `/mine` and `/created`. */
async function respondWithList(
  req: Request,
  res: Response,
  and: Record<string, unknown>[]
): Promise<void> {
  const { limit, offset } = parsePagination(req);
  const statusError = applyStatusFilter(req, and);
  if (statusError) {
    res.status(statusError.status).json({ error: statusError.error });
    return;
  }
  const sort = parseTaskSort(req);
  if (isInvalid(sort)) {
    res.status(sort.status).json({ error: sort.error });
    return;
  }

  const filter = { $and: and };
  const [ids, total] = await Promise.all([sortedTaskIds(filter, sort, limit, offset), Task.countDocuments(filter)]);
  const tasks = await serializeTasks(await loadTasksInOrder(ids), req.user);

  if (req.query.recurring === "true") {
    const counts = await copyCounts(ids);
    for (const task of tasks) task.copyCount = counts.get(String(task._id)) ?? 0;
  }
  res.json({ tasks, total, limit, offset });
}

/**
 * Re-normalises a column's positions when a fractional insert collapsed the gap
 * between neighbours (float precision exhausted). The moved task keeps its
 * intended slot: after the previous neighbour or before the next one.
 */
async function normalizeColumnIfNeeded(task: ITask): Promise<void> {
  const [prev, next] = await Promise.all([
    Task.findOne({ status: task.status, _id: { $ne: task._id }, position: { $lte: task.position } })
      .sort({ position: -1 })
      .select("position"),
    Task.findOne({ status: task.status, _id: { $ne: task._id }, position: { $gte: task.position } })
      .sort({ position: 1 })
      .select("position"),
  ]);
  const prevGap = prev ? task.position - prev.position : Infinity;
  const nextGap = next ? next.position - task.position : Infinity;
  if (prevGap >= MIN_POSITION_GAP && nextGap >= MIN_POSITION_GAP) return;

  const others = await Task.find({ status: task.status, _id: { $ne: task._id } })
    .sort({ position: 1, createdAt: 1 })
    .select("_id position");
  const tiedWithPrev = prevGap < MIN_POSITION_GAP;
  let index = others.findIndex((o) =>
    tiedWithPrev ? o.position > task.position : o.position >= task.position
  );
  if (index === -1) index = others.length;
  const ordered = [
    ...others.slice(0, index).map((o) => o._id),
    task._id,
    ...others.slice(index).map((o) => o._id),
  ];

  await Task.bulkWrite(
    ordered.map((id, i) => ({
      updateOne: { filter: { _id: id }, update: { $set: { position: (i + 1) * 1024 } } },
    }))
  );
}

/** Task fields every task email needs. */
/** The task fields the notification emails show (code, project, dates, status). */
function emailTask(task: ITask) {
  return {
    _id: task._id as mongoose.Types.ObjectId,
    title: task.title,
    dueDate: task.dueDate,
    startDate: task.startDate,
    priority: task.priority,
    status: task.status,
    shortCode: task.shortCode,
    number: task.number,
    project: task.project,
  };
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  completed: "Completed",
  rejected: "Rejected",
};

/**
 * Shared by PATCH /:id/status, PATCH /:id/move and POST /bulk: validates the
 * transition for the caller, applies side fields, persists, and fans out
 * history / activity / notifications / SSE. `previousStatus` is captured BEFORE
 * mutating. Returns an `Invalid` (nothing written) when the move isn't allowed.
 */
/**
 * Completion rule: a task can't be completed (or sent for review) without a final
 * deliverable — an uploaded final file, a link, or an outcome note — and without
 * time logged on it. Returns the reason, or null when it may complete.
 */
// Completion needs the final file / link or an outcome note (logged time is optional).
/**
 * A task can be completed only with (1) a record of the outcome — an outcome
 * note, the final file or link, or a file on the task — and (2) time spent logged.
 */
async function completionBlocker(task: ITask): Promise<string | null> {
  const [file, log] = await Promise.all([
    TaskFile.exists({ task: task._id }),
    TimeLog.exists({ task: task._id, status: { $ne: "rejected" } }),
  ]);
  const outcome = Boolean(task.finalFile?.fileId || task.finalFile?.url || task.submissionNotes?.trim() || file);
  if (!outcome && !log) return "Add a note, file or link and log the time spent before completing this task";
  if (!outcome) return "Add a note, file or link before completing this task";
  if (!log) return "Log the time spent before completing this task";
  return null;
}

async function applyStatusChange(
  user: IUser,
  task: ITask,
  to: TaskStatus,
  position: number | undefined,
  ip: string | undefined
): Promise<Invalid | { changed: boolean }> {
  const flags = await taskProjectFlags(task, user);
  const manager = canManageTask(user, task, flags);

  if (!manager && !isAssignee(user, task)) {
    return { status: 403, error: "You can only move tasks assigned to you or created by you" };
  }
  const transition = { skipReview: flags.skipReview, projectManager: flags.projectManager };
  if (!canTransition(user, task, to, transition)) {
    const allowed = allowedTransitions(user, task, transition);
    return {
      status: 400,
      error: `Cannot transition from "${task.status}" to "${to}". Allowed: ${allowed.join(", ") || "none"}`,
    };
  }

  if ((to === "completed" || to === "in_review") && task.status !== to && task.status !== "in_review") {
    const blocker = await completionBlocker(task);
    if (blocker) return { status: 400, error: blocker };
  }

  const previousStatus = task.status;
  const statusChanged = previousStatus !== to;
  const now = new Date();

  if (statusChanged) {
    task.status = to;
    if (to === "in_review") {
      task.submittedAt = now;
    }
    if (to === "completed") {
      task.completedAt = now;
      task.reviewedAt = now;
      task.reviewedBy = user._id;
    } else {
      task.completedAt = null;
    }
    if (to === "rejected") {
      task.reviewedAt = now;
      task.reviewedBy = user._id;
    }
    await applyAutoActualDates(task, previousStatus, to, now);
  }

  if (position !== undefined) {
    task.position = position;
  } else if (statusChanged) {
    // No explicit slot → bottom of the destination column
    task.position = Date.now();
  }

  await task.save();
  if (to === "completed") void syncActualDatesFromLogs(task._id as mongoose.Types.ObjectId);
  await normalizeColumnIfNeeded(task);

  if (statusChanged) {
    recordTaskHistory(task._id as mongoose.Types.ObjectId, user, "status_changed", {
      from: previousStatus,
      to,
    });

    logActivity({
      action: "task_status_updated",
      actor: user,
      targetType: "task",
      targetId: task._id as mongoose.Types.ObjectId,
      targetName: task.title,
      details: { from: previousStatus, to },
      ip,
    });

    // A creator/admin dragging an in-review card to Completed/Rejected is a review.
    const isReview = previousStatus === "in_review" && (to === "completed" || to === "rejected");
    if (isReview) {
      const approved = to === "completed";
      notifyTask({
        recipients: task.assignees,
        actor: user,
        type: approved ? "task_approved" : "task_rejected",
        task: emailTask(task),
        title: approved ? "Task approved" : "Task rejected",
        message: `Your task "${task.title}" has been ${approved ? "approved" : "rejected"}.`,
        email: {
          subject: approved ? `✅ Task Approved: ${task.title}` : `❌ Task Rejected: ${task.title}`,
          heading: approved ? "Task Approved" : "Task Rejected",
          intro: `${user.name} ${approved ? "approved" : "rejected"} your task.`,
        },
      });
    } else {
      notifyTask({
        recipients: [...task.assignees, task.assignedBy],
        actor: user,
        type: "task_status_changed",
        task: emailTask(task),
        title: "Task status changed",
        message: `${user.name} moved "${task.title}" from ${STATUS_LABELS[previousStatus]} to ${STATUS_LABELS[to]}.`,
        email: {
          subject: `🔄 ${task.title}: ${STATUS_LABELS[to]}`,
          heading: "Task Status Changed",
          intro: `${user.name} moved this task from ${STATUS_LABELS[previousStatus]} to ${STATUS_LABELS[to]}.`,
        },
      });
    }
  }

  pushTaskUpdate(task, statusChanged ? "status-changed" : "moved", {
    previousStatus,
    position: task.position,
    actorId: user._id.toString(),
  });
  if (statusChanged) scheduleProgressRecalc(task.project ?? null);
  return { changed: statusChanged };
}

/** HTTP wrapper around `applyStatusChange` — responds with the task detail. */
async function changeStatus(
  req: Request,
  res: Response,
  task: ITask,
  to: TaskStatus,
  position: number | undefined
): Promise<void> {
  const user = req.user!;
  const result = await applyStatusChange(user, task, to, position, req.ip);
  if (isInvalid(result)) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  const detail = await loadTaskDetail(task._id as mongoose.Types.ObjectId, user);
  res.json(detail);
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface CreateTaskBody {
  project?: unknown;
  /** Controlled name parts { unit, quantity, shortName }; the title is composed from them. */
  titleParts?: unknown;
  /** "new" | "rework". */
  iteration?: unknown;
  /** Rework: the original task (same project). */
  reworkOf?: unknown;
  /** The form uploads attachments right after creation (they count as the brief). */
  hasAttachments?: unknown;
  milestone?: unknown;
  title?: unknown;
  description?: unknown;
  assignees?: unknown;
  /** Legacy single-assignee field — still accepted. */
  assignedTo?: unknown;
  priority?: unknown;
  startDate?: unknown;
  dueDate?: unknown;
  labels?: unknown;
  category?: unknown;
  subtasks?: unknown;
  recurrence?: unknown;
  /** Estimated time in minutes (0-100000) or null. */
  estimateMinutes?: unknown;
}

type UpdateTaskBody = Omit<CreateTaskBody, "subtasks"> & {
  /** ISO date-time; null clears it (back to automatic). */
  actualStartAt?: unknown;
  actualEndAt?: unknown;
};

interface UpdateStatusBody {
  status?: unknown;
}

interface MoveTaskBody {
  status?: unknown;
  position?: unknown;
}

interface SubmitTaskBody {
  submissionNotes?: unknown;
  /** A file already uploaded to this task (Files) that is the final deliverable. */
  finalFileId?: unknown;
  /** Or a link to the final deliverable (http/https). */
  finalUrl?: unknown;
}

interface ReviewTaskBody {
  decision?: unknown;
  reviewNotes?: unknown;
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

export interface CreateTaskOptions {
  /** Tasks created in the app's task form: project, brief, estimate, iteration and the controlled name are required. */
  enforceRules?: boolean;
  /** Imports may add tasks to projects whose month has ended; everything else may not. */
  allowClosedProject?: boolean;
  /** History action for the "created" row (meetings use "created_from_meeting"). */
  historyAction?: TaskHistoryAction;
  /** Links the task back to a meeting transcript line. */
  sourceMeeting?: ITaskSourceMeeting | null;
  /** Initial status (imports); default "todo". */
  status?: TaskStatus;
  /** false = in-app notifications only, no emails (bulk imports). Default true. */
  sendEmail?: boolean;
  /** Actual start / end supplied by an import (source "import"; validated by the caller). */
  actual?: { start: Date | null; end: Date | null };
}

/**
 * Creates and assigns a task (POST /, POST /:id/duplicate and
 * POST /api/meetings/:id/tasks share this path): validation, project
 * membership, short code + global number, history, activity, `task_assigned`
 * notifications and SSE. Heads can only assign to members of their own department.
 */
/** `titleParts` -> validated parts, undefined when absent. */
function parseTitleParts(raw: unknown): ITaskTitleParts | undefined | Invalid {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") return { status: 400, error: "titleParts must be { unit, quantity, shortName }" };
  const r = raw as { unit?: unknown; quantity?: unknown; shortName?: unknown };
  const unit = typeof r.unit === "string" ? r.unit.trim() : "";
  const shortName = typeof r.shortName === "string" ? r.shortName.trim() : "";
  const quantity = typeof r.quantity === "number" ? r.quantity : Number(r.quantity);
  if (!unit || unit.length > TASK_TITLE_LIMITS.unitMax) {
    return { status: 400, error: `Scope unit is required (max ${TASK_TITLE_LIMITS.unitMax} characters)` };
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > TASK_TITLE_LIMITS.quantityMax) {
    return { status: 400, error: `Quantity must be a whole number from 1 to ${TASK_TITLE_LIMITS.quantityMax}` };
  }
  if (!shortName || shortName.length > TASK_TITLE_LIMITS.shortNameMax) {
    return { status: 400, error: `Short name is required (max ${TASK_TITLE_LIMITS.shortNameMax} characters)` };
  }
  return { unit, quantity, shortName };
}

/** `iteration` -> "new" | "rework", undefined when absent. */
function parseIteration(raw: unknown): TaskIteration | undefined | Invalid {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || !(TASK_ITERATIONS as readonly string[]).includes(raw)) {
    return { status: 400, error: 'iteration must be "new" or "rework"' };
  }
  return raw as TaskIteration;
}

export async function createTaskCore(
  actor: IUser,
  body: CreateTaskBody,
  ip: string | undefined,
  historyExtra: Record<string, unknown> = {},
  options: CreateTaskOptions = {}
): Promise<Invalid | { taskId: mongoose.Types.ObjectId; warnings: string[] }> {
  const { description, priority } = body;
  let titleParts = parseTitleParts(body.titleParts);
  if (isInvalid(titleParts)) return titleParts;
  const iteration = parseIteration(body.iteration);
  if (isInvalid(iteration)) return iteration;
  let title: unknown = titleParts ? composeTaskTitle(titleParts) : body.title;

  // Project tasks: admins, heads, the project manager and members. Standalone tasks: heads/admins.
  let project: IProject | null = null;
  if (body.project !== undefined && body.project !== null && body.project !== "") {
    const resolved = await resolveTaskProject(actor, body.project);
    if (isInvalid(resolved)) {
      return resolved;
    }
    if (!options.allowClosedProject && isProjectExpired(resolved)) {
      return { status: 400, error: PROJECT_CLOSED_MESSAGE };
    }
    if (!options.allowClosedProject && !isProjectApproved(resolved)) {
      return { status: 400, error: await notApprovedMessage(resolved) };
    }
    project = resolved;
  } else if (actor.role === "employee") {
    return { status: 403, error: "Only heads and admins can create tasks outside a project" };
  }
  let milestone: IMilestone | null = null;
  if (body.milestone !== undefined) {
    const resolved = await resolveMilestone(body.milestone, project);
    if (isInvalid(resolved)) {
      return resolved;
    }
    milestone = resolved;
  }

  // Validate title (rework is named from the original task further down)
  const autoNamed = iteration === "rework" && typeof body.reworkOf === "string" && body.reworkOf !== "";
  if (autoNamed && (typeof title !== "string" || !title.trim())) title = "Rework";
  if (typeof title !== "string" || !title.trim()) {
    return { status: 400, error: "title is required" };
  }
  if (title.trim().length > 200) {
    return { status: 400, error: "title must be 200 characters or fewer" };
  }

  // Description validation
  if (description !== undefined && description !== null && (typeof description !== "string" || description.trim().length > TASK_LIMITS.maxDescription)) {
    return { status: 400, error: `description must be ${TASK_LIMITS.maxDescription} characters or fewer` };
  }

  // Validate priority
  if (priority !== undefined && (typeof priority !== "string" || !TASK_PRIORITIES.includes(priority as TaskPriority))) {
    return { status: 400, error: PRIORITY_ERROR };
  }

  // Validate assignees (legacy `assignedTo` is wrapped into a one-item list)
  const rawAssignees =
    body.assignees !== undefined ? body.assignees : body.assignedTo !== undefined ? [body.assignedTo] : undefined;
  const assignees = await resolveAssignees(actor, rawAssignees, { skipDepartmentCheck: Boolean(project) });
  if (isInvalid(assignees)) {
    return assignees;
  }

  // Validate dates
  const startDate = parseOptionalDate(body.startDate, "startDate");
  if (isInvalid(startDate)) {
    return startDate;
  }
  const dueDate = parseOptionalDate(body.dueDate, "dueDate");
  if (isInvalid(dueDate)) {
    return dueDate;
  }
  if (startDate && dueDate && startDate.getTime() > dueDate.getTime()) {
    return { status: 400, error: "startDate must be on or before dueDate" };
  }

  // Labels / category
  let labels: mongoose.Types.ObjectId[] = [];
  if (body.labels !== undefined) {
    const resolved = await resolveLabels(body.labels);
    if (isInvalid(resolved)) {
      return resolved;
    }
    labels = resolved;
  }
  let category: mongoose.Types.ObjectId | null = null;
  if (body.category !== undefined) {
    const resolved = await resolveCategory(body.category);
    if (isInvalid(resolved)) {
      return resolved;
    }
    category = resolved;
  }

  // Initial subtasks
  const assigneeIds = new Set(assignees.map((u) => u._id.toString()));
  let subtasks: Array<Record<string, unknown>> = [];
  if (body.subtasks !== undefined) {
    const parsed = parseInitialSubtasks(body.subtasks, assigneeIds, actor._id);
    if (isInvalid(parsed)) {
      return parsed;
    }
    subtasks = parsed;
  }

  const estimateMinutes = parseEstimate(body.estimateMinutes);
  if (isInvalid(estimateMinutes)) return estimateMinutes;

  // Rework is a task of its own, linked to the original task (same project).
  let reworkOf: ITask | null = null;
  if (body.reworkOf !== undefined && body.reworkOf !== null && body.reworkOf !== "") {
    if (typeof body.reworkOf !== "string" || isInvalidObjectId(body.reworkOf)) {
      return { status: 400, error: "reworkOf must be a valid task ID" };
    }
    reworkOf = await Task.findById(body.reworkOf);
    if (!reworkOf) return { status: 404, error: "The task being reworked was not found" };
    if (!project || !reworkOf.project || !reworkOf.project.equals(project._id as mongoose.Types.ObjectId)) {
      return { status: 400, error: "The rework must be in the same project as the original task" };
    }
    if (iteration === "rework") {
      // Auto-versioned name: the original's name + R<round> ("Video 1 – Teaser R2").
      const round = (await Task.countDocuments({ reworkOf: reworkOf._id })) + 1;
      const base = reworkOf.titleParts ?? { unit: "Rework", quantity: 1, shortName: reworkOf.title };
      const shortName = `${base.shortName.replace(/\s+R\d+$/, "").slice(0, TASK_TITLE_LIMITS.shortNameMax - 5)} R${round}`;
      titleParts = { unit: base.unit, quantity: base.quantity, shortName };
      title = composeTaskTitle(titleParts);
    }
  }

  // App-created tasks (the task form): every task sits under a project, carries a brief
  // (description or attachment), the iteration and a controlled name. Rework tasks
  // name the original task they rework.
  if (options.enforceRules) {
    if (!project) return { status: 400, error: "Every task must belong to a project (pick one)" };
    const hasDescription = typeof description === "string" && description.trim().length > 0;
    if (!hasDescription && body.hasAttachments !== true) {
      return { status: 400, error: "Add a brief: write a description or attach a file" };
    }
    if (!titleParts) return { status: 400, error: "Task name needs a scope unit, a quantity and a short name" };
    if (!iteration) return { status: 400, error: "Choose the iteration: new work or rework" };
    if (iteration === "rework" && !reworkOf) {
      return { status: 400, error: "Choose the task this rework is for" };
    }
    // Rework also needs a due date (the brief rule is the same as new work).
    if (iteration === "rework") {
      if (body.dueDate === undefined || body.dueDate === null || body.dueDate === "") {
        return { status: 400, error: "Choose the due date for this rework" };
      }
    }
  }

  // Recurrence
  let recurrence: ITaskRecurrence | null = null;
  if (body.recurrence !== undefined) {
    const parsed = parseRecurrence(body.recurrence, startDate);
    if (isInvalid(parsed)) {
      return parsed;
    }
    recurrence = parsed;
  }

  // Project membership rule (auto-adds non-members when the actor manages the project)
  if (project) {
    const ensured = await ensureProjectMembers(actor, project, assignees, options.sendEmail !== false);
    if (isInvalid(ensured)) {
      return ensured;
    }
  }
  const initialStatus: TaskStatus = options.status ?? "todo";
  if (!TASK_STATUSES.includes(initialStatus)) return { status: 400, error: STATUS_ERROR };
  const shortCode = project ? await nextShortCode(project._id as mongoose.Types.ObjectId) : null;
  const number = await nextTaskNumber();
  const warnings = milestoneWarnings(dueDate, milestone);
  const createdAt = new Date();
  const actual = initialActualDates(initialStatus, createdAt);
  if (options.actual?.start) {
    actual.actualStartAt = options.actual.start;
    actual.actualStartSource = "import";
  }
  if (options.actual?.end) {
    actual.actualEndAt = options.actual.end;
    actual.actualEndSource = "import";
  }

  // Traffic desk: a task created with only traffic managers waits to be routed to the team.
  const trafficManagers = new Set((await getDeliverySettings()).trafficManagers);
  const onlyTraffic = assignees.length > 0 && assignees.every((a) => trafficManagers.has(String(a._id)));
  const task = await Task.create({
    trafficVia: onlyTraffic ? assignees[0]!._id : null,
    assignedAt: onlyTraffic ? null : new Date(),
    title: String(title).trim(),
    description: typeof description === "string" && description.trim() ? description.trim() : undefined,
    assignees: assignees.map((u) => u._id),
    assignedBy: actor._id,
    department: assignees[0]!.department || project?.departments[0] || null,
    project: project ? project._id : null,
    milestone: milestone ? milestone._id : null,
    shortCode,
    number,
    estimateMinutes: estimateMinutes ?? null,
    iteration: iteration ?? null,
    reworkOf: iteration === "rework" && reworkOf ? reworkOf._id : null,
    ...(titleParts ? { titleParts } : {}),
    category,
    labels,
    priority: (priority as TaskPriority) || "medium",
    startDate: startDate ?? null,
    dueDate: dueDate ?? null,
    position: Date.now(),
    subtasks,
    recurrence,
    status: initialStatus,
    ...(initialStatus === "completed" ? { completedAt: createdAt } : {}),
    ...(initialStatus === "in_review" ? { submittedAt: createdAt } : {}),
    ...actual,
    sourceMeeting: options.sourceMeeting ?? null,
  });
  const taskId = task._id as mongoose.Types.ObjectId;

  if (task.reworkOf) {
    recordTaskHistory(task.reworkOf, actor, "rework_added", {
      reworkTask: taskId.toString(),
      title: task.title,
      shortCode: task.shortCode ?? null,
    });
  }

  recordTaskHistory(taskId, actor, options.historyAction ?? "created", {
    assignees: assignees.map((u) => u.name),
    subtasks: subtasks.length,
    ...(initialStatus !== "todo" ? { status: initialStatus } : {}),
    ...historyExtra,
  });

  logActivity({
    action: "task_created",
    actor,
    targetType: "task",
    targetId: taskId,
    targetName: task.title,
    details: { assignees: assignees.map((u) => u.name), priority: task.priority },
    ip,
  });

  // Notify every assignee
  notifyTask({
    recipients: task.assignees,
    actor,
    type: "task_assigned",
    task: emailTask(task),
    title: "New task assigned",
    message: `${actor.name} assigned you a new task: ${task.title}`,
    skipEmail: options.sendEmail === false,
    email: {
      subject: `📋 New Task Assigned: ${task.title}`,
      heading: "New Task Assigned",
      intro: `${actor.name} assigned a new task to you.`,
      quote: task.description ?? null,
    },
  });

  // Real-time SSE push to assignees, creator and watchers
  pushTaskUpdate(task, "created", { actorId: actor._id.toString() });
  scheduleBriefCheck(taskId);
  scheduleTaskTag(taskId);
  if (project) {
    scheduleProgressRecalc(project._id as mongoose.Types.ObjectId);
    pushProjectUpdate(project, "task-created", { taskId: taskId.toString(), shortCode });
  }

  return { taskId, warnings };
}

/**
 * Head or admin (or a project manager in their project): creates and assigns a task.
 * Heads can only assign to members of their own department.
 */
export async function createTask(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const result = await createTaskCore(actor, (req.body ?? {}) as CreateTaskBody, req.ip, {}, { enforceRules: true });
  if (isInvalid(result)) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  const detail = await loadTaskDetail(result.taskId, actor);
  res.status(201).json({ ...detail, warnings: result.warnings });
}

/**
 * Any authenticated user: tasks scoped by role.
 * - admin: all; head: created/assigned + their department (any assignee in it);
 * employee: assigned/created. Everyone also sees tasks of projects they manage.
 * Filters: scope (assigned|created|all), status, assignee, department, label, category,
 * priority, due (overdue|today|week), search, plus pagination.
 * `?view=board` returns `{ columns, totals }` grouped by status, ordered by position.
 */
export async function listTasks(req: Request, res: Response): Promise<void> {
  await respondTasks(req, res);
}

/** GET /api/projects/:id/tasks — the task list / board scoped to one project. */
export async function listTasksForProject(req: Request, res: Response, project: IProject): Promise<void> {
  await respondTasks(req, res, project);
}

async function respondTasks(req: Request, res: Response, project?: IProject): Promise<void> {
  const and = await buildListFilter(req, project);
  if (isInvalid(and)) {
    res.status(and.status).json({ error: and.error });
    return;
  }

  if (req.query.view !== "board") {
    await respondWithList(req, res, and);
    return;
  }

  const results = await Promise.all(
    TASK_STATUSES.map(async (status) => {
      const filter = { $and: [...and, { status }] };
      const [tasks, total] = await Promise.all([
        Task.find(filter).populate(TASK_POPULATE).sort({ position: 1 }).limit(BOARD_COLUMN_LIMIT).lean<LeanTask[]>(),
        Task.countDocuments(filter),
      ]);
      return { status, tasks, total };
    })
  );

  // One serialization pass (3 count aggregations) for the whole board, not one per column.
  const serialized = await serializeTasks(results.flatMap((r) => r.tasks), req.user);
  const columns: Record<string, unknown[]> = {};
  const totals: Record<string, number> = {};
  let offset = 0;
  for (const { status, tasks, total } of results) {
    columns[status] = serialized.slice(offset, offset + tasks.length);
    offset += tasks.length;
    totals[status] = total;
  }
  res.json({ columns, totals, limit: BOARD_COLUMN_LIMIT });
}

/** Any authenticated user: their own assigned tasks, newest first (kept for compatibility). */
export async function myTasks(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const and: Record<string, unknown>[] = [{ assignees: user._id }];
  const search = searchRegex(req.query.search);
  if (search) and.push({ $or: [{ title: search }, { description: search }] });
  await respondWithList(req, res, and);
}

/** Head or admin: tasks they created, newest first (kept for compatibility). */
export async function createdTasks(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const and: Record<string, unknown>[] = [{ assignedBy: user._id }];
  const assignee = req.query.assignee;
  if (typeof assignee === "string" && !isInvalidObjectId(assignee)) {
    and.push({ assignees: new mongoose.Types.ObjectId(assignee) });
  }
  const search = searchRegex(req.query.search);
  if (search) and.push({ $or: [{ title: search }, { description: search }] });
  await respondWithList(req, res, and);
}

/** Task detail — populated, with subtasks and the caller's permissions. */
export async function getTask(req: Request, res: Response): Promise<void> {
  const task = await getViewableTaskOr404(req, res);
  if (!task) return;

  const detail = await loadTaskDetail(task._id as mongoose.Types.ObjectId, req.user!);
  res.json(detail);
}

/** GET /api/tasks/:id/reworks — rework tasks made from this task (its rework history). */
export async function listReworkTasks(req: Request, res: Response): Promise<void> {
  const task = await getViewableTaskOr404(req, res);
  if (!task) return;
  const reworks = await Task.find({ reworkOf: task._id })
    .select("title shortCode number status priority assignees assignedBy dueDate completedAt createdAt")
    .populate([
      { path: "assignees", select: "name email" },
      { path: "assignedBy", select: "name" },
    ])
    .sort({ createdAt: 1 })
    .limit(200)
    .lean();
  res.json({
    tasks: reworks.map((r, index) => ({ ...r, _id: String(r._id), round: index + 1 })),
    total: reworks.length,
  });
}

/** Assignee/creator/admin: changes status (same transition rules as a board move). */
export async function updateStatus(req: Request, res: Response): Promise<void> {
  const task = await getTaskOr404(req, res);
  if (!task) return;

  const { status } = (req.body ?? {}) as UpdateStatusBody;
  if (typeof status !== "string" || !TASK_STATUSES.includes(status as TaskStatus)) {
    res.status(400).json({ error: STATUS_ERROR });
    return;
  }

  await changeStatus(req, res, task, status as TaskStatus, undefined);
}

/** Board drag: `{ status, position }`. Validates the transition for the caller's role. */
export async function moveTask(req: Request, res: Response): Promise<void> {
  const task = await getTaskOr404(req, res);
  if (!task) return;

  const { status, position } = (req.body ?? {}) as MoveTaskBody;
  if (typeof status !== "string" || !TASK_STATUSES.includes(status as TaskStatus)) {
    res.status(400).json({ error: STATUS_ERROR });
    return;
  }
  if (position !== undefined && (typeof position !== "number" || !Number.isFinite(position))) {
    res.status(400).json({ error: "position must be a finite number" });
    return;
  }

  await changeStatus(req, res, task, status as TaskStatus, position as number | undefined);
}

/**
 * Assignee: submits completed work with notes.
 * Sets status to in_review and notifies the task creator.
 */
export async function submitTask(req: Request, res: Response): Promise<void> {
  const task = await getTaskOr404(req, res);
  if (!task) return;

  const user = req.user!;
  if (!isAssignee(user, task)) {
    // Whoever manages the task may also mark it complete on projects without task approval.
    const flags = await taskProjectFlags(task, user);
    if (!(flags.skipReview && canManageTask(user, task, flags))) {
      res.status(403).json({ error: "You can only submit your own tasks" });
      return;
    }
  }

  if (task.status !== "todo" && task.status !== "in_progress" && task.status !== "rejected") {
    res.status(400).json({ error: "Only todo, in_progress, or rejected tasks can be submitted" });
    return;
  }

  const { submissionNotes, finalFileId, finalUrl } = (req.body ?? {}) as SubmitTaskBody;
  if (submissionNotes !== undefined && (typeof submissionNotes !== "string" || submissionNotes.trim().length > 2000)) {
    res.status(400).json({ error: "submissionNotes must be 2000 characters or fewer" });
    return;
  }
  let finalFile: { fileId: mongoose.Types.ObjectId | null; url: string | null; addedAt: Date } | null = null;
  if (finalFileId !== undefined && finalFileId !== null && finalFileId !== "") {
    if (typeof finalFileId !== "string" || isInvalidObjectId(finalFileId)) {
      res.status(400).json({ error: "finalFileId must be a valid file ID" });
      return;
    }
    const exists = await TaskFile.exists({ _id: finalFileId, task: task._id });
    if (!exists) {
      res.status(400).json({ error: "The final file must be uploaded to this task" });
      return;
    }
    finalFile = { fileId: new mongoose.Types.ObjectId(finalFileId), url: null, addedAt: new Date() };
  } else if (finalUrl !== undefined && finalUrl !== null && finalUrl !== "") {
    if (typeof finalUrl !== "string" || !/^https?:\/\/\S+$/i.test(finalUrl.trim()) || finalUrl.trim().length > 2000) {
      res.status(400).json({ error: "The final link must start with http:// or https://" });
      return;
    }
    finalFile = { fileId: null, url: finalUrl.trim(), addedAt: new Date() };
  }
  if (finalFile) task.finalFile = finalFile;
  if (submissionNotes !== undefined) {
    task.submissionNotes = typeof submissionNotes === "string" && submissionNotes.trim() ? submissionNotes.trim() : undefined;
  }
  const blocker = await completionBlocker(task);
  if (blocker) {
    res.status(400).json({ error: blocker });
    return;
  }

  const previousStatus = task.status;
  // Projects with requireTaskApproval = false skip the review step.
  const { skipReview } = await taskProjectFlags(task);
  const now = new Date();
  task.status = skipReview ? "completed" : "in_review";
  task.submittedAt = now;
  if (skipReview) task.completedAt = now;
  await applyAutoActualDates(task, previousStatus, task.status, now);
  await task.save();
  if (skipReview) void syncActualDatesFromLogs(task._id as mongoose.Types.ObjectId);
  const taskId = task._id as mongoose.Types.ObjectId;
  scheduleProgressRecalc(task.project ?? null);

  recordTaskHistory(taskId, user, "submitted", {
    from: previousStatus,
    submissionNotes: task.submissionNotes,
  });

  logActivity({
    action: "task_submitted",
    actor: user,
    targetType: "task",
    targetId: taskId,
    targetName: task.title,
    details: { submissionNotes: task.submissionNotes },
    ip: req.ip,
  });

  // Notify the task creator
  notifyTask({
    recipients: [task.assignedBy],
    actor: user,
    type: "task_completed",
    task: emailTask(task),
    title: skipReview ? "Task completed" : "Task submitted for review",
    message: skipReview
      ? `${user.name} completed "${task.title}" (no review required for this project).`
      : `${user.name} has submitted "${task.title}" for your review.`,
    email: {
      subject: skipReview ? `✅ Task Completed: ${task.title}` : `✅ Task Submitted for Review: ${task.title}`,
      heading: skipReview ? "Task Completed" : "Task Submitted for Review",
      intro: skipReview
        ? `${user.name} completed this task. This project does not require task approval.`
        : `${user.name} submitted this task for your review.`,
      quote: task.submissionNotes ?? null,
      quoteAuthor: task.submissionNotes ? user.name : null,
      buttonLabel: skipReview ? "View Task" : "Review Task",
    },
  });

  pushTaskUpdate(task, "submitted", { previousStatus, submittedBy: user.name });

  const detail = await loadTaskDetail(taskId, user);
  res.json(detail);
}

/**
 * Creator or admin: reviews a submitted task.
 * Approves or rejects with optional notes.
 */
export async function reviewTask(req: Request, res: Response): Promise<void> {
  const task = await getTaskOr404(req, res);
  if (!task) return;

  const user = req.user!;
  if (!(await canManageTaskAsync(user, task))) {
    res.status(403).json({ error: "Only the task creator or an admin can review tasks" });
    return;
  }

  if (task.status !== "in_review") {
    res.status(400).json({ error: "Only tasks in review can be reviewed" });
    return;
  }

  const { decision, reviewNotes } = (req.body ?? {}) as ReviewTaskBody;
  if (decision !== "approved" && decision !== "rejected") {
    res.status(400).json({ error: "decision must be approved or rejected" });
    return;
  }
  if (reviewNotes !== undefined && (typeof reviewNotes !== "string" || reviewNotes.trim().length > 2000)) {
    res.status(400).json({ error: "reviewNotes must be 2000 characters or fewer" });
    return;
  }

  const isApproved = decision === "approved";
  const reviewedAt = new Date();
  if (isApproved) {
    task.status = "completed";
    task.completedAt = reviewedAt;
  } else {
    task.status = "rejected";
  }
  await applyAutoActualDates(task, "in_review", task.status, reviewedAt);

  task.reviewNotes = reviewNotes ? (reviewNotes as string).trim() : undefined;
  task.reviewedAt = reviewedAt;
  task.reviewedBy = user._id;
  await task.save();
  const taskId = task._id as mongoose.Types.ObjectId;

  recordTaskHistory(taskId, user, "reviewed", { decision, reviewNotes: task.reviewNotes });
  scheduleProgressRecalc(task.project ?? null);

  logActivity({
    action: "task_reviewed",
    actor: user,
    targetType: "task",
    targetId: taskId,
    targetName: task.title,
    details: { decision, reviewNotes: task.reviewNotes },
    ip: req.ip,
  });

  // Notify the assignees
  notifyTask({
    recipients: task.assignees,
    actor: user,
    type: isApproved ? "task_approved" : "task_rejected",
    task: emailTask(task),
    title: isApproved ? "Task approved" : "Task rejected",
    message: `Your task "${task.title}" has been ${decision}.`,
    email: {
      subject: isApproved ? `✅ Task Approved: ${task.title}` : `❌ Task Rejected: ${task.title}`,
      heading: isApproved ? "Task Approved" : "Task Rejected",
      intro: `${user.name} ${decision} your task.`,
      quote: task.reviewNotes ?? null,
      quoteAuthor: task.reviewNotes ? user.name : null,
    },
  });

  pushTaskUpdate(task, "reviewed", { previousStatus: "in_review", decision, reviewedBy: user.name });

  const detail = await loadTaskDetail(taskId, user);
  res.json(detail);
}

/**
 * Creator or admin: edits a task's details (PATCH /:id and the bulk "assign"
 * action share this path). Diffs assignees — newly added ones get
 * `task_assigned` (subtask assignments are kept). Nothing is written when it
 * returns an `Invalid`.
 */
async function applyTaskUpdate(
  user: IUser,
  task: ITask,
  body: UpdateTaskBody,
  ip: string | undefined
): Promise<Invalid | { warnings: string[] }> {
  if (!(await canManageTaskAsync(user, task))) {
    return { status: 403, error: "Only the task creator or an admin can update tasks" };
  }

  const { description, priority } = body;
  /** Fields that trigger `task_updated` for the assignees. */
  const notable: string[] = [];
  const changed: string[] = [];

  const titleParts = parseTitleParts(body.titleParts);
  if (isInvalid(titleParts)) return titleParts;
  const title = titleParts ? composeTaskTitle(titleParts) : body.title;
  if (titleParts) {
    const before = task.titleParts;
    if (!before || before.unit !== titleParts.unit || before.quantity !== titleParts.quantity || before.shortName !== titleParts.shortName) {
      task.titleParts = titleParts;
      changed.push("titleParts");
    }
  } else if (body.title !== undefined && task.titleParts) {
    return { status: 400, error: "This task's name is controlled: send titleParts { unit, quantity, shortName }" };
  }
  if (body.iteration !== undefined) {
    const iteration = parseIteration(body.iteration);
    if (isInvalid(iteration)) return iteration;
    if (!iteration && task.iteration) return { status: 400, error: "The iteration can't be cleared" };
    if (iteration && iteration !== task.iteration) {
      task.iteration = iteration;
      notable.push("iteration");
    }
  }

  if (title !== undefined) {
    if (typeof title !== "string" || !title.trim()) {
      return { status: 400, error: "title cannot be empty" };
    }
    if (title.trim().length > 200) {
      return { status: 400, error: "title must be 200 characters or fewer" };
    }
    if (task.title !== title.trim()) {
      task.title = title.trim();
      notable.push("title");
    }
  }

  if (description !== undefined) {
    if (description !== null && (typeof description !== "string" || description.trim().length > TASK_LIMITS.maxDescription)) {
      return { status: 400, error: `description must be ${TASK_LIMITS.maxDescription} characters or fewer` };
    }
    const next = typeof description === "string" ? description.trim() || undefined : undefined;
    if ((task.description ?? undefined) !== next) {
      task.description = next;
      notable.push("description");
    }
  }

  if (priority !== undefined) {
    if (typeof priority !== "string" || !TASK_PRIORITIES.includes(priority as TaskPriority)) {
      return { status: 400, error: PRIORITY_ERROR };
    }
    if (task.priority !== priority) {
      task.priority = priority as TaskPriority;
      notable.push("priority");
    }
  }

  const startDate = parseOptionalDate(body.startDate, "startDate");
  if (isInvalid(startDate)) {
    return startDate;
  }
  const dueDate = parseOptionalDate(body.dueDate, "dueDate");
  if (isInvalid(dueDate)) {
    return dueDate;
  }
  const nextStart = startDate === undefined ? task.startDate ?? null : startDate;
  const nextDue = dueDate === undefined ? task.dueDate ?? null : dueDate;
  if (nextStart && nextDue && nextStart.getTime() > nextDue.getTime()) {
    return { status: 400, error: "startDate must be on or before dueDate" };
  }
  if (startDate !== undefined && (task.startDate?.getTime() ?? null) !== (startDate?.getTime() ?? null)) {
    task.startDate = startDate;
    notable.push("startDate");
  }
  if (dueDate !== undefined && (task.dueDate?.getTime() ?? null) !== (dueDate?.getTime() ?? null)) {
    task.dueDate = dueDate;
    // A new due date re-arms the reminders
    task.lastReminderSentOn = null;
    notable.push("dueDate");
  }

  const estimateMinutes = parseEstimate(body.estimateMinutes);
  if (isInvalid(estimateMinutes)) return estimateMinutes;
  if (estimateMinutes !== undefined && (task.estimateMinutes ?? null) !== estimateMinutes) {
    task.estimateMinutes = estimateMinutes;
    changed.push("estimateMinutes");
  }

  let actualChanges: ActualDateChange[] = [];
  if (hasActualDates(body)) {
    const applied = await applyManualActualDates(task, body);
    if (isInvalid(applied)) return applied;
    actualChanges = applied;
  }

  if (body.labels !== undefined) {
    const resolved = await resolveLabels(body.labels);
    if (isInvalid(resolved)) {
      return resolved;
    }
    task.labels = resolved;
    changed.push("labels");
  }

  if (body.category !== undefined) {
    const resolved = await resolveCategory(body.category);
    if (isInvalid(resolved)) {
      return resolved;
    }
    task.category = resolved;
    changed.push("category");
  }

  if (body.recurrence !== undefined) {
    const parsed = parseRecurrence(body.recurrence, task.startDate, task.recurrence);
    if (isInvalid(parsed)) {
      return parsed;
    }
    task.recurrence = parsed;
    changed.push("recurrence");
  }

  // Project / milestone (moving to another project assigns a new short code)
  const previousProject = task.project ?? null;
  let projectDoc: IProject | null = null;
  let projectChanged = false;
  const extendedBody = body as UpdateTaskBody & { project?: unknown; milestone?: unknown };
  if (extendedBody.project !== undefined) {
    if (extendedBody.project === null || extendedBody.project === "") {
      if (task.project && task.iteration) {
        return { status: 400, error: "Every task must belong to a project" };
      }
      if (task.project) {
        task.project = null;
        task.milestone = null;
        task.shortCode = null;
        projectChanged = true;
      }
    } else {
      const resolved = await resolveTaskProject(user, extendedBody.project);
      if (isInvalid(resolved)) {
        return resolved;
      }
      projectDoc = resolved;
      if (!task.project || !task.project.equals(resolved._id as mongoose.Types.ObjectId)) {
        if (isProjectExpired(resolved)) {
          return { status: 400, error: "That project closed at the end of its month. Tasks can't be moved into it." };
        }
        if (!isProjectApproved(resolved)) {
          return { status: 400, error: await notApprovedMessage(resolved) };
        }
        task.project = resolved._id as mongoose.Types.ObjectId;
        task.milestone = null;
        projectChanged = true;
      }
    }
    if (projectChanged) changed.push("project");
  }
  if (!projectDoc && task.project) projectDoc = await Project.findById(task.project);
  let milestoneDoc: IMilestone | null = null;
  if (extendedBody.milestone !== undefined) {
    const resolved = await resolveMilestone(extendedBody.milestone, projectDoc);
    if (isInvalid(resolved)) {
      return resolved;
    }
    milestoneDoc = resolved;
    task.milestone = resolved ? (resolved._id as mongoose.Types.ObjectId) : null;
    changed.push("milestone");
  } else if (task.milestone) {
    milestoneDoc = await Milestone.findById(task.milestone);
  }

  // Assignees — diff old vs new
  let added: IUser[] = [];
  let removedIds: string[] = [];
  const rawAssignees =
    body.assignees !== undefined ? body.assignees : body.assignedTo !== undefined ? [body.assignedTo] : undefined;
  if (rawAssignees !== undefined) {
    const assignees = await resolveAssignees(user, rawAssignees, { skipDepartmentCheck: Boolean(projectDoc) });
    if (isInvalid(assignees)) {
      return assignees;
    }
    if (projectDoc) {
      const ensured = await ensureProjectMembers(user, projectDoc, assignees);
      if (isInvalid(ensured)) {
        return ensured;
      }
    }
    const before = new Set(task.assignees.map((id) => id.toString()));
    const after = new Set(assignees.map((u) => u._id.toString()));
    added = assignees.filter((u) => !before.has(u._id.toString()));
    removedIds = [...before].filter((id) => !after.has(id));

    task.assignees = assignees.map((u) => u._id);
    // The department is recalculated from the first assignee
    task.department = assignees[0]!.department || null;
    // Subtask assignees stand alone now (they need not be task assignees), so
    // removing someone from the task keeps their subtask assignments.
  }

  // Moving into a project: current assignees must be members too
  if (projectChanged && projectDoc && rawAssignees === undefined) {
    const current = await User.find({ _id: { $in: task.assignees } });
    const ensured = await ensureProjectMembers(user, projectDoc, current);
    if (isInvalid(ensured)) {
      return ensured;
    }
  }
  if (projectChanged && projectDoc) {
    task.shortCode = await nextShortCode(projectDoc._id as mongoose.Types.ObjectId);
  }

  await task.save();
  if (notable.includes("description") || notable.includes("title") || changed.includes("titleParts")) {
    scheduleBriefCheck(task._id as mongoose.Types.ObjectId);
  }
  if (projectChanged || changed.includes("titleParts")) scheduleTaskTag(task._id as mongoose.Types.ObjectId);
  const taskId = task._id as mongoose.Types.ObjectId;
  const warnings = milestoneWarnings(task.dueDate, milestoneDoc);
  if (projectChanged) {
    scheduleProgressRecalc(previousProject);
    // Time logged on the task follows it to the new project
    await TimeLog.updateMany({ task: taskId }, { $set: { project: task.project ?? null } });
  }
  scheduleProgressRecalc(task.project ?? null);

  if (notable.length > 0 || changed.length > 0) {
    recordTaskHistory(taskId, user, "updated", { fields: [...notable, ...changed] });
  }
  if (actualChanges.length > 0) {
    recordTaskHistory(taskId, user, "actual_dates_updated", { changes: actualChanges });
    changed.push("actualDates");
  }
  if ((added.length > 0 || removedIds.length > 0) && !task.assignedAt) {
    // Routed on: the first time someone other than a traffic manager is on the task.
    const trafficManagers = new Set((await getDeliverySettings()).trafficManagers);
    if (task.assignees.some((a) => !trafficManagers.has(String(a)))) {
      await Task.updateOne({ _id: task._id, assignedAt: null }, { $set: { assignedAt: new Date() } });
    }
  }
  if (added.length > 0 || removedIds.length > 0) {
    const removedUsers = await User.find({ _id: { $in: removedIds } }).select("name").lean();
    recordTaskHistory(taskId, user, "assignees_changed", {
      added: added.map((u) => u.name),
      removed: removedUsers.map((u) => u.name),
    });
  }

  logActivity({
    action: "task_updated",
    actor: user,
    targetType: "task",
    targetId: taskId,
    targetName: task.title,
    details: {
      fields: [...notable, ...changed],
      assigneesAdded: added.length,
      assigneesRemoved: removedIds.length,
    },
    ip,
  });

  // Newly added assignees get task_assigned…
  if (added.length > 0) {
    notifyTask({
      recipients: added.map((u) => u._id),
      actor: user,
      type: "task_assigned",
      task: emailTask(task),
      title: "New task assigned",
      message: `${user.name} assigned you to the task: ${task.title}`,
      email: {
        subject: `📋 New Task Assigned: ${task.title}`,
        heading: "New Task Assigned",
        intro: `${user.name} added you to this task.`,
        quote: task.description ?? null,
      },
    });
  }

  // …everyone else hears about notable edits
  if (notable.length > 0) {
    const addedSet = new Set(added.map((u) => u._id.toString()));
    notifyTask({
      recipients: task.assignees.filter((id) => !addedSet.has(id.toString())),
      actor: user,
      type: "task_updated",
      task: emailTask(task),
      title: "Task updated",
      message: `${user.name} updated "${task.title}" (${notable.join(", ")}).`,
      email: {
        subject: `✏️ Task Updated: ${task.title}`,
        heading: "Task Updated",
        intro: `${user.name} updated this task: ${notable.join(", ")}.`,
      },
    });
  }

  // Removed assignees also get the SSE event so their lists drop the task
  pushTaskUpdate(task, "updated", { fields: [...notable, ...changed] }, removedIds);

  return { warnings };
}

/**
 * PATCH with only `actualStartAt` / `actualEndAt`: the task's managers (incl.
 * the head of its department) and its assignees. Writes `actual_dates_updated`.
 */
async function applyActualDatesUpdate(
  user: IUser,
  task: ITask,
  body: UpdateTaskBody,
  ip: string | undefined
): Promise<Invalid | { warnings: string[] }> {
  const flags = await taskProjectFlags(task, user);
  if (!canManageSubtasks(user, task, flags) && !isAssignee(user, task)) {
    return { status: 403, error: "Only the task's managers and assignees can edit its actual dates" };
  }
  const changes = await applyManualActualDates(task, body);
  if (isInvalid(changes)) return changes;
  if (changes.length === 0) return { warnings: [] };
  await task.save();
  const taskId = task._id as mongoose.Types.ObjectId;
  recordTaskHistory(taskId, user, "actual_dates_updated", { changes });
  logActivity({
    action: "task_updated",
    actor: user,
    targetType: "task",
    targetId: taskId,
    targetName: task.title,
    details: { fields: ["actualDates"] },
    ip,
  });
  pushTaskUpdate(task, "updated", { fields: ["actualDates"] });
  return { warnings: [] };
}

const ACTUAL_DATE_KEYS = new Set(["actualStartAt", "actualEndAt"]);

/** Creator or admin: edits a task's details (see `applyTaskUpdate`); actual dates alone also assignees. */
export async function updateTask(req: Request, res: Response): Promise<void> {
  const task = await getTaskOr404(req, res);
  if (!task) return;
  const user = req.user!;
  const body = (req.body ?? {}) as UpdateTaskBody;
  const keys = Object.keys(body);
  const actualOnly = keys.length > 0 && keys.every((key) => ACTUAL_DATE_KEYS.has(key));
  const result = actualOnly
    ? await applyActualDatesUpdate(user, task, body, req.ip)
    : await applyTaskUpdate(user, task, body, req.ip);
  if (isInvalid(result)) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  const detail = await loadTaskDetail(task._id as mongoose.Types.ObjectId, user);
  res.json({ ...detail, warnings: result.warnings });
}

/** Creator or admin: sends a manual reminder to the assignees (once per hour per task). */
export async function remindTask(req: Request, res: Response): Promise<void> {
  const task = await getTaskOr404(req, res);
  if (!task) return;

  const user = req.user!;
  if (!(await canManageTaskAsync(user, task))) {
    res.status(403).json({ error: "Only the task creator or an admin can send reminders" });
    return;
  }
  if (task.status === "completed") {
    res.status(400).json({ error: "Completed tasks don't need reminders" });
    return;
  }

  const now = Date.now();
  const last = task.lastManualReminderAt?.getTime() ?? 0;
  if (now - last < MANUAL_REMINDER_COOLDOWN_MS) {
    const retryAfterSeconds = Math.ceil((MANUAL_REMINDER_COOLDOWN_MS - (now - last)) / 1000);
    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.status(429).json({
      error: `A reminder was already sent recently. Try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s).`,
    });
    return;
  }

  // Claim the slot atomically so double-clicks don't send twice
  const claimed = await Task.findOneAndUpdate(
    { _id: task._id, lastManualReminderAt: task.lastManualReminderAt ?? null },
    { $set: { lastManualReminderAt: new Date(now) } }
  );
  if (!claimed) {
    res.status(429).json({ error: "A reminder was already sent recently." });
    return;
  }
  const taskId = task._id as mongoose.Types.ObjectId;

  notifyTask({
    recipients: task.assignees,
    actor: user,
    type: "task_reminder",
    task: emailTask(task),
    title: "Task reminder",
    message: `${user.name} sent a reminder about "${task.title}".`,
    email: {
      subject: `🔔 Reminder: ${task.title}`,
      heading: "Task Reminder",
      intro: `${user.name} sent you a reminder about this task.`,
    },
  });

  recordTaskHistory(taskId, user, "reminder_sent", { kind: "manual" });
  pushTaskUpdate(task, "reminded");

  res.json({ success: true, remindedAt: new Date(now).toISOString() });
}

/**
 * Creator or admin: deletes a task with its comments, files (GridFS), history,
 * notifications and pins (DELETE /:id and the bulk "delete" action).
 */
export async function applyTaskDelete(user: IUser, task: ITask, ip: string | undefined): Promise<Invalid | null> {
  if (!(await canManageTaskAsync(user, task))) {
    return { status: 403, error: "Only the task creator or an admin can delete tasks" };
  }

  const taskId = task._id as mongoose.Types.ObjectId;
  const files = await TaskFile.find({ task: taskId }).select("gridFsId");

  await Task.findByIdAndDelete(taskId);
  await Promise.all([
    // Historical time stays (on the project); draft timesheets drop the task row
    TimeLog.updateMany({ task: taskId }, { $set: { task: null } }),
    WeeklyTimesheet.updateMany(
      { "entries.task": taskId, status: { $in: ["draft", "rejected"] } },
      { $pull: { entries: { task: taskId } } }
    ),
    TaskComment.deleteMany({ task: taskId }),
    TaskNote.deleteMany({ task: taskId }),
    TaskFile.deleteMany({ task: taskId }),
    TaskHistory.deleteMany({ task: taskId }),
    User.updateMany({ pinnedTasks: taskId }, { $pull: { pinnedTasks: taskId } }),
    Notification.deleteMany({
      $or: [{ task: taskId }, { link: `/tasks?task=${taskId.toString()}` }],
    }),
    ...files.map((f) => deleteFromGridFs(f.gridFsId)),
  ]);

  logActivity({
    action: "task_deleted",
    actor: user,
    targetType: "task",
    targetId: taskId,
    targetName: task.title,
    details: { files: files.length },
    ip,
  });

  pushTaskUpdate(task, "deleted");
  scheduleProgressRecalc(task.project ?? null);
  return null;
}

/** Creator or admin: deletes a task (see `applyTaskDelete`). */
export async function deleteTask(req: Request, res: Response): Promise<void> {
  const task = await getTaskOr404(req, res);
  if (!task) return;
  const result = await applyTaskDelete(req.user!, task, req.ip);
  if (result) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ success: true });
}

/** Anyone who can view the task: history timeline, newest first. */
export async function listHistory(req: Request, res: Response): Promise<void> {
  const task = await getViewableTaskOr404(req, res);
  if (!task) return;

  const { limit, offset } = parsePagination(req);
  const filter = { task: task._id };

  let query = TaskHistory.find(filter).populate("actor", "name email").sort({ createdAt: -1 });
  if (limit !== null) {
    query = query.skip(offset).limit(limit);
  }

  const [history, total] = await Promise.all([query, TaskHistory.countDocuments(filter)]);
  res.json({ history: history.map((h) => h.toJSON()), total, limit, offset });
}

/**
 * Head/admin: users the caller may assign tasks to (admin: everyone; head: their
 * department). Supports ?search= and pagination.
 */
export async function assignableUsers(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const { limit, offset } = parsePagination(req);
  const search = searchRegex(req.query.search);

  // Everyone can pick from the whole company (project tasks add the assignee to the project).
  void user;
  const filter: Record<string, unknown> = {};
  if (search) {
    filter.$or = [{ name: search }, { email: search }];
  }

  let query = User.find(filter).select("name email role department").populate("department", "name").sort({ name: 1 });
  if (limit !== null) {
    query = query.skip(offset).limit(limit);
  }

  const [users, total] = await Promise.all([query, User.countDocuments(filter)]);
  res.json({ users: users.map((u) => u.toJSON()), total, limit, offset });
}

/** Anyone who can view the task: users who can be @mentioned (everyone who can view it). */
export async function mentionableUsers(req: Request, res: Response): Promise<void> {
  const task = await getViewableTaskOr404(req, res);
  if (!task) return;

  const or: Record<string, unknown>[] = [
    {
      _id: {
        $in: [
          ...task.assignees,
          task.assignedBy,
          // Subtask assignees can view the task too.
          ...task.subtasks.flatMap((sub) => (sub.assignee ? [sub.assignee] : [])),
        ],
      },
    },
    { role: "admin" },
  ];
  const departments = await taskDepartmentIds(task);
  if (departments.length > 0) or.push({ role: "head", department: { $in: departments } });

  const users = await User.find({ $or: or }).select("name email role").sort({ name: 1 });
  res.json({ users: users.map((u) => u.toJSON()), total: users.length, limit: null, offset: 0 });
}

// ---------------------------------------------------------------------------
// Tables: approvals, calendar, export, bulk, duplicate, pins
// ---------------------------------------------------------------------------

/** GET /api/tasks/approvals/count — `{ count, isReviewer }` for the "Waiting approval" badge. */
export async function approvalsCount(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const and: Record<string, unknown>[] = [await approvalsFilter(user)];
  const archived = await archivedProjectIds();
  if (archived.length > 0) and.push({ project: { $nin: archived } });
  const [count, reviewer] = await Promise.all([Task.countDocuments({ $and: and }), isReviewer(user)]);
  res.json({ count, isReviewer: reviewer });
}

const CALENDAR_LIMIT = 500;
const CALENDAR_MAX_DAYS = 100;

/**
 * GET /api/tasks/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD (+ every list filter).
 * Tasks with a due date whose start→due span overlaps the range (just the due
 * date when there's no start date). Lean rows, capped at 500.
 */
export async function calendarTasks(req: Request, res: Response): Promise<void> {
  const from = queryDate(req.query.from, "from");
  const to = queryDate(req.query.to, "to");
  if (isInvalid(from) || isInvalid(to) || !from || !to) {
    res.status(400).json({ error: "from and to are required (YYYY-MM-DD)" });
    return;
  }
  if (from.getTime() > to.getTime()) {
    res.status(400).json({ error: "from must be on or before to" });
    return;
  }
  if (to.getTime() - from.getTime() > CALENDAR_MAX_DAYS * 86_400_000) {
    res.status(400).json({ error: `The calendar range can be at most ${CALENDAR_MAX_DAYS} days` });
    return;
  }

  const and = await buildListFilter(req, undefined, { calendar: true });
  if (isInvalid(and)) {
    res.status(and.status).json({ error: and.error });
    return;
  }
  const statusError = applyStatusFilter(req, and);
  if (statusError) {
    res.status(statusError.status).json({ error: statusError.error });
    return;
  }
  and.push(
    { dueDate: { $ne: null, $gte: from } },
    { $or: [{ dueDate: { $lte: to } }, { startDate: { $ne: null, $lte: to } }] }
  );
  const filter = { $and: and };

  const [rows, total] = await Promise.all([
    Task.find(filter)
      .select("title shortCode number status priority startDate dueDate completedAt project assignees")
      .populate([
        { path: "project", select: "name code" },
        { path: "assignees", select: "name" },
      ])
      .sort({ dueDate: 1, _id: 1 })
      .limit(CALENDAR_LIMIT)
      .lean(),
    Task.countDocuments(filter),
  ]);
  res.json({
    tasks: rows.map((t) => ({
      _id: t._id,
      title: t.title,
      shortCode: t.shortCode ?? null,
      number: t.number ?? null,
      status: t.status,
      priority: t.priority,
      startDate: t.startDate ?? null,
      dueDate: t.dueDate ?? null,
      completedAt: t.completedAt ?? null,
      project: t.project ?? null,
      assignees: t.assignees,
    })),
    total,
    limit: CALENDAR_LIMIT,
    truncated: total > rows.length,
  });
}

/** "PEAR-12" or "#12" (or "" for un-migrated tasks). */
function taskCode(task: Pick<ITask, "shortCode" | "number">): string {
  return task.shortCode || (task.number ? `#${task.number}` : "");
}

type ExportRow = Omit<ITask, "project" | "assignees" | "labels" | "category" | "milestone" | "assignedBy"> & {
  project?: { name?: string } | null;
  assignees: Array<{ name?: string }>;
  labels: Array<{ name?: string }>;
  category?: { name?: string } | null;
  milestone?: { title?: string } | null;
  assignedBy?: { name?: string } | null;
};

/**
 * GET /api/tasks/export — CSV of the current list filters + sort, or of
 * `?ids=a,b,c` (still limited to tasks the caller can open). UTF-8 BOM, capped
 * at 5000 rows (`X-Export-Truncated: true` when capped).
 */
export async function exportTasks(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const sort = parseTaskSort(req);
  if (isInvalid(sort)) {
    res.status(sort.status).json({ error: sort.error });
    return;
  }

  let and: Record<string, unknown>[];
  const ids = parseIdList(req.query.ids);
  if (ids) {
    if (ids.length === 0 || ids.some((id) => isInvalidObjectId(id))) {
      res.status(400).json({ error: "ids must be a comma-separated list of task IDs" });
      return;
    }
    if (ids.length > EXPORT_ROW_LIMIT) {
      res.status(400).json({ error: `At most ${EXPORT_ROW_LIMIT} ids can be exported` });
      return;
    }
    and = [await extendedVisibilityFilter(user), { _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } }];
  } else {
    const built = await buildListFilter(req);
    if (isInvalid(built)) {
      res.status(built.status).json({ error: built.error });
      return;
    }
    const statusError = applyStatusFilter(req, built);
    if (statusError) {
      res.status(statusError.status).json({ error: statusError.error });
      return;
    }
    and = built;
  }

  const filter = { $and: and };
  const [pageIds, total] = await Promise.all([
    sortedTaskIds(filter, sort, EXPORT_ROW_LIMIT, 0),
    Task.countDocuments(filter),
  ]);
  const docs = await Task.find({ _id: { $in: pageIds } })
    .populate([
      { path: "project", select: "name code" },
      { path: "assignees", select: "name" },
      { path: "labels", select: "name" },
      { path: "category", select: "name" },
      { path: "milestone", select: "title" },
      { path: "assignedBy", select: "name" },
    ])
    .lean<ExportRow[]>();
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  const logged = await loggedMinutesByTask(pageIds);

  const headers = [
    "Code",
    "Task",
    "Project",
    "Milestone",
    "Status",
    "Priority",
    "Assigned to",
    "Labels",
    "Category",
    "Start date",
    "Due date",
    "Completed on",
    "Actual start",
    "Actual end",
    "Start variance (days)",
    "Finish variance (days)",
    "Estimated hours",
    "Hours logged",
    "Created by",
    "Created on",
  ];
  const rows = pageIds.flatMap((id) => {
    const t = byId.get(id.toString());
    if (!t) return [];
    return [
      [
        taskCode(t),
        t.title,
        t.project?.name ?? "",
        t.milestone?.title ?? "",
        STATUS_LABELS[t.status],
        t.priority,
        t.assignees.map((a) => a.name ?? "").filter(Boolean).join("; "),
        t.labels.map((l) => l.name ?? "").filter(Boolean).join("; "),
        t.category?.name ?? "",
        csvDate(t.startDate),
        csvDate(t.dueDate),
        t.completedAt ? appDateKey(t.completedAt) : "",
        csvDateTime(t.actualStartAt),
        csvDateTime(t.actualEndAt),
        varianceDays(t.actualStartAt, t.startDate) ?? "",
        varianceDays(t.actualEndAt, t.dueDate) ?? "",
        csvHours(t.estimateMinutes ?? null),
        csvHours(logged.get(id.toString()) ?? 0),
        t.assignedBy?.name ?? "",
        appDateKey(t.createdAt),
      ],
    ];
  });

  sendCsv(res, "tasks", toCsv(headers, rows), { rows: rows.length, total });
}

const BULK_LIMIT = 200;
const BULK_ACTIONS = ["status", "assign", "delete"] as const;
type BulkAction = (typeof BULK_ACTIONS)[number];

/**
 * POST /api/tasks/bulk — `{ ids (≤200), action: "status" | "assign" | "delete",
 * status?, assignees? }`. Every task goes through the exact single-item code
 * path (permission, transition rules, history, notifications, SSE); failures are
 * skipped with the reason the single endpoint would have returned.
 */
export async function bulkTasks(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const body = (req.body ?? {}) as { ids?: unknown; action?: unknown; status?: unknown; assignees?: unknown };

  if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.some((id) => typeof id !== "string" || isInvalidObjectId(id))) {
    res.status(400).json({ error: "ids must be a non-empty array of task IDs" });
    return;
  }
  const ids = [...new Set(body.ids as string[])];
  if (ids.length > BULK_LIMIT) {
    res.status(400).json({ error: `At most ${BULK_LIMIT} tasks can be updated at once` });
    return;
  }
  if (typeof body.action !== "string" || !BULK_ACTIONS.includes(body.action as BulkAction)) {
    res.status(400).json({ error: `action must be one of: ${BULK_ACTIONS.join(", ")}` });
    return;
  }
  const action = body.action as BulkAction;
  if (action === "status" && (typeof body.status !== "string" || !TASK_STATUSES.includes(body.status as TaskStatus))) {
    res.status(400).json({ error: STATUS_ERROR });
    return;
  }
  if (action === "assign") {
    if (user.role === "employee") {
      res.status(403).json({ error: "Only heads and admins can reassign tasks in bulk" });
      return;
    }
    if (!Array.isArray(body.assignees) || body.assignees.length === 0) {
      res.status(400).json({ error: "assignees must be a non-empty array of user IDs" });
      return;
    }
  }

  const tasks = await Task.find({ _id: { $in: ids } });
  const byId = new Map(tasks.map((t) => [t._id.toString(), t]));
  const archivedIds = new Set(
    (
      await Project.find({ _id: { $in: tasks.flatMap((t) => (t.project ? [t.project] : [])) }, archivedAt: { $ne: null } })
        .select("_id")
        .lean()
    ).map((p) => p._id.toString())
  );

  const updatedIds: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  // Sequential on purpose: same ordering/side effects as N single requests.
  for (const id of ids) {
    const task = byId.get(id);
    if (!task) {
      skipped.push({ id, reason: "Task not found" });
      continue;
    }
    if (task.project && archivedIds.has(task.project.toString())) {
      skipped.push({ id, reason: "This task belongs to an archived project and is read-only" });
      continue;
    }
    try {
      let result: Invalid | null = null;
      if (action === "status") {
        if (task.status === body.status) {
          skipped.push({ id, reason: `Already ${STATUS_LABELS[task.status]}` });
          continue;
        }
        const applied = await applyStatusChange(user, task, body.status as TaskStatus, undefined, req.ip);
        if (isInvalid(applied)) result = applied;
      } else if (action === "assign") {
        const applied = await applyTaskUpdate(user, task, { assignees: body.assignees }, req.ip);
        if (isInvalid(applied)) result = applied;
      } else {
        result = await applyTaskDelete(user, task, req.ip);
      }
      if (result) skipped.push({ id, reason: result.error });
      else updatedIds.push(id);
    } catch (err) {
      console.error("[tasks] bulk item failed", id, err);
      skipped.push({ id, reason: "Unexpected error" });
    }
  }

  // Each item already wrote its own activity/history rows via the shared path.
  res.json({ updated: updatedIds.length, updatedIds, skipped });
}

/**
 * POST /api/tasks/:id/duplicate — copies title (+ " (copy)"), description,
 * assignees, labels, category, priority, project, milestone, dates, estimate and
 * subtasks (not done). Not copied: comments, files, notes, history, recurrence.
 * Goes through `createTaskCore` (new number/short code, `task_assigned`).
 */
export async function duplicateTask(req: Request, res: Response): Promise<void> {
  const source = await getViewableTaskOr404(req, res);
  if (!source) return;
  const actor = req.user!;

  // Drop references that no longer exist so the copy doesn't fail on them.
  const [users, labels, category, milestone] = await Promise.all([
    User.find({ _id: { $in: source.assignees } }).select("_id").lean(),
    TaskLabel.find({ _id: { $in: source.labels } }).select("_id").lean(),
    source.category ? TaskCategory.exists({ _id: source.category }) : null,
    source.milestone && source.project ? Milestone.exists({ _id: source.milestone, project: source.project }) : null,
  ]);
  const assigneeIds = new Set(users.map((u) => u._id.toString()));
  const dateKey = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
  const suffix = " (copy)";
  const title = `${source.title.slice(0, 200 - suffix.length)}${suffix}`;

  const body: CreateTaskBody = {
    project: source.project ? source.project.toString() : undefined,
    milestone: milestone ? source.milestone!.toString() : undefined,
    title,
    description: source.description ?? undefined,
    assignees: users.map((u) => u._id.toString()),
    labels: labels.map((l) => l._id.toString()),
    category: category ? source.category!.toString() : undefined,
    priority: source.priority,
    startDate: dateKey(source.startDate),
    dueDate: dateKey(source.dueDate),
    estimateMinutes: source.estimateMinutes ?? null,
    subtasks: source.subtasks.map((s) => ({
      title: s.title,
      description: s.description ?? "",
      assignee: s.assignee && assigneeIds.has(s.assignee.toString()) ? s.assignee.toString() : null,
      dueDate: dateKey(s.dueDate),
    })),
  };

  const result = await createTaskCore(actor, body, req.ip, { duplicatedFrom: source._id.toString() });
  if (isInvalid(result)) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  const detail = await loadTaskDetail(result.taskId, actor);
  res.status(201).json({ ...detail, warnings: result.warnings });
}

/** Loads `:id` for pinning: view access only (pins work on archived projects' tasks too). */
async function getPinnableTask(req: Request, res: Response): Promise<ITask | undefined> {
  const id = req.params.id;
  if (typeof id !== "string" || isInvalidObjectId(id)) {
    res.status(404).json({ error: "Task not found" });
    return undefined;
  }
  const task = await Task.findById(id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return undefined;
  }
  if (!(await canViewTaskAsync(req.user!, task))) {
    res.status(403).json({ error: "You don't have access to this task" });
    return undefined;
  }
  return task;
}

const MAX_PINNED_TASKS = 500;

/** PUT /api/tasks/:id/pin. */
export async function pinTask(req: Request, res: Response): Promise<void> {
  const task = await getPinnableTask(req, res);
  if (!task) return;
  const user = req.user!;
  const already = (user.pinnedTasks ?? []).some((id) => id.equals(task._id as mongoose.Types.ObjectId));
  if (!already && (user.pinnedTasks ?? []).length >= MAX_PINNED_TASKS) {
    res.status(400).json({ error: `You can pin at most ${MAX_PINNED_TASKS} tasks` });
    return;
  }
  await User.updateOne({ _id: user._id }, { $addToSet: { pinnedTasks: task._id } });
  res.json({ pinned: true });
}

/** DELETE /api/tasks/:id/pin (works even if the task is gone or no longer visible). */
export async function unpinTask(req: Request, res: Response): Promise<void> {
  const id = req.params.id;
  if (typeof id !== "string" || isInvalidObjectId(id)) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  await User.updateOne({ _id: req.user!._id }, { $pull: { pinnedTasks: new mongoose.Types.ObjectId(id) } });
  res.json({ pinned: false });
}
