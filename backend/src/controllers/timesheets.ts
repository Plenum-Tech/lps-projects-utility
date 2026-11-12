import type { Request, Response } from "express";
import mongoose from "mongoose";
import { logActivity } from "../lib/activityLog.js";
import { addDays, appTimeOn, appToday, currentWeekStart, mondayOf } from "../lib/appTime.js";
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
import { markActualStartFromLogs } from "../lib/actualDates.js";
import { assignedBrands, canLogBrandTime } from "../lib/brandTime.js";
import { Brand } from "../models/Brand.js";

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
async function loggableTasks(userId: mongoose.Types.ObjectId, extraTaskIds: mongoose.Types.ObjectId[], brandsOnly = false) {
  // Brand-time people (program, CM, brand leads, leadership) log on brands only — pitch work
  // too, on the pitch's brand. Tasks already holding hours on the sheet stay.
  if (brandsOnly) {
    if (extraTaskIds.length === 0) return [];
    const kept = await Task.find({ _id: { $in: extraTaskIds } }).select(TASK_SELECT).populate("project", "name code").sort({ project: 1, createdAt: 1 });
    return kept.map((t) => t.toJSON());
  }
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
  const byBrand: Record<string, number> = {};
  for (const e of sheet.entries) {
    const day = dateKey(e.date);
    byDay[day] = (byDay[day] ?? 0) + e.minutes;
    if (e.task) byTask[e.task.toString()] = (byTask[e.task.toString()] ?? 0) + e.minutes;
    if (e.brand) byBrand[e.brand.toString()] = (byBrand[e.brand.toString()] ?? 0) + e.minutes;
  }
  return { byDay, byTask, byBrand, total: timesheetTotalMinutes(sheet) };
}

/** "YYYY-MM" of each day, once. */
function monthsOf(days: string[]): string[] {
  return [...new Set(days.map((d) => d.slice(0, 7)))];
}

/** Projects picked on brand rows. */
function entryProjectIds(entries: Array<{ project?: mongoose.Types.ObjectId | null }>): mongoose.Types.ObjectId[] {
  return entries.flatMap((e) => (e.project ? [e.project] : []));
}

/**
 * Projects a brand row can be on: each brand's projects of these months (not archived), plus
 * the ones already on the rows. The grid filters them by the row's brand.
 */
async function brandProjects(months: string[], extraIds: mongoose.Types.ObjectId[]) {
  if (months.length === 0 && extraIds.length === 0) return [];
  const projects = await Project.find({
    $or: [
      { "naming.month": { $in: months }, archivedAt: null, brand: { $ne: null } },
      // Projects carried into these months (open tasks carry a project on).
      ...(months.length
        ? [{ "naming.month": { $lt: [...months].sort()[0]! }, activeThrough: { $gte: [...months].sort()[0]! }, archivedAt: null, brand: { $ne: null } }]
        : []),
      { _id: { $in: extraIds } },
    ],
  })
    .select("name code brand naming.month")
    .sort({ name: 1 })
    .lean();
  return projects.map((p) => ({
    _id: String(p._id),
    name: p.name,
    code: p.code ?? "",
    brand: p.brand ? String(p.brand) : null,
    month: p.naming?.month ?? null,
  }));
}

/**
 * Brand rows' projects must be one of their brand's projects for these months (or already on
 * the rows). Returns the error message, or null.
 */
async function checkBrandProjects(
  rows: Array<{ brand: mongoose.Types.ObjectId | null; project: mongoose.Types.ObjectId | null }>,
  months: string[],
  known: mongoose.Types.ObjectId[]
): Promise<string | null> {
  const picked = rows.filter((r) => r.brand && r.project);
  if (picked.length === 0) return null;
  const usable = new Map((await brandProjects(months, known)).map((p) => [p._id, p.brand]));
  const bad = picked.find((r) => usable.get(String(r.project)) !== String(r.brand));
  return bad ? "Pick one of the brand's projects for this month" : null;
}

/** Task ids on a sheet (brand rows have none). */
function sheetTaskIds(sheet: Pick<IWeeklyTimesheet, "entries">): mongoose.Types.ObjectId[] {
  return sheet.entries.flatMap((e) => (e.task ? [e.task] : []));
}

/** `{ timesheet, tasks, days, totals, permissions }` for the grid. */
async function sheetResponse(sheet: IWeeklyTimesheet, actor: IUser) {
  const owner = await User.findById(sheet.user).select("name email department");
  const populated = await WeeklyTimesheet.findById(sheet._id)
    .populate("user", "name email department")
    .populate("reviewedBy", "name");
  const own = sheet.user.equals(actor._id);
  const editable = own && (sheet.status === "draft" || sheet.status === "rejected");
  const canLogBrands = own && (await canLogBrandTime(actor));
  return {
    timesheet: { ...(populated!.toJSON() as unknown as Record<string, unknown>), weekStartKey: dateKey(sheet.weekStart) },
    tasks: await loggableTasks(sheet.user, sheetTaskIds(sheet), canLogBrands),
    days: weekDays(sheet.weekStart),
    totals: sheetTotals(sheet),
    // Brand rows: the brands' projects of the week's month(s) to pick from.
    brandProjects: await brandProjects(canLogBrands ? monthsOf(weekDays(sheet.weekStart)) : [], entryProjectIds(sheet.entries)),
    // Brands from the user's manpower allocation: shown as rows with 0 hours on an editable sheet.
    assignedBrands: editable && canLogBrands ? await assignedBrands(sheet.user, monthsOf(weekDays(sheet.weekStart))) : [],
    permissions: {
      /** Program / CM / leadership: rows on a brand (no approval). */
      canLogBrands,
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

/**
 * PUT /api/timesheets/:id/entries — `{ entries: [{ task | brand, project?, date, minutes, note? }] }`
 * replaces the draft's rows. Brand rows (time on a brand, or on one of its projects of the
 * month) are for Program / CM / leadership (lib/brandTime.ts).
 */
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
  const entries: Array<{
    task: mongoose.Types.ObjectId | null;
    brand: mongoose.Types.ObjectId | null;
    project: mongoose.Types.ObjectId | null;
    note: string;
    date: Date;
    minutes: number;
  }> = [];
  for (const item of raw) {
    const { task, brand, project, note, date, minutes } = (item ?? {}) as {
      task?: unknown;
      brand?: unknown;
      project?: unknown;
      note?: unknown;
      date?: unknown;
      minutes?: unknown;
    };
    const taskId = typeof task === "string" && task ? task : null;
    const brandId = typeof brand === "string" && brand ? brand : null;
    const projectId = brandId && typeof project === "string" && project ? project : null;
    if ((taskId ? 1 : 0) + (brandId ? 1 : 0) !== 1 || isInvalidObjectId(taskId ?? brandId ?? "") || (projectId && isInvalidObjectId(projectId))) {
      res.status(400).json({ error: "Each entry needs a valid task or brand (not both)" });
      return;
    }
    if (note !== undefined && (typeof note !== "string" || note.trim().length > 300)) {
      res.status(400).json({ error: "A note must be 300 characters or fewer" });
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
    const key = `${taskId ?? `brand:${brandId}:${projectId ?? ""}`}:${dateKey(day)}`;
    if (seen.has(key)) {
      res.status(400).json({ error: taskId ? "Each task can appear once per day" : "Each brand / project can appear once per day" });
      return;
    }
    seen.add(key);
    if (minutes === 0) continue;
    perDay[dateKey(day)] = (perDay[dateKey(day)] ?? 0) + minutes;
    if (perDay[dateKey(day)]! > 1440) {
      res.status(400).json({ error: `More than 24 hours logged on ${dateKey(day)}` });
      return;
    }
    entries.push({
      task: taskId ? new mongoose.Types.ObjectId(taskId) : null,
      brand: brandId ? new mongoose.Types.ObjectId(brandId) : null,
      project: projectId ? new mongoose.Types.ObjectId(projectId) : null,
      note: brandId && typeof note === "string" ? note.trim() : "",
      date: day,
      minutes,
    });
  }

  // Every task must be loggable by the owner (or already on the sheet).
  const allowed = new Set(
    (await loggableTasks(actor._id, sheetTaskIds(sheet), await canLogBrandTime(actor))).map((t) => String((t as { _id: unknown })._id))
  );
  const invalid = entries.find((e) => e.task && !allowed.has(e.task.toString()));
  if (invalid) {
    res.status(400).json({ error: "You can only log time on open tasks assigned to you", task: invalid.task!.toString() });
    return;
  }
  // Brand rows: Program / CM / leadership, on active approved brands (or brands already on the sheet).
  const brandIds = [...new Set(entries.flatMap((e) => (e.brand ? [e.brand.toString()] : [])))];
  if (brandIds.length) {
    if (!(await canLogBrandTime(actor))) {
      res.status(403).json({ error: "Only Program, CM and leadership can log time on a brand. Log it on a task instead." });
      return;
    }
    const onSheet = new Set(sheet.entries.flatMap((e) => (e.brand ? [e.brand.toString()] : [])));
    const usable = await Brand.find({
      _id: { $in: brandIds },
      $or: [{ _id: { $in: [...onSheet] } }, { active: true, $or: [{ status: { $exists: false } }, { status: "approved" }] }],
    })
      .select("_id")
      .lean();
    if (usable.length !== brandIds.length) {
      res.status(400).json({ error: "Pick an active brand" });
      return;
    }
    const projectError = await checkBrandProjects(entries, monthsOf([...days]), entryProjectIds(sheet.entries));
    if (projectError) {
      res.status(400).json({ error: projectError });
      return;
    }
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
  const submitted = await submitSheet(sheet, actor);
  if (!submitted) {
    res.status(409).json({ error: "This timesheet was already submitted" });
    return;
  }
  if (submitted.status === "submitted") notifySubmitted(actor, [submitted]);
  res.json(await sheetResponse(submitted, actor));
}

/**
 * Submits an editable sheet with entries: one TimeLog per entry, back-to-back from 09:00
 * each day. Brand-only weeks are approved at once. Null when it was already submitted.
 */
async function submitSheet(sheet: IWeeklyTimesheet, actor: IUser): Promise<IWeeklyTimesheet | null> {
  // Claim the transition atomically so a double-submit creates logs once.
  const claimed = await WeeklyTimesheet.findOneAndUpdate(
    { _id: sheet._id, status: { $in: ["draft", "rejected"] } },
    { $set: { status: "submitted", submittedAt: new Date(), reviewedBy: null, reviewedAt: null }, $unset: { rejectReason: 1 } },
    { returnDocument: "after" }
  );
  if (!claimed) return null;

  const sheetId = claimed._id as mongoose.Types.ObjectId;
  await TimeLog.deleteMany({ weeklyTimesheet: sheetId });
  const tasks = await Task.find({ _id: { $in: sheetTaskIds(claimed) } }).select("project");
  const projectOf = new Map(tasks.map((t) => [t._id.toString(), t.project ?? null]));
  const projectIds = [...new Set([...projectOf.values()].filter(Boolean).map(String))];
  const projects = await Project.find({ _id: { $in: [...projectIds, ...entryProjectIds(claimed.entries).map(String)] } }).select("members");
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
    // Brand rows: the brand's project when one was picked.
    const projectId = entry.task ? (projectOf.get(entry.task.toString()) ?? null) : (entry.project ?? null);
    const rate = await resolveHourlyRate(actor._id, projectId ? projectById.get(projectId.toString()) : null);
    // Brand rows (no task) need no approval: they count at once.
    const onBrand = Boolean(entry.brand);
    docs.push({
      user: actor._id,
      project: projectId,
      task: entry.task ?? null,
      brand: entry.brand ?? null,
      startTime: start,
      endTime: end,
      durationMinutes: entry.minutes,
      breakMinutes: 0,
      memo: onBrand && entry.note ? entry.note : `Weekly timesheet ${dateKey(claimed.weekStart)}`,
      source: "timesheet",
      hourlyRate: rate,
      earnings: computeEarnings(rate, entry.minutes),
      status: onBrand ? "approved" : "pending",
      ...(onBrand ? { reviewedAt: new Date() } : {}),
      weeklyTimesheet: sheetId,
      addedBy: actor._id,
    });
  }
  await TimeLog.insertMany(docs);
  await markActualStartFromLogs(docs.flatMap((d) => (d.task ? [{ task: d.task, start: d.startTime }] : [])));
  for (const id of projectIds) scheduleProgressRecalc(id);

  // Only brand rows: nothing to approve — the week is approved as it's submitted.
  if (claimed.entries.every((e) => e.brand)) {
    const approved = await WeeklyTimesheet.findOneAndUpdate(
      { _id: sheetId, status: "submitted" },
      { $set: { status: "approved", reviewedAt: new Date() } },
      { returnDocument: "after" }
    );
    pushTimesheetUpdate(approved ?? claimed, "approved", actor.department);
    return approved ?? claimed;
  }
  pushTimesheetUpdate(claimed, "submitted", actor.department);
  return claimed;
}

/** One "timesheet submitted" notification to the approvers for these submitted weeks. */
function notifySubmitted(actor: IUser, sheets: IWeeklyTimesheet[]): void {
  if (sheets.length === 0) return;
  void (async () => {
    // Department head(s); admins when the department has no head.
    let approvers = (await departmentHeads(actor.department ?? null)).filter((id) => !id.equals(actor._id));
    if (approvers.length === 0) approvers = await adminIds();
    const sorted = [...sheets].sort((a, b) => a.weekStart.getTime() - b.weekStart.getTime());
    const total = formatMinutes(sorted.reduce((sum, s) => sum + timesheetTotalMinutes(s), 0));
    const weekOf = (s: IWeeklyTimesheet) => formatDueDate(s.weekStart) ?? dateKey(s.weekStart);
    const first = weekOf(sorted[0]!);
    const last = weekOf(sorted[sorted.length - 1]!);
    const several = sorted.length > 1;
    notifyUsers({
      recipients: approvers,
      actor,
      type: "timesheet_submitted",
      title: several ? "Timesheets submitted" : "Timesheet submitted",
      message: several
        ? `${actor.name} submitted timesheets for ${sorted.length} weeks (${first} – ${last}, ${total}).`
        : `${actor.name} submitted the timesheet for the week of ${first} (${total}).`,
      link: `${REPORT_LINK}?status=submitted`,
      email: {
        subject: `🗓️ Timesheet submitted: ${actor.name} (${several ? `${sorted.length} weeks` : first})`,
        heading: several ? "Weekly Timesheets Submitted" : "Weekly Timesheet Submitted",
        intro: several
          ? `${actor.name} submitted ${sorted.length} weekly timesheets for your approval.`
          : `${actor.name} submitted a weekly timesheet for your approval.`,
        cardTitle: several ? `Weeks of ${first} – ${last}` : `Week of ${first}`,
        rows: [["Total", total]],
        buttonLabel: "Review Timesheets",
      },
    });
  })().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Month catch-up: the whole previous month at once — a total per task / brand,
// spread evenly over the month's working days (Mon–Fri) in its weekly sheets.
// Weeks already submitted or approved keep their hours; the rest is spread over
// the editable days.
// ---------------------------------------------------------------------------

const MONTH_MAX_MINUTES = 31 * 24 * 60;
/** Spread in 15-minute steps. */
const STEP = 15;

/** "YYYY-MM" of the previous month (app timezone) — the month that can be logged in one go. */
function catchUpMonth(): string {
  const today = appToday();
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00.000Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** The user's sheet for a week, created as a draft when missing. */
async function ensureSheet(userId: mongoose.Types.ObjectId, weekStart: Date): Promise<IWeeklyTimesheet> {
  const found = await WeeklyTimesheet.findOne({ user: userId, weekStart });
  if (found) return found;
  try {
    return (await WeeklyTimesheet.findOneAndUpdate(
      { user: userId, weekStart },
      { $setOnInsert: { user: userId, weekStart, status: "draft", entries: [] } },
      { upsert: true, returnDocument: "after" }
    ))!;
  } catch {
    return (await WeeklyTimesheet.findOne({ user: userId, weekStart }))!;
  }
}

function isEditable(sheet: IWeeklyTimesheet): boolean {
  return sheet.status === "draft" || sheet.status === "rejected";
}

function rowKey(e: { task?: mongoose.Types.ObjectId | null; brand?: mongoose.Types.ObjectId | null; project?: mongoose.Types.ObjectId | null }): string {
  return e.task ? `task:${String(e.task)}` : `brand:${String(e.brand)}:${e.project ? String(e.project) : ""}`;
}

interface MonthContext {
  month: string;
  days: Set<string>;
  /** Mon–Fri days of the month whose week is still editable, in order. */
  editableWorkdays: string[];
  /** Every Mon–Fri day of the month, in order. */
  allWorkdays: string[];
  workdays: number;
  sheets: IWeeklyTimesheet[];
}

async function monthContext(userId: mongoose.Types.ObjectId, month: string): Promise<MonthContext> {
  const first = new Date(`${month}-01T00:00:00.000Z`);
  const last = addDays(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1)), -1);
  const days: string[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) days.push(dateKey(d));
  const sheets: IWeeklyTimesheet[] = [];
  for (let w = mondayOf(first); w <= last; w = addDays(w, 7)) sheets.push(await ensureSheet(userId, w));
  const editableDays = new Set(sheets.filter(isEditable).flatMap((s) => weekDays(s.weekStart)));
  const isWorkday = (day: string) => {
    const dow = new Date(`${day}T00:00:00.000Z`).getUTCDay();
    return dow !== 0 && dow !== 6;
  };
  return {
    month,
    days: new Set(days),
    editableWorkdays: days.filter((d) => isWorkday(d) && editableDays.has(d)),
    allWorkdays: days.filter(isWorkday),
    workdays: days.filter(isWorkday).length,
    sheets,
  };
}

/**
 * Month form when every week is already submitted: brand rows can only grow. The extra hours of
 * each brand row are spread over the month's working days and added to those (submitted /
 * approved) weeks as entries plus approved time logs — brand time needs no approval. Task rows
 * can't change any more.
 */
async function addLateBrandHours(
  ctx: MonthContext,
  rows: Array<{ key: string; task: mongoose.Types.ObjectId | null; brand: mongoose.Types.ObjectId | null; project: mongoose.Types.ObjectId | null; note: string; minutes: number }>,
  actor: IUser
): Promise<{ added: number } | { status: number; error: string }> {
  const label = monthLabel(ctx.month);
  const current = new Map<string, number>();
  for (const sheet of ctx.sheets) {
    for (const e of sheet.entries) {
      if (ctx.days.has(dateKey(e.date))) current.set(rowKey(e), (current.get(rowKey(e)) ?? 0) + e.minutes);
    }
  }
  const workdays = ctx.allWorkdays;
  const perDay = new Map<string, Map<string, number>>();
  let added = 0;
  for (const row of rows) {
    const extra = row.minutes - (current.get(row.key) ?? 0);
    if (extra === 0) continue;
    if (row.task) {
      return { status: 409, error: `Every week of ${label} is already submitted — task hours can't change any more. You can still add brand hours.` };
    }
    if (extra < 0) {
      return { status: 400, error: `Every week of ${label} is already submitted — brand hours can only be added, not lowered` };
    }
    const steps = Math.floor(extra / STEP);
    const days = new Map<string, number>();
    workdays.forEach((day, i) => {
      const minutes = Math.floor(steps / workdays.length) * STEP + (i < steps % workdays.length ? STEP : 0) + (i === 0 ? extra % STEP : 0);
      if (minutes > 0) days.set(day, minutes);
    });
    perDay.set(row.key, days);
    added += extra;
  }
  if (added === 0) return { status: 400, error: "Add a brand and its hours first" };

  const changes: Array<{ sheet: IWeeklyTimesheet; added: Array<{ task: null; brand: mongoose.Types.ObjectId; project: mongoose.Types.ObjectId | null; note: string; date: Date; minutes: number }> }> = [];
  for (const sheet of ctx.sheets) {
    const add = weekDays(sheet.weekStart).flatMap((day) =>
      rows.flatMap((row) => {
        const minutes = perDay.get(row.key)?.get(day) ?? 0;
        return minutes > 0 && row.brand
          ? [{ task: null, brand: row.brand, project: row.project, note: row.note, date: new Date(`${day}T00:00:00.000Z`), minutes }]
          : [];
      })
    );
    if (add.length === 0) continue;
    const dayTotals = new Map<string, number>();
    for (const e of [...sheet.entries, ...add]) dayTotals.set(dateKey(e.date), (dayTotals.get(dateKey(e.date)) ?? 0) + e.minutes);
    const over = [...dayTotals].find(([, minutes]) => minutes > 1440);
    if (over) {
      const day = formatDueDate(new Date(`${over[0]}T00:00:00.000Z`)) ?? over[0];
      return { status: 400, error: `That's more than 24 hours on ${day} — lower the totals` };
    }
    if (sheet.entries.length + add.length > MAX_ENTRIES) return { status: 400, error: "Too many rows in one week" };
    changes.push({ sheet, added: add });
  }

  for (const { sheet, added: add } of changes) {
    // Time logs start after the hours already on each day (as on submit, from 09:00).
    const offsetByDay = new Map<string, number>();
    for (const e of sheet.entries) offsetByDay.set(dateKey(e.date), (offsetByDay.get(dateKey(e.date)) ?? 0) + e.minutes);
    const docs = [];
    for (const entry of add) {
      const day = dateKey(entry.date);
      const offset = offsetByDay.get(day) ?? 0;
      const start = new Date(appTimeOn(day, DAY_START).getTime() + offset * 60_000);
      offsetByDay.set(day, offset + entry.minutes);
      const rate = await resolveHourlyRate(actor._id, entry.project ? (await Project.find({ _id: entry.project }).select("members"))[0] : null);
      docs.push({
        user: actor._id,
        project: entry.project,
        task: null,
        brand: entry.brand,
        startTime: start,
        endTime: new Date(start.getTime() + entry.minutes * 60_000),
        durationMinutes: entry.minutes,
        breakMinutes: 0,
        memo: entry.note || `Weekly timesheet ${dateKey(sheet.weekStart)}`,
        source: "timesheet",
        hourlyRate: rate,
        earnings: computeEarnings(rate, entry.minutes),
        status: "approved",
        reviewedAt: new Date(),
        weeklyTimesheet: sheet._id,
        addedBy: actor._id,
      });
    }
    await WeeklyTimesheet.updateOne({ _id: sheet._id }, { $push: { entries: { $each: add } } });
    await TimeLog.insertMany(docs);
    pushTimesheetUpdate(sheet, "updated", actor.department);
  }
  return { added };
}

/** `{ month, label, weeks, tasks, brands, rows, … }` for the month form. */
async function monthResponse(ctx: MonthContext, actor: IUser) {
  const rows = new Map<
    string,
    { task: string | null; brand: string | null; project: string | null; note: string; minutes: number; lockedMinutes: number }
  >();
  for (const sheet of ctx.sheets) {
    for (const e of sheet.entries) {
      if (!ctx.days.has(dateKey(e.date))) continue;
      const key = rowKey(e);
      const row = rows.get(key) ?? {
        task: e.task ? String(e.task) : null,
        brand: e.brand ? String(e.brand) : null,
        project: e.project ? String(e.project) : null,
        note: "",
        minutes: 0,
        lockedMinutes: 0,
      };
      row.minutes += e.minutes;
      if (!isEditable(sheet)) row.lockedMinutes += e.minutes;
      if (e.note && !row.note) row.note = e.note;
      rows.set(key, row);
    }
  }
  const brandIds = [...rows.values()].flatMap((r) => (r.brand ? [r.brand] : []));
  const brands = brandIds.length ? await Brand.find({ _id: { $in: brandIds } }).select("name organisation").lean() : [];
  const canLogBrands = await canLogBrandTime(actor);
  return {
    month: ctx.month,
    label: monthLabel(ctx.month),
    workdays: ctx.workdays,
    editableWorkdays: ctx.editableWorkdays.length,
    weeks: ctx.sheets.map((s) => ({ _id: s._id, weekStart: dateKey(s.weekStart), status: s.status })),
    tasks: await loggableTasks(actor._id, ctx.sheets.flatMap(sheetTaskIds), canLogBrands),
    brands: brands.map((b) => ({ _id: b._id, name: b.name, organisation: (b as { organisation?: string }).organisation ?? "" })),
    rows: [...rows.values()],
    brandProjects: await brandProjects(canLogBrands ? [ctx.month] : [], ctx.sheets.flatMap((s) => entryProjectIds(s.entries))),
    // Brands from the user's manpower allocation: listed with 0 hours.
    assignedBrands: canLogBrands ? await assignedBrands(actor._id, [ctx.month]) : [],
    canLogBrands,
  };
}

function parseMonth(raw: unknown): string | null {
  return typeof raw === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) ? raw : null;
}

/** GET /api/timesheets/month?month=YYYY-MM — my hours for the catch-up month, per task / brand. */
export async function getMonth(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const month = req.query.month === undefined || req.query.month === "" ? catchUpMonth() : parseMonth(req.query.month);
  if (!month || month !== catchUpMonth()) {
    res.status(400).json({ error: `Only ${monthLabel(catchUpMonth())} can be logged as a whole month` });
    return;
  }
  res.json(await monthResponse(await monthContext(actor._id, month), actor));
}

/**
 * PUT /api/timesheets/month — `{ month, rows: [{ task | brand, project?, minutes, note? }], submit? }`:
 * each row's month total is spread over the editable working days (rows not sent are left
 * as they are). With `submit`, every ended week of the month that has hours is submitted.
 */
export async function saveMonth(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const body = (req.body ?? {}) as { month?: unknown; rows?: unknown; submit?: unknown };
  const month = parseMonth(body.month);
  if (!month || month !== catchUpMonth()) {
    res.status(400).json({ error: `Only ${monthLabel(catchUpMonth())} can be logged as a whole month` });
    return;
  }
  if (!Array.isArray(body.rows) || body.rows.length > 100) {
    res.status(400).json({ error: "rows must be an array of at most 100 rows" });
    return;
  }

  const rows: Array<{
    key: string;
    task: mongoose.Types.ObjectId | null;
    brand: mongoose.Types.ObjectId | null;
    project: mongoose.Types.ObjectId | null;
    note: string;
    minutes: number;
  }> = [];
  for (const item of body.rows) {
    const { task, brand, project, note, minutes } = (item ?? {}) as {
      task?: unknown;
      brand?: unknown;
      project?: unknown;
      note?: unknown;
      minutes?: unknown;
    };
    const taskId = typeof task === "string" && task ? task : null;
    const brandId = typeof brand === "string" && brand ? brand : null;
    const projectId = brandId && typeof project === "string" && project ? project : null;
    if ((taskId ? 1 : 0) + (brandId ? 1 : 0) !== 1 || isInvalidObjectId(taskId ?? brandId ?? "") || (projectId && isInvalidObjectId(projectId))) {
      res.status(400).json({ error: "Each row needs a valid task or brand (not both)" });
      return;
    }
    if (note !== undefined && (typeof note !== "string" || note.trim().length > 300)) {
      res.status(400).json({ error: "A note must be 300 characters or fewer" });
      return;
    }
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 0 || minutes > MONTH_MAX_MINUTES) {
      res.status(400).json({ error: "minutes must be a whole number of minutes for the month" });
      return;
    }
    const ids = {
      task: taskId ? new mongoose.Types.ObjectId(taskId) : null,
      brand: brandId ? new mongoose.Types.ObjectId(brandId) : null,
      project: projectId ? new mongoose.Types.ObjectId(projectId) : null,
    };
    const key = rowKey(ids);
    if (rows.some((r) => r.key === key)) {
      res.status(400).json({ error: "Each task or brand / project can appear once" });
      return;
    }
    rows.push({ ...ids, key, note: brandId && typeof note === "string" ? note.trim() : "", minutes });
  }

  const ctx = await monthContext(actor._id, month);

  // Tasks: open tasks assigned to the user (or already on these weeks).
  const allowed = new Set(
    (await loggableTasks(actor._id, ctx.sheets.flatMap(sheetTaskIds), await canLogBrandTime(actor))).map((t) => String((t as { _id: unknown })._id))
  );
  const invalid = rows.find((r) => r.task && r.minutes > 0 && !allowed.has(r.task.toString()));
  if (invalid) {
    res.status(400).json({ error: "You can only log time on open tasks assigned to you", task: invalid.task!.toString() });
    return;
  }
  // Brands: Program / CM / leadership, on active approved brands (or brands already on these weeks).
  const brandIds = [...new Set(rows.flatMap((r) => (r.brand && r.minutes > 0 ? [r.brand.toString()] : [])))];
  if (brandIds.length) {
    if (!(await canLogBrandTime(actor))) {
      res.status(403).json({ error: "Only Program, CM and leadership can log time on a brand. Log it on a task instead." });
      return;
    }
    const known = [...new Set(ctx.sheets.flatMap((s) => s.entries.flatMap((e) => (e.brand ? [e.brand.toString()] : []))))];
    const usable = await Brand.find({
      _id: { $in: brandIds },
      $or: [{ _id: { $in: known } }, { active: true, $or: [{ status: { $exists: false } }, { status: "approved" }] }],
    })
      .select("_id")
      .lean();
    if (usable.length !== brandIds.length) {
      res.status(400).json({ error: "Pick an active brand" });
      return;
    }
    const projectError = await checkBrandProjects(
      rows.filter((r) => r.minutes > 0),
      [month],
      ctx.sheets.flatMap((s) => entryProjectIds(s.entries))
    );
    if (projectError) {
      res.status(400).json({ error: projectError });
      return;
    }
  }

  // Every week of the month is submitted: brand hours (no approval needed) can still be added —
  // the extra is spread over the month's working days in the submitted / approved weeks.
  if (ctx.editableWorkdays.length === 0) {
    const result = await addLateBrandHours(ctx, rows, actor);
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    logActivity({
      action: "timesheet_month_logged",
      actor,
      targetType: "timesheet",
      targetId: actor._id,
      targetName: `${actor.name} · ${monthLabel(month)}`,
      details: { rows: rows.length, addedMinutes: result.added, lateBrandHours: true },
      ip: req.ip,
    });
    res.json({ ...(await monthResponse(await monthContext(actor._id, month), actor)), submittedWeeks: 0 });
    return;
  }

  // Hours already in submitted / approved weeks stay; the rest is spread over the editable working days.
  const workdays = ctx.editableWorkdays;
  const lockedEntries = ctx.sheets.filter((s) => !isEditable(s)).flatMap((s) => s.entries);
  const perDay = new Map<string, Map<string, number>>(); // row key → day → minutes
  for (const row of rows) {
    const locked = lockedEntries
      .filter((e) => rowKey(e) === row.key && ctx.days.has(dateKey(e.date)))
      .reduce((sum, e) => sum + e.minutes, 0);
    const remaining = row.minutes - locked;
    if (remaining < 0) {
      res.status(400).json({ error: `A row already has ${formatMinutes(locked)} in submitted weeks — its month total can't be lower` });
      return;
    }
    if (remaining > 0 && workdays.length === 0) {
      res.status(409).json({ error: `Every week of ${monthLabel(month)} is already submitted` });
      return;
    }
    const steps = Math.floor(remaining / STEP);
    const days = new Map<string, number>();
    workdays.forEach((day, i) => {
      const minutes =
        Math.floor(steps / workdays.length) * STEP + (i < steps % workdays.length ? STEP : 0) + (i === 0 ? remaining % STEP : 0);
      if (minutes > 0) days.set(day, minutes);
    });
    perDay.set(row.key, days);
  }

  // Rebuild the editable weeks: the sent rows' month days are replaced, everything else stays.
  const changed: IWeeklyTimesheet[] = [];
  for (const sheet of ctx.sheets.filter(isEditable)) {
    const kept = sheet.entries
      .filter((e) => !(perDay.has(rowKey(e)) && ctx.days.has(dateKey(e.date))))
      .map((e) => ({ task: e.task ?? null, brand: e.brand ?? null, project: e.project ?? null, note: e.note ?? "", date: e.date, minutes: e.minutes }));
    const added = weekDays(sheet.weekStart).flatMap((day) =>
      rows.flatMap((row) => {
        const minutes = perDay.get(row.key)?.get(day) ?? 0;
        return minutes > 0
          ? [{ task: row.task, brand: row.brand, project: row.project, note: row.note, date: new Date(`${day}T00:00:00.000Z`), minutes }]
          : [];
      })
    );
    const entries = [...kept, ...added];
    const dayTotals = new Map<string, number>();
    for (const e of entries) dayTotals.set(dateKey(e.date), (dayTotals.get(dateKey(e.date)) ?? 0) + e.minutes);
    const over = [...dayTotals].find(([, minutes]) => minutes > 1440);
    if (over) {
      const day = formatDueDate(new Date(`${over[0]}T00:00:00.000Z`)) ?? over[0];
      res.status(400).json({ error: `That's more than 24 hours on ${day} — lower the totals` });
      return;
    }
    if (entries.length > MAX_ENTRIES) {
      res.status(400).json({ error: "Too many rows in one week" });
      return;
    }
    sheet.set("entries", entries);
    changed.push(sheet);
  }
  for (const sheet of changed) await sheet.save();

  let submittedWeeks = 0;
  if (body.submit === true) {
    const today = appToday();
    const toApprove: IWeeklyTimesheet[] = [];
    for (const sheet of changed) {
      // Only weeks that have ended, with hours on them.
      if (sheet.entries.length === 0 || addDays(sheet.weekStart, 7) > today) continue;
      const submitted = await submitSheet(sheet, actor);
      if (!submitted) continue;
      submittedWeeks++;
      if (submitted.status === "submitted") toApprove.push(submitted);
    }
    notifySubmitted(actor, toApprove);
  }

  logActivity({
    action: "timesheet_month_logged",
    actor,
    targetType: "timesheet",
    targetId: actor._id,
    targetName: `${actor.name} · ${monthLabel(month)}`,
    details: { rows: rows.length, minutes: rows.reduce((sum, r) => sum + r.minutes, 0), submittedWeeks },
    ip: req.ip,
  });
  res.json({ ...(await monthResponse(await monthContext(actor._id, month), actor)), submittedWeeks });
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
  // Brand hours need no approval: only the task rows' logs go (a resubmit rebuilds them all).
  const logs = await TimeLog.find({ weeklyTimesheet: sheetId, brand: null }).select("user project status");
  await TimeLog.deleteMany({ weeklyTimesheet: sheetId, brand: null });
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
