import type { Request, Response } from "express";
import mongoose from "mongoose";
import { addDays, appDayStart, appToday, zonedParts } from "../lib/appTime.js";
import { parsePagination } from "../lib/pagination.js";
import { departmentUserIds, isInvalidObjectId } from "../lib/projectAccess.js";
import { parseDateOnly } from "../lib/taskAccess.js";
import { appDateKey, appTimeZone } from "../lib/taskJobs.js";
import { Project } from "../models/Project.js";
import { Task, TASK_PRIORITIES, TASK_STATUSES } from "../models/Task.js";
import { TimeLog, TIMELOG_STATUSES } from "../models/TimeLog.js";
import type { TimeLogStatus } from "../models/TimeLog.js";
import type { IUser } from "../models/User.js";
import { User } from "../models/User.js";
import { TIMESHEET_STATUSES, WeeklyTimesheet } from "../models/WeeklyTimesheet.js";
import type { TimesheetStatus } from "../models/WeeklyTimesheet.js";
import { canReviewTimesheet, timesheetTotalMinutes } from "./timesheets.js";

// ---------------------------------------------------------------------------
// Shared helpers — head = own department only; admin = everything
// ---------------------------------------------------------------------------

interface Invalid {
  status: number;
  error: string;
}

function isInvalid(value: unknown): value is Invalid {
  return typeof value === "object" && value !== null && "error" in value && "status" in value;
}

const EXPORT_LIMIT = 50_000;

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `from`/`to` (YYYY-MM-DD, inclusive). Defaults: first of the current month → today. */
function parseRange(req: Request, defaults = true): { from: Date | null; to: Date | null } | Invalid {
  const today = appToday();
  let from: Date | null = defaults ? new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)) : null;
  let to: Date | null = defaults ? today : null;
  if (req.query.from !== undefined && req.query.from !== "") {
    from = parseDateOnly(req.query.from);
    if (!from) return { status: 400, error: "from must be a valid date (YYYY-MM-DD)" };
  }
  if (req.query.to !== undefined && req.query.to !== "") {
    to = parseDateOnly(req.query.to);
    if (!to) return { status: 400, error: "to must be a valid date (YYYY-MM-DD)" };
  }
  if (from && to && from.getTime() > to.getTime()) return { status: 400, error: "from must be on or before to" };
  return { from, to };
}

function optionalId(req: Request, name: string): mongoose.Types.ObjectId | null | Invalid {
  const raw = req.query[name];
  if (raw === undefined || raw === "") return null;
  if (typeof raw !== "string" || isInvalidObjectId(raw)) return { status: 400, error: `${name} must be a valid ID` };
  return new mongoose.Types.ObjectId(raw);
}

/**
 * Users in scope for person-based reports: head → their department; admin →
 * everyone, or `department`. `null` = no restriction.
 */
async function userScope(actor: IUser, department: mongoose.Types.ObjectId | null): Promise<mongoose.Types.ObjectId[] | null | Invalid> {
  if (actor.role === "head") {
    if (!actor.department) return [];
    if (department && !department.equals(actor.department)) {
      return { status: 403, error: "Heads can only report on their own department" };
    }
    return departmentUserIds(actor.department);
  }
  if (department) return departmentUserIds(department);
  return null;
}

/** Excel-friendly CSV: BOM, CRLF, quoted cells, formula-injection guard. */
function toCsv(header: string[], rows: Array<Array<string | number | null | undefined>>): string {
  const cell = (value: string | number | null | undefined): string => {
    let text = value === null || value === undefined ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(text) && typeof value === "string") text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return "﻿" + [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

function sendCsv(res: Response, filename: string, csv: string): void {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
}

/** "YYYY-MM-DD HH:mm" in the app timezone. */
function localDateTime(date: Date | null | undefined): string {
  if (!date) return "";
  const p = zonedParts(date);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

function hours(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Time log report — GET /api/reports/time/summary | /export
// ---------------------------------------------------------------------------

const GROUP_BY = ["user", "project", "task", "day"] as const;
type GroupBy = (typeof GROUP_BY)[number];

async function timeFilter(req: Request): Promise<{ match: Record<string, unknown>; from: Date | null; to: Date | null } | Invalid> {
  const actor = req.user!;
  const range = parseRange(req);
  if (isInvalid(range)) return range;
  const department = optionalId(req, "department");
  if (isInvalid(department)) return department;
  const project = optionalId(req, "project");
  if (isInvalid(project)) return project;
  const user = optionalId(req, "user");
  if (isInvalid(user)) return user;
  const scope = await userScope(actor, department);
  if (isInvalid(scope)) return scope;

  const and: Record<string, unknown>[] = [{ endTime: { $ne: null } }];
  const status = req.query.status;
  if (status !== undefined && status !== "") {
    if (typeof status !== "string" || !TIMELOG_STATUSES.includes(status as TimeLogStatus)) {
      return { status: 400, error: "status must be one of: pending, approved, rejected" };
    }
    and.push({ status });
  } else {
    and.push({ status: { $in: ["pending", "approved"] } });
  }
  // Day boundary: logs are reported by their start date (app timezone).
  if (range.from) and.push({ startTime: { $gte: appDayStart(range.from) } });
  if (range.to) and.push({ startTime: { $lt: appDayStart(addDays(range.to, 1)) } });
  if (scope) and.push({ user: { $in: scope } });
  if (user) and.push({ user });
  if (project) and.push({ project });
  return { match: { $and: and }, from: range.from, to: range.to };
}

/** GET /api/reports/time/summary?from&to&groupBy=user|project|task|day&project&user&department&status */
export async function timeSummary(req: Request, res: Response): Promise<void> {
  const groupBy = (typeof req.query.groupBy === "string" && req.query.groupBy ? req.query.groupBy : "user") as GroupBy;
  if (!GROUP_BY.includes(groupBy)) {
    res.status(400).json({ error: "groupBy must be one of: user, project, task, day" });
    return;
  }
  const filter = await timeFilter(req);
  if (isInvalid(filter)) {
    res.status(filter.status).json({ error: filter.error });
    return;
  }

  const groupKey =
    groupBy === "day"
      ? { $dateToString: { format: "%Y-%m-%d", date: "$startTime", timezone: appTimeZone() } }
      : `$${groupBy}`;
  const rows = await TimeLog.aggregate<{ _id: unknown; minutes: number; earnings: number; count: number }>([
    { $match: filter.match },
    { $group: { _id: groupKey, minutes: { $sum: "$durationMinutes" }, earnings: { $sum: "$earnings" }, count: { $sum: 1 } } },
  ]);

  const ids = rows.map((r) => r._id).filter((id): id is mongoose.Types.ObjectId => id instanceof mongoose.Types.ObjectId);
  const labels = new Map<string, { label: string; sublabel?: string | null }>();
  if (groupBy === "user") {
    for (const u of await User.find({ _id: { $in: ids } }).select("name email").lean()) {
      labels.set(u._id.toString(), { label: u.name, sublabel: u.email });
    }
  } else if (groupBy === "project") {
    for (const p of await Project.find({ _id: { $in: ids } }).select("name code").lean()) {
      labels.set(p._id.toString(), { label: p.name, sublabel: p.code });
    }
  } else if (groupBy === "task") {
    for (const t of await Task.find({ _id: { $in: ids } }).select("title shortCode").lean()) {
      labels.set(t._id.toString(), { label: t.title, sublabel: t.shortCode ?? null });
    }
  }

  const result = rows.map((r) => {
    const key = r._id === null || r._id === undefined ? null : String(r._id);
    const label =
      groupBy === "day"
        ? { label: key ?? "", sublabel: null }
        : (key && labels.get(key)) || { label: key ? "(deleted)" : groupBy === "project" ? "No project" : "No task", sublabel: null };
    return {
      key,
      label: label.label,
      sublabel: label.sublabel ?? null,
      minutes: r.minutes,
      hours: hours(r.minutes),
      earnings: Math.round(r.earnings * 100) / 100,
      count: r.count,
    };
  });
  if (groupBy === "day") result.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  else result.sort((a, b) => b.minutes - a.minutes);

  const totals = result.reduce(
    (acc, r) => ({ minutes: acc.minutes + r.minutes, earnings: acc.earnings + r.earnings, count: acc.count + r.count }),
    { minutes: 0, earnings: 0, count: 0 }
  );
  res.json({
    from: filter.from ? dateKey(filter.from) : null,
    to: filter.to ? dateKey(filter.to) : null,
    groupBy,
    rows: result,
    totals: { ...totals, hours: hours(totals.minutes), earnings: Math.round(totals.earnings * 100) / 100 },
  });
}

/** GET /api/reports/time/export?… — one CSV row per time log. */
export async function timeExport(req: Request, res: Response): Promise<void> {
  const filter = await timeFilter(req);
  if (isInvalid(filter)) {
    res.status(filter.status).json({ error: filter.error });
    return;
  }
  const logs = await TimeLog.find(filter.match)
    .populate("user", "name email")
    .populate("project", "name code")
    .populate("task", "title shortCode")
    .sort({ startTime: 1 })
    .limit(EXPORT_LIMIT)
    .lean();
  type Ref = { name?: string; email?: string; code?: string; title?: string; shortCode?: string } | null;
  const csv = toCsv(
    ["Date", "Employee", "Email", "Project code", "Project", "Task code", "Task", "Start", "End", "Hours", "Break (min)", "Earnings", "Status", "Source", "Memo"],
    logs.map((l) => {
      const user = l.user as unknown as Ref;
      const project = l.project as unknown as Ref;
      const task = l.task as unknown as Ref;
      return [
        appDateKey(l.startTime),
        user?.name ?? "",
        user?.email ?? "",
        project?.code ?? "",
        project?.name ?? "",
        task?.shortCode ?? "",
        task?.title ?? "",
        localDateTime(l.startTime),
        localDateTime(l.endTime ?? null),
        hours(l.durationMinutes),
        l.breakMinutes,
        l.earnings,
        l.status,
        l.source,
        l.memo,
      ];
    })
  );
  sendCsv(res, `time-report-${filter.from ? dateKey(filter.from) : "all"}-${filter.to ? dateKey(filter.to) : "all"}.csv`, csv);
}

// ---------------------------------------------------------------------------
// Task report — GET /api/reports/tasks/summary | /export
// ---------------------------------------------------------------------------

interface LeanTask {
  _id: mongoose.Types.ObjectId;
  title: string;
  shortCode?: string | null;
  status: string;
  priority: string;
  assignees: Array<{ _id: mongoose.Types.ObjectId; name: string; email: string }>;
  department?: { _id: mongoose.Types.ObjectId; name: string } | null;
  project?: { _id: mongoose.Types.ObjectId; name: string; code: string } | null;
  startDate?: Date | null;
  dueDate?: Date | null;
  completedAt?: Date | null;
  createdAt: Date;
}

/**
 * Same visibility as the task list: archived projects' tasks are hidden unless
 * `project` is given. Range applies to `createdAt` (app timezone). Heads see
 * their department's tasks.
 */
async function loadReportTasks(
  req: Request
): Promise<{ tasks: LeanTask[]; from: Date | null; to: Date | null; members: Set<string> | null } | Invalid> {
  const actor = req.user!;
  const range = parseRange(req, false);
  if (isInvalid(range)) return range;
  const department = optionalId(req, "department");
  if (isInvalid(department)) return department;
  const project = optionalId(req, "project");
  if (isInvalid(project)) return project;
  const user = optionalId(req, "user");
  if (isInvalid(user)) return user;

  const and: Record<string, unknown>[] = [];
  // A department's tasks: `task.department` (first assignee's) or any assignee
  // from it. Per-employee rows are then limited to that department's members.
  let scopeDepartment: mongoose.Types.ObjectId | null = department;
  if (actor.role === "head") {
    if (!actor.department) return { tasks: [], from: range.from, to: range.to, members: new Set() };
    if (department && !department.equals(actor.department)) {
      return { status: 403, error: "Heads can only report on their own department" };
    }
    scopeDepartment = actor.department;
  }
  let members: Set<string> | null = null;
  if (scopeDepartment) {
    const ids = await departmentUserIds(scopeDepartment);
    members = new Set(ids.map((id) => id.toString()));
    and.push({ $or: [{ department: scopeDepartment }, ...(ids.length > 0 ? [{ assignees: { $in: ids } }] : [])] });
  }
  if (project) {
    and.push({ project });
  } else {
    const archived = await Project.find({ archivedAt: { $ne: null } }).select("_id").lean();
    if (archived.length > 0) and.push({ project: { $nin: archived.map((p) => p._id) } });
  }
  if (user) and.push({ assignees: user });
  if (range.from) and.push({ createdAt: { $gte: appDayStart(range.from) } });
  if (range.to) and.push({ createdAt: { $lt: appDayStart(addDays(range.to, 1)) } });
  const priority = req.query.priority;
  if (priority !== undefined && priority !== "") {
    if (typeof priority !== "string" || !(TASK_PRIORITIES as readonly string[]).includes(priority)) {
      return { status: 400, error: "priority must be one of: low, medium, high, urgent" };
    }
    and.push({ priority });
  }

  const tasks = await Task.find(and.length > 0 ? { $and: and } : {})
    .select("title shortCode status priority assignees department project startDate dueDate completedAt createdAt")
    .populate("assignees", "name email")
    .populate("department", "name")
    .populate("project", "name code")
    .sort({ createdAt: -1 })
    .limit(EXPORT_LIMIT)
    .lean<LeanTask[]>();
  return { tasks, from: range.from, to: range.to, members };
}

/** "on_time" | "late" | null for a completed task with a due date (date-only, app timezone). */
function timeliness(task: LeanTask): "on_time" | "late" | null {
  if (task.status !== "completed" || !task.dueDate || !task.completedAt) return null;
  return appDateKey(task.completedAt) <= dateKey(task.dueDate) ? "on_time" : "late";
}

/** GET /api/reports/tasks/summary?from&to&project&user&department&priority */
export async function taskSummary(req: Request, res: Response): Promise<void> {
  const loaded = await loadReportTasks(req);
  if (isInvalid(loaded)) {
    res.status(loaded.status).json({ error: loaded.error });
    return;
  }
  const { tasks } = loaded;
  const todayKey = dateKey(appToday());
  const isOverdue = (t: LeanTask) => t.status !== "completed" && Boolean(t.dueDate) && dateKey(t.dueDate!) < todayKey;

  const byStatus = new Map<string, number>(TASK_STATUSES.map((s) => [s, 0]));
  const byPriority = new Map<string, number>(TASK_PRIORITIES.map((p) => [p, 0]));
  const byEmployee = new Map<string, { userId: string; name: string; email: string; total: number; completed: number; overdue: number; onTime: number; late: number }>();
  const byProject = new Map<string, { projectId: string | null; name: string; code: string | null; total: number; completed: number; overdue: number }>();
  let completed = 0;
  let onTime = 0;
  let late = 0;
  let overdue = 0;

  for (const t of tasks) {
    byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);
    byPriority.set(t.priority, (byPriority.get(t.priority) ?? 0) + 1);
    const done = t.status === "completed";
    const over = isOverdue(t);
    const when = timeliness(t);
    if (done) completed++;
    if (over) overdue++;
    if (when === "on_time") onTime++;
    if (when === "late") late++;
    for (const a of t.assignees ?? []) {
      if (!a) continue;
      const key = a._id.toString();
      // Department-scoped reports: only that department's people get a row.
      if (loaded.members && !loaded.members.has(key)) continue;
      const row = byEmployee.get(key) ?? { userId: key, name: a.name, email: a.email, total: 0, completed: 0, overdue: 0, onTime: 0, late: 0 };
      row.total++;
      if (done) row.completed++;
      if (over) row.overdue++;
      if (when === "on_time") row.onTime++;
      if (when === "late") row.late++;
      byEmployee.set(key, row);
    }
    const pKey = t.project ? t.project._id.toString() : "none";
    const prow = byProject.get(pKey) ?? {
      projectId: t.project ? pKey : null,
      name: t.project?.name ?? "No project",
      code: t.project?.code ?? null,
      total: 0,
      completed: 0,
      overdue: 0,
    };
    prow.total++;
    if (done) prow.completed++;
    if (over) prow.overdue++;
    byProject.set(pKey, prow);
  }

  const overdueList = tasks
    .filter(isOverdue)
    .sort((a, b) => a.dueDate!.getTime() - b.dueDate!.getTime())
    .slice(0, 100)
    .map((t) => ({
      _id: t._id,
      title: t.title,
      shortCode: t.shortCode ?? null,
      status: t.status,
      priority: t.priority,
      dueDate: t.dueDate,
      daysOverdue: Math.round((appToday().getTime() - t.dueDate!.getTime()) / 86_400_000),
      assignees: (t.assignees ?? []).filter(Boolean).map((a) => ({ _id: a._id, name: a.name })),
      project: t.project ? { _id: t.project._id, name: t.project.name, code: t.project.code } : null,
    }));

  res.json({
    from: loaded.from ? dateKey(loaded.from) : null,
    to: loaded.to ? dateKey(loaded.to) : null,
    totals: {
      total: tasks.length,
      completed,
      open: tasks.length - completed,
      overdue,
      completionRate: tasks.length === 0 ? 0 : Math.round((completed / tasks.length) * 1000) / 10,
      onTime,
      late,
    },
    byStatus: [...byStatus].map(([status, count]) => ({ status, count })),
    byPriority: [...byPriority].map(([priority, count]) => ({ priority, count })),
    byEmployee: [...byEmployee.values()].sort((a, b) => b.total - a.total),
    byProject: [...byProject.values()].sort((a, b) => b.total - a.total),
    overdue: overdueList,
  });
}

/** GET /api/reports/tasks/export?… — one CSV row per task. */
export async function taskExport(req: Request, res: Response): Promise<void> {
  const loaded = await loadReportTasks(req);
  if (isInvalid(loaded)) {
    res.status(loaded.status).json({ error: loaded.error });
    return;
  }
  const csv = toCsv(
    ["Code", "Title", "Project", "Status", "Priority", "Assignees", "Department", "Created", "Start", "Due", "Completed", "Timeliness"],
    loaded.tasks.map((t) => [
      t.shortCode ?? "",
      t.title,
      t.project ? `${t.project.code} · ${t.project.name}` : "",
      t.status,
      t.priority,
      (t.assignees ?? []).filter(Boolean).map((a) => a.name).join("; "),
      t.department?.name ?? "",
      appDateKey(t.createdAt),
      t.startDate ? dateKey(t.startDate) : "",
      t.dueDate ? dateKey(t.dueDate) : "",
      t.completedAt ? appDateKey(t.completedAt) : "",
      timeliness(t) ?? "",
    ])
  );
  sendCsv(res, `task-report-${loaded.from ? dateKey(loaded.from) : "all"}-${loaded.to ? dateKey(loaded.to) : "all"}.csv`, csv);
}

// ---------------------------------------------------------------------------
// Weekly timesheet report — GET /api/reports/timesheets | /export
// ---------------------------------------------------------------------------

async function timesheetFilter(req: Request): Promise<Record<string, unknown> | Invalid> {
  const actor = req.user!;
  const range = parseRange(req, false);
  if (isInvalid(range)) return range;
  const department = optionalId(req, "department");
  if (isInvalid(department)) return department;
  const user = optionalId(req, "user");
  if (isInvalid(user)) return user;
  const scope = await userScope(actor, department);
  if (isInvalid(scope)) return scope;

  const and: Record<string, unknown>[] = [];
  if (scope) and.push({ user: { $in: scope } });
  if (user) and.push({ user });
  // Range filters on weekStart (weeks starting within [from, to]).
  if (range.from) and.push({ weekStart: { $gte: range.from } });
  if (range.to) and.push({ weekStart: { $lte: range.to } });
  const status = req.query.status;
  if (status !== undefined && status !== "") {
    if (typeof status !== "string" || !TIMESHEET_STATUSES.includes(status as TimesheetStatus)) {
      return { status: 400, error: "status must be one of: draft, submitted, approved, rejected" };
    }
    and.push({ status });
  } else if (req.query.includeEmpty !== "true") {
    // Hide untouched lazily-created drafts.
    and.push({ $or: [{ status: { $ne: "draft" } }, { "entries.0": { $exists: true } }] });
  }
  return and.length > 0 ? { $and: and } : {};
}

/** GET /api/reports/timesheets?from&to&user&department&status — one row per employee per week. */
export async function timesheetReport(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const filter = await timesheetFilter(req);
  if (isInvalid(filter)) {
    res.status(filter.status).json({ error: filter.error });
    return;
  }
  const { limit, offset } = parsePagination(req);
  let query = WeeklyTimesheet.find(filter)
    .populate({ path: "user", select: "name email department", populate: { path: "department", select: "name" } })
    .populate("reviewedBy", "name")
    .sort({ weekStart: -1, createdAt: -1 });
  if (limit !== null) query = query.skip(offset).limit(limit);
  const [sheets, total] = await Promise.all([query, WeeklyTimesheet.countDocuments(filter)]);
  res.json({
    timesheets: sheets.map((s) => {
      const owner = s.user as unknown as { _id: mongoose.Types.ObjectId; department?: { _id: mongoose.Types.ObjectId } | null };
      const json = s.toJSON() as unknown as Record<string, unknown>;
      delete json.entries;
      return {
        ...json,
        weekStartKey: dateKey(s.weekStart),
        totalMinutes: timesheetTotalMinutes(s),
        entryCount: s.entries.length,
        canReview:
          s.status === "submitted" &&
          Boolean(owner?._id) &&
          canReviewTimesheet(actor, { _id: owner._id, department: owner.department?._id ?? null } as IUser),
      };
    }),
    total,
    limit,
    offset,
  });
}

/** GET /api/reports/timesheets/export?… */
export async function timesheetExport(req: Request, res: Response): Promise<void> {
  const filter = await timesheetFilter(req);
  if (isInvalid(filter)) {
    res.status(filter.status).json({ error: filter.error });
    return;
  }
  const sheets = await WeeklyTimesheet.find(filter)
    .populate({ path: "user", select: "name email department", populate: { path: "department", select: "name" } })
    .populate("reviewedBy", "name")
    .sort({ weekStart: -1 })
    .limit(EXPORT_LIMIT);
  const csv = toCsv(
    ["Employee", "Email", "Department", "Week start", "Total hours", "Status", "Submitted", "Reviewed", "Reviewer", "Reject reason"],
    sheets.map((s) => {
      const user = s.user as unknown as { name?: string; email?: string; department?: { name?: string } | null } | null;
      const reviewer = s.reviewedBy as unknown as { name?: string } | null;
      return [
        user?.name ?? "",
        user?.email ?? "",
        user?.department?.name ?? "",
        dateKey(s.weekStart),
        hours(timesheetTotalMinutes(s)),
        s.status,
        localDateTime(s.submittedAt ?? null),
        localDateTime(s.reviewedAt ?? null),
        reviewer?.name ?? "",
        s.rejectReason ?? "",
      ];
    })
  );
  sendCsv(res, "weekly-timesheets.csv", csv);
}
