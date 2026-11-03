import type { Request, Response } from "express";
import ExcelJS from "exceljs";
import mongoose from "mongoose";
import { addDays, appDayStart, appToday, zonedParts } from "../lib/appTime.js";
import { csvHours, toXlsx } from "../lib/csv.js";
import { parsePagination } from "../lib/pagination.js";
import { departmentUserIds, isInvalidObjectId } from "../lib/projectAccess.js";
import { parseDateOnly } from "../lib/taskAccess.js";
import { appDateKey, appTimeZone } from "../lib/taskJobs.js";
import { Department } from "../models/Department.js";
import { Brand } from "../models/Brand.js";
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

export interface Invalid {
  status: number;
  error: string;
}

export function isInvalid(value: unknown): value is Invalid {
  return typeof value === "object" && value !== null && "error" in value && "status" in value;
}

const EXPORT_LIMIT = 50_000;

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `from`/`to` (YYYY-MM-DD, inclusive). Defaults: first of the current month → today. */
export function parseRange(req: Request, defaults = true): { from: Date | null; to: Date | null } | Invalid {
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

export function optionalId(req: Request, name: string): mongoose.Types.ObjectId | null | Invalid {
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

/** Sends the rows as an Excel workbook (.xlsx) named `filename`. */
async function sendXlsx(res: Response, filename: string, header: string[], rows: Array<Array<string | number | null | undefined>>): Promise<void> {
  const body = await toXlsx(filename.replace(/\.xlsx$/, ""), header, rows);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  res.send(body);
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

const GROUP_BY = ["user", "project", "task", "day", "brand"] as const;
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

/**
 * GET /api/reports/time/summary?from&to&groupBy=user|project|task|day|brand&project&user&department&status
 * `brand`: a log counts for its own brand (brand time: Program / CM / leadership timesheet rows)
 * or its project's brand.
 */
export async function timeSummary(req: Request, res: Response): Promise<void> {
  const groupBy = (typeof req.query.groupBy === "string" && req.query.groupBy ? req.query.groupBy : "user") as GroupBy;
  if (!GROUP_BY.includes(groupBy)) {
    res.status(400).json({ error: "groupBy must be one of: user, project, task, day, brand" });
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
  const rows = await TimeLog.aggregate<{ _id: unknown; minutes: number; earnings: number; count: number; brandMinutes?: number }>([
    { $match: filter.match },
    ...(groupBy === "brand"
      ? [
          { $lookup: { from: "projects", localField: "project", foreignField: "_id", as: "_p", pipeline: [{ $project: { brand: 1 } }] } },
          { $addFields: { _brand: { $ifNull: ["$brand", { $arrayElemAt: ["$_p.brand", 0] }] } } },
          {
            $group: {
              _id: "$_brand",
              minutes: { $sum: "$durationMinutes" },
              earnings: { $sum: "$earnings" },
              count: { $sum: 1 },
              // Of which logged on the brand as a whole (not a task).
              brandMinutes: { $sum: { $cond: [{ $ifNull: ["$brand", false] }, "$durationMinutes", 0] } },
            },
          },
        ]
      : [{ $group: { _id: groupKey, minutes: { $sum: "$durationMinutes" }, earnings: { $sum: "$earnings" }, count: { $sum: 1 } } }]),
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
  } else if (groupBy === "brand") {
    for (const b of await Brand.find({ _id: { $in: ids } }).select("name organisation").lean()) {
      const org = (b.organisation ?? "").trim();
      labels.set(b._id.toString(), { label: org && org.toLowerCase() !== b.name.toLowerCase() ? `${org} › ${b.name}` : b.name });
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
        : (key && labels.get(key)) || {
            label: key ? "(deleted)" : groupBy === "project" ? "No project (incl. brand time)" : groupBy === "brand" ? "No brand" : "No task",
            sublabel: null,
          };
    const brandTime = groupBy === "brand" && r.brandMinutes ? `${hours(r.brandMinutes)} h logged on the brand directly` : null;
    return {
      key,
      label: label.label,
      sublabel: brandTime ?? label.sublabel ?? null,
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
  const sheet: [string[], Array<Array<string | number | null | undefined>>] = [
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
        csvHours(l.durationMinutes),
        l.breakMinutes,
        l.earnings,
        l.status,
        l.source,
        l.memo,
      ];
    })
  ];
  await sendXlsx(res, `time-report-${filter.from ? dateKey(filter.from) : "all"}-${filter.to ? dateKey(filter.to) : "all"}.xlsx`, ...sheet);
}

// ---------------------------------------------------------------------------
// Time log breakdown (employee › project › task) + Excel workbook
// ---------------------------------------------------------------------------

interface BreakdownRow {
  key: string | null;
  label: string;
  sublabel: string | null;
  minutes: number;
  hours: number;
  earnings: number;
  count: number;
}
/** Task row: the task's own details next to the hours this employee logged on it. */
interface BreakdownTask extends BreakdownRow {
  status: string | null;
  startDate: string | null;
  dueDate: string | null;
  completedAt: string | null;
  estimateMinutes: number | null;
  client: string | null;
}
interface BreakdownProject extends BreakdownRow {
  client: string | null;
  tasks: BreakdownTask[];
}
interface BreakdownEmployee extends BreakdownRow {
  projects: BreakdownProject[];
}

function sumInto(target: { minutes: number; earnings: number; count: number }, row: { minutes: number; earnings: number; count: number }) {
  target.minutes += row.minutes;
  target.earnings += row.earnings;
  target.count += row.count;
}

function dateOrNull(value: Date | null | undefined): string | null {
  return value ? dateKey(value) : null;
}

/** Hours per employee › project › task for a time-log filter, biggest first at every level. */
async function loadBreakdown(match: Record<string, unknown>): Promise<{ employees: BreakdownEmployee[]; totals: BreakdownRow }> {
  const rows = await TimeLog.aggregate<{
    _id: { user: mongoose.Types.ObjectId | null; project: mongoose.Types.ObjectId | null; task: mongoose.Types.ObjectId | null; brand?: mongoose.Types.ObjectId | null };
    minutes: number;
    earnings: number;
    count: number;
  }>([
    { $match: match },
    {
      $group: {
        _id: { user: "$user", project: "$project", task: "$task", brand: "$brand" },
        minutes: { $sum: "$durationMinutes" },
        earnings: { $sum: "$earnings" },
        count: { $sum: 1 },
      },
    },
  ]);
  const ids = (pick: "user" | "project" | "task" | "brand") =>
    [...new Set(rows.map((r) => r._id[pick]).filter((id): id is mongoose.Types.ObjectId => id instanceof mongoose.Types.ObjectId).map(String))].map(
      (id) => new mongoose.Types.ObjectId(id)
    );
  type ProjectLean = { _id: mongoose.Types.ObjectId; name: string; code?: string; brand?: { name?: string } | null };
  type TaskLean = {
    _id: mongoose.Types.ObjectId;
    title: string;
    shortCode?: string | null;
    number?: number | null;
    status?: string;
    startDate?: Date | null;
    dueDate?: Date | null;
    completedAt?: Date | null;
    estimateMinutes?: number | null;
  };
  const [users, projects, tasks, brands] = await Promise.all([
    User.find({ _id: { $in: ids("user") } }).select("name email").lean(),
    Project.find({ _id: { $in: ids("project") } }).select("name code brand").populate("brand", "name").lean<ProjectLean[]>(),
    Task.find({ _id: { $in: ids("task") } })
      .select("title shortCode number status startDate dueDate completedAt estimateMinutes")
      .lean<TaskLean[]>(),
    Brand.find({ _id: { $in: ids("brand") } }).select("name organisation").lean(),
  ]);
  const userLabel = new Map(users.map((u) => [u._id.toString(), { label: u.name, sublabel: u.email ?? null }]));
  const projectInfo = new Map(projects.map((p) => [p._id.toString(), { label: p.name, sublabel: p.code ?? null, client: p.brand?.name ?? null }]));
  const taskInfo = new Map(tasks.map((t) => [t._id.toString(), t]));
  // Brand time (no project): its own row per brand, "Brand time · ENOC › Zoom".
  for (const b of brands) {
    const org = (b.organisation ?? "").trim();
    const name = org && org.toLowerCase() !== b.name.toLowerCase() ? `${org} › ${b.name}` : b.name;
    projectInfo.set(`brand:${b._id.toString()}`, { label: `Brand time · ${name}`, sublabel: null, client: b.name });
  }

  const employees = new Map<string, BreakdownEmployee>();
  for (const r of rows) {
    const uKey = r._id.user ? String(r._id.user) : null;
    const pKey = r._id.project ? String(r._id.project) : r._id.brand ? `brand:${String(r._id.brand)}` : null;
    const tKey = r._id.task ? String(r._id.task) : null;
    const uid = uKey ?? "none";
    let emp = employees.get(uid);
    if (!emp) {
      const l = (uKey && userLabel.get(uKey)) || { label: uKey ? "(deleted user)" : "No employee", sublabel: null };
      emp = { key: uKey, ...l, minutes: 0, hours: 0, earnings: 0, count: 0, projects: [] };
      employees.set(uid, emp);
    }
    let proj = emp.projects.find((p) => p.key === pKey);
    if (!proj) {
      const info = (pKey && projectInfo.get(pKey)) || { label: pKey ? "(deleted project)" : "No project", sublabel: null, client: null };
      proj = { key: pKey, label: info.label, sublabel: info.sublabel, client: info.client, minutes: 0, hours: 0, earnings: 0, count: 0, tasks: [] };
      emp.projects.push(proj);
    }
    const t = tKey ? taskInfo.get(tKey) : undefined;
    const task: BreakdownTask = {
      key: tKey,
      label: t ? t.title : tKey ? "(deleted task)" : "No task",
      sublabel: t ? (t.shortCode ?? (t.number ? `#${t.number}` : null)) : null,
      minutes: r.minutes,
      hours: hours(r.minutes),
      earnings: Math.round(r.earnings * 100) / 100,
      count: r.count,
      status: t?.status ?? null,
      startDate: dateOrNull(t?.startDate),
      dueDate: dateOrNull(t?.dueDate),
      completedAt: t?.completedAt ? appDateKey(t.completedAt) : null,
      estimateMinutes: t?.estimateMinutes ?? null,
      client: proj.client,
    };
    proj.tasks.push(task);
    sumInto(proj, task);
    sumInto(emp, task);
  }
  const totals: BreakdownRow = { key: null, label: "Total", sublabel: null, minutes: 0, hours: 0, earnings: 0, count: 0 };
  const finish = (row: BreakdownRow) => {
    row.hours = hours(row.minutes);
    row.earnings = Math.round(row.earnings * 100) / 100;
  };
  const list = [...employees.values()];
  for (const emp of list) {
    for (const proj of emp.projects) {
      proj.tasks.sort((a, b) => b.minutes - a.minutes);
      finish(proj);
    }
    emp.projects.sort((a, b) => b.minutes - a.minutes);
    finish(emp);
    sumInto(totals, emp);
  }
  list.sort((a, b) => b.minutes - a.minutes);
  finish(totals);
  return { employees: list, totals };
}

/** GET /api/reports/time/breakdown?from&to&project&user&department&status */
export async function timeBreakdown(req: Request, res: Response): Promise<void> {
  const filter = await timeFilter(req);
  if (isInvalid(filter)) {
    res.status(filter.status).json({ error: filter.error });
    return;
  }
  const { employees, totals } = await loadBreakdown(filter.match);
  res.json({
    from: filter.from ? dateKey(filter.from) : null,
    to: filter.to ? dateKey(filter.to) : null,
    employees,
    totals: { minutes: totals.minutes, hours: totals.hours, earnings: totals.earnings, count: totals.count, employees: employees.length },
  });
}

const XLSX_GREEN = "FF16A34A";
const XLSX_HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE6F4EA" } };

function styleHeader(sheet: ExcelJS.Worksheet): void {
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.fill = XLSX_HEADER_FILL;
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  if (sheet.columns.length > 0) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };
  }
}

/** In-cell bar chart on a numeric column (rows 2..lastRow). */
function dataBars(sheet: ExcelJS.Worksheet, column: string, lastRow: number): void {
  if (lastRow < 2) return;
  sheet.addConditionalFormatting({
    ref: `${column}2:${column}${lastRow}`,
    rules: [{ type: "dataBar", priority: 1, cfvo: [{ type: "min" }, { type: "max" }], color: { argb: XLSX_GREEN }, gradient: false } as ExcelJS.ConditionalFormattingRule],
  });
}

function totalRow(sheet: ExcelJS.Worksheet, values: Array<string | number | null>): void {
  const row = sheet.addRow(values);
  row.font = { bold: true };
  row.border = { top: { style: "thin" } };
}

function statusLabel(status: string | null): string {
  if (!status) return "";
  return status.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** GET /api/reports/time/export.xlsx?… — Summary, Breakdown, Tasks, By employee/project, Time logs. */
export async function timeExportXlsx(req: Request, res: Response): Promise<void> {
  const filter = await timeFilter(req);
  if (isInvalid(filter)) {
    res.status(filter.status).json({ error: filter.error });
    return;
  }
  const [{ employees, totals }, logs] = await Promise.all([
    loadBreakdown(filter.match),
    TimeLog.find(filter.match)
      .populate("user", "name email")
      .populate("project", "name code")
      .populate("task", "title shortCode number")
      .sort({ startTime: 1 })
      .limit(EXPORT_LIMIT)
      .lean(),
  ]);

  const q = (name: string) => (typeof req.query[name] === "string" ? (req.query[name] as string) : "");
  const [projectDoc, departmentDoc, userDoc] = await Promise.all([
    q("project") && !isInvalidObjectId(q("project")) ? Project.findById(q("project")).select("name code").lean() : null,
    q("department") && !isInvalidObjectId(q("department")) ? Department.findById(q("department")).select("name").lean() : null,
    q("user") && !isInvalidObjectId(q("user")) ? User.findById(q("user")).select("name").lean() : null,
  ]);
  const period = `${filter.from ? dateKey(filter.from) : "start"} to ${filter.to ? dateKey(filter.to) : "today"}`;

  const wb = new ExcelJS.Workbook();
  wb.creator = req.user!.name;
  wb.created = new Date();

  // --- Summary --------------------------------------------------------------
  const summary = wb.addWorksheet("Summary");
  summary.columns = [{ width: 22 }, { width: 48 }];
  const put = (label: string, value: string | number) => {
    const row = summary.addRow([label, value]);
    row.getCell(1).font = { bold: true };
    return row;
  };
  summary.addRow(["Time log report"]).font = { bold: true, size: 14 };
  summary.addRow([]);
  put("Period", period);
  put("Project", projectDoc ? `${projectDoc.code ? `${projectDoc.code} - ` : ""}${projectDoc.name}` : "Any");
  put("Department", departmentDoc ? departmentDoc.name : "Any");
  put("Employee", userDoc ? userDoc.name : "Any");
  put("Status", q("status") ? statusLabel(q("status")) : "Pending + approved");
  put("Generated", `${localDateTime(new Date())} by ${req.user!.name}`);
  summary.addRow([]);
  put("Total hours", totals.hours).getCell(2).numFmt = "0.00";
  put("Earnings", totals.earnings).getCell(2).numFmt = "#,##0.00";
  put("Time logs", totals.count);
  put("Employees", employees.length);
  if (logs.length >= EXPORT_LIMIT) put("Note", `Time logs sheet capped at ${EXPORT_LIMIT} rows`);

  // --- Breakdown (outline: employee › project › task) ------------------------
  const bd = wb.addWorksheet("Breakdown", { properties: { outlineLevelRow: 2 } });
  bd.columns = [
    { header: "Employee", width: 26 },
    { header: "Project", width: 34 },
    { header: "Task", width: 48 },
    { header: "Hours", width: 10, style: { numFmt: "0.00" } },
    { header: "Earnings", width: 12, style: { numFmt: "#,##0.00" } },
    { header: "Entries", width: 9 },
  ];
  for (const emp of employees) {
    const er = bd.addRow([emp.label, "", "", emp.hours, emp.earnings, emp.count]);
    er.font = { bold: true };
    er.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };
    for (const proj of emp.projects) {
      const pr = bd.addRow(["", proj.sublabel ? `${proj.sublabel} - ${proj.label}` : proj.label, "", proj.hours, proj.earnings, proj.count]);
      pr.font = { italic: true };
      pr.outlineLevel = 1;
      for (const task of proj.tasks) {
        const tr = bd.addRow(["", "", task.sublabel ? `${task.sublabel} - ${task.label}` : task.label, task.hours, task.earnings, task.count]);
        tr.outlineLevel = 2;
      }
    }
  }
  totalRow(bd, ["Total", "", "", totals.hours, totals.earnings, totals.count]);
  styleHeader(bd);
  dataBars(bd, "D", bd.rowCount - 1);

  // --- Tasks: one row per employee x task, with the task's details ----------
  const tasksSheet = wb.addWorksheet("Tasks");
  tasksSheet.columns = [
    { header: "Employee name", width: 24 },
    { header: "Task", width: 48 },
    { header: "Project", width: 34 },
    { header: "Completed On", width: 13 },
    { header: "Client", width: 22 },
    { header: "Start Date", width: 12 },
    { header: "Due Date", width: 12 },
    { header: "Estimated Time (h)", width: 16, style: { numFmt: "0.00" } },
    { header: "Hours Logged", width: 13, style: { numFmt: "0.00" } },
    { header: "Task Status", width: 13 },
  ];
  for (const emp of employees) {
    for (const proj of emp.projects) {
      for (const task of proj.tasks) {
        tasksSheet.addRow([
          emp.label,
          task.sublabel ? `${task.sublabel} - ${task.label}` : task.label,
          proj.sublabel ? `${proj.sublabel} - ${proj.label}` : proj.label,
          task.completedAt ?? "",
          task.client ?? "",
          task.startDate ?? "",
          task.dueDate ?? "",
          task.estimateMinutes === null ? null : hours(task.estimateMinutes),
          task.hours,
          statusLabel(task.status),
        ]);
      }
    }
  }
  totalRow(tasksSheet, ["Total", "", "", "", "", "", "", null, totals.hours, ""]);
  styleHeader(tasksSheet);
  dataBars(tasksSheet, "I", tasksSheet.rowCount - 1);

  // --- By employee / project --------------------------------------------------
  const byProject = new Map<string, { label: string; sublabel: string | null; client: string | null; minutes: number; earnings: number; count: number; employees: Set<string> }>();
  for (const emp of employees) {
    for (const proj of emp.projects) {
      const pk = proj.key ?? "none";
      let p = byProject.get(pk);
      if (!p) {
        p = { label: proj.label, sublabel: proj.sublabel, client: proj.client, minutes: 0, earnings: 0, count: 0, employees: new Set() };
        byProject.set(pk, p);
      }
      sumInto(p, proj);
      p.employees.add(emp.label);
    }
  }

  const byEmp = wb.addWorksheet("By employee");
  byEmp.columns = [
    { header: "Employee", width: 26 },
    { header: "Email", width: 30 },
    { header: "Hours", width: 10, style: { numFmt: "0.00" } },
    { header: "Earnings", width: 12, style: { numFmt: "#,##0.00" } },
    { header: "Entries", width: 9 },
    { header: "% of hours", width: 11, style: { numFmt: "0.0%" } },
  ];
  for (const emp of employees) {
    byEmp.addRow([emp.label, emp.sublabel ?? "", emp.hours, emp.earnings, emp.count, totals.minutes ? emp.minutes / totals.minutes : 0]);
  }
  totalRow(byEmp, ["Total", "", totals.hours, totals.earnings, totals.count, totals.minutes ? 1 : 0]);
  styleHeader(byEmp);
  dataBars(byEmp, "C", byEmp.rowCount - 1);

  const byProj = wb.addWorksheet("By project");
  byProj.columns = [
    { header: "Code", width: 14 },
    { header: "Project", width: 40 },
    { header: "Client", width: 22 },
    { header: "Hours", width: 10, style: { numFmt: "0.00" } },
    { header: "Earnings", width: 12, style: { numFmt: "#,##0.00" } },
    { header: "Entries", width: 9 },
    { header: "Employees", width: 10 },
    { header: "% of hours", width: 11, style: { numFmt: "0.0%" } },
  ];
  for (const p of [...byProject.values()].sort((a, b) => b.minutes - a.minutes)) {
    byProj.addRow([p.sublabel ?? "", p.label, p.client ?? "", hours(p.minutes), Math.round(p.earnings * 100) / 100, p.count, p.employees.size, totals.minutes ? p.minutes / totals.minutes : 0]);
  }
  totalRow(byProj, ["", "Total", "", totals.hours, totals.earnings, totals.count, employees.length, totals.minutes ? 1 : 0]);
  styleHeader(byProj);
  dataBars(byProj, "D", byProj.rowCount - 1);

  // --- Time logs (raw) --------------------------------------------------------
  const raw = wb.addWorksheet("Time logs");
  raw.columns = [
    { header: "Date", width: 12 },
    { header: "Employee", width: 24 },
    { header: "Project", width: 30 },
    { header: "Task", width: 40 },
    { header: "Start", width: 17 },
    { header: "End", width: 17 },
    { header: "Hours", width: 9, style: { numFmt: "0.00" } },
    { header: "Break (min)", width: 11 },
    { header: "Earnings", width: 11, style: { numFmt: "#,##0.00" } },
    { header: "Status", width: 10 },
    { header: "Memo", width: 40 },
  ];
  type Ref = { name?: string; code?: string; title?: string; shortCode?: string | null; number?: number | null } | null;
  for (const l of logs) {
    const user = l.user as unknown as Ref;
    const project = l.project as unknown as Ref;
    const task = l.task as unknown as Ref;
    const taskCode = task ? (task.shortCode ?? (task.number ? `#${task.number}` : "")) : "";
    raw.addRow([
      appDateKey(l.startTime),
      user?.name ?? "",
      project ? `${project.code ? `${project.code} - ` : ""}${project.name ?? ""}` : "",
      task ? `${taskCode}${taskCode ? " - " : ""}${task.title ?? ""}` : "",
      localDateTime(l.startTime),
      localDateTime(l.endTime ?? null),
      hours(l.durationMinutes),
      l.breakMinutes,
      l.earnings,
      statusLabel(l.status),
      l.memo ?? "",
    ]);
  }
  styleHeader(raw);

  const filename = `time-report-${filter.from ? dateKey(filter.from) : "all"}-${filter.to ? dateKey(filter.to) : "all"}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("X-Export-Rows", String(logs.length));
  await wb.xlsx.write(res);
  res.end();
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
  actualEndAt?: Date | null;
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
  // The Task Report is view-only and open to everyone, across all departments.
  void actor;
  const scopeDepartment: mongoose.Types.ObjectId | null = department;
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
    .select("title shortCode status priority assignees department project startDate dueDate completedAt actualEndAt createdAt")
    .populate("assignees", "name email")
    .populate("department", "name")
    .populate("project", "name code")
    .sort({ createdAt: -1 })
    .limit(EXPORT_LIMIT)
    .lean<LeanTask[]>();
  return { tasks, from: range.from, to: range.to, members };
}

/**
 * "on_time" | "late" | null for a completed task with a due date (date-only, app
 * timezone) — judged by the actual end (when the work finished), else completion.
 */
function timeliness(task: LeanTask): "on_time" | "late" | null {
  if (task.status !== "completed" || !task.dueDate || !task.completedAt) return null;
  return appDateKey(task.actualEndAt ?? task.completedAt) <= dateKey(task.dueDate) ? "on_time" : "late";
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
  const sheet: [string[], Array<Array<string | number | null | undefined>>] = [
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
  ];
  await sendXlsx(res, `task-report-${loaded.from ? dateKey(loaded.from) : "all"}-${loaded.to ? dateKey(loaded.to) : "all"}.xlsx`, ...sheet);
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
  const sheet: [string[], Array<Array<string | number | null | undefined>>] = [
    ["Employee", "Email", "Department", "Week start", "Total hours", "Status", "Submitted", "Reviewed", "Reviewer", "Reject reason"],
    sheets.map((s) => {
      const user = s.user as unknown as { name?: string; email?: string; department?: { name?: string } | null } | null;
      const reviewer = s.reviewedBy as unknown as { name?: string } | null;
      return [
        user?.name ?? "",
        user?.email ?? "",
        user?.department?.name ?? "",
        dateKey(s.weekStart),
        csvHours(timesheetTotalMinutes(s)),
        s.status,
        localDateTime(s.submittedAt ?? null),
        localDateTime(s.reviewedAt ?? null),
        reviewer?.name ?? "",
        s.rejectReason ?? "",
      ];
    })
  ];
  await sendXlsx(res, "weekly-timesheets.xlsx", ...sheet);
}
