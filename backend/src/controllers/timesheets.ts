import type { Request, Response } from "express";
import mongoose from "mongoose";
import { logActivity } from "../lib/activityLog.js";
import { addDays, appTimeOn, currentWeekStart, mondayOf } from "../lib/appTime.js";
import { formatDueDate, notifyUsers } from "../lib/notifications.js";
import { parsePagination } from "../lib/pagination.js";
import {
  adminIds,
  departmentHeads,
  departmentUserIds,
  isHeadOfUser,
  isInvalidObjectId,
  param,
} from "../lib/projectAccess.js";
import { scheduleProgressRecalc } from "../lib/projectProgress.js";
import { parseDateOnly } from "../lib/taskAccess.js";
import { computeEarnings, formatMinutes, pushTimeLogUpdate, resolveHourlyRate } from "../lib/timeLogs.js";
import { createEvent, pushToUsers } from "../lib/sse.js";
import { Project } from "../models/Project.js";
import { completedStatusIds } from "../models/ProjectStatus.js";
import { Task } from "../models/Task.js";
import { TimeLog } from "../models/TimeLog.js";
import type { IUser } from "../models/User.js";
import { User } from "../models/User.js";
import { WeeklyTimesheet } from "../models/WeeklyTimesheet.js";
import type { IWeeklyTimesheet } from "../models/WeeklyTimesheet.js";

const TIMESHEET_LINK = "/timesheet";
const REPORT_LINK = "/reports/timesheets";
/** Generated logs start at this local time and run back-to-back per day. */
const DAY_START = "09:00";
const MAX_ENTRIES = 7 * 50;

const TASK_SELECT = "title shortCode status project";

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function weekDays(weekStart: Date): string[] {
  return Array.from({ length: 7 }, (_, i) => dateKey(addDays(weekStart, i)));
}

export function timesheetTotalMinutes(sheet: Pick<IWeeklyTimesheet, "entries">): number {
  return sheet.entries.reduce((sum, e) => sum + e.minutes, 0);
}

/** Admin, or head of the employee's department (never their own sheet unless admin). */
export function canReviewTimesheet(actor: IUser, owner: Pick<IUser, "_id" | "department">): boolean {
  if (actor.role === "admin") return true;
  return isHeadOfUser(actor, owner);
}

/**
 * Tasks the user can log against in a week: open tasks assigned to them whose
 * project is neither archived nor completed (plus tasks already on the sheet).
 */
async function loggableTasks(userId: mongoose.Types.ObjectId, extraTaskIds: mongoose.Types.ObjectId[]) {
  const [archived, completedStatuses] = await Promise.all([
    Project.find({ archivedAt: { $ne: null } }).select("_id").lean(),
    completedStatusIds(),
  ]);
  const finished = await Project.find({ status: { $in: completedStatuses } }).select("_id").lean();
  const excluded = [...archived, ...finished].map((p) => p._id);
  const tasks = await Task.find({
    $or: [
      { assignees: userId, status: { $ne: "completed" }, project: { $nin: excluded } },
      { _id: { $in: extraTaskIds } },
    ],
  })
    .select(TASK_SELECT)
    .populate("project", "name code")
    .sort({ project: 1, createdAt: 1 });
  return tasks.map((t) => t.toJSON());
}

function sheetTotals(sheet: IWeeklyTimesheet) {
  const byDay: Record<string, number> = {};
  const byTask: Record<string, number> = {};
  for (const e of sheet.entries) {
    const day = dateKey(e.date);
    byDay[day] = (byDay[day] ?? 0) + e.minutes;
    byTask[e.task.toString()] = (byTask[e.task.toString()] ?? 0) + e.minutes;
  }
  return { byDay, byTask, total: timesheetTotalMinutes(sheet) };
}

/** `{ timesheet, tasks, days, totals, permissions }` for the grid. */
async function sheetResponse(sheet: IWeeklyTimesheet, actor: IUser) {
  const owner = await User.findById(sheet.user).select("name email department");
  const populated = await WeeklyTimesheet.findById(sheet._id)
    .populate("user", "name email department")
    .populate("reviewedBy", "name");
  const own = sheet.user.equals(actor._id);
  const editable = own && (sheet.status === "draft" || sheet.status === "rejected");
  return {
    timesheet: { ...(populated!.toJSON() as unknown as Record<string, unknown>), weekStartKey: dateKey(sheet.weekStart) },
    tasks: await loggableTasks(sheet.user, sheet.entries.map((e) => e.task)),
    days: weekDays(sheet.weekStart),
    totals: sheetTotals(sheet),
    permissions: {
      canEdit: editable,
      canSubmit: editable && sheet.entries.length > 0,
      canReview: sheet.status === "submitted" && Boolean(owner) && canReviewTimesheet(actor, owner!),
    },
  };
}

/** Pushes `timesheet-updated` to the owner, their department heads and admins. */
function pushTimesheetUpdate(sheet: IWeeklyTimesheet, action: string, ownerDepartment: mongoose.Types.ObjectId | null | undefined): void {
  void (async () => {
    const ids = new Set<string>([sheet.user.toString()]);
    for (const id of await departmentHeads(ownerDepartment ?? null)) ids.add(id.toString());
    for (const id of await adminIds()) ids.add(id.toString());
    pushToUsers(
      [...ids],
      createEvent("timesheet-updated", {
        timesheetId: sheet._id.toString(),
        action,
        userId: sheet.user.toString(),
        weekStart: dateKey(sheet.weekStart),
        status: sheet.status,
      })
    );
  })().catch(() => undefined);
}

async function getSheetOr404(req: Request, res: Response): Promise<IWeeklyTimesheet | undefined> {
  const id = param(req, "id");
  const sheet = id && !isInvalidObjectId(id) ? await WeeklyTimesheet.findById(id) : null;
  if (!sheet) {
    res.status(404).json({ error: "Timesheet not found" });
    return undefined;
  }
  return sheet;
}

// ---------------------------------------------------------------------------
// Owner endpoints
// ---------------------------------------------------------------------------

/** GET /api/timesheets/week?weekStart=YYYY-MM-DD — my sheet (created lazily as a draft). */
export async function getWeek(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  let weekStart = currentWeekStart();
  if (req.query.weekStart !== undefined && req.query.weekStart !== "") {
    const parsed = parseDateOnly(req.query.weekStart);
    if (!parsed) {
      res.status(400).json({ error: "weekStart must be a valid date (YYYY-MM-DD)" });
      return;
    }
    weekStart = mondayOf(parsed);
  }
  let sheet = await WeeklyTimesheet.findOne({ user: actor._id, weekStart });
  if (!sheet) {
    try {
      sheet = await WeeklyTimesheet.findOneAndUpdate(
        { user: actor._id, weekStart },
        { $setOnInsert: { user: actor._id, weekStart, status: "draft", entries: [] } },
        { upsert: true, returnDocument: "after" }
      );
    } catch {
      sheet = await WeeklyTimesheet.findOne({ user: actor._id, weekStart });
    }
  }
  res.json(await sheetResponse(sheet!, actor));
}

/** GET /api/timesheets/:id — the owner or an approver. */
export async function getTimesheet(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const sheet = await getSheetOr404(req, res);
  if (!sheet) return;
  const owner = await User.findById(sheet.user).select("department");
  if (!sheet.user.equals(actor._id) && !(owner && canReviewTimesheet(actor, owner))) {
    res.status(403).json({ error: "You don't have access to this timesheet" });
    return;
  }
  res.json(await sheetResponse(sheet, actor));
}

/** PUT /api/timesheets/:id/entries — `{ entries: [{ task, date, minutes }] }` replaces the draft's rows. */
export async function saveEntries(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const sheet = await getSheetOr404(req, res);
  if (!sheet) return;
  if (!sheet.user.equals(actor._id)) {
    res.status(403).json({ error: "You can only edit your own timesheet" });
    return;
  }
  if (sheet.status !== "draft" && sheet.status !== "rejected") {
    res.status(409).json({ error: `A ${sheet.status} timesheet can't be edited` });
    return;
  }

  const raw = (req.body ?? {}).entries;
  if (!Array.isArray(raw) || raw.length > MAX_ENTRIES) {
    res.status(400).json({ error: `entries must be an array of at most ${MAX_ENTRIES} rows` });
    return;
  }
  const days = new Set(weekDays(sheet.weekStart));
  const seen = new Set<string>();
  const perDay: Record<string, number> = {};
  const entries: Array<{ task: mongoose.Types.ObjectId; date: Date; minutes: number }> = [];
  for (const item of raw) {
    const { task, date, minutes } = (item ?? {}) as { task?: unknown; date?: unknown; minutes?: unknown };
    if (typeof task !== "string" || isInvalidObjectId(task)) {
      res.status(400).json({ error: "Each entry needs a valid task ID" });
      return;
    }
    const day = parseDateOnly(date);
    if (!day || !days.has(dateKey(day))) {
      res.status(400).json({ error: "Each entry date must be a YYYY-MM-DD day within the week" });
      return;
    }
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
      res.status(400).json({ error: "minutes must be an integer between 0 and 1440" });
      return;
    }
    const key = `${task}:${dateKey(day)}`;
    if (seen.has(key)) {
      res.status(400).json({ error: "Each task can appear once per day" });
      return;
    }
    seen.add(key);
    if (minutes === 0) continue;
    perDay[dateKey(day)] = (perDay[dateKey(day)] ?? 0) + minutes;
    if (perDay[dateKey(day)]! > 1440) {
      res.status(400).json({ error: `More than 24 hours logged on ${dateKey(day)}` });
      return;
    }
    entries.push({ task: new mongoose.Types.ObjectId(task), date: day, minutes });
  }

  // Every task must be loggable by the owner (or already on the sheet).
  const allowed = new Set(
    (await loggableTasks(actor._id, sheet.entries.map((e) => e.task))).map((t) => String((t as { _id: unknown })._id))
  );
  const invalid = entries.find((e) => !allowed.has(e.task.toString()));
  if (invalid) {
    res.status(400).json({ error: "You can only log time on open tasks assigned to you", task: invalid.task.toString() });
    return;
  }

  sheet.set("entries", entries);
  await sheet.save();
  res.json(await sheetResponse(sheet, actor));
}

/**
 * POST /api/timesheets/:id/submit — creates pending TimeLogs (`source: "timesheet"`),
 * one per entry, back-to-back from 09:00 (app timezone) each day.
 */
export async function submitTimesheet(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const sheet = await getSheetOr404(req, res);
  if (!sheet) return;
  if (!sheet.user.equals(actor._id)) {
    res.status(403).json({ error: "You can only submit your own timesheet" });
    return;
  }
  if (sheet.status !== "draft" && sheet.status !== "rejected") {
    res.status(409).json({ error: `This timesheet is already ${sheet.status}` });
    return;
  }
  if (sheet.entries.length === 0) {
    res.status(400).json({ error: "Add at least one entry before submitting" });
    return;
  }

  // Claim the transition atomically so a double-submit creates logs once.
  const claimed = await WeeklyTimesheet.findOneAndUpdate(
    { _id: sheet._id, status: { $in: ["draft", "rejected"] } },
    { $set: { status: "submitted", submittedAt: new Date(), reviewedBy: null, reviewedAt: null }, $unset: { rejectReason: 1 } },
    { returnDocument: "after" }
  );
  if (!claimed) {
    res.status(409).json({ error: "This timesheet was already submitted" });
    return;
  }

  const sheetId = claimed._id as mongoose.Types.ObjectId;
  await TimeLog.deleteMany({ weeklyTimesheet: sheetId });
  const tasks = await Task.find({ _id: { $in: claimed.entries.map((e) => e.task) } }).select("project");
  const projectOf = new Map(tasks.map((t) => [t._id.toString(), t.project ?? null]));
  const projectIds = [...new Set([...projectOf.values()].filter(Boolean).map(String))];
  const projects = await Project.find({ _id: { $in: projectIds } }).select("members");
  const projectById = new Map(projects.map((p) => [p._id.toString(), p]));

  const sorted = [...claimed.entries].sort((a, b) => a.date.getTime() - b.date.getTime());
  const offsetByDay = new Map<string, number>();
  const docs = [];
  for (const entry of sorted) {
    const day = dateKey(entry.date);
    const offset = offsetByDay.get(day) ?? 0;
    const start = new Date(appTimeOn(day, DAY_START).getTime() + offset * 60_000);
    const end = new Date(start.getTime() + entry.minutes * 60_000);
    offsetByDay.set(day, offset + entry.minutes);
    const projectId = projectOf.get(entry.task.toString()) ?? null;
    const rate = await resolveHourlyRate(actor._id, projectId ? projectById.get(projectId.toString()) : null);
    docs.push({
      user: actor._id,
      project: projectId,
      task: entry.task,
      startTime: start,
      endTime: end,
      durationMinutes: entry.minutes,
      breakMinutes: 0,
      memo: `Weekly timesheet ${dateKey(claimed.weekStart)}`,
      source: "timesheet",
      hourlyRate: rate,
      earnings: computeEarnings(rate, entry.minutes),
      status: "pending",
      weeklyTimesheet: sheetId,
      addedBy: actor._id,
    });
  }
  await TimeLog.insertMany(docs);
  for (const id of projectIds) scheduleProgressRecalc(id);

  // Department head(s); admins when the department has no head.
  let approvers = (await departmentHeads(actor.department ?? null)).filter((id) => !id.equals(actor._id));
  if (approvers.length === 0) approvers = await adminIds();
  const total = formatMinutes(timesheetTotalMinutes(claimed));
  const week = formatDueDate(claimed.weekStart) ?? dateKey(claimed.weekStart);
  notifyUsers({
    recipients: approvers,
    actor,
    type: "timesheet_submitted",
    title: "Timesheet submitted",
    message: `${actor.name} submitted the timesheet for the week of ${week} (${total}).`,
    link: `${REPORT_LINK}?status=submitted`,
    email: {
      subject: `🗓️ Timesheet submitted: ${actor.name} (${week})`,
      heading: "Weekly Timesheet Submitted",
      intro: `${actor.name} submitted a weekly timesheet for your approval.`,
      cardTitle: `Week of ${week}`,
      rows: [["Total", total]],
      buttonLabel: "Review Timesheets",
    },
  });
  pushTimesheetUpdate(claimed, "submitted", actor.department);
  res.json(await sheetResponse(claimed, actor));
}

// ---------------------------------------------------------------------------
// Approver endpoints
// ---------------------------------------------------------------------------

/** GET /api/timesheets/pending — submitted sheets the caller can review (oldest week first). */
export async function listPending(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const { limit, offset } = parsePagination(req);
  const filter: Record<string, unknown> = { status: "submitted" };
  if (actor.role !== "admin") {
    if (actor.role !== "head" || !actor.department) {
      res.json({ timesheets: [], total: 0, limit, offset });
      return;
    }
    const members = (await departmentUserIds(actor.department)).filter((id) => !id.equals(actor._id));
    filter.user = { $in: members };
  }
  let query = WeeklyTimesheet.find(filter).populate("user", "name email department").sort({ weekStart: 1, submittedAt: 1 });
  if (limit !== null) query = query.skip(offset).limit(limit);
  const [sheets, total] = await Promise.all([query, WeeklyTimesheet.countDocuments(filter)]);
  res.json({
    timesheets: sheets.map((s) => ({
      ...(s.toJSON() as unknown as Record<string, unknown>),
      weekStartKey: dateKey(s.weekStart),
      totalMinutes: timesheetTotalMinutes(s),
    })),
    total,
    limit,
    offset,
  });
}

async function reviewContext(req: Request, res: Response): Promise<{ sheet: IWeeklyTimesheet; owner: IUser } | undefined> {
  const actor = req.user!;
  const sheet = await getSheetOr404(req, res);
  if (!sheet) return undefined;
  const owner = await User.findById(sheet.user);
  if (!owner) {
    res.status(404).json({ error: "Timesheet owner not found" });
    return undefined;
  }
  if (!canReviewTimesheet(actor, owner)) {
    res.status(403).json({ error: "Only the employee's department head or an admin can review this timesheet" });
    return undefined;
  }
  if (sheet.status !== "submitted") {
    res.status(409).json({ error: `Only submitted timesheets can be reviewed (this one is ${sheet.status})` });
    return undefined;
  }
  return { sheet, owner };
}

/** POST /api/timesheets/:id/approve — approves the sheet and its generated logs. */
export async function approveTimesheet(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const ctx = await reviewContext(req, res);
  if (!ctx) return;
  const now = new Date();
  const updated = await WeeklyTimesheet.findOneAndUpdate(
    { _id: ctx.sheet._id, status: "submitted" },
    { $set: { status: "approved", reviewedBy: actor._id, reviewedAt: now }, $unset: { rejectReason: 1 } },
    { returnDocument: "after" }
  );
  if (!updated) {
    res.status(409).json({ error: "This timesheet was already reviewed" });
    return;
  }
  const sheetId = updated._id as mongoose.Types.ObjectId;
  await TimeLog.updateMany(
    { weeklyTimesheet: sheetId },
    { $set: { status: "approved", reviewedBy: actor._id, reviewedAt: now }, $unset: { rejectReason: 1 } }
  );
  const logs = await TimeLog.find({ weeklyTimesheet: sheetId }).select("user project status");
  for (const log of logs) pushTimeLogUpdate(log, "approved");
  for (const id of new Set(logs.map((l) => String(l.project ?? "")).filter(Boolean))) scheduleProgressRecalc(id);

  const week = formatDueDate(updated.weekStart) ?? dateKey(updated.weekStart);
  logActivity({
    action: "timesheet_reviewed",
    actor,
    targetType: "timesheet",
    targetId: sheetId,
    targetName: `${ctx.owner.name} · week of ${week}`,
    details: { decision: "approved", minutes: timesheetTotalMinutes(updated) },
    ip: req.ip,
  });
  notifyUsers({
    recipients: [updated.user],
    actor,
    type: "timesheet_approved",
    title: "Timesheet approved",
    message: `${actor.name} approved your timesheet for the week of ${week}.`,
    link: `${TIMESHEET_LINK}?week=${dateKey(updated.weekStart)}`,
    email: {
      subject: `✅ Timesheet approved (week of ${week})`,
      heading: "Timesheet Approved",
      intro: `${actor.name} approved your weekly timesheet.`,
      cardTitle: `Week of ${week}`,
      rows: [["Total", formatMinutes(timesheetTotalMinutes(updated))]],
      buttonLabel: "View Timesheet",
    },
  });
  pushTimesheetUpdate(updated, "approved", ctx.owner.department);
  res.json(await sheetResponse(updated, actor));
}

/** POST /api/timesheets/:id/reject — `{ reason }`; deletes the generated logs, back to editable. */
export async function rejectTimesheet(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const reason = (req.body ?? {}).reason;
  if (typeof reason !== "string" || !reason.trim() || reason.trim().length > 1000) {
    res.status(400).json({ error: "reason is required (1000 characters or fewer)" });
    return;
  }
  const ctx = await reviewContext(req, res);
  if (!ctx) return;
  const updated = await WeeklyTimesheet.findOneAndUpdate(
    { _id: ctx.sheet._id, status: "submitted" },
    { $set: { status: "rejected", reviewedBy: actor._id, reviewedAt: new Date(), rejectReason: reason.trim() } },
    { returnDocument: "after" }
  );
  if (!updated) {
    res.status(409).json({ error: "This timesheet was already reviewed" });
    return;
  }
  const sheetId = updated._id as mongoose.Types.ObjectId;
  const logs = await TimeLog.find({ weeklyTimesheet: sheetId }).select("user project status");
  await TimeLog.deleteMany({ weeklyTimesheet: sheetId });
  for (const log of logs) pushTimeLogUpdate(log, "deleted");
  for (const id of new Set(logs.map((l) => String(l.project ?? "")).filter(Boolean))) scheduleProgressRecalc(id);

  const week = formatDueDate(updated.weekStart) ?? dateKey(updated.weekStart);
  logActivity({
    action: "timesheet_reviewed",
    actor,
    targetType: "timesheet",
    targetId: sheetId,
    targetName: `${ctx.owner.name} · week of ${week}`,
    details: { decision: "rejected", reason: reason.trim() },
    ip: req.ip,
  });
  notifyUsers({
    recipients: [updated.user],
    actor,
    type: "timesheet_rejected",
    title: "Timesheet rejected",
    message: `${actor.name} rejected your timesheet for the week of ${week}: ${reason.trim()}`,
    link: `${TIMESHEET_LINK}?week=${dateKey(updated.weekStart)}`,
    email: {
      subject: `❌ Timesheet rejected (week of ${week})`,
      heading: "Timesheet Rejected",
      intro: `${actor.name} rejected your weekly timesheet. You can edit and resubmit it.`,
      cardTitle: `Week of ${week}`,
      quote: reason.trim(),
      quoteAuthor: actor.name,
      buttonLabel: "Edit Timesheet",
    },
  });
  pushTimesheetUpdate(updated, "rejected", ctx.owner.department);
  res.json(await sheetResponse(updated, actor));
}
