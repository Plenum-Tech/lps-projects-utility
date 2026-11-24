import type { Request, Response } from "express";
import mongoose from "mongoose";
import { addDays, appDateKey, appDayStart } from "../lib/appTime.js";
import { assignedBrands } from "../lib/brandTime.js";
import { Brand } from "../models/Brand.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";
import { getTaskSettings } from "../models/TaskSettings.js";
import { TimeLog } from "../models/TimeLog.js";
import { User } from "../models/User.js";
import { optionalId, parseRange } from "./timeReports.js";

// ---------------------------------------------------------------------------
// Timesheet performance (leadership): estimated time against the time actually logged, per
// person and per task, with the time each rework took — live from the time logs.
//
// - A task counts when time was logged on it in the period. Its actual time is everything
//   logged on it so far (the estimate covers the whole task, not just the period).
// - Per person: each task's estimate is shared by the people who logged on it, in proportion
//   to their time, so a person's deviation is their part of the task against their part of
//   the estimate. Rework time = their time in the period on rework tasks.
// - Per task: the original task with its reworks as one row — the original estimate against
//   all the time spent, and the time of each iteration.
// - Brand hours: program / CM / brand leads log per brand (no task, no estimate).
// ---------------------------------------------------------------------------

type Id = mongoose.Types.ObjectId;
const dateKey = (d: Date) => d.toISOString().slice(0, 10);
const pct = (actual: number, estimate: number) => (estimate > 0 ? Math.round(((actual - estimate) / estimate) * 100) : null);

interface TaskDoc {
  _id: Id;
  title: string;
  shortCode?: string | null;
  estimateMinutes?: number | null;
  iteration?: string | null;
  reworkOf?: Id | null;
  status: string;
  dueDate?: Date | null;
  completedAt?: Date | null;
  actualEndAt?: Date | null;
  project?: Id | null;
  createdAt: Date;
}
const TASK_FIELDS = "title shortCode estimateMinutes iteration reworkOf status dueDate completedAt actualEndAt project createdAt";

/** GET /api/reports/timesheets/performance?from&to&department&brand — leadership only. */
export async function timesheetPerformance(req: Request, res: Response): Promise<void> {
  const range = parseRange(req);
  if ("error" in range) {
    res.status(range.status).json({ error: range.error });
    return;
  }
  const department = optionalId(req, "department");
  const brand = optionalId(req, "brand");
  for (const v of [department, brand]) {
    if (v && "error" in v) {
      res.status(v.status).json({ error: v.error });
      return;
    }
  }
  const from = range.from!;
  const to = range.to!;
  const start = appDayStart(from);
  const end = appDayStart(addDays(to, 1));
  const settings = await getTaskSettings();
  const overPct = settings.performanceOverEstimatePct ?? 25;
  const iterationFlag = settings.performanceIterationFlag ?? 3;

  // People (and the department filter).
  const users = await User.find({}).select("name department").populate("department", "name").lean<Array<{ _id: Id; name: string; department?: { _id: Id; name: string } | null }>>();
  const userOf = new Map(users.map((u) => [String(u._id), u]));
  const inDepartment = (u: string) => !department || String(userOf.get(u)?.department?._id ?? "") === String(department);

  // Time logged in the period: per task and person, and per brand and person (brand rows).
  const finished = { endTime: { $ne: null }, status: { $ne: "rejected" } };
  const [taskLogs, brandLogs] = await Promise.all([
    TimeLog.aggregate<{ _id: { task: Id; user: Id }; minutes: number }>([
      { $match: { ...finished, task: { $ne: null }, startTime: { $gte: start, $lt: end } } },
      { $group: { _id: { task: "$task", user: "$user" }, minutes: { $sum: "$durationMinutes" } } },
    ]),
    TimeLog.aggregate<{ _id: { brand: Id; user: Id }; minutes: number }>([
      { $match: { ...finished, task: null, brand: { $ne: null }, startTime: { $gte: start, $lt: end } } },
      { $group: { _id: { brand: "$brand", user: "$user" }, minutes: { $sum: "$durationMinutes" } } },
    ]),
  ]);

  // The tasks worked on, and their families (the original task + its reworks).
  const docs = new Map<string, TaskDoc>();
  const load = async (filter: Record<string, unknown>) => {
    const found = await Task.find(filter).select(TASK_FIELDS).lean<TaskDoc[]>();
    const fresh = found.filter((t) => !docs.has(String(t._id)));
    for (const t of fresh) docs.set(String(t._id), t);
    return fresh;
  };
  let frontier = await load({ _id: { $in: taskLogs.map((l) => l._id.task) } });
  // Up to the originals, then down to every rework (a few levels at most).
  for (let i = 0; i < 6 && frontier.length; i++) {
    const parents = frontier.map((t) => t.reworkOf).filter((id): id is Id => Boolean(id) && !docs.has(String(id)));
    frontier = parents.length ? await load({ _id: { $in: parents } }) : [];
  }
  frontier = [...docs.values()];
  for (let i = 0; i < 6 && frontier.length; i++) {
    frontier = await load({ reworkOf: { $in: frontier.map((t) => t._id) }, _id: { $nin: [...docs.values()].map((t) => t._id) } });
  }
  const rootOf = (id: string): string => {
    let at = id;
    for (let i = 0; i < 8; i++) {
      const parent = docs.get(at)?.reworkOf;
      if (!parent || !docs.has(String(parent))) break;
      at = String(parent);
    }
    return at;
  };
  const families = new Map<string, TaskDoc[]>();
  for (const t of docs.values()) {
    const root = rootOf(String(t._id));
    families.set(root, [...(families.get(root) ?? []), t]);
  }
  for (const list of families.values()) list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  // Projects → brands (labels and the brand filter).
  const projectIds = [...docs.values()].map((t) => t.project).filter((id): id is Id => Boolean(id));
  const projects = await Project.find({ _id: { $in: projectIds } })
    .select("name brand")
    .lean<Array<{ _id: Id; name: string; brand?: Id | null }>>();
  const projectOf = new Map(projects.map((p) => [String(p._id), p]));
  const brandDocs = await Brand.find({}).select("name organisation").lean<Array<{ _id: Id; name: string; organisation?: string }>>();
  const brandName = new Map(brandDocs.map((b) => [String(b._id), b.organisation && b.organisation.toLowerCase() !== b.name.toLowerCase() ? `${b.organisation} › ${b.name}` : b.name]));
  const brandOfTask = (t: TaskDoc) => (t.project ? String(projectOf.get(String(t.project))?.brand ?? "") : "");
  const inBrand = (t: TaskDoc) => !brand || brandOfTask(t) === String(brand);

  // Everything logged on those tasks so far: per task and person.
  const allTime = await TimeLog.aggregate<{ _id: { task: Id; user: Id }; minutes: number }>([
    { $match: { ...finished, task: { $in: [...docs.values()].map((t) => t._id) } } },
    { $group: { _id: { task: "$task", user: "$user" }, minutes: { $sum: "$durationMinutes" } } },
  ]);
  const totalOf = new Map<string, number>();
  const ownOf = new Map<string, number>();
  const loggersOf = new Map<string, Set<string>>();
  for (const l of allTime) {
    const t = String(l._id.task);
    const u = String(l._id.user);
    totalOf.set(t, (totalOf.get(t) ?? 0) + l.minutes);
    ownOf.set(`${t}|${u}`, l.minutes);
    loggersOf.set(t, (loggersOf.get(t) ?? new Set()).add(u));
  }

  // --- Per person ---------------------------------------------------------------------------
  type Person = {
    id: string;
    tasks: number;
    estimated: number;
    actual: number;
    compared: number;
    over: number;
    reworkMinutes: number;
    periodMinutes: number;
    noEstimate: number;
    families: Set<string>;
    due: number;
    onTime: number;
    rows: Array<{ id: string; code: string; title: string; brand: string; rework: boolean; estimate: number | null; actual: number; deviationPct: number | null; iterations: number; status: string }>;
  };
  const people = new Map<string, Person>();
  const seenTasks = new Set<string>();
  const overTasks = new Map<string, { estimate: number; actual: number }>();
  const noEstimateTasks = new Map<string, number>();
  let reworkMinutes = 0;
  let periodMinutes = 0;
  for (const l of taskLogs) {
    const taskId = String(l._id.task);
    const userId = String(l._id.user);
    const t = docs.get(taskId);
    if (!t || !inBrand(t) || !inDepartment(userId) || !userOf.has(userId)) continue;
    const p: Person =
      people.get(userId) ??
      { id: userId, tasks: 0, estimated: 0, actual: 0, compared: 0, over: 0, reworkMinutes: 0, periodMinutes: 0, noEstimate: 0, families: new Set(), due: 0, onTime: 0, rows: [] };
    const own = ownOf.get(`${taskId}|${userId}`) ?? l.minutes;
    const total = totalOf.get(taskId) ?? own;
    const estimate = t.estimateMinutes && t.estimateMinutes > 0 ? t.estimateMinutes : null;
    const share = estimate && total > 0 ? Math.round((estimate * own) / total) : null;
    p.tasks++;
    p.periodMinutes += l.minutes;
    periodMinutes += l.minutes;
    if (t.iteration === "rework") {
      p.reworkMinutes += l.minutes;
      reworkMinutes += l.minutes;
    }
    if (share !== null) {
      p.estimated += share;
      p.actual += own;
      p.compared++;
      if (total > estimate!) {
        p.over++;
        overTasks.set(taskId, { estimate: estimate!, actual: total });
      }
    } else {
      p.noEstimate++;
      noEstimateTasks.set(taskId, total);
    }
    const root = rootOf(taskId);
    p.families.add(root);
    if (t.status === "completed" && t.dueDate && t.completedAt) {
      p.due++;
      if (appDateKey(t.actualEndAt ?? t.completedAt) <= dateKey(t.dueDate)) p.onTime++;
    }
    p.rows.push({
      id: taskId,
      code: t.shortCode ?? "",
      title: t.title,
      brand: brandName.get(brandOfTask(t)) ?? "",
      rework: t.iteration === "rework",
      estimate: share,
      actual: own,
      deviationPct: share !== null ? pct(own, share) : null,
      iterations: families.get(root)?.length ?? 1,
      status: t.status,
    });
    seenTasks.add(taskId);
    people.set(userId, p);
  }
  const personRows = [...people.values()]
    .map((p) => ({
      user: { _id: p.id, name: userOf.get(p.id)!.name, department: userOf.get(p.id)!.department?.name ?? "" },
      tasks: p.tasks,
      estimatedMinutes: p.estimated,
      actualMinutes: p.actual,
      deviationPct: pct(p.actual, p.estimated),
      comparedTasks: p.compared,
      overEstimate: p.over,
      noEstimate: p.noEstimate,
      reworkMinutes: p.reworkMinutes,
      periodMinutes: p.periodMinutes,
      avgIterations: p.families.size ? Math.round(([...p.families].reduce((n, f) => n + (families.get(f)?.length ?? 1), 0) / p.families.size) * 10) / 10 : null,
      onTimePct: p.due ? Math.round((p.onTime / p.due) * 100) : null,
      completedWithDue: p.due,
      taskRows: p.rows.sort((a, b) => (b.deviationPct ?? -999) - (a.deviationPct ?? -999)).slice(0, 100),
    }))
    .sort((a, b) => (b.deviationPct ?? -999) - (a.deviationPct ?? -999) || b.actualMinutes - a.actualMinutes);

  // --- Per task (the original with its reworks) ----------------------------------------------
  const names = (ids: Iterable<string>) => [...ids].map((u) => userOf.get(u)?.name).filter(Boolean) as string[];
  const familyRows = [...families]
    .filter(([, list]) => list.some((t) => seenTasks.has(String(t._id))))
    .map(([root, list]) => {
      const first = docs.get(root)!;
      const estimate = first.estimateMinutes && first.estimateMinutes > 0 ? first.estimateMinutes : null;
      const actual = list.reduce((n, t) => n + (totalOf.get(String(t._id)) ?? 0), 0);
      const doers = new Set<string>();
      for (const t of list) for (const u of loggersOf.get(String(t._id)) ?? []) doers.add(u);
      let reworkNo = 0;
      return {
        id: root,
        code: first.shortCode ?? "",
        title: first.title,
        brand: brandName.get(brandOfTask(first)) ?? "",
        doers: names(doers),
        estimateMinutes: estimate,
        actualMinutes: actual,
        deviationPct: estimate ? pct(actual, estimate) : null,
        iterations: list.map((t) => ({
          id: String(t._id),
          label: String(t._id) === root ? "Original" : `Rework ${++reworkNo}`,
          minutes: totalOf.get(String(t._id)) ?? 0,
        })),
        reworkMinutes: list.filter((t) => String(t._id) !== root).reduce((n, t) => n + (totalOf.get(String(t._id)) ?? 0), 0),
        status: list[list.length - 1]!.status,
      };
    })
    .sort((a, b) => (b.deviationPct ?? -999) - (a.deviationPct ?? -999) || b.actualMinutes - a.actualMinutes);

  // --- Brand hours ---------------------------------------------------------------------------
  const months = [...new Set([dateKey(from).slice(0, 7), dateKey(to).slice(0, 7)])];
  const brandPeople = new Map<string, Map<string, number>>();
  for (const l of brandLogs) {
    const u = String(l._id.user);
    const b = String(l._id.brand);
    if (!inDepartment(u) || !userOf.has(u) || (brand && b !== String(brand))) continue;
    const mine = brandPeople.get(u) ?? new Map<string, number>();
    mine.set(b, (mine.get(b) ?? 0) + l.minutes);
    brandPeople.set(u, mine);
  }
  const brandHours = await Promise.all(
    [...brandPeople].map(async ([u, mine]) => {
      const allocated = brand ? [] : await assignedBrands(new mongoose.Types.ObjectId(u), months);
      return {
        user: { _id: u, name: userOf.get(u)!.name, department: userOf.get(u)!.department?.name ?? "" },
        minutes: [...mine.values()].reduce((n, m) => n + m, 0),
        brands: [...mine].map(([b, minutes]) => ({ name: brandName.get(b) ?? "Brand", minutes })).sort((a, b) => b.minutes - a.minutes),
        allocatedWithoutHours: allocated.filter((b) => !mine.has(String(b._id))).map((b) => b.name),
      };
    })
  );
  brandHours.sort((a, b) => b.minutes - a.minutes);

  // --- Totals and flags ----------------------------------------------------------------------
  const estimated = personRows.reduce((n, p) => n + p.estimatedMinutes, 0);
  const actual = personRows.reduce((n, p) => n + p.actualMinutes, 0);
  const wayOver = [...overTasks].filter(([, v]) => v.actual > v.estimate * (1 + overPct / 100));
  const label = (id: string) => {
    const t = docs.get(id)!;
    return { id, code: t.shortCode ?? "", title: t.title, brand: brandName.get(brandOfTask(t)) ?? "" };
  };
  const manyIterations = familyRows.filter((f) => f.iterations.length >= iterationFlag);
  const noEstimateBy = new Map<string, number>();
  for (const p of personRows) if (p.noEstimate) noEstimateBy.set(p.user.name, p.noEstimate);

  res.json({
    from: dateKey(from),
    to: dateKey(to),
    settings: { overEstimatePct: overPct, iterationFlag },
    totals: {
      estimatedMinutes: estimated,
      actualMinutes: actual,
      deviationPct: pct(actual, estimated),
      tasks: seenTasks.size,
      tasksWithEstimate: seenTasks.size - noEstimateTasks.size,
      tasksOverEstimate: overTasks.size,
      tasksWayOver: wayOver.length,
      reworkMinutes,
      periodMinutes,
      reworkTasks: [...seenTasks].filter((id) => docs.get(id)?.iteration === "rework").length,
    },
    people: personRows,
    tasks: familyRows.slice(0, 300),
    taskCount: familyRows.length,
    brandHours,
    flags: {
      overEstimate: {
        count: wayOver.length,
        top: wayOver
          .sort((a, b) => b[1].actual / b[1].estimate - a[1].actual / a[1].estimate)
          .slice(0, 5)
          .map(([id, v]) => ({ ...label(id), estimateMinutes: v.estimate, actualMinutes: v.actual })),
      },
      noEstimate: {
        count: noEstimateTasks.size,
        minutes: [...noEstimateTasks.values()].reduce((n, m) => n + m, 0),
        people: [...noEstimateBy].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, tasks]) => ({ name, tasks })),
      },
      iterations: {
        count: manyIterations.length,
        top: manyIterations
          .sort((a, b) => b.iterations.length - a.iterations.length || b.reworkMinutes - a.reworkMinutes)
          .slice(0, 5)
          .map((f) => ({ id: f.id, code: f.code, title: f.title, brand: f.brand, iterations: f.iterations.length, reworkMinutes: f.reworkMinutes })),
      },
    },
  });
}

/** PATCH /api/reports/timesheets/performance/settings — leadership: `{ overEstimatePct?, iterationFlag? }`. */
export async function updatePerformanceSettings(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { overEstimatePct?: unknown; iterationFlag?: unknown };
  const settings = await getTaskSettings();
  if (body.overEstimatePct !== undefined) {
    const v = Number(body.overEstimatePct);
    if (!Number.isInteger(v) || v < 1 || v > 500) {
      res.status(400).json({ error: "The over-estimate threshold must be a whole number from 1 to 500 (%)" });
      return;
    }
    settings.performanceOverEstimatePct = v;
  }
  if (body.iterationFlag !== undefined) {
    const v = Number(body.iterationFlag);
    if (!Number.isInteger(v) || v < 2 || v > 10) {
      res.status(400).json({ error: "The iteration threshold must be a whole number from 2 to 10" });
      return;
    }
    settings.performanceIterationFlag = v;
  }
  await settings.save();
  res.json({ settings: { overEstimatePct: settings.performanceOverEstimatePct ?? 25, iterationFlag: settings.performanceIterationFlag ?? 3 } });
}
