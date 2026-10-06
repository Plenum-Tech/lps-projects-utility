import type { Request, Response } from "express";
import mongoose from "mongoose";
import { logActivity } from "../lib/activityLog.js";
import { addDays, appDayStart } from "../lib/appTime.js";
import { isDuplicateKeyError } from "../lib/errors.js";
import { notifyUsers } from "../lib/notifications.js";
import { parsePagination } from "../lib/pagination.js";
import {
  canManageProject,
  canReviewTime,
  canViewProject,
  isHeadOfUser,
  isInvalidObjectId,
  isProjectManager,
  isProjectMember,
  isProjectStatusCompleted,
  managedProjectIds,
  departmentUserIds,
  param,
  timeLogVisibilityFilter,
} from "../lib/projectAccess.js";
import { scheduleProgressRecalc } from "../lib/projectProgress.js";
import { canViewTaskAsync, isAssignee, parseDateOnly } from "../lib/taskAccess.js";
import {
  computeDurations,
  computeEarnings,
  findOverlap,
  findRunningTimer,
  formatMinutes,
  initialStatus,
  notifyTimeLogPending,
  pushTimeLogUpdate,
  pushTimerUpdate,
  remainingProjectMinutes,
  resolveHourlyRate,
  stopTimer,
  TIMELOG_POPULATE,
  TIMELOGS_LINK,
} from "../lib/timeLogs.js";
import { Project } from "../models/Project.js";
import type { IProject } from "../models/Project.js";
import { getProjectSettings } from "../models/ProjectSettings.js";
import { Task } from "../models/Task.js";
import type { ITask } from "../models/Task.js";
import { TimeLog, TIMELOG_STATUSES } from "../models/TimeLog.js";
import type { ITimeLog, TimeLogStatus } from "../models/TimeLog.js";
import type { IUser } from "../models/User.js";
import { User } from "../models/User.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Invalid {
  status: number;
  error: string;
  extra?: Record<string, unknown>;
}

function isInvalid(value: unknown): value is Invalid {
  return typeof value === "object" && value !== null && "error" in value && "status" in value;
}

function send(res: Response, invalid: Invalid): void {
  res.status(invalid.status).json({ error: invalid.error, ...(invalid.extra ?? {}) });
}

const MAX_ENTRY_MINUTES = 24 * 60;
/** Clock skew tolerance for "not in the future". */
const FUTURE_GRACE_MS = 60_000;

/** Populate list (project includes the manager for row permissions). */
const LOG_POPULATE = TIMELOG_POPULATE.map((p) => (p.path === "project" ? { path: "project", select: "name code manager" } : p));

type PopulatedLog = ITimeLog & {
  user: IUser | mongoose.Types.ObjectId;
  project: (IProject & { manager?: mongoose.Types.ObjectId | null }) | mongoose.Types.ObjectId | null;
};

function idOf(value: unknown): mongoose.Types.ObjectId | null {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  const id = (value as { _id?: unknown })._id;
  return id instanceof mongoose.Types.ObjectId ? id : null;
}

/** What the caller may do with one (populated) log. */
function rowPermissions(actor: IUser, log: PopulatedLog) {
  const ownerId = idOf(log.user)!;
  const owner = {
    _id: ownerId,
    department: (log.user as IUser).department ?? null,
  } as Pick<IUser, "_id" | "department">;
  const project =
    log.project && !(log.project instanceof mongoose.Types.ObjectId) ? (log.project as unknown as IProject) : null;
  const own = ownerId.equals(actor._id);
  const approver =
    actor.role === "admin" ||
    isHeadOfUser(actor, owner) ||
    Boolean(project?.manager && project.manager.equals(actor._id));
  const fromTimesheet = Boolean(log.weeklyTimesheet);
  const editable = !fromTimesheet && (approver || (own && log.status === "pending"));
  return {
    canEdit: editable,
    canDelete: editable,
    canApprove:
      !fromTimesheet && log.status === "pending" && Boolean(log.endTime) && canReviewTime(actor, owner, project),
    canStop: !log.endTime && (own || approver),
  };
}

function serializeLog(actor: IUser, log: ITimeLog): Record<string, unknown> {
  const json = log.toJSON() as Record<string, unknown>;
  const project = json.project as Record<string, unknown> | null;
  if (project && typeof project === "object") delete project.manager;
  return {
    ...json,
    isRunning: !log.endTime,
    isPaused: !log.endTime && log.breaks.some((b) => !b.endTime),
    permissions: rowPermissions(actor, log as PopulatedLog),
  };
}

async function loadPopulated(id: mongoose.Types.ObjectId): Promise<ITimeLog | null> {
  return TimeLog.findById(id).populate(LOG_POPULATE);
}

/** Running timer JSON for the owner (or null). */
async function timerJson(actor: IUser, id: mongoose.Types.ObjectId | null): Promise<Record<string, unknown> | null> {
  if (!id) return null;
  const log = await loadPopulated(id);
  return log ? serializeLog(actor, log) : null;
}

/**
 * Whether `user` may log time on the project/task:
 * admin; project manager/member or a head who can view the project; for tasks
 * without a project the assignees/creator (and heads who can view it).
 */
async function canLogOn(user: IUser, project: IProject | null, task: ITask | null): Promise<boolean> {
  if (user.role === "admin") return true;
  if (project) {
    if (isProjectMember(user, project) || isProjectManager(user, project)) return true;
    if (user.role === "head" && canViewProject(user, project)) return true;
    if (canManageProject(user, project)) return true;
  }
  if (task) {
    if (isAssignee(user, task) || task.assignedBy.equals(user._id)) return true;
    if (user.role === "head" && (await canViewTaskAsync(user, task))) return true;
  }
  return false;
}

/**
 * Resolves `{ project?, task? }` for a log owned by `owner` per settings.logTimeFor.
 * A task's project wins; archived / completed projects are refused.
 */
async function resolveTarget(
  owner: IUser,
  rawProject: unknown,
  rawTask: unknown
): Promise<{ project: IProject | null; task: ITask | null } | Invalid> {
  const settings = await getProjectSettings();
  let task: ITask | null = null;
  let project: IProject | null = null;

  if (rawTask !== undefined && rawTask !== null && rawTask !== "") {
    if (typeof rawTask !== "string" || isInvalidObjectId(rawTask)) return { status: 400, error: "task must be a valid task ID" };
    task = await Task.findById(rawTask);
    if (!task) return { status: 404, error: "Task not found" };
  }
  if (rawProject !== undefined && rawProject !== null && rawProject !== "") {
    if (typeof rawProject !== "string" || isInvalidObjectId(rawProject)) {
      return { status: 400, error: "project must be a valid project ID" };
    }
    if (task?.project && task.project.toString() !== rawProject) {
      return { status: 400, error: "The task belongs to a different project" };
    }
    project = await Project.findById(rawProject);
    if (!project) return { status: 404, error: "Project not found" };
  }
  if (task?.project && !project) {
    project = await Project.findById(task.project);
  }

  if (settings.logTimeFor === "task" && !task) return { status: 400, error: "Time must be logged against a task" };
  if (settings.logTimeFor === "project" && !project) return { status: 400, error: "Time must be logged against a project" };
  if (!task && !project) return { status: 400, error: "project or task is required" };

  if (project) {
    if (project.archivedAt) return { status: 409, error: "This project is archived" };
    if (await isProjectStatusCompleted(project)) return { status: 409, error: "This project is completed" };
  }
  if (task?.status === "completed") return { status: 409, error: "This task is completed" };
  if (!(await canLogOn(owner, project, task))) {
    return { status: 403, error: "Only project members or task assignees can log time here" };
  }
  return { project, task };
}

function parseInstant(raw: unknown, field: string): Date | Invalid {
  if (typeof raw !== "string" || !raw.trim()) return { status: 400, error: `${field} must be an ISO date-time` };
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return { status: 400, error: `${field} must be an ISO date-time` };
  return date;
}

function parseMemo(raw: unknown): string | undefined | Invalid {
  if (raw === undefined) return undefined;
  if (raw === null) return "";
  if (typeof raw !== "string" || raw.trim().length > 500) return { status: 400, error: "memo must be 500 characters or fewer" };
  return raw.trim();
}

/** Validates a finished window: ≥ 1 minute, ≤ 24 h, not in the future, no overlap. */
async function validateWindow(
  userId: mongoose.Types.ObjectId,
  start: Date,
  end: Date,
  excludeId?: mongoose.Types.ObjectId
): Promise<number | Invalid> {
  if (end.getTime() <= start.getTime()) return { status: 400, error: "endTime must be after startTime" };
  if (end.getTime() > Date.now() + FUTURE_GRACE_MS) return { status: 400, error: "Time logs cannot be in the future" };
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
  if (minutes < 1) return { status: 400, error: "A time log must be at least 1 minute" };
  if (minutes > MAX_ENTRY_MINUTES) return { status: 400, error: "A single time log cannot exceed 24 hours" };
  const overlap = await findOverlap(userId, start, end, excludeId);
  if (overlap) {
    return {
      status: 409,
      error: "This entry overlaps another time log",
      extra: { conflict: { _id: overlap._id, startTime: overlap.startTime, endTime: overlap.endTime ?? null } },
    };
  }
  return minutes;
}

async function hourLimitError(project: IProject | null, minutes: number): Promise<Invalid | null> {
  const remaining = await remainingProjectMinutes(project);
  if (remaining === null) return null;
  if (remaining <= 0 || minutes > remaining) {
    return {
      status: 409,
      error: `The project's allocated hours are exhausted (${formatMinutes(remaining)} left)`,
      extra: { remainingMinutes: remaining },
    };
  }
  return null;
}

async function getLogOr404(req: Request, res: Response): Promise<ITimeLog | undefined> {
  const id = param(req, "id");
  const log = id && !isInvalidObjectId(id) ? await TimeLog.findById(id) : null;
  if (!log) {
    res.status(404).json({ error: "Time log not found" });
    return undefined;
  }
  return log;
}

/** Owner + project needed for permission checks on a raw log. */
async function logContext(log: ITimeLog): Promise<{ owner: IUser | null; project: IProject | null }> {
  const [owner, project] = await Promise.all([
    User.findById(log.user),
    log.project ? Project.findById(log.project) : Promise.resolve(null),
  ]);
  return { owner, project };
}

function isApprover(actor: IUser, owner: IUser, project: IProject | null): boolean {
  return actor.role === "admin" || isHeadOfUser(actor, owner) || Boolean(project && isProjectManager(actor, project));
}

// ---------------------------------------------------------------------------
// List / active
// ---------------------------------------------------------------------------

/**
 * GET /api/timelogs — `scope=mine|team|all|approvals` (default mine), filters
 * user, project, task, status, from, to (YYYY-MM-DD, app timezone, by start).
 * Totals cover matching finished logs (pending + approved unless `status` is given).
 */
export async function listTimeLogs(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const { limit, offset } = parsePagination(req);
  const and: Record<string, unknown>[] = [];
  const scope = typeof req.query.scope === "string" && req.query.scope ? req.query.scope : "mine";

  if (scope === "mine") {
    and.push({ user: actor._id });
  } else if (scope === "team") {
    and.push(await timeLogVisibilityFilter(actor));
  } else if (scope === "all") {
    if (actor.role !== "admin") {
      res.status(403).json({ error: "Only admins can list all time logs" });
      return;
    }
  } else if (scope === "approvals") {
    and.push({ status: "pending", endTime: { $ne: null }, weeklyTimesheet: null });
    if (actor.role !== "admin") {
      const or: Record<string, unknown>[] = [];
      const managed = await managedProjectIds(actor);
      if (managed.length > 0) or.push({ project: { $in: managed } });
      if (actor.role === "head" && actor.department) {
        const members = (await departmentUserIds(actor.department)).filter((id) => !id.equals(actor._id));
        or.push({ user: { $in: members } });
      }
      if (or.length === 0) {
        res.json({ logs: [], total: 0, limit, offset, totals: { minutes: 0, earnings: 0, count: 0 } });
        return;
      }
      and.push({ $or: or }, { user: { $ne: actor._id } });
    }
  } else {
    res.status(400).json({ error: "scope must be one of: mine, team, all, approvals" });
    return;
  }

  const idFilters: Array<[unknown, string]> = [
    [req.query.user, "user"],
    [req.query.project, "project"],
    [req.query.task, "task"],
  ];
  for (const [value, field] of idFilters) {
    if (value === undefined || value === "") continue;
    if (typeof value !== "string" || isInvalidObjectId(value)) {
      res.status(400).json({ error: `${field} must be a valid ID` });
      return;
    }
    and.push({ [field]: new mongoose.Types.ObjectId(value) });
  }
  const status = req.query.status;
  if (status !== undefined && status !== "") {
    if (typeof status !== "string" || !TIMELOG_STATUSES.includes(status as TimeLogStatus)) {
      res.status(400).json({ error: "status must be one of: pending, approved, rejected" });
      return;
    }
    and.push({ status });
  }
  for (const [key, op] of [["from", "$gte"], ["to", "$lt"]] as const) {
    const raw = req.query[key];
    if (raw === undefined || raw === "") continue;
    const day = parseDateOnly(raw);
    if (!day) {
      res.status(400).json({ error: `${key} must be a valid date (YYYY-MM-DD)` });
      return;
    }
    and.push({ startTime: { [op]: appDayStart(key === "to" ? addDays(day, 1) : day) } });
  }

  const filter = and.length > 0 ? { $and: and } : {};
  let query = TimeLog.find(filter).populate(LOG_POPULATE).sort({ startTime: -1 });
  if (limit !== null) query = query.skip(offset).limit(limit);

  const [logs, total, totalsRows] = await Promise.all([
    query,
    TimeLog.countDocuments(filter),
    TimeLog.aggregate<{ minutes: number; earnings: number; count: number }>([
      // Totals: finished logs; rejected ones only count when explicitly filtered for.
      { $match: { $and: [filter, { endTime: { $ne: null } }, ...(status ? [] : [{ status: { $in: ["pending", "approved"] } }])] } },
      { $group: { _id: null, minutes: { $sum: "$durationMinutes" }, earnings: { $sum: "$earnings" }, count: { $sum: 1 } } },
    ]),
  ]);
  const totals = totalsRows[0] ?? { minutes: 0, earnings: 0, count: 0 };
  res.json({
    logs: logs.map((l) => serializeLog(actor, l)),
    total,
    limit,
    offset,
    totals: { minutes: totals.minutes, earnings: Math.round(totals.earnings * 100) / 100, count: totals.count },
  });
}

/** GET /api/timelogs/active — `{ timer }` (my running timer or null). */
export async function activeTimer(req: Request, res: Response): Promise<void> {
  const running = await findRunningTimer(req.user!._id);
  res.json({ timer: await timerJson(req.user!, running ? (running._id as mongoose.Types.ObjectId) : null) });
}

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------

/** POST /api/timelogs/timer/start — `{ project?, task?, memo? }`. 409 when one is already running. */
export async function startTimer(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const body = (req.body ?? {}) as { project?: unknown; task?: unknown; memo?: unknown };

  const running = await findRunningTimer(actor._id);
  if (running) {
    res.status(409).json({
      error: "A timer is already running. Stop it before starting a new one.",
      timer: await timerJson(actor, running._id as mongoose.Types.ObjectId),
    });
    return;
  }
  const memo = parseMemo(body.memo);
  if (isInvalid(memo)) return send(res, memo);
  const target = await resolveTarget(actor, body.project, body.task);
  if (isInvalid(target)) return send(res, target);
  const limitError = await hourLimitError(target.project, 0);
  if (limitError) return send(res, limitError);

  let log: ITimeLog;
  try {
    log = await TimeLog.create({
      user: actor._id,
      project: target.project ? target.project._id : null,
      task: target.task ? target.task._id : null,
      startTime: new Date(),
      endTime: null,
      memo: memo ?? "",
      source: "timer",
      hourlyRate: await resolveHourlyRate(actor._id, target.project),
      status: "pending",
      addedBy: actor._id,
    });
  } catch (error) {
    // The partial unique index caught a concurrent start.
    if (isDuplicateKeyError(error)) {
      res.status(409).json({ error: "A timer is already running. Stop it before starting a new one." });
      return;
    }
    throw error;
  }

  const timer = await timerJson(actor, log._id as mongoose.Types.ObjectId);
  pushTimerUpdate(actor._id, "started", timer);
  pushTimeLogUpdate(log, "started");
  res.status(201).json({ timer });
}

async function requireRunning(req: Request, res: Response): Promise<ITimeLog | undefined> {
  const running = await findRunningTimer(req.user!._id);
  if (!running) {
    res.status(404).json({ error: "No timer is running" });
    return undefined;
  }
  return running;
}

/** POST /api/timelogs/timer/pause — `{ reason? }`. Pausing a paused timer is a no-op. */
export async function pauseTimer(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const running = await requireRunning(req, res);
  if (!running) return;
  const reason = (req.body ?? {}).reason;
  if (reason !== undefined && reason !== null && (typeof reason !== "string" || reason.length > 200)) {
    res.status(400).json({ error: "reason must be 200 characters or fewer" });
    return;
  }
  if (!running.breaks.some((b) => !b.endTime)) {
    running.breaks.push({ startTime: new Date(), endTime: null, reason: typeof reason === "string" ? reason.trim() || undefined : undefined });
    await running.save();
    const timer = await timerJson(actor, running._id as mongoose.Types.ObjectId);
    pushTimerUpdate(actor._id, "paused", timer);
    res.json({ timer });
    return;
  }
  res.json({ timer: await timerJson(actor, running._id as mongoose.Types.ObjectId) });
}

/** POST /api/timelogs/timer/resume — closes the open break (no-op when not paused). */
export async function resumeTimer(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const running = await requireRunning(req, res);
  if (!running) return;
  const open = running.breaks.find((b) => !b.endTime);
  if (open) {
    open.endTime = new Date();
    await running.save();
    const timer = await timerJson(actor, running._id as mongoose.Types.ObjectId);
    pushTimerUpdate(actor._id, "resumed", timer);
    res.json({ timer });
    return;
  }
  res.json({ timer: await timerJson(actor, running._id as mongoose.Types.ObjectId) });
}

/** POST /api/timelogs/timer/stop — `{ memo? }`. Closes an open break first. Returns `{ log }`. */
export async function stopMyTimer(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const running = await requireRunning(req, res);
  if (!running) return;
  const memo = parseMemo((req.body ?? {}).memo);
  if (isInvalid(memo)) return send(res, memo);
  if (memo !== undefined) {
    running.memo = memo;
    await running.save();
  }
  const stopped = await stopTimer(running, new Date(), { actor });
  if (!stopped) {
    res.status(409).json({ error: "The timer was already stopped" });
    return;
  }
  const log = await loadPopulated(stopped._id as mongoose.Types.ObjectId);
  res.json({ log: log ? serializeLog(actor, log) : null });
}

/** POST /api/timelogs/:id/stop — approvers (admin, head of the employee, project manager) stop someone's timer. */
export async function stopTimerById(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const log = await getLogOr404(req, res);
  if (!log) return;
  if (log.endTime) {
    res.status(409).json({ error: "This timer is not running" });
    return;
  }
  const { owner, project } = await logContext(log);
  if (!owner) {
    res.status(404).json({ error: "Time log owner not found" });
    return;
  }
  if (!owner._id.equals(actor._id) && !isApprover(actor, owner, project)) {
    res.status(403).json({ error: "Only the employee, their department head, the project manager or an admin can stop this timer" });
    return;
  }
  const stopped = await stopTimer(log, new Date(), { actor });
  if (!stopped) {
    res.status(409).json({ error: "The timer was already stopped" });
    return;
  }
  const populated = await loadPopulated(stopped._id as mongoose.Types.ObjectId);
  res.json({ log: populated ? serializeLog(actor, populated) : null });
}

// ---------------------------------------------------------------------------
// Manual entries + edits
// ---------------------------------------------------------------------------

/**
 * POST /api/timelogs — `{ project?, task?, startTime, endTime, memo?, user? }`.
 * Approvers may log for others (`user`); the employee is then notified.
 */
export async function createTimeLog(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const body = (req.body ?? {}) as {
    project?: unknown;
    task?: unknown;
    startTime?: unknown;
    endTime?: unknown;
    memo?: unknown;
    user?: unknown;
  };

  let owner: IUser = actor;
  if (body.user !== undefined && body.user !== null && body.user !== "" && body.user !== actor._id.toString()) {
    if (typeof body.user !== "string" || isInvalidObjectId(body.user)) return send(res, { status: 400, error: "user must be a valid user ID" });
    const found = await User.findById(body.user);
    if (!found) return send(res, { status: 404, error: "User not found" });
    owner = found;
  }

  const start = parseInstant(body.startTime, "startTime");
  if (isInvalid(start)) return send(res, start);
  const end = parseInstant(body.endTime, "endTime");
  if (isInvalid(end)) return send(res, end);
  const memo = parseMemo(body.memo);
  if (isInvalid(memo)) return send(res, memo);

  const target = await resolveTarget(owner, body.project, body.task);
  if (isInvalid(target)) return send(res, target);
  const { project, task } = target;

  if (!owner._id.equals(actor._id) && !isApprover(actor, owner, project)) {
    return send(res, { status: 403, error: "Only admins, the employee's department head or the project manager can log time for others" });
  }
  if (project && !project.manualTimeLogs && !canManageProject(actor, project)) {
    return send(res, { status: 403, error: "Manual time entries are disabled for this project" });
  }

  const minutes = await validateWindow(owner._id, start, end);
  if (isInvalid(minutes)) return send(res, minutes);
  const limitError = await hourLimitError(project, minutes);
  if (limitError) return send(res, limitError);

  const hourlyRate = await resolveHourlyRate(owner._id, project);
  const { durationMinutes } = computeDurations(start, end, []);
  const status = await initialStatus();
  const log = await TimeLog.create({
    user: owner._id,
    project: project ? project._id : null,
    task: task ? task._id : null,
    startTime: start,
    endTime: end,
    durationMinutes,
    breakMinutes: 0,
    memo: memo ?? "",
    source: "manual",
    hourlyRate,
    earnings: computeEarnings(hourlyRate, durationMinutes),
    status,
    reviewedAt: status === "approved" ? new Date() : null,
    addedBy: actor._id,
  });

  if (status === "pending") notifyTimeLogPending(log, actor);
  pushTimeLogUpdate(log, "created");
  scheduleProgressRecalc(log.project ?? null);
  const populated = await loadPopulated(log._id as mongoose.Types.ObjectId);
  res.status(201).json({ log: serializeLog(actor, populated!) });
}

/** Edit/delete: approvers any time; the owner while pending. Timesheet logs are edited via the timesheet. */
function canModify(actor: IUser, log: ITimeLog, owner: IUser, project: IProject | null): string | null {
  if (log.weeklyTimesheet) return "This entry comes from a weekly timesheet. Edit the timesheet instead.";
  if (isApprover(actor, owner, project)) return null;
  if (log.user.equals(actor._id)) return log.status === "pending" ? null : "Only pending time logs can be changed";
  return "You can't change this time log";
}

/** PATCH /api/timelogs/:id — `{ memo?, startTime?, endTime?, project?, task? }` (running timers: memo only). */
export async function updateTimeLog(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const log = await getLogOr404(req, res);
  if (!log) return;
  const { owner, project: currentProject } = await logContext(log);
  if (!owner) return send(res, { status: 404, error: "Time log owner not found" });
  const denied = canModify(actor, log, owner, currentProject);
  if (denied) return send(res, { status: 403, error: denied });

  const body = (req.body ?? {}) as { memo?: unknown; startTime?: unknown; endTime?: unknown; project?: unknown; task?: unknown };
  const memo = parseMemo(body.memo);
  if (isInvalid(memo)) return send(res, memo);

  const changesWindow = body.startTime !== undefined || body.endTime !== undefined;
  const changesTarget = body.project !== undefined || body.task !== undefined;
  if (!log.endTime && (changesWindow || changesTarget)) {
    return send(res, { status: 400, error: "Only the memo of a running timer can be changed" });
  }
  if (memo === undefined && !changesWindow && !changesTarget) {
    return send(res, { status: 400, error: "At least one field to update is required" });
  }

  const previousProject = log.project ?? null;
  if (changesTarget) {
    const target = await resolveTarget(
      owner,
      body.project !== undefined ? body.project : log.project?.toString(),
      body.task !== undefined ? body.task : log.task?.toString()
    );
    if (isInvalid(target)) return send(res, target);
    if (target.project && !target.project.manualTimeLogs && !canManageProject(actor, target.project) && log.source === "manual") {
      return send(res, { status: 403, error: "Manual time entries are disabled for this project" });
    }
    const newProjectId = target.project ? (target.project._id as mongoose.Types.ObjectId) : null;
    if (String(newProjectId) !== String(log.project ?? null)) {
      log.hourlyRate = await resolveHourlyRate(owner._id, target.project);
    }
    log.project = newProjectId;
    log.task = target.task ? (target.task._id as mongoose.Types.ObjectId) : null;
  }

  if (changesWindow) {
    const start = body.startTime !== undefined ? parseInstant(body.startTime, "startTime") : log.startTime;
    if (isInvalid(start)) return send(res, start);
    const end = body.endTime !== undefined ? parseInstant(body.endTime, "endTime") : log.endTime!;
    if (isInvalid(end)) return send(res, end);
    const minutes = await validateWindow(owner._id, start, end, log._id as mongoose.Types.ObjectId);
    if (isInvalid(minutes)) return send(res, minutes);
    log.startTime = start;
    log.endTime = end;
    log.set(
      "breaks",
      log.breaks
        .filter((b) => b.startTime >= start && b.startTime < end)
        .map((b) => ({ startTime: b.startTime, endTime: b.endTime ?? null, reason: b.reason }))
    );
  }
  if (log.endTime) {
    const { durationMinutes, breakMinutes } = computeDurations(log.startTime, log.endTime, log.breaks);
    if (changesWindow || changesTarget) {
      // Hour limit: only the additional minutes count against the same project.
      const sameProject = String(log.project ?? null) === String(previousProject);
      const additional = sameProject ? durationMinutes - log.durationMinutes : durationMinutes;
      if (additional > 0 && log.project) {
        const limitError = await hourLimitError(await Project.findById(log.project), additional);
        if (limitError) return send(res, limitError);
      }
    }
    log.durationMinutes = durationMinutes;
    log.breakMinutes = breakMinutes;
    log.earnings = computeEarnings(log.hourlyRate, durationMinutes);
  }
  if (memo !== undefined) log.memo = memo;
  if (!log.user.equals(actor._id)) log.editedBy = actor._id;
  await log.save();

  pushTimeLogUpdate(log, "updated");
  if (!log.endTime) pushTimerUpdate(log.user, "resumed", await timerJson(owner, log._id as mongoose.Types.ObjectId));
  scheduleProgressRecalc(previousProject);
  if (String(previousProject) !== String(log.project ?? null)) scheduleProgressRecalc(log.project ?? null);
  const populated = await loadPopulated(log._id as mongoose.Types.ObjectId);
  res.json({ log: serializeLog(actor, populated!) });
}

/** DELETE /api/timelogs/:id */
export async function deleteTimeLog(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const log = await getLogOr404(req, res);
  if (!log) return;
  const { owner, project } = await logContext(log);
  if (!owner) {
    await log.deleteOne();
    res.json({ success: true });
    return;
  }
  const denied = canModify(actor, log, owner, project);
  if (denied) return send(res, { status: 403, error: denied });
  await log.deleteOne();
  if (!log.endTime) pushTimerUpdate(log.user, "deleted", null);
  pushTimeLogUpdate(log, "deleted");
  scheduleProgressRecalc(log.project ?? null);
  res.json({ success: true });
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

/** Shared approve/reject gate. Returns the context or responds. */
async function reviewGate(
  actor: IUser,
  log: ITimeLog
): Promise<{ owner: IUser; project: IProject | null } | Invalid> {
  if (!log.endTime) return { status: 409, error: "A running timer can't be reviewed" };
  if (log.weeklyTimesheet) return { status: 400, error: "Review this entry through its weekly timesheet" };
  if (log.status !== "pending") return { status: 409, error: `This time log is already ${log.status}` };
  const { owner, project } = await logContext(log);
  if (!owner) return { status: 404, error: "Time log owner not found" };
  if (!canReviewTime(actor, owner, project)) {
    return { status: 403, error: "Only the employee's department head, the project manager or an admin can review this time log" };
  }
  return { owner, project };
}

function describe(log: ITimeLog, project: IProject | null): string {
  return project ? `${project.code} · ${project.name}` : "a task";
}

async function approveOne(actor: IUser, log: ITimeLog, project: IProject | null, ip: string | undefined): Promise<boolean> {
  const updated = await TimeLog.findOneAndUpdate(
    { _id: log._id, status: "pending" },
    { $set: { status: "approved", reviewedBy: actor._id, reviewedAt: new Date() }, $unset: { rejectReason: 1 } },
    { returnDocument: "after" }
  );
  if (!updated) return false;
  logActivity({
    action: "timelog_reviewed",
    actor,
    targetType: "timelog",
    targetId: updated._id as mongoose.Types.ObjectId,
    targetName: describe(updated, project),
    details: { decision: "approved", minutes: updated.durationMinutes, user: updated.user.toString() },
    ip,
  });
  const duration = formatMinutes(updated.durationMinutes);
  notifyUsers({
    recipients: [updated.user],
    actor,
    type: "timelog_approved",
    title: "Time log approved",
    message: `${actor.name} approved ${duration} on ${describe(updated, project)}.`,
    link: TIMELOGS_LINK,
    project: updated.project ?? null,
    email: {
      subject: `✅ Time log approved (${duration})`,
      heading: "Time Log Approved",
      intro: `${actor.name} approved your time log.`,
      cardTitle: describe(updated, project),
      rows: [["Duration", duration]],
      buttonLabel: "View Time Logs",
    },
  });
  pushTimeLogUpdate(updated, "approved");
  return true;
}

/** POST /api/timelogs/:id/approve */
export async function approveTimeLog(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const log = await getLogOr404(req, res);
  if (!log) return;
  const gate = await reviewGate(actor, log);
  if (isInvalid(gate)) return send(res, gate);
  if (!(await approveOne(actor, log, gate.project, req.ip))) {
    return send(res, { status: 409, error: "This time log was already reviewed" });
  }
  const populated = await loadPopulated(log._id as mongoose.Types.ObjectId);
  res.json({ log: serializeLog(actor, populated!) });
}

/** POST /api/timelogs/:id/reject — `{ reason }` (required). */
export async function rejectTimeLog(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const log = await getLogOr404(req, res);
  if (!log) return;
  const reason = (req.body ?? {}).reason;
  if (typeof reason !== "string" || !reason.trim() || reason.trim().length > 1000) {
    return send(res, { status: 400, error: "reason is required (1000 characters or fewer)" });
  }
  const gate = await reviewGate(actor, log);
  if (isInvalid(gate)) return send(res, gate);

  const updated = await TimeLog.findOneAndUpdate(
    { _id: log._id, status: "pending" },
    { $set: { status: "rejected", reviewedBy: actor._id, reviewedAt: new Date(), rejectReason: reason.trim() } },
    { returnDocument: "after" }
  );
  if (!updated) return send(res, { status: 409, error: "This time log was already reviewed" });

  logActivity({
    action: "timelog_reviewed",
    actor,
    targetType: "timelog",
    targetId: updated._id as mongoose.Types.ObjectId,
    targetName: describe(updated, gate.project),
    details: { decision: "rejected", reason: reason.trim(), user: updated.user.toString() },
    ip: req.ip,
  });
  const duration = formatMinutes(updated.durationMinutes);
  notifyUsers({
    recipients: [updated.user],
    actor,
    type: "timelog_rejected",
    title: "Time log rejected",
    message: `${actor.name} rejected ${duration} on ${describe(updated, gate.project)}: ${reason.trim()}`,
    link: TIMELOGS_LINK,
    project: updated.project ?? null,
    email: {
      subject: `❌ Time log rejected (${duration})`,
      heading: "Time Log Rejected",
      intro: `${actor.name} rejected your time log.`,
      cardTitle: describe(updated, gate.project),
      rows: [["Duration", duration]],
      quote: reason.trim(),
      quoteAuthor: actor.name,
      buttonLabel: "View Time Logs",
    },
  });
  pushTimeLogUpdate(updated, "rejected");
  scheduleProgressRecalc(updated.project ?? null);
  const populated = await loadPopulated(updated._id as mongoose.Types.ObjectId);
  res.json({ log: serializeLog(actor, populated!) });
}

/** POST /api/timelogs/bulk-approve — `{ ids[] }` (max 200). Each id is checked individually. */
export async function bulkApprove(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const { ids } = (req.body ?? {}) as { ids?: unknown };
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200 || ids.some((id) => typeof id !== "string" || isInvalidObjectId(id))) {
    return send(res, { status: 400, error: "ids must be an array of 1-200 time log IDs" });
  }
  const unique = [...new Set(ids as string[])];
  const logs = await TimeLog.find({ _id: { $in: unique } });
  const byId = new Map(logs.map((l) => [l._id.toString(), l]));
  const approved: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const id of unique) {
    const log = byId.get(id);
    if (!log) {
      skipped.push({ id, reason: "Time log not found" });
      continue;
    }
    const gate = await reviewGate(actor, log);
    if (isInvalid(gate)) {
      skipped.push({ id, reason: gate.error });
      continue;
    }
    if (await approveOne(actor, log, gate.project, req.ip)) approved.push(id);
    else skipped.push({ id, reason: "Already reviewed" });
  }
  res.json({ approved, skipped });
}
