import mongoose from "mongoose";
import { Project } from "../models/Project.js";
import type { IProject } from "../models/Project.js";
import { getProjectSettings } from "../models/ProjectSettings.js";
import { TimeLog } from "../models/TimeLog.js";
import type { ITimeLog, ITimeLogBreak } from "../models/TimeLog.js";
import type { IUser } from "../models/User.js";
import { User } from "../models/User.js";
import { notifyUsers } from "./notifications.js";
import { adminIds, departmentHeads, loggedTotalsByProject } from "./projectAccess.js";
import { scheduleProgressRecalc } from "./projectProgress.js";
import { createEvent, pushToUsers } from "./sse.js";

// ---------------------------------------------------------------------------
// Shared time-log logic: durations, rates, overlap + hour-limit checks,
// stopping timers, SSE fan-out and approval notifications.
// ---------------------------------------------------------------------------

export const TIMELOG_POPULATE = [
  { path: "user", select: "name email department" },
  { path: "project", select: "name code" },
  { path: "task", select: "title shortCode" },
  // Brand time (Program / CM / leadership weekly timesheet rows): no project or task.
  { path: "brand", select: "name organisation" },
  { path: "reviewedBy", select: "name" },
  { path: "addedBy", select: "name" },
  { path: "editedBy", select: "name" },
];

export const TIMELOGS_LINK = "/timelogs";

/** Duration excluding breaks (clipped to the log window), rounded to whole minutes. */
export function computeDurations(
  start: Date,
  end: Date,
  breaks: Array<Pick<ITimeLogBreak, "startTime" | "endTime">>
): { durationMinutes: number; breakMinutes: number } {
  const startMs = start.getTime();
  const endMs = end.getTime();
  let breakMs = 0;
  for (const b of breaks) {
    const bs = Math.max(b.startTime.getTime(), startMs);
    const be = Math.min((b.endTime ?? end).getTime(), endMs);
    if (be > bs) breakMs += be - bs;
  }
  const workMs = Math.max(0, endMs - startMs - breakMs);
  return { durationMinutes: Math.round(workMs / 60_000), breakMinutes: Math.round(breakMs / 60_000) };
}

export function computeEarnings(hourlyRate: number, minutes: number): number {
  return Math.round(((hourlyRate * minutes) / 60) * 100) / 100;
}

/** Membership rate on the project (when > 0), otherwise the user's default rate. */
export async function resolveHourlyRate(
  userId: mongoose.Types.ObjectId,
  project: Pick<IProject, "members"> | null | undefined
): Promise<number> {
  const row = project?.members.find((m) => m.user.equals(userId));
  if (row && row.hourlyRate > 0) return row.hourlyRate;
  const user = await User.findById(userId).select("hourlyRate").lean();
  return user?.hourlyRate ?? 0;
}

/**
 * First approved/pending log of `userId` overlapping [start, end). A running
 * timer occupies [startTime, ∞).
 */
export async function findOverlap(
  userId: mongoose.Types.ObjectId,
  start: Date,
  end: Date,
  excludeId?: mongoose.Types.ObjectId
): Promise<ITimeLog | null> {
  const filter: Record<string, unknown> = {
    user: userId,
    status: { $in: ["pending", "approved"] },
    startTime: { $lt: end },
    $or: [{ endTime: null }, { endTime: { $gt: start } }],
  };
  if (excludeId) filter._id = { $ne: excludeId };
  return TimeLog.findOne(filter);
}

/** Minutes left under `hoursAllocated` in `total_time` mode (null = no limit). */
export async function remainingProjectMinutes(project: IProject | null | undefined): Promise<number | null> {
  if (!project || project.progressMode !== "total_time" || !project.hoursAllocated || project.hoursAllocated <= 0) {
    return null;
  }
  const totals = await loggedTotalsByProject([project._id as mongoose.Types.ObjectId]);
  const logged = totals.get(String(project._id))?.minutes ?? 0;
  return Math.max(0, project.hoursAllocated * 60 - logged);
}

/** Status a newly finished log gets: pending when approval is required. */
export async function initialStatus(): Promise<"pending" | "approved"> {
  const settings = await getProjectSettings();
  return settings.approvalRequired ? "pending" : "approved";
}

/** The caller's running timer, if any. */
export function findRunningTimer(userId: mongoose.Types.ObjectId): Promise<ITimeLog | null> {
  return TimeLog.findOne({ user: userId, endTime: null });
}

export interface StopOptions {
  /** Stopped by the auto-stop job / hour limit. */
  autoStopped?: boolean;
  /** Who stopped it (null for jobs). */
  actor?: IUser | null;
}

/**
 * Stops a running timer at `end`: closes an open break, drops breaks that start
 * after `end`, computes duration/earnings and the approval status. Atomic on
 * `endTime: null` so a concurrent stop (user + job) only happens once.
 * Returns the stopped log, or null when it was no longer running.
 */
export async function stopTimer(log: ITimeLog, end: Date, options: StopOptions = {}): Promise<ITimeLog | null> {
  const endAt = new Date(Math.max(end.getTime(), log.startTime.getTime()));
  const breaks = log.breaks
    .filter((b) => b.startTime.getTime() < endAt.getTime())
    .map((b) => ({
      _id: (b as unknown as { _id: mongoose.Types.ObjectId })._id,
      startTime: b.startTime,
      endTime: b.endTime && b.endTime.getTime() <= endAt.getTime() ? b.endTime : endAt,
      reason: b.reason,
    }));
  const { durationMinutes, breakMinutes } = computeDurations(log.startTime, endAt, breaks);
  const status = await initialStatus();
  const now = new Date();

  const stopped = await TimeLog.findOneAndUpdate(
    { _id: log._id, endTime: null },
    {
      $set: {
        endTime: endAt,
        breaks,
        durationMinutes,
        breakMinutes,
        earnings: computeEarnings(log.hourlyRate, durationMinutes),
        status,
        reviewedAt: status === "approved" ? now : null,
        autoStopped: Boolean(options.autoStopped),
        ...(options.actor && !options.actor._id.equals(log.user) ? { editedBy: options.actor._id } : {}),
      },
    },
    { returnDocument: "after" }
  );
  if (!stopped) return null;

  pushTimerUpdate(stopped.user, "stopped", null);
  pushTimeLogUpdate(stopped, "stopped");
  scheduleProgressRecalc(stopped.project ?? null);
  if (stopped.status === "pending") {
    notifyTimeLogPending(stopped, options.actor ?? null);
  }
  return stopped;
}

/** Stops every running timer matching `filter` (archive, member removal). Returns how many stopped. */
export async function stopTimersWhere(filter: Record<string, unknown>, actor: IUser | null): Promise<number> {
  const running = await TimeLog.find({ ...filter, endTime: null });
  let count = 0;
  const now = new Date();
  for (const log of running) {
    if (await stopTimer(log, now, { actor })) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

/** `timer-updated` to the timer owner (all tabs). `timer` is the populated running log or null. */
export function pushTimerUpdate(
  userId: mongoose.Types.ObjectId,
  action: "started" | "paused" | "resumed" | "stopped" | "deleted",
  timer: Record<string, unknown> | null
): void {
  pushToUsers([userId.toString()], createEvent("timer-updated", { action, timer }));
}

/** `timelog-updated` to the owner, admins, the owner's department heads and the project manager. */
export function pushTimeLogUpdate(log: Pick<ITimeLog, "_id" | "user" | "project" | "status">, action: string): void {
  void (async () => {
    const owner = await User.findById(log.user).select("department").lean();
    const ids = new Set<string>([log.user.toString()]);
    for (const id of await adminIds()) ids.add(id.toString());
    for (const id of await departmentHeads(owner?.department ?? null)) ids.add(id.toString());
    if (log.project) {
      const project = await Project.findById(log.project).select("manager").lean();
      if (project?.manager) ids.add(project.manager.toString());
    }
    pushToUsers(
      [...ids],
      createEvent("timelog-updated", {
        logId: String(log._id),
        action,
        userId: log.user.toString(),
        projectId: log.project ? log.project.toString() : null,
        status: log.status,
      })
    );
  })().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export { formatMinutes };

/**
 * `timelog_pending`: logged by someone else → the employee; otherwise the
 * approvers (department head(s) + project manager), falling back to admins.
 */
export function notifyTimeLogPending(log: ITimeLog, actor: IUser | null): void {
  void (async () => {
    const owner = await User.findById(log.user).select("name department").lean();
    if (!owner) return;
    const project = log.project ? await Project.findById(log.project).select("name code manager").lean() : null;
    const what = project ? `${project.code} · ${project.name}` : "a task";
    const duration = formatMinutes(log.durationMinutes);

    if (actor && !actor._id.equals(log.user)) {
      notifyUsers({
        recipients: [log.user],
        actor,
        type: "timelog_pending",
        title: "Time logged for you",
        message: `${actor.name} logged ${duration} on ${what} for you. It is pending approval.`,
        link: TIMELOGS_LINK,
        project: log.project ?? null,
        email: {
          subject: `⏱️ ${actor.name} logged ${duration} for you`,
          heading: "Time Logged For You",
          intro: `${actor.name} logged time on your behalf. It is pending approval.`,
          cardTitle: what,
          rows: [["Duration", duration]],
          quote: log.memo || null,
          buttonLabel: "View Time Logs",
        },
      });
      return;
    }

    let approvers = await departmentHeads(owner.department ?? null);
    if (project?.manager) approvers = [...approvers, project.manager];
    approvers = approvers.filter((id) => !id.equals(log.user));
    if (approvers.length === 0) approvers = await adminIds();

    notifyUsers({
      recipients: approvers,
      actor: actor ?? null,
      type: "timelog_pending",
      title: "Time log pending approval",
      message: `${owner.name} logged ${duration} on ${what}.`,
      link: `${TIMELOGS_LINK}?tab=pending`,
      project: log.project ?? null,
      email: {
        subject: `⏱️ Time log pending: ${owner.name} (${duration})`,
        heading: "Time Log Pending Approval",
        intro: `${owner.name} logged time that needs your approval.`,
        cardTitle: what,
        rows: [["Duration", duration]],
        quote: log.memo || null,
        quoteAuthor: log.memo ? owner.name : null,
        buttonLabel: "Review Time Logs",
      },
    });
  })().catch((err) => console.error("[timelogs] pending notification failed:", err));
}

/** True when the id is a valid ObjectId string. */
export function isObjectIdString(value: unknown): value is string {
  return typeof value === "string" && mongoose.isValidObjectId(value);
}
