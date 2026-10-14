import type { Request, Response } from "express";
import mongoose from "mongoose";
import { isProjectApproved } from "./projectApproval.js";
import { isProjectExpired, projectClosesOn } from "./projectExpiry.js";
import { cached } from "./refCache.js";
import { Project } from "../models/Project.js";
import type { IProject } from "../models/Project.js";
import { ProjectActivity } from "../models/ProjectActivity.js";
import type { ProjectActivityAction } from "../models/ProjectActivity.js";
import { completedStatusIds, ProjectStatus } from "../models/ProjectStatus.js";
import { Task, TASK_STATUSES } from "../models/Task.js";
import { TimeLog } from "../models/TimeLog.js";
import type { IUser } from "../models/User.js";
import { User } from "../models/User.js";
import { createEvent, pushToUsers } from "./sse.js";
import { appToday } from "./taskJobs.js";

export function isInvalidObjectId(id: string): boolean {
  return !mongoose.isValidObjectId(id);
}

/** Express 5 types params as `string | string[] | undefined`; normalize to a single value. */
export function param(req: Request, name: string): string | undefined {
  const value = req.params[name];
  return typeof value === "string" ? value : undefined;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AccessUser = Pick<IUser, "_id" | "role" | "department">;

type AccessProject = Pick<
  IProject,
  "manager" | "members" | "createdBy" | "departments" | "isPublic" | "archivedAt"
>;

export interface Invalid {
  status: number;
  error: string;
}

export function isInvalid(value: unknown): value is Invalid {
  return typeof value === "object" && value !== null && "error" in value && "status" in value;
}

function sameId(a: mongoose.Types.ObjectId | null | undefined, b: mongoose.Types.ObjectId | null | undefined): boolean {
  return Boolean(a && b && a.equals(b));
}

// ---------------------------------------------------------------------------
// Role predicates
// ---------------------------------------------------------------------------

export function isProjectManager(user: AccessUser, project: AccessProject): boolean {
  return sameId(project.manager ?? null, user._id);
}

export function isProjectMember(user: AccessUser | mongoose.Types.ObjectId, project: Pick<IProject, "members">): boolean {
  const id = user instanceof mongoose.Types.ObjectId ? user : user._id;
  return project.members.some((m) => m.user.equals(id));
}

/** A head whose department is one of the project's departments. */
export function isDepartmentHeadOf(user: AccessUser, project: AccessProject): boolean {
  if (user.role !== "head" || !user.department) return false;
  return project.departments.some((d) => d.equals(user.department!));
}

/** admin: all; head: their department(s) + member/manager/creator; others: member/manager or public. */
export function canViewProject(user: AccessUser, project: AccessProject): boolean {
  if (user.role === "admin") return true;
  if (isProjectManager(user, project) || isProjectMember(user, project)) return true;
  if (sameId(project.createdBy, user._id)) return true;
  if (isDepartmentHeadOf(user, project)) return true;
  return project.isPublic;
}

/** Edit, status, members, milestones, archive: admin, the manager, or whoever created it. */
export function canManageProject(user: AccessUser, project: AccessProject): boolean {
  if (user.role === "admin") return true;
  if (isProjectManager(user, project)) return true;
  return sameId(project.createdBy, user._id);
}

/** Anyone signed in may create a project (it still needs approval before tasks). */
export function canCreateProject(_user: AccessUser): boolean {
  return true;
}

/** Create tasks in the project: admin, managers, members, and heads who can view it. */
export function canCreateProjectTasks(user: AccessUser, project: AccessProject): boolean {
  if (canManageProject(user, project) || isProjectMember(user, project)) return true;
  return user.role === "head" && canViewProject(user, project);
}

/** Upload files / add notes: managers, members and heads who can view it. */
export function canContribute(user: AccessUser, project: AccessProject): boolean {
  if (canManageProject(user, project) || isProjectMember(user, project)) return true;
  return user.role === "head" && canViewProject(user, project);
}

/** Hourly rates, earnings, budget: admin, manager, creator, head of a project department. */
export function canViewRates(user: AccessUser, project: AccessProject): boolean {
  if (canManageProject(user, project)) return true;
  return isDepartmentHeadOf(user, project);
}

/** Approve/reject time logged on this project: admin, manager, head of a project department. */
export function canApproveProjectTime(user: AccessUser, project: AccessProject): boolean {
  return user.role === "admin" || isProjectManager(user, project) || isDepartmentHeadOf(user, project);
}

/** Mongo filter for every project `user` may view (mirrors `canViewProject`). */
export function projectVisibilityFilter(user: AccessUser): Record<string, unknown> {
  if (user.role === "admin") return {};
  const or: Record<string, unknown>[] = [
    { "members.user": user._id },
    { manager: user._id },
    { createdBy: user._id },
    { isPublic: true },
  ];
  if (user.role === "head" && user.department) or.push({ departments: user.department });
  return { $or: or };
}

/** What the current user may do with a project; drives the project UI. */
export function projectPermissions(
  user: AccessUser & { pinnedProjects?: mongoose.Types.ObjectId[] },
  project: AccessProject & { _id: unknown },
  options: { statusCompleted?: boolean } = {}
) {
  const manage = canManageProject(user, project);
  const archived = Boolean(project.archivedAt);
  const member = isProjectMember(user, project);
  const view = canViewProject(user, project);
  const loggable = !archived && !options.statusCompleted;
  return {
    canEdit: manage && !archived,
    canChangeStatus: manage && !archived,
    canManageMembers: manage && !archived,
    canManageMilestones: manage && !archived,
    canArchive: manage && !archived,
    canRestore: manage && archived,
    canDelete: user.role === "admin" && archived,
    // Copying needs create rights and management of the source (heads: their own projects).
    canDuplicate: canCreateProject(user) && manage,
    canCreateTasks:
      canCreateProjectTasks(user, project) &&
      !archived &&
      isProjectApproved(project as { approval?: { status?: string } | null }),
    canUploadFiles: canContribute(user, project) && !archived,
    canAddNotes: canContribute(user, project) && !archived,
    canViewRates: canViewRates(user, project),
    canLogTime:
      loggable &&
      (user.role === "admin" || manage || member || (user.role === "head" && view)),
    canApproveTime: canApproveProjectTime(user, project),
    isManager: isProjectManager(user, project),
    isMember: member,
  };
}

export type ProjectPermissions = ReturnType<typeof projectPermissions>;

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

/** Loads `:id` (or another param) as a project or responds 404. */
export async function getProjectOr404(req: Request, res: Response, name = "id"): Promise<IProject | undefined> {
  const id = param(req, name);
  if (!id || isInvalidObjectId(id)) {
    res.status(404).json({ error: "Project not found" });
    return undefined;
  }
  const project = await Project.findById(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return undefined;
  }
  return project;
}

/** Loads `:id` and enforces view access (404 / 403). */
export async function getViewableProjectOr404(req: Request, res: Response): Promise<IProject | undefined> {
  const project = await getProjectOr404(req, res);
  if (!project) return undefined;
  if (!canViewProject(req.user!, project)) {
    res.status(403).json({ error: "You don't have access to this project" });
    return undefined;
  }
  return project;
}

/** Archived projects are read-only: responds 409 and returns false. */
export function ensureNotArchived(project: Pick<IProject, "archivedAt">, res: Response): boolean {
  if (project.archivedAt) {
    res.status(409).json({ error: "This project is archived and read-only. Restore it first." });
    return false;
  }
  return true;
}

export function projectLink(id: mongoose.Types.ObjectId | string, tab?: string): string {
  return `/projects/${id.toString()}${tab ? `?tab=${tab}` : ""}`;
}

/** True when the project's status is flagged `isCompleted`. */
export async function isProjectStatusCompleted(project: Pick<IProject, "status">): Promise<boolean> {
  if (!project.status) return false;
  return (await completedStatusIds()).some((id) => id.equals(project.status));
}

// ---------------------------------------------------------------------------
// Side effects: activity rows + SSE fan-out
// ---------------------------------------------------------------------------

/** Writes a ProjectActivity row (fire-and-forget). */
export function recordProjectActivity(
  projectId: mongoose.Types.ObjectId,
  actor: IUser | null | undefined,
  action: ProjectActivityAction,
  details?: unknown
): void {
  void ProjectActivity.create({ project: projectId, actor: actor ? actor._id : null, action, details }).catch(
    () => undefined
  );
}

/** Manager, members, creator, admins and heads of the project's departments. */
export async function projectAudience(project: AccessProject): Promise<string[]> {
  const ids = new Set<string>([
    ...project.members.map((m) => m.user.toString()),
    project.createdBy.toString(),
  ]);
  if (project.manager) ids.add(project.manager.toString());
  const or: Record<string, unknown>[] = [{ role: "admin" }];
  if (project.departments.length > 0) or.push({ role: "head", department: { $in: project.departments } });
  const watchers = await User.find({ $or: or }).select("_id").lean();
  for (const w of watchers) ids.add(w._id.toString());
  return [...ids];
}

/** Pushes `project-updated` to the project's audience (fire-and-forget). */
export function pushProjectUpdate(
  project: AccessProject & { _id: unknown; name: string },
  action: string,
  extra: Record<string, unknown> = {},
  alsoNotify: Array<mongoose.Types.ObjectId | string> = []
): void {
  void projectAudience(project)
    .then((ids) => {
      pushToUsers(
        [...ids, ...alsoNotify.map((id) => id.toString())],
        createEvent("project-updated", {
          projectId: String(project._id),
          action,
          name: project.name,
          ...extra,
        })
      );
    })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export const PROJECT_POPULATE = [
  { path: "status", select: "name color isDefault isCompleted order" },
  { path: "category", select: "name" },
  { path: "brand", select: "name shortName color active" },
  { path: "campaign", select: "name startMonth endMonth status" },
  { path: "departments", select: "name" },
  { path: "manager", select: "name email" },
  { path: "members.user", select: "name email role department" },
  { path: "team.users", select: "name email" },
  { path: "createdBy", select: "name email" },
];

export type TaskCounts = Record<(typeof TASK_STATUSES)[number], number> & { total: number; open: number };

function emptyTaskCounts(): TaskCounts {
  const counts = { total: 0, open: 0 } as TaskCounts;
  for (const s of TASK_STATUSES) counts[s] = 0;
  return counts;
}

/** Task counts per status for each project. */
export async function taskCountsByProject(ids: mongoose.Types.ObjectId[]): Promise<Map<string, TaskCounts>> {
  const map = new Map<string, TaskCounts>();
  if (ids.length === 0) return map;
  const rows = await Task.aggregate<{ _id: { project: mongoose.Types.ObjectId; status: string }; count: number }>([
    { $match: { project: { $in: ids } } },
    { $group: { _id: { project: "$project", status: "$status" }, count: { $sum: 1 } } },
  ]);
  for (const row of rows) {
    const key = row._id.project.toString();
    const counts = map.get(key) ?? emptyTaskCounts();
    (counts as Record<string, number>)[row._id.status] = row.count;
    counts.total += row.count;
    if (row._id.status !== "completed") counts.open += row.count;
    map.set(key, counts);
  }
  return map;
}

export interface LoggedTotals {
  minutes: number;
  approvedMinutes: number;
  pendingMinutes: number;
  earnings: number;
}

/** Minutes/earnings of finished approved + pending logs per project. */
export async function loggedTotalsByProject(ids: mongoose.Types.ObjectId[]): Promise<Map<string, LoggedTotals>> {
  const map = new Map<string, LoggedTotals>();
  if (ids.length === 0) return map;
  const rows = await TimeLog.aggregate<{ _id: { project: mongoose.Types.ObjectId; status: string }; minutes: number; earnings: number }>([
    { $match: { project: { $in: ids }, endTime: { $ne: null }, status: { $in: ["pending", "approved"] } } },
    {
      $group: {
        _id: { project: "$project", status: "$status" },
        minutes: { $sum: "$durationMinutes" },
        earnings: { $sum: "$earnings" },
      },
    },
  ]);
  for (const row of rows) {
    const key = row._id.project.toString();
    const totals = map.get(key) ?? { minutes: 0, approvedMinutes: 0, pendingMinutes: 0, earnings: 0 };
    totals.minutes += row.minutes;
    totals.earnings = Math.round((totals.earnings + row.earnings) * 100) / 100;
    if (row._id.status === "approved") totals.approvedMinutes += row.minutes;
    else totals.pendingMinutes += row.minutes;
    map.set(key, totals);
  }
  return map;
}

/**
 * Populated project JSON for `user`: strips other members' hourly rates and the
 * budget unless the user may view rates; adds pinned / overdue / task counts /
 * logged minutes.
 */
export async function serializeProjects(
  projects: IProject[],
  user: AccessUser & { pinnedProjects?: mongoose.Types.ObjectId[] }
): Promise<Record<string, unknown>[]> {
  const ids = projects.map((p) => p._id as mongoose.Types.ObjectId);
  const [counts, logged] = await Promise.all([taskCountsByProject(ids), loggedTotalsByProject(ids)]);
  const pinned = new Set((user.pinnedProjects ?? []).map((id) => id.toString()));
  const today = appToday().getTime();

  return projects.map((p) => {
    const json = p.toJSON() as Record<string, unknown>;
    const raw = p.toObject({ depopulate: true }) as unknown as IProject;
    const ratesVisible = canViewRates(user, raw);
    const members = (json.members as Array<Record<string, unknown>>) ?? [];
    json.members = members.map((m) => {
      const memberUser = m.user as { _id?: unknown } | null;
      const memberId = memberUser && typeof memberUser === "object" && "_id" in memberUser ? String(memberUser._id) : String(m.user);
      if (ratesVisible || memberId === user._id.toString()) return m;
      const { hourlyRate: _rate, ...rest } = m;
      return rest;
    });
    if (!ratesVisible) delete json.budget;
    const status = json.status as { isCompleted?: boolean } | null;
    const deadline = p.deadline ? p.deadline.getTime() : null;
    const id = String(p._id);
    const totals = logged.get(id);
    json.pinned = pinned.has(id);
    json.isOverdue = Boolean(deadline !== null && deadline < today && !status?.isCompleted && !p.archivedAt);
    json.taskCounts = counts.get(id) ?? emptyTaskCounts();
    json.loggedMinutes = totals?.minutes ?? 0;
    json.closesOn = projectClosesOn(p);
    json.expired = isProjectExpired(p);
    return json;
  });
}

// ---------------------------------------------------------------------------
// Time-log approval helpers (department head of the employee, project manager, admin)
// ---------------------------------------------------------------------------

/** Heads of a department (empty when none). */
export async function departmentHeads(departmentId: mongoose.Types.ObjectId | null | undefined): Promise<mongoose.Types.ObjectId[]> {
  if (!departmentId) return [];
  const ids = await cached(`user:dept-heads:${String(departmentId)}`, 15_000, async () => {
    const heads = await User.find({ role: "head", department: departmentId }).select("_id").lean();
    return heads.map((h) => h._id);
  });
  return [...ids];
}

export async function adminIds(): Promise<mongoose.Types.ObjectId[]> {
  const ids = await cached("user:admins", 15_000, async () => {
    const admins = await User.find({ role: "admin" }).select("_id").lean();
    return admins.map((a) => a._id);
  });
  return [...ids];
}

/** Head of the employee's department (not themselves). */
export function isHeadOfUser(actor: AccessUser, employee: Pick<IUser, "_id" | "department">): boolean {
  return (
    actor.role === "head" &&
    Boolean(actor.department && employee.department && actor.department.equals(employee.department)) &&
    !actor._id.equals(employee._id)
  );
}

/**
 * Review (approve/reject) time logged by `employee` (optionally on `project`):
 * admin, head of the employee's department, or the project's manager. Nobody
 * but an admin reviews their own time.
 */
export function canReviewTime(
  actor: AccessUser,
  employee: Pick<IUser, "_id" | "department">,
  project?: Pick<IProject, "manager"> | null
): boolean {
  if (actor.role === "admin") return true;
  if (actor._id.equals(employee._id)) return false;
  if (isHeadOfUser(actor, employee)) return true;
  return Boolean(project?.manager && project.manager.equals(actor._id));
}

/** Projects managed by `user` (ids). */
export async function managedProjectIds(user: AccessUser): Promise<mongoose.Types.ObjectId[]> {
  const rows = await Project.find({ manager: user._id }).select("_id").lean();
  return rows.map((r) => r._id);
}

/** Users in the head's department (ids). */
export async function departmentUserIds(departmentId: mongoose.Types.ObjectId | null | undefined): Promise<mongoose.Types.ObjectId[]> {
  if (!departmentId) return [];
  // Cached 15 s per department; dropped on any user write (lib/refCache.ts).
  const ids = await cached(`user:dept-members:${String(departmentId)}`, 15_000, async () => {
    const rows = await User.find({ department: departmentId }).select("_id").lean();
    return rows.map((r) => r._id);
  });
  return [...ids];
}

/**
 * Mongo filter for every time log `user` may see (and see earnings for):
 * admin: all; head: own + their department's employees + managed projects;
 * others: own + logs on projects they manage.
 */
export async function timeLogVisibilityFilter(user: AccessUser): Promise<Record<string, unknown>> {
  if (user.role === "admin") return {};
  const managed = await managedProjectIds(user);
  const or: Record<string, unknown>[] = [{ user: user._id }];
  if (managed.length > 0) or.push({ project: { $in: managed } });
  if (user.role === "head" && user.department) {
    const members = await departmentUserIds(user.department);
    or.push({ user: { $in: members } });
  }
  return { $or: or };
}
