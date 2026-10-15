import type { Request, Response } from "express";
import mongoose from "mongoose";
import { addDays, appDayStart, mondayOf } from "../lib/appTime.js";
import { csvDate, EXPORT_ROW_LIMIT, sendSheet } from "../lib/csv.js";
import { emptyTrailCounts, pearityTrailCounts, type PearityTrailCounts } from "../lib/pearity.js";
import { departmentUserIds } from "../lib/projectAccess.js";
import { appDateKey } from "../lib/taskJobs.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";
import { isInvalid, optionalId, parseRange, type Invalid } from "./timeReports.js";

// ---------------------------------------------------------------------------
// Pearity stats — GET /api/reports/pearity | /api/reports/pearity/export
//
// Completed tasks whose completedAt (app-timezone day) falls in the period:
// how many were made On Pearity / Off Pearity (task.parity, chosen when
// closing; older tasks have none = "not recorded"), their Pearity generation
// trail (task history, same counts as the task detail trail), outcome
// readiness and on-time delivery — in total, per assignee, per brand, weekly,
// and a best / needs-attention ranking. View-only and open to everyone, like
// the Task Report and Delivery Pulse.
// ---------------------------------------------------------------------------

/** Composite score weights (sum 1). A component a person has no data for is left out and the rest re-weighted. */
export const PEARITY_SCORE_WEIGHTS = { onPearity: 0.4, readiness: 0.3, onTime: 0.2, jobSuccess: 0.1 } as const;
/** People need at least this many closed tasks in the period to be ranked. */
export const PEARITY_MIN_TASKS = 3;
const RANK_SIZE = 5;
const TASK_LIMIT = 50_000;

interface ReportTask {
  _id: mongoose.Types.ObjectId;
  title: string;
  shortCode?: string | null;
  parity?: "on" | "off" | null;
  outcomeReadiness?: { score?: number | null } | null;
  dueDate?: Date | null;
  completedAt: Date;
  actualEndAt?: Date | null;
  assignees: Array<{ _id: mongoose.Types.ObjectId; name: string; email: string } | null>;
  project?: {
    _id: mongoose.Types.ObjectId;
    name: string;
    code: string;
    brand?: { _id: mongoose.Types.ObjectId; name: string; shortName?: string; organisation?: string } | null;
  } | null;
}

/** Running totals for one group (everything, a person, a brand). */
interface Acc extends PearityTrailCounts {
  closed: number;
  on: number;
  off: number;
  notRecorded: number;
  readinessSum: number;
  readinessCount: number;
  onTime: number;
  late: number;
}

function emptyAcc(): Acc {
  return { closed: 0, on: 0, off: 0, notRecorded: 0, readinessSum: 0, readinessCount: 0, onTime: 0, late: 0, ...emptyTrailCounts() };
}

/** "on_time" | "late" | null — same rule as the Task Report: actual end (else completion) vs the due date. */
function timeliness(task: ReportTask): "on_time" | "late" | null {
  if (!task.dueDate) return null;
  return appDateKey(task.actualEndAt ?? task.completedAt) <= task.dueDate.toISOString().slice(0, 10) ? "on_time" : "late";
}

function add(acc: Acc, task: ReportTask, trail: PearityTrailCounts): void {
  acc.closed++;
  if (task.parity === "on") acc.on++;
  else if (task.parity === "off") acc.off++;
  else acc.notRecorded++;
  const score = task.outcomeReadiness?.score;
  if (typeof score === "number") {
    acc.readinessSum += score;
    acc.readinessCount++;
  }
  const when = timeliness(task);
  if (when === "on_time") acc.onTime++;
  if (when === "late") acc.late++;
  acc.generateClicks += trail.generateClicks;
  acc.jobsStarted += trail.jobsStarted;
  acc.jobsCompleted += trail.jobsCompleted;
  acc.jobsFailed += trail.jobsFailed;
  acc.savedToDam += trail.savedToDam;
}

const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

/** The public metrics of a group. Percentages are 0–100 with one decimal, null when there is nothing to divide by. */
function metrics(acc: Acc) {
  const recorded = acc.on + acc.off;
  const finishedJobs = acc.jobsCompleted + acc.jobsFailed;
  return {
    closed: acc.closed,
    on: acc.on,
    off: acc.off,
    notRecorded: acc.notRecorded,
    recorded,
    /** On Pearity as a share of the tasks with a recorded choice. */
    onPct: pct(acc.on, recorded),
    offPct: pct(acc.off, recorded),
    generateClicks: acc.generateClicks,
    jobsStarted: acc.jobsStarted,
    jobsCompleted: acc.jobsCompleted,
    jobsFailed: acc.jobsFailed,
    /** Completed jobs out of finished (completed + failed) jobs. */
    jobSuccessPct: pct(acc.jobsCompleted, finishedJobs),
    savedToDam: acc.savedToDam,
    avgReadiness: acc.readinessCount > 0 ? Math.round((acc.readinessSum / acc.readinessCount) * 10) / 10 : null,
    readinessCount: acc.readinessCount,
    onTime: acc.onTime,
    late: acc.late,
    onTimePct: pct(acc.onTime, acc.onTime + acc.late),
  };
}

type Metrics = ReturnType<typeof metrics>;

/**
 * Composite score 0–100 = weighted average of the components a person has data for:
 * On-Pearity share (of recorded) 40 %, average outcome readiness 30 %, on-time 20 %,
 * job success 10 %. Missing components (no recorded choice, no readiness score, no
 * due dates, no finished jobs) are skipped and the remaining weights scaled up.
 */
function composite(m: Metrics) {
  const parts = [
    { key: "onPearity" as const, value: m.onPct },
    { key: "readiness" as const, value: m.avgReadiness },
    { key: "onTime" as const, value: m.onTimePct },
    { key: "jobSuccess" as const, value: m.jobSuccessPct },
  ];
  let weight = 0;
  let sum = 0;
  for (const p of parts) {
    if (p.value === null) continue;
    weight += PEARITY_SCORE_WEIGHTS[p.key];
    sum += PEARITY_SCORE_WEIGHTS[p.key] * p.value;
  }
  return {
    score: weight > 0 ? Math.round((sum / weight) * 10) / 10 : null,
    components: Object.fromEntries(parts.map((p) => [p.key, { value: p.value, weight: PEARITY_SCORE_WEIGHTS[p.key] }])) as Record<
      (typeof parts)[number]["key"],
      { value: number | null; weight: number }
    >,
  };
}

interface Loaded {
  tasks: ReportTask[];
  trails: Map<string, PearityTrailCounts>;
  from: Date | null;
  to: Date | null;
  /** Department filter: only its members get person rows. */
  members: Set<string> | null;
  user: mongoose.Types.ObjectId | null;
}

/** Filters: from/to (completedAt, app-timezone days), brand, department, user. */
async function load(req: Request): Promise<Loaded | Invalid> {
  const range = parseRange(req, false);
  if (isInvalid(range)) return range;
  const brand = optionalId(req, "brand");
  if (isInvalid(brand)) return brand;
  const department = optionalId(req, "department");
  if (isInvalid(department)) return department;
  const user = optionalId(req, "user");
  if (isInvalid(user)) return user;

  const and: Record<string, unknown>[] = [{ status: "completed" }, { completedAt: { $ne: null } }];
  if (range.from) and.push({ completedAt: { $gte: appDayStart(range.from) } });
  if (range.to) and.push({ completedAt: { $lt: appDayStart(addDays(range.to, 1)) } });
  let members: Set<string> | null = null;
  if (department) {
    // Same as the Task Report: the task's department, or any assignee from it.
    const ids = await departmentUserIds(department);
    members = new Set(ids.map((id) => id.toString()));
    and.push({ $or: [{ department }, ...(ids.length > 0 ? [{ assignees: { $in: ids } }] : [])] });
  }
  if (brand) {
    const projects = await Project.find({ brand }).select("_id").lean();
    and.push({ project: { $in: projects.map((p) => p._id) } });
  }
  if (user) and.push({ assignees: user });

  const tasks = await Task.find({ $and: and })
    .select("title shortCode parity outcomeReadiness.score dueDate completedAt actualEndAt assignees project")
    .populate("assignees", "name email")
    .populate({ path: "project", select: "name code brand", populate: { path: "brand", select: "name shortName organisation" } })
    .sort({ completedAt: -1 })
    .limit(TASK_LIMIT)
    .lean<ReportTask[]>();
  const trails = await pearityTrailCounts(tasks.map((t) => t._id));
  return { tasks, trails, from: range.from, to: range.to, members, user };
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** GET /api/reports/pearity?from&to&brand&department&user */
export async function pearityReport(req: Request, res: Response): Promise<void> {
  const loaded = await load(req);
  if (isInvalid(loaded)) {
    res.status(loaded.status).json({ error: loaded.error });
    return;
  }
  const { tasks, trails } = loaded;
  const totals = emptyAcc();
  const people = new Map<string, { userId: string; name: string; email: string; acc: Acc }>();
  const brands = new Map<string, { brandId: string | null; name: string; shortName: string; organisation: string; acc: Acc }>();
  const weeks = new Map<string, { on: number; off: number; notRecorded: number }>();

  for (const task of tasks) {
    const trail = trails.get(task._id.toString()) ?? emptyTrailCounts();
    add(totals, task, trail);

    for (const a of task.assignees ?? []) {
      if (!a) continue;
      const key = a._id.toString();
      if (loaded.members && !loaded.members.has(key)) continue;
      if (loaded.user && !loaded.user.equals(a._id)) continue;
      let row = people.get(key);
      if (!row) {
        row = { userId: key, name: a.name, email: a.email, acc: emptyAcc() };
        people.set(key, row);
      }
      add(row.acc, task, trail);
    }

    const b = task.project?.brand ?? null;
    const bKey = b ? b._id.toString() : "none";
    let brow = brands.get(bKey);
    if (!brow) {
      brow = b
        ? { brandId: bKey, name: b.name, shortName: b.shortName ?? "", organisation: b.organisation ?? "", acc: emptyAcc() }
        : { brandId: null, name: "No brand", shortName: "", organisation: "", acc: emptyAcc() };
      brands.set(bKey, brow);
    }
    add(brow.acc, task, trail);

    // Week (Monday, app timezone) the task was closed in.
    const week = dateKey(mondayOf(new Date(`${appDateKey(task.completedAt)}T00:00:00.000Z`)));
    const w = weeks.get(week) ?? { on: 0, off: 0, notRecorded: 0 };
    if (task.parity === "on") w.on++;
    else if (task.parity === "off") w.off++;
    else w.notRecorded++;
    weeks.set(week, w);
  }

  const byPerson = [...people.values()]
    .map((p) => {
      const m = metrics(p.acc);
      return { userId: p.userId, name: p.name, email: p.email, ...m, ...composite(m), qualifies: m.closed >= PEARITY_MIN_TASKS };
    })
    .sort((a, b) => b.closed - a.closed || a.name.localeCompare(b.name));

  // Ranking: qualified people with a score. With fewer than 2 × 5 qualified people the list is
  // split in half (the upper half is "best"), so nobody appears in both cards.
  const ranked = byPerson.filter((p) => p.qualifies && p.score !== null).sort((a, b) => b.score! - a.score! || b.closed - a.closed);
  const best = ranked.slice(0, Math.min(RANK_SIZE, Math.ceil(ranked.length / 2)));
  const bestIds = new Set(best.map((p) => p.userId));
  const worst = [...ranked]
    .reverse()
    .filter((p) => !bestIds.has(p.userId))
    .slice(0, RANK_SIZE);
  const pick = (p: (typeof byPerson)[number]) => ({
    userId: p.userId,
    name: p.name,
    closed: p.closed,
    score: p.score,
    components: p.components,
  });

  // Weekly trend: every week from the first to the last (empty weeks included), capped at a year.
  const weekKeys = [...weeks.keys()].sort();
  const trend: Array<{ week: string; on: number; off: number; notRecorded: number }> = [];
  if (weekKeys.length > 0) {
    const first = new Date(`${weekKeys[0]}T00:00:00.000Z`);
    const last = new Date(`${weekKeys[weekKeys.length - 1]}T00:00:00.000Z`);
    for (let d = first; d.getTime() <= last.getTime() && trend.length < 104; d = addDays(d, 7)) {
      const key = dateKey(d);
      trend.push({ week: key, ...(weeks.get(key) ?? { on: 0, off: 0, notRecorded: 0 }) });
    }
  }

  res.json({
    from: loaded.from ? dateKey(loaded.from) : null,
    to: loaded.to ? dateKey(loaded.to) : null,
    truncated: tasks.length >= TASK_LIMIT,
    totals: metrics(totals),
    byPerson,
    byBrand: [...brands.values()]
      .map((b) => ({ brandId: b.brandId, name: b.name, shortName: b.shortName, organisation: b.organisation, ...metrics(b.acc) }))
      .sort((a, b) => a.organisation.localeCompare(b.organisation) || b.closed - a.closed || a.name.localeCompare(b.name)),
    trend,
    performers: {
      weights: PEARITY_SCORE_WEIGHTS,
      minTasks: PEARITY_MIN_TASKS,
      best: best.map(pick),
      needsAttention: worst.map(pick),
      tooFewTasks: byPerson
        .filter((p) => !p.qualifies)
        .map((p) => ({ userId: p.userId, name: p.name, closed: p.closed }))
        .sort((a, b) => b.closed - a.closed || a.name.localeCompare(b.name)),
    },
  });
}

/** GET /api/reports/pearity/export?… — one Excel row per closed task. */
export async function pearityExport(req: Request, res: Response): Promise<void> {
  const loaded = await load(req);
  if (isInvalid(loaded)) {
    res.status(loaded.status).json({ error: loaded.error });
    return;
  }
  const headers = [
    "Code",
    "Task",
    "Organisation",
    "Brand",
    "Project",
    "Assignees",
    "Completed",
    "Due",
    "Timeliness",
    "Pearity",
    "Outcome readiness",
    "Generate clicks",
    "Jobs started",
    "Jobs completed",
    "Jobs failed",
    "Saved to DAM",
  ];
  const shown = loaded.tasks.slice(0, EXPORT_ROW_LIMIT);
  const rows = shown.map((t) => {
    const trail = loaded.trails.get(t._id.toString()) ?? emptyTrailCounts();
    const when = timeliness(t);
    const brand = t.project?.brand ?? null;
    return [
      t.shortCode ?? "",
      t.title,
      brand?.organisation ?? "",
      brand?.name ?? "",
      t.project ? `${t.project.code} · ${t.project.name}` : "",
      (t.assignees ?? []).filter(Boolean).map((a) => a!.name).join("; "),
      appDateKey(t.completedAt),
      csvDate(t.dueDate ?? null),
      when === "on_time" ? "On time" : when === "late" ? "Late" : "",
      t.parity === "on" ? "On Pearity" : t.parity === "off" ? "Off Pearity" : "Not recorded",
      typeof t.outcomeReadiness?.score === "number" ? t.outcomeReadiness.score : "",
      trail.generateClicks,
      trail.jobsStarted,
      trail.jobsCompleted,
      trail.jobsFailed,
      trail.savedToDam,
    ];
  });
  await sendSheet(res, "pearity-stats", headers, rows, { rows: rows.length, total: loaded.tasks.length });
}
