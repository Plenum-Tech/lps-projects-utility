import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod/v4";
import { pearityReport } from "../../controllers/pearityReport.js";
import { Brand } from "../../models/Brand.js";
import { ChangeRequest } from "../../models/ChangeRequest.js";
import { APPROVED_PLAN, latestPlan, ManpowerPlan } from "../../models/ManpowerPlan.js";
import { archivedProjectIds, Project } from "../../models/Project.js";
import { Task } from "../../models/Task.js";
import { TaskHistory } from "../../models/TaskHistory.js";
import { TimeLog } from "../../models/TimeLog.js";
import { appDayStart, appTimeZone } from "../appTime.js";
import { dayFromKey, keyFromDay, mondayOfDay } from "../delivery/days.js";
import { loadFacts, loadRefData, OTHER_TEAM, type DeliveryFilters, type RefData, type TaskFact } from "../delivery/facts.js";
import { addFact, emptyAcc, finalize, openAt, statsFor, type Acc } from "../delivery/metrics.js";
import { getDeliverySettings } from "../delivery/settings.js";
import { MANPOWER_ROLES } from "../manpowerRoles.js";
import { currentQuarter, loadPitchRows, pitchToday, brandLabel } from "../pitches.js";
import { projectVisibilityFilter } from "../projectAccess.js";
import { projectMonth } from "../projectExpiry.js";
import { scopeTotals, scopeUnitOf, type ScopeItem } from "../scopeUnits.js";
import { resolveTeam, teamInfo, teamScopeParam, type TeamFilter, type TeamScope } from "./people.js";
import {
  brandIdByName,
  brandIdsByName,
  currentMonth,
  excerpt,
  filterParams,
  limitParam,
  LOW_VOLUME,
  sortDirParam,
  sortRows,
  matchName,
  monthLabel,
  pctOf,
  periodParams,
  personIdByName,
  resolvePeriod,
  round1,
  todayDay,
  ToolInputError,
  type Period,
  type ToolContext,
} from "./common.js";

// ---------------------------------------------------------------------------
// Leadership Insights data tools. Each is READ-ONLY: zod-validated params in,
// a small aggregated JSON object out (≤ MAX_ROWS rows), computed by our own
// code (the Delivery Pulse facts, the scope-usage rule, the approved manpower
// plan, the pitch tracker rows, the Pearity report). No emails, passwords,
// tokens, hourly rates, costs, leave or HR data ever leave a tool.
// ---------------------------------------------------------------------------

export interface InsightTool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  params: S;
  run(args: z.infer<S>, ctx: ToolContext): Promise<unknown>;
}

const defineTool = <S extends z.ZodObject>(tool: InsightTool<S>) => tool as unknown as InsightTool;

const oid = (id: string) => new mongoose.Types.ObjectId(id);
const teamFilterParams = { ...filterParams, teamScope: teamScopeParam };
const take = <T>(rows: T[], limit: number | undefined, fallback = 25) => rows.slice(0, limit ?? fallback);

// -- Delivery facts (tasks, late, rework) -------------------------------------

interface FactCtx {
  ref: RefData;
  facts: TaskFact[];
  period: Period;
  today: number;
  applied: Record<string, string>;
  team: TeamFilter | null;
}

async function loadTaskFacts(args: { brand?: string; team?: string; person?: string; teamScope?: TeamScope }, period: Period): Promise<FactCtx> {
  const [settings, ref] = await Promise.all([getDeliverySettings(), loadRefData()]);
  const applied: Record<string, string> = {};
  const filters: DeliveryFilters = { team: null, brand: null, person: null };
  if (args.brand) {
    const b = brandIdByName(ref, args.brand);
    filters.brand = b.id;
    applied.brand = b.label;
  }
  const team = args.team ? await resolveTeam(ref, args.team, args.teamScope) : null;
  // A department narrows the scan like Delivery Pulse; a person's team is filtered below.
  if (team?.kind === "department") filters.team = team.departmentId;
  if (team) applied.team = team.label;
  if (args.person) {
    const p = personIdByName(ref, args.person);
    filters.person = p.id;
    applied.person = p.label;
  }
  const { facts } = await loadFacts(settings, ref, { kind: "all", department: null }, filters, period.start);
  return { ref, facts: team?.kind === "person" ? facts.filter(team.matchFact) : facts, period, today: todayDay(), applied, team };
}

const GROUPS = ["none", "status", "brand", "project", "person", "team"] as const;
type GroupBy = (typeof GROUPS)[number];

function groupKeys(f: TaskFact, by: GroupBy): string[] {
  switch (by) {
    case "status":
      return [f.status];
    case "brand":
      return [f.brand ?? "none"];
    case "project":
      return [f.project ?? "none"];
    case "person":
      return f.doers.length ? f.doers : ["none"];
    case "team":
      return f.teams;
    default:
      return ["all"];
  }
}

function groupLabel(ref: RefData, by: GroupBy, key: string): string {
  if (key === "none") return by === "person" ? "Unassigned" : by === "brand" ? "No brand" : "No project";
  switch (by) {
    case "brand":
      return ref.brands.get(key)?.name ?? "Unknown brand";
    case "project": {
      const p = ref.projects.get(key);
      return p ? `${p.code} · ${p.name}` : "Unknown project";
    }
    case "person":
      return ref.users.get(key)?.name ?? "Unknown";
    case "team":
      return key === OTHER_TEAM ? "Other" : (ref.departments.get(key) ?? "Unknown team");
    default:
      return key;
  }
}

function grouped(c: FactCtx, by: GroupBy) {
  const range = { start: c.period.start, end: c.period.end };
  const asOf = Math.min(c.period.end, c.today);
  const accs = new Map<string, Acc>();
  for (const f of c.facts) {
    for (const k of new Set(groupKeys(f, by))) {
      let acc = accs.get(k);
      if (!acc) accs.set(k, (acc = emptyAcc()));
      addFact(acc, f, range, asOf);
    }
  }
  return [...accs].map(([key, acc]) => ({ key, name: groupLabel(c.ref, by, key), stats: finalize(acc) }));
}

const tasksSummary = defineTool({
  name: "tasksSummary",
  description:
    "Task counts for a period: created, completed, completed on time vs late (actual end vs due date), open and overdue (as of the period end or today), rework; optionally grouped by status, brand, project, person or team. Default period: last 30 days.",
  params: z.object({
    ...periodParams,
    ...teamFilterParams,
    groupBy: z.enum(GROUPS).optional().describe("Group rows by this (default none)."),
    sortBy: z.enum(["created", "completed", "completedLate", "onTimePct", "open", "overdue", "rework"]).optional().describe("Rank groups by this (default created; onTimePct puts groups with fewer than 5 completed last)."),
    sortDir: sortDirParam,
    limit: limitParam,
  }),
  async run(args) {
    const period = resolvePeriod(args);
    const c = await loadTaskFacts(args, period);
    const asOf = Math.min(period.end, c.today);
    const s = statsFor(c.facts, { start: period.start, end: period.end }, asOf);
    const createdInRange = c.facts.filter((f) => f.createdDay >= period.start && f.createdDay <= period.end);
    const byStatus: Record<string, number> = {};
    for (const f of createdInRange) byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
    const by = args.groupBy ?? "none";
    const groups =
      by === "none"
        ? []
        : grouped(c, by)
            .filter((g) => g.stats.created + g.stats.completed + g.stats.open > 0)
            .map((g) => ({
              name: g.name,
              created: g.stats.created,
              completed: g.stats.completed,
              completedOnTime: g.stats.onTime,
              completedLate: g.stats.completedWithDue - g.stats.onTime,
              onTimePct: g.stats.onTimePct,
              open: g.stats.open,
              overdue: g.stats.overdue,
              rework: g.stats.rework,
              lowVolume: g.stats.completed < LOW_VOLUME,
            }));
    const sortBy = args.sortBy ?? "created";
    const ranked = sortRows(groups, sortBy, args.sortDir, sortBy === "onTimePct");
    return {
      period: { from: period.from, to: period.to, label: period.label, openAsOf: keyFromDay(asOf) },
      filters: c.applied,
      ...teamInfo(c.team),
      totals: {
        created: s.created,
        completed: s.completed,
        completedWithDueDate: s.completedWithDue,
        completedOnTime: s.onTime,
        completedLate: s.completedWithDue - s.onTime,
        onTimePct: s.onTimePct,
        open: s.open,
        overdue: s.overdue,
        rework: s.rework,
        reworkPct: s.reworkPct,
        meanDaysToComplete: s.meanDays,
      },
      createdInPeriodByCurrentStatus: byStatus,
      groupBy: by,
      sortedBy: `${sortBy} ${args.sortDir ?? "desc"}`,
      groups: take(ranked, args.limit),
      groupCount: groups.length,
    };
  },
});

const lateTasks = defineTool({
  name: "lateTasks",
  description:
    "Lists late tasks: 'closed_late' = completed in the period after the due date (actual end vs due); 'overdue' = still open and past due today; 'both' returns both in one call. Each row: task code, title, brand, project, doers, due date, actual end, days late, outcome-note excerpt (the 'why'). Default period: last 30 days.",
  params: z.object({
    ...periodParams,
    ...teamFilterParams,
    kind: z.enum(["closed_late", "overdue", "both"]).optional().describe("Which late tasks (default closed_late)."),
    limit: limitParam,
  }),
  async run(args) {
    const period = resolvePeriod(args);
    const c = await loadTaskFacts(args, period);
    const kind = args.kind ?? "closed_late";
    const rows: Array<{ f: TaskFact; kind: "closed_late" | "overdue"; endDay: number | null; daysLate: number }> = [];
    for (const f of c.facts) {
      if (f.dueDay === null) continue;
      if (kind !== "overdue" && f.completedDay !== null && f.completedDay >= period.start && f.completedDay <= period.end) {
        const endDay = f.actualEndDay ?? f.completedDay;
        if (endDay > f.dueDay) rows.push({ f, kind: "closed_late", endDay, daysLate: endDay - f.dueDay });
      }
      if (kind !== "closed_late" && openAt(f, c.today) && f.dueDay < c.today) {
        rows.push({ f, kind: "overdue", endDay: null, daysLate: c.today - f.dueDay });
      }
    }
    rows.sort((a, b) => b.daysLate - a.daysLate || a.f.code.localeCompare(b.f.code));
    const shown = take(rows, args.limit);
    const notes = await Task.find({ _id: { $in: shown.map((r) => oid(r.f.id)) } })
      .select("submissionNotes")
      .lean();
    const noteById = new Map(notes.map((t) => [String(t._id), excerpt(t.submissionNotes)]));
    return {
      period: { from: period.from, to: period.to, label: period.label },
      filters: c.applied,
      ...teamInfo(c.team),
      total: rows.length,
      closedLate: rows.filter((r) => r.kind === "closed_late").length,
      overdue: rows.filter((r) => r.kind === "overdue").length,
      tasks: shown.map((r) => {
        const p = r.f.project ? c.ref.projects.get(r.f.project) : null;
        return {
          id: r.f.id,
          code: r.f.code,
          title: r.f.title,
          kind: r.kind,
          status: r.f.status,
          brand: r.f.brand ? (c.ref.brands.get(r.f.brand)?.name ?? null) : null,
          project: p ? p.code : null,
          doers: r.f.doers.map((d) => c.ref.users.get(d)?.name ?? "Unknown"),
          due: keyFromDay(r.f.dueDay!),
          actualEnd: r.endDay !== null ? keyFromDay(r.endDay) : null,
          daysLate: r.daysLate,
          outcomeNote: noteById.get(r.f.id) || null,
        };
      }),
    };
  },
});

const reworkStats = defineTool({
  name: "reworkStats",
  description:
    "Rework among tasks created in the period: count, rate (% of tasks created), split internal (our review) vs external (client) vs not set; optionally grouped by brand, team or person. Groups are ranked by sortBy (default reworkPct, desc); groups with fewer than 5 tasks are flagged lowVolume and ranked after the others for rates. Default period: last 30 days.",
  params: z.object({
    ...periodParams,
    ...teamFilterParams,
    groupBy: z.enum(["none", "brand", "team", "person"]).optional().describe("Group rows by this (default none)."),
    sortBy: z.enum(["reworkPct", "rework", "created", "external", "internal"]).optional().describe("Rank groups by this (default reworkPct)."),
    sortDir: sortDirParam,
    limit: limitParam,
  }),
  async run(args) {
    const period = resolvePeriod(args);
    const c = await loadTaskFacts(args, period);
    const s = statsFor(c.facts, { start: period.start, end: period.end }, Math.min(period.end, c.today));
    const by = args.groupBy ?? "none";
    const groups =
      by === "none"
        ? []
        : grouped(c, by)
            .filter((g) => g.stats.created > 0)
            .map((g) => ({
              name: g.name,
              created: g.stats.created,
              rework: g.stats.rework,
              reworkPct: g.stats.reworkPct,
              internal: g.stats.reworkInternal,
              external: g.stats.reworkExternal,
              notSet: g.stats.reworkNotSet,
              lowVolume: g.stats.created < LOW_VOLUME,
            }));
    const sortBy = args.sortBy ?? "reworkPct";
    const ranked = sortRows(groups, sortBy, args.sortDir, sortBy === "reworkPct");
    return {
      period: { from: period.from, to: period.to, label: period.label },
      filters: c.applied,
      ...teamInfo(c.team),
      totals: {
        created: s.created,
        rework: s.rework,
        reworkPct: s.reworkPct,
        internal: s.reworkInternal,
        external: s.reworkExternal,
        notSet: s.reworkNotSet,
      },
      groupBy: by,
      sortedBy: `${sortBy} ${args.sortDir ?? "desc"}`,
      groups: take(ranked, args.limit),
      groupCount: groups.length,
      ...(by !== "none" ? { note: `lowVolume = fewer than ${LOW_VOLUME} tasks created (rate not comparable).` } : {}),
    };
  },
});

// -- Scope usage --------------------------------------------------------------

const scopeUsage = defineTool({
  name: "scopeUsage",
  description:
    "Scope usage of the projects of a month or a range of months (the project's month: naming month, else the month written in its name, else its deadline): per brand and project, per scope unit (e.g. Static, Video), the approved scope total, the amount used by new-work tasks (rework excluded, rejected over-scope excluded), 'remaining' = scope not delivered yet and 'over' = used beyond the total. Also counts over-scope task requests (pending / approved). Use it for 'which scope is not delivered / pending / remaining' (undeliveredOnly) and for over-scope (overOnly). A brand name also covers its sub-brands (Zoom → Zoom, ZOOM TT). Default: the current month.",
  params: z.object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional().describe("Single month YYYY-MM (default current)."),
    fromMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional().describe("First month YYYY-MM of a range ('from April 2026' → 2026-04)."),
    toMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional().describe("Last month YYYY-MM of a range (default: the current month, 'till date')."),
    brand: filterParams.brand,
    overOnly: z.boolean().optional().describe("Only brands / projects over scope."),
    undeliveredOnly: z.boolean().optional().describe("Only brands / projects / units with scope not delivered yet (remaining > 0)."),
    limit: limitParam,
  }),
  async run(args) {
    const ranged = !!(args.fromMonth || args.toMonth);
    const from = ranged ? (args.fromMonth ?? args.toMonth!) : (args.month ?? currentMonth());
    const to = ranged ? (args.toMonth ?? currentMonth()) : from;
    if (from > to) throw new ToolInputError(`fromMonth ${from} is after toMonth ${to}.`);
    const ref = await loadRefData();
    const brandFilter = args.brand ? brandIdsByName(ref, args.brand) : null;
    // Projects imported without a naming month carry their month in the name or deadline.
    const projects = (
      await Project.find({
        $or: [{ "naming.month": { $gte: from, $lte: to } }, { "naming.month": null }],
        archivedAt: null,
        ...(brandFilter ? { brand: { $in: brandFilter.ids.map(oid) } } : {}),
      })
        .select("code name brand naming deadline scopeItems requiresScope")
        .lean()
    )
      .map((p) => ({ ...p, month: projectMonth(p) }))
      .filter((p): p is typeof p & { month: string } => !!p.month && p.month >= from && p.month <= to)
      .sort((a, b) => a.month.localeCompare(b.month));
    const ids = projects.map((p) => p._id);
    const [used, overScope, taskCounts] = await Promise.all([
      Task.aggregate<{ _id: { project: mongoose.Types.ObjectId; unit: string }; used: number }>([
        {
          $match: {
            project: { $in: ids },
            iteration: { $ne: "rework" },
            "overScope.status": { $ne: "rejected" },
            "titleParts.unit": { $type: "string" },
          },
        },
        { $group: { _id: { project: "$project", unit: { $toLower: "$titleParts.unit" } }, used: { $sum: "$titleParts.quantity" } } },
      ]),
      Task.aggregate<{ _id: { project: mongoose.Types.ObjectId; status: string }; n: number }>([
        { $match: { project: { $in: ids }, "overScope.status": { $in: ["pending", "approved"] } } },
        { $group: { _id: { project: "$project", status: "$overScope.status" }, n: { $sum: 1 } } },
      ]),
      // New-work tasks per project: done / open, and how many carry no scope unit
      // (older and imported tasks) — those can't be counted against the scope.
      Task.aggregate<{ _id: mongoose.Types.ObjectId; tasks: number; done: number; open: number; untagged: number }>([
        { $match: { project: { $in: ids }, iteration: { $ne: "rework" }, status: { $ne: "rejected" } } },
        {
          $group: {
            _id: "$project",
            tasks: { $sum: 1 },
            done: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
            open: { $sum: { $cond: [{ $ne: ["$status", "completed"] }, 1, 0] } },
            untagged: { $sum: { $cond: [{ $eq: [{ $type: "$titleParts.unit" }, "string"] }, 0, 1] } },
          },
        },
      ]),
    ]);
    const usedBy = new Map(used.map((u) => [`${u._id.project}:${u._id.unit.trim()}`, u.used]));
    const overBy = new Map(overScope.map((o) => [`${o._id.project}:${o._id.status}`, o.n]));
    const countsBy = new Map(taskCounts.map((c) => [String(c._id), c]));

    type UnitRow = { unit: string; total: number; used: number; remaining: number; over: number };
    const projectRows = projects.map((p) => {
      const units: UnitRow[] = [];
      const totals = scopeTotals(p.scopeItems as ScopeItem[]);
      const seen = new Set<string>();
      for (const [key, t] of totals) {
        seen.add(key);
        const u = usedBy.get(`${p._id}:${key}`) ?? 0;
        units.push({ unit: t.unit, total: t.total, used: u, remaining: Math.max(0, t.total - u), over: Math.max(0, u - t.total) });
      }
      // Work on a known scope unit the project has no scope for is all over scope;
      // free-text (legacy) units are only counted.
      let unknownUnits = 0;
      const prefix = `${p._id}:`;
      for (const [k, u] of usedBy) {
        if (!k.startsWith(prefix)) continue;
        const unit = k.slice(prefix.length);
        if (seen.has(unit)) continue;
        const def = scopeUnitOf(unit);
        if (def && !seen.has(def.name.toLowerCase())) units.push({ unit: def.name, total: 0, used: u, remaining: 0, over: u });
        else if (!def) unknownUnits += u;
      }
      return {
        brandId: p.brand ? String(p.brand) : null,
        code: p.code,
        name: p.name,
        month: monthLabel(p.month),
        hasScope: totals.size > 0,
        tasks: countsBy.get(String(p._id))?.tasks ?? 0,
        tasksDone: countsBy.get(String(p._id))?.done ?? 0,
        tasksOpen: countsBy.get(String(p._id))?.open ?? 0,
        tasksWithoutScopeUnit: countsBy.get(String(p._id))?.untagged ?? 0,
        tasksOnUnknownUnits: unknownUnits,
        units,
        overScopeTasksPending: overBy.get(`${p._id}:pending`) ?? 0,
        overScopeTasksApproved: overBy.get(`${p._id}:approved`) ?? 0,
      };
    });

    const brands = new Map<string, { brand: string; units: Map<string, UnitRow>; projects: number; projectsOver: number; pending: number; approved: number; tasks: number; done: number; open: number; untagged: number }>();
    for (const p of projectRows) {
      const key = p.brandId ?? "none";
      const b = brands.get(key) ?? {
        brand: p.brandId ? (ref.brands.get(p.brandId)?.name ?? "Unknown brand") : "No brand",
        units: new Map(),
        projects: 0,
        projectsOver: 0,
        pending: 0,
        approved: 0,
        tasks: 0,
        done: 0,
        open: 0,
        untagged: 0,
      };
      brands.set(key, b);
      b.projects++;
      b.tasks += p.tasks;
      b.done += p.tasksDone;
      b.open += p.tasksOpen;
      b.untagged += p.tasksWithoutScopeUnit;
      if (p.units.some((u) => u.over > 0)) b.projectsOver++;
      b.pending += p.overScopeTasksPending;
      b.approved += p.overScopeTasksApproved;
      for (const u of p.units) {
        const k = u.unit.toLowerCase();
        const acc = b.units.get(k) ?? { unit: u.unit, total: 0, used: 0, remaining: 0, over: 0 };
        acc.remaining += u.remaining;
        acc.total += u.total;
        acc.used += u.used;
        acc.over += u.over;
        b.units.set(k, acc);
      }
    }
    let brandRows = [...brands.values()].map((b) => {
      const units = [...b.units.values()];
      return {
        brand: b.brand,
        projects: b.projects,
        projectsOverScope: b.projectsOver,
        overScopeTasksPending: b.pending,
        overScopeTasksApproved: b.approved,
        tasks: b.tasks,
        tasksDone: b.done,
        tasksOpen: b.open,
        tasksWithoutScopeUnit: b.untagged,
        totalScope: units.reduce((s, u) => s + u.total, 0),
        totalUsed: units.reduce((s, u) => s + u.used, 0),
        notDelivered: units.reduce((s, u) => s + u.remaining, 0),
        notDeliveredUnits: units.filter((u) => u.remaining > 0).map((u) => `${u.remaining} ${u.unit}`),
        overUnits: units.reduce((s, u) => s + u.over, 0),
        overUnitNames: units.filter((u) => u.over > 0).map((u) => u.unit),
        units,
      };
    });
    let projectList = projectRows.map(({ brandId, ...p }) => ({
      brand: brandId ? (ref.brands.get(brandId)?.name ?? "Unknown brand") : "No brand",
      ...p,
    }));
    if (args.overOnly) {
      brandRows = brandRows.filter((b) => b.overUnits > 0 || b.overScopeTasksApproved + b.overScopeTasksPending > 0);
      projectList = projectList.filter((p) => p.units.some((u) => u.over > 0) || p.overScopeTasksApproved + p.overScopeTasksPending > 0);
    }
    if (args.undeliveredOnly) {
      brandRows = brandRows.filter((b) => b.notDelivered > 0);
      projectList = projectList
        .map((p) => ({ ...p, units: p.units.filter((u) => u.remaining > 0) }))
        .filter((p) => p.units.length > 0);
    }
    if (args.undeliveredOnly) {
      brandRows.sort((a, b) => b.notDelivered - a.notDelivered);
      projectList.sort((a, b) => b.units.reduce((s, u) => s + u.remaining, 0) - a.units.reduce((s, u) => s + u.remaining, 0));
    } else {
      brandRows.sort((a, b) => b.overUnits - a.overUnits || b.totalUsed - a.totalUsed);
      projectList.sort((a, b) => b.units.reduce((s, u) => s + u.over, 0) - a.units.reduce((s, u) => s + u.over, 0));
    }
    return {
      month: from === to ? from : `${from}..${to}`,
      label: from === to ? monthLabel(from) : `${monthLabel(from)} – ${monthLabel(to)}`,
      filters: brandFilter ? { brand: brandFilter.label } : {},
      projectCount: projects.length,
      projectsWithoutScope: projectRows.filter((p) => !p.hasScope).length,
      brands: take(brandRows, args.limit, 40),
      projects: take(projectList, args.limit, 40),
      note: "used = sum of task quantities (new work, not rework) per scope unit; remaining = approved scope not delivered yet (total − used); over = used beyond the approved total. Each project shows its month. Tasks without a scope unit (older / imported tasks) are not counted in used, so when tasksWithoutScopeUnit > 0 the remaining figure overstates what is undelivered: say so, and give the task counts (done / open) alongside it — open tasks are work not delivered yet. A brand is over scope when work on a scope unit goes beyond its approved total (overUnits > 0). Over-scope task requests (approved = allowed beyond scope, pending = waiting) are counted separately. Describe this in plain words, not field names.",
    };
  },
});

// -- Time logged --------------------------------------------------------------

const timeLogged = defineTool({
  name: "timeLogged",
  description:
    "Hours logged (pending + approved time logs, by start date) in a period, grouped by person, brand, project, team or week. Hours only — never rates or cost. Default period: last 30 days.",
  params: z.object({
    ...periodParams,
    ...teamFilterParams,
    project: z.string().max(80).optional().describe("Project code or name (or part of it)."),
    groupBy: z.enum(["person", "brand", "project", "team", "week"]).optional().describe("Group rows by this (default person)."),
    limit: limitParam,
  }),
  async run(args) {
    const period = resolvePeriod(args);
    const ref = await loadRefData();
    const applied: Record<string, string> = {};
    const brand = args.brand ? brandIdByName(ref, args.brand) : null;
    const team = args.team ? await resolveTeam(ref, args.team, args.teamScope) : null;
    const person = args.person ? personIdByName(ref, args.person) : null;
    const project = args.project
      ? matchName(
          "project",
          args.project,
          [...ref.projects].map(([id, p]) => ({ id, names: [p.code, p.name], label: `${p.code} · ${p.name}` }))
        )
      : null;
    if (brand) applied.brand = brand.label;
    if (team) applied.team = team.label;
    if (person) applied.person = person.label;
    if (project) applied.project = project.label;

    const tz = appTimeZone();
    const from = new Date((period.start - 1) * 86_400_000);
    const to = new Date((period.end + 2) * 86_400_000);
    const match: Record<string, unknown> = { endTime: { $ne: null }, status: { $in: ["pending", "approved"] }, startTime: { $gte: from, $lt: to } };
    if (person) match.user = oid(person.id);
    if (project) match.project = oid(project.id);
    const rows = await TimeLog.aggregate<{ _id: { user: mongoose.Types.ObjectId; project: mongoose.Types.ObjectId | null; day: string }; minutes: number }>([
      { $match: match },
      {
        $group: {
          _id: { user: "$user", project: "$project", day: { $dateToString: { format: "%Y-%m-%d", date: "$startTime", timezone: tz } } },
          minutes: { $sum: "$durationMinutes" },
        },
      },
    ]);
    const by = args.groupBy ?? "person";
    const groups = new Map<string, { name: string; minutes: number; people: Set<string> }>();
    let total = 0;
    for (const r of rows) {
      const day = dayFromKey(r._id.day);
      if (day < period.start || day > period.end) continue;
      const userId = String(r._id.user);
      const u = ref.users.get(userId);
      if (!u) continue; // guests
      if (team && !team.userIds.has(userId)) continue;
      const projectId = r._id.project ? String(r._id.project) : null;
      const p = projectId ? ref.projects.get(projectId) : null;
      if (brand && p?.brand !== brand.id) continue;
      let key: string;
      let name: string;
      switch (by) {
        case "brand":
          key = p?.brand ?? "none";
          name = p?.brand ? (ref.brands.get(p.brand)?.name ?? "Unknown brand") : "No brand";
          break;
        case "project":
          key = projectId ?? "none";
          name = p ? `${p.code} · ${p.name}` : "No project";
          break;
        case "team":
          key = u.department ?? "none";
          name = u.department ? (ref.departments.get(u.department) ?? "Unknown team") : "No team";
          break;
        case "week":
          key = keyFromDay(mondayOfDay(day));
          name = `Week of ${key}`;
          break;
        default:
          key = userId;
          name = u.name;
      }
      const g = groups.get(key) ?? { name, minutes: 0, people: new Set<string>() };
      g.minutes += r.minutes;
      g.people.add(userId);
      groups.set(key, g);
      total += r.minutes;
    }
    const list = [...groups]
      .map(([key, g]) => ({ key, name: g.name, hours: round1(g.minutes / 60), people: g.people.size }))
      .sort((a, b) => (by === "week" ? a.key.localeCompare(b.key) : b.hours - a.hours));
    return {
      period: { from: period.from, to: period.to, label: period.label },
      filters: applied,
      totalHours: round1(total / 60),
      ...teamInfo(team),
      groupBy: by,
      groups: take(
        list.map(({ key: _k, ...g }) => g),
        args.limit,
        by === "week" ? 60 : 25
      ),
      groupCount: list.length,
    };
  },
});

// -- Manpower plan -----------------------------------------------------------

const ROLE_LABEL = new Map<string, string>(MANPOWER_ROLES.map((r) => [r.key, r.label]));
const LEAD_ROLES = ["programLead", "pm"];

const manpowerLoad = defineTool({
  name: "manpowerLoad",
  description:
    "The month's approved manpower plan: per person the plan lines (active / pitch) and brands they're on, flagged overloaded when active lines exceed the plan's max per person; lines with empty roles (no one assigned, not marked not-needed; placeholders like 'New PM' listed) and lines missing a lead (no Program Lead and no PM). Default month: the current one.",
  params: z.object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional().describe("Month YYYY-MM (default current)."),
    person: filterParams.person,
    overloadedOnly: z.boolean().optional().describe("Only overloaded people."),
    limit: limitParam,
  }),
  async run(args) {
    const month = args.month ?? currentMonth();
    const [plan, ref] = await Promise.all([latestPlan(month), loadRefData()]);
    if (!plan) {
      const months = (await ManpowerPlan.distinct("month", APPROVED_PLAN)).sort();
      return { month, label: monthLabel(month), plan: null, note: `There is no approved manpower plan for ${monthLabel(month)}. Tell the user this first (title and summary); show another month only if asked, clearly labelled as that month.`, monthsWithAPlan: months.slice(-12) };
    }
    const person = args.person ? personIdByName(ref, args.person) : null;
    const max = plan.maxProjectsPerPerson;
    const people = new Map<string, { active: Set<string>; pitch: Set<string>; brands: Set<string>; roles: Set<string> }>();
    const lines: Array<{ line: string; section: string; brand: string | null; emptyRoles: string[]; placeholders: string[]; missingLead: boolean }> = [];
    for (const row of plan.rows) {
      const brand = row.brand ? (ref.brands.get(String(row.brand))?.name ?? null) : null;
      const emptyRoles: string[] = [];
      const placeholders: string[] = [];
      let hasLead = false;
      for (const cell of row.cells) {
        if (cell.users.length > 0 && LEAD_ROLES.includes(cell.role)) hasLead = true;
        if (cell.users.length === 0 && !cell.notNeeded) {
          emptyRoles.push(ROLE_LABEL.get(cell.role) ?? cell.role);
          placeholders.push(...cell.placeholders.map((p) => `${ROLE_LABEL.get(cell.role) ?? cell.role}: ${p}`));
        }
        for (const u of cell.users) {
          const id = String(u);
          const e = people.get(id) ?? { active: new Set(), pitch: new Set(), brands: new Set(), roles: new Set() };
          people.set(id, e);
          (row.section === "pitch" ? e.pitch : e.active).add(row.key);
          if (brand) e.brands.add(brand);
          e.roles.add(ROLE_LABEL.get(cell.role) ?? cell.role);
        }
      }
      lines.push({ line: row.name, section: row.section, brand, emptyRoles, placeholders, missingLead: row.section === "active" && !hasLead });
    }
    let personRows = [...people]
      .filter(([id]) => ref.users.has(id))
      .map(([id, e]) => ({
        name: ref.users.get(id)!.name,
        team: ref.users.get(id)!.department ? (ref.departments.get(ref.users.get(id)!.department!) ?? null) : null,
        activeLines: e.active.size,
        pitchLines: e.pitch.size,
        brands: e.brands.size,
        brandNames: [...e.brands].slice(0, 12),
        roles: [...e.roles],
        overloaded: e.active.size > max,
        _id: id,
      }))
      .sort((a, b) => b.activeLines - a.activeLines || b.brands - a.brands || a.name.localeCompare(b.name));
    if (person) personRows = personRows.filter((p) => p._id === person.id);
    if (args.overloadedOnly) personRows = personRows.filter((p) => p.overloaded);
    const needing = lines.filter((l) => l.emptyRoles.length || l.missingLead);
    return {
      month,
      label: monthLabel(month),
      version: plan.version,
      maxActiveLinesPerPerson: max,
      lineCount: plan.rows.length,
      peopleOnPlan: people.size,
      overloadedCount: [...people.values()].filter((e) => e.active.size > max).length,
      people: take(
        personRows.map(({ _id, ...p }) => p),
        args.limit,
        30
      ),
      linesMissingLead: lines.filter((l) => l.missingLead).length,
      linesWithEmptyRoles: lines.filter((l) => l.emptyRoles.length).length,
      linesNeedingStaff: take(needing, args.limit, 30),
    };
  },
});

// -- Pitch pipeline -----------------------------------------------------------

const pitchPipeline = defineTool({
  name: "pitchPipeline",
  description:
    "Pitches of a quarter (Pitch & Growth tracker): count and revenue potential (AED; TBC when unknown) by month and by lead, status tone (ok / soon / missed / done / no dates), and per step (Milestone 1, Milestone 2, Client presentation) how many were held, not held, rescheduled, missed or upcoming; plus the pitch rows. One call (no lead filter) already includes byLead and byMonth with status-tone counts — don't call it per lead. Default quarter: the current one.",
  params: z.object({
    quarter: z.string().regex(/^\d{4}-Q[1-4]$/).optional().describe("Quarter like 2026-Q4 (default current)."),
    lead: z.string().max(80).optional().describe("Only pitches led by this person (name or part)."),
    status: z.enum(["ok", "soon", "missed", "done", "none"]).optional().describe("Only pitches with this status tone."),
    limit: limitParam,
  }),
  async run(args, ctx) {
    const quarter = args.quarter ?? currentQuarter();
    let rows = await loadPitchRows(ctx.user, projectVisibilityFilter(ctx.user), quarter);
    const ref = await loadRefData();
    const lead = args.lead ? personIdByName(ref, args.lead) : null;
    if (lead) rows = rows.filter((r) => r.leads.some((l) => l.id === lead.id));
    if (args.status) rows = rows.filter((r) => r.status.tone === args.status);
    const today = pitchToday();

    const byMonth = new Map<string, { month: string; pitches: number; revenue: number; tbc: number }>();
    const byLead = new Map<string, { lead: string; pitches: number; revenue: number; tbc: number; byStatusTone: Record<string, number> }>();
    const tones: Record<string, number> = {};
    const steps: Record<string, { held: number; notHeld: number; rescheduled: number; missed: number; upcoming: number; noDate: number }> = {};
    for (const r of rows) {
      const m = r.group ?? "no dates";
      const mm = byMonth.get(m) ?? { month: r.group ? monthLabel(r.group) : "Dates not set", pitches: 0, revenue: 0, tbc: 0 };
      mm.pitches++;
      mm.revenue += r.revenue ?? 0;
      if (r.revenue === null) mm.tbc++;
      byMonth.set(m, mm);
      for (const l of r.leads.length ? r.leads : [{ id: "none", name: "No lead" }]) {
        const e = byLead.get(l.id) ?? { lead: l.name, pitches: 0, revenue: 0, tbc: 0, byStatusTone: {} };
        e.pitches++;
        e.revenue += r.revenue ?? 0;
        if (r.revenue === null) e.tbc++;
        e.byStatusTone[r.status.tone] = (e.byStatusTone[r.status.tone] ?? 0) + 1;
        byLead.set(l.id, e);
      }
      tones[r.status.tone] = (tones[r.status.tone] ?? 0) + 1;
      for (const s of r.steps) {
        const acc = (steps[s.title] ??= { held: 0, notHeld: 0, rescheduled: 0, missed: 0, upcoming: 0, noDate: 0 });
        if (s.outcome === "not_held") acc.notHeld++;
        else if (s.done) acc.held++;
        else if (!s.due) acc.noDate++;
        else if (s.due < today) acc.missed++;
        else if (s.outcome === "rescheduled") acc.rescheduled++;
        else acc.upcoming++;
      }
    }
    return {
      quarter,
      today,
      filters: { ...(lead ? { lead: lead.label } : {}), ...(args.status ? { status: args.status } : {}) },
      totals: {
        pitches: rows.length,
        revenuePotentialAed: rows.reduce((s, r) => s + (r.revenue ?? 0), 0),
        revenueTbc: rows.filter((r) => r.revenue === null && !r.revenueHidden).length,
        byStatusTone: tones,
      },
      byMonth: [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v),
      byLead: [...byLead.values()].sort((a, b) => b.pitches - a.pitches || b.revenue - a.revenue),
      steps,
      pitches: take(rows, args.limit, 40).map((r) => ({
        client: brandLabel(r),
        title: r.title,
        month: r.month,
        revenueAed: r.revenue,
        revenueTbc: r.revenueTbc,
        leads: r.leads.map((l) => l.name),
        status: r.status.text,
        tone: r.status.tone,
        milestone1: r.milestone1,
        milestone2: r.milestone2,
        clientPresentation: r.clientPresentation,
      })),
    };
  },
});

// -- Pearity ------------------------------------------------------------------

/** Runs the Pearity report endpoint in-process (same numbers as Reports → Pearity stats). */
async function runPearityReport(user: ToolContext["user"], query: Record<string, string>): Promise<Record<string, unknown>> {
  let status = 200;
  let body: unknown = null;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(data: unknown) {
      body = data;
      return res;
    },
  };
  await pearityReport({ query, user } as unknown as Request, res as unknown as Response);
  if (status >= 400) throw new ToolInputError((body as { error?: string } | null)?.error ?? "Pearity report failed");
  return body as Record<string, unknown>;
}

const PEARITY_FIELDS = ["closed", "on", "off", "notRecorded", "onPct", "generateClicks", "jobsCompleted", "jobsFailed", "savedToDam", "avgReadiness", "onTimePct"] as const;
const pickPearity = (row: Record<string, unknown>) => Object.fromEntries(PEARITY_FIELDS.map((k) => [k, row[k] ?? null]));
/** Shares of all closed tasks (onPct is of the tasks with a recorded choice). */
const withShares = (t: Record<string, unknown>) => {
  const closed = Number(t.closed) || 0;
  return { ...t, onPctOfClosed: pctOf(Number(t.on) || 0, closed), offPctOfClosed: pctOf(Number(t.off) || 0, closed), notRecordedPctOfClosed: pctOf(Number(t.notRecorded) || 0, closed) };
};

const pearityStats = defineTool({
  name: "pearityStats",
  description:
    "Pearity usage of tasks completed in the period: On vs Off Pearity (and not recorded), On %, Pearity generations (generate clicks, jobs completed / failed, assets saved to DAM), average outcome readiness and on-time %; in total, by brand or by person, plus a weekly trend. Default period: last 30 days.",
  params: z.object({
    ...periodParams,
    ...teamFilterParams,
    groupBy: z.enum(["brand", "person"]).optional().describe("Rows by brand (default) or person."),
    sortBy: z.enum(["closed", "on", "off", "notRecorded", "onPct"]).optional().describe("Rank rows by this (default closed; onPct puts rows with fewer than 5 closed last)."),
    sortDir: sortDirParam,
    limit: limitParam,
  }),
  async run(args, ctx) {
    const period = resolvePeriod(args);
    const ref = await loadRefData();
    const query: Record<string, string> = { from: period.from, to: period.to };
    const applied: Record<string, string> = {};
    if (args.brand) {
      const b = brandIdByName(ref, args.brand);
      query.brand = b.id;
      applied.brand = b.label;
    }
    if (args.team) {
      const t = await resolveTeam(ref, args.team, args.teamScope);
      // The Pearity report filters by one department or one person: a person's team uses their department
      // for "department", else the person themselves.
      if (t.kind === "department" || t.scope === "department") {
        if (t.departmentId) query.department = t.departmentId;
      } else if (t.personId) query.user = t.personId;
      applied.team = t.kind === "person" && t.scope !== "department" ? `${t.label} (only their own tasks here)` : t.label;
    }
    if (args.person) {
      const p = personIdByName(ref, args.person);
      query.user = p.id;
      applied.person = p.label;
    }
    const report = await runPearityReport(ctx.user, query);
    const by = args.groupBy ?? "brand";
    const rows = (by === "person" ? (report.byPerson as Array<Record<string, unknown>>) : (report.byBrand as Array<Record<string, unknown>>)) ?? [];
    return {
      period: { from: period.from, to: period.to, label: period.label },
      filters: applied,
      totals: withShares(pickPearity((report.totals as Record<string, unknown>) ?? {})),
      groupBy: by,
      groups: take(
        sortRows(
          rows.map((r) => ({ name: String(r.name ?? ""), ...pickPearity(r), lowVolume: Number(r.closed) < LOW_VOLUME })),
          args.sortBy ?? "closed",
          args.sortDir,
          args.sortBy === "onPct"
        ),
        args.limit
      ),
      groupCount: rows.length,
      weeklyTrend: ((report.trend as Array<Record<string, unknown>>) ?? []).slice(-26),
    };
  },
});

// -- Approvals ----------------------------------------------------------------

const approvalsWaiting = defineTool({
  name: "approvalsWaiting",
  description:
    "What waits for leadership approval now: change requests (project scope / team, brand edits, manpower plan versions, project moves), new brands, new projects and tasks over scope — counts per kind and the oldest items with their age in days.",
  params: z.object({
    kind: z.enum(["all", "changes", "brands", "projects", "overScopeTasks"]).optional().describe("Only this kind (default all)."),
    limit: limitParam,
  }),
  async run(args) {
    const kind = args.kind ?? "all";
    const now = Date.now();
    const age = (d: Date | null | undefined) => (d ? Math.floor((now - new Date(d).getTime()) / 86_400_000) : null);
    const ref = await loadRefData();
    const name = (id: unknown) => (id ? (ref.users.get(String(id))?.name ?? "Unknown") : null);
    const items: Array<{ kind: string; title: string; requestedBy: string | null; brand: string | null; ageDays: number | null }> = [];
    if (kind === "all" || kind === "changes") {
      const changes = await ChangeRequest.find({ status: "pending", draft: { $ne: true } })
        .select("kind title brand requestedBy createdAt sentAt")
        .sort({ createdAt: 1 })
        .limit(500)
        .lean();
      for (const c of changes)
        items.push({
          kind: `change:${c.kind}`,
          title: c.title,
          requestedBy: name(c.requestedBy),
          brand: c.brand ? (ref.brands.get(String(c.brand))?.name ?? null) : null,
          ageDays: age(c.sentAt ?? c.createdAt),
        });
    }
    if (kind === "all" || kind === "brands") {
      const brands = await Brand.find({ status: "pending" }).select("name requestedBy createdAt").sort({ createdAt: 1 }).limit(500).lean();
      for (const b of brands) items.push({ kind: "new_brand", title: b.name, requestedBy: name(b.requestedBy), brand: b.name, ageDays: age(b.createdAt) });
    }
    if (kind === "all" || kind === "projects") {
      const projects = await Project.find({ "approval.status": "pending", archivedAt: null })
        .select("code name brand approval.requestedAt approval.requestedBy")
        .sort({ "approval.requestedAt": 1 })
        .limit(500)
        .lean();
      for (const p of projects)
        items.push({
          kind: "new_project",
          title: `${p.code} · ${p.name}`,
          requestedBy: name(p.approval?.requestedBy),
          brand: p.brand ? (ref.brands.get(String(p.brand))?.name ?? null) : null,
          ageDays: age(p.approval?.requestedAt),
        });
    }
    if (kind === "all" || kind === "overScopeTasks") {
      const tasks = await Task.find({ "overScope.status": "pending" }).select("title shortCode project assignedBy createdAt").sort({ createdAt: 1 }).limit(500).lean();
      for (const t of tasks) {
        const p = t.project ? ref.projects.get(String(t.project)) : null;
        items.push({
          kind: "over_scope_task",
          title: `${t.shortCode ?? ""} ${t.title}`.trim(),
          requestedBy: name(t.assignedBy),
          brand: p?.brand ? (ref.brands.get(p.brand)?.name ?? null) : null,
          ageDays: age(t.createdAt),
        });
      }
    }
    const counts: Record<string, number> = {};
    for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
    items.sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));
    return {
      total: items.length,
      countsByKind: counts,
      oldestAgeDays: items[0]?.ageDays ?? null,
      items: take(items, args.limit, 30),
    };
  },
});

// -- Day-to-day: today's workload per person and recent task activity ---------

/** The people a team / person / brand filter selects (null = everyone) and the team info. */
async function peopleScope(ref: RefData, args: { team?: string; person?: string; teamScope?: TeamScope }) {
  const applied: Record<string, string> = {};
  let users: Set<string> | null = null;
  let team: TeamFilter | null = null;
  if (args.team) {
    team = await resolveTeam(ref, args.team, args.teamScope);
    users = team.userIds;
    applied.team = team.label;
  }
  if (args.person) {
    const p = personIdByName(ref, args.person);
    users = new Set([p.id]);
    applied.person = p.label;
  }
  return { users, team, applied };
}

const OPEN = ["todo", "in_progress", "in_review"];
const dateKeyUtc = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

const teamDay = defineTool({
  name: "teamDay",
  description:
    "Day-to-day task update for a team or person (or everyone): per person today's workload — tasks due today, due this week (to Sunday), in progress, in review, overdue, completed today and hours logged today; plus the list of those tasks. `team` may name a department or a person's team (\"Hamza team\").",
  params: z.object({
    team: filterParams.team,
    teamScope: teamScopeParam,
    person: filterParams.person,
    brand: filterParams.brand,
    limit: limitParam,
  }),
  async run(args) {
    const ref = await loadRefData();
    const { users, team, applied } = await peopleScope(ref, args);
    const brand = args.brand ? brandIdByName(ref, args.brand) : null;
    if (brand) applied.brand = brand.label;
    const today = todayDay();
    const todayKey = keyFromDay(today);
    const weekEndKey = keyFromDay(mondayOfDay(today) + 6);
    const dayStart = appDayStart(todayKey);
    const match: Record<string, unknown> = {
      $or: [{ status: { $in: OPEN } }, { status: "completed", completedAt: { $gte: dayStart } }],
    };
    if (users) match.assignees = { $in: [...users].map(oid) };
    if (brand) match.project = { $in: [...ref.projects].filter(([, p]) => p.brand === brand.id).map(([id]) => oid(id)) };
    const archived = await archivedProjectIds();
    const tasks = await Task.find({ $and: [match, { $or: [{ status: "completed" }, { project: { $nin: archived } }] }] })
      .select("title shortCode status dueDate completedAt assignees project")
      .limit(5000)
      .lean();
    const hours = await TimeLog.aggregate<{ _id: mongoose.Types.ObjectId; minutes: number }>([
      { $match: { startTime: { $gte: dayStart }, endTime: { $ne: null }, status: { $in: ["pending", "approved"] }, ...(users ? { user: { $in: [...users].map(oid) } } : {}) } },
      { $group: { _id: "$user", minutes: { $sum: "$durationMinutes" } } },
    ]);
    type Row = { name: string; team: string | null; dueToday: number; dueThisWeek: number; inProgress: number; inReview: number; overdue: number; completedToday: number; hoursToday: number };
    const rows = new Map<string, Row>();
    const row = (id: string) => {
      let r = rows.get(id);
      if (!r) {
        const u = ref.users.get(id);
        r = { name: u?.name ?? "Unknown", team: u?.department ? (ref.departments.get(u.department) ?? null) : null, dueToday: 0, dueThisWeek: 0, inProgress: 0, inReview: 0, overdue: 0, completedToday: 0, hoursToday: 0 };
        rows.set(id, r);
      }
      return r;
    };
    const list: Array<Record<string, unknown>> = [];
    for (const t of tasks) {
      const due = dateKeyUtc(t.dueDate);
      const doers = (t.assignees ?? []).map(String).filter((id) => ref.users.has(id) && (!users || users.has(id)));
      const open = OPEN.includes(t.status);
      const flags = {
        dueToday: open && due === todayKey,
        dueThisWeek: open && due !== null && due >= todayKey && due <= weekEndKey,
        overdue: open && due !== null && due < todayKey,
        completedToday: t.status === "completed",
      };
      for (const d of doers) {
        const r = row(d);
        if (flags.dueToday) r.dueToday++;
        if (flags.dueThisWeek) r.dueThisWeek++;
        if (flags.overdue) r.overdue++;
        if (flags.completedToday) r.completedToday++;
        if (t.status === "in_progress") r.inProgress++;
        if (t.status === "in_review") r.inReview++;
      }
      if (doers.length && (flags.dueThisWeek || flags.overdue || flags.completedToday)) {
        const p = t.project ? ref.projects.get(String(t.project)) : null;
        list.push({
          id: String(t._id),
          code: t.shortCode ?? "",
          title: t.title,
          people: doers.map((d) => ref.users.get(d)?.name ?? "Unknown"),
          status: t.status,
          due,
          when: flags.completedToday ? "completed today" : flags.overdue ? "overdue" : flags.dueToday ? "due today" : "due this week",
          brand: p?.brand ? (ref.brands.get(p.brand)?.name ?? null) : null,
        });
      }
    }
    for (const h of hours) if (!users || users.has(String(h._id))) row(String(h._id)).hoursToday = round1(h.minutes / 60);
    const people = [...rows.values()].sort((a, b) => b.overdue - a.overdue || b.dueToday - a.dueToday || a.name.localeCompare(b.name));
    const order = { overdue: 0, "due today": 1, "due this week": 2, "completed today": 3 } as Record<string, number>;
    list.sort((a, b) => order[String(a.when)]! - order[String(b.when)]! || String(a.due ?? "").localeCompare(String(b.due ?? "")));
    const sum = (k: keyof Row) => people.reduce((s, r) => s + Number(r[k]), 0);
    return {
      today: todayKey,
      weekEnds: weekEndKey,
      filters: applied,
      ...teamInfo(team),
      totals: { people: people.length, dueToday: sum("dueToday"), dueThisWeek: sum("dueThisWeek"), inProgress: sum("inProgress"), overdue: sum("overdue"), completedToday: sum("completedToday"), hoursToday: round1(sum("hoursToday")) },
      people: take(people, args.limit, 60),
      tasks: take(list, args.limit, 60),
      taskCount: list.length,
    };
  },
});

const ACTIVITY_ACTIONS = ["created", "status_changed", "submitted", "reviewed", "comment_added", "rework_added", "subtask_completed"] as const;
const ACTIVITY_LABEL: Record<string, string> = {
  created: "created",
  status_changed: "status",
  submitted: "submitted",
  reviewed: "reviewed",
  comment_added: "comment",
  rework_added: "rework added",
  subtask_completed: "item done",
};

const taskActivity = defineTool({
  name: "taskActivity",
  description:
    "Recent task updates (from task history): status changes, completions, submissions, reviews, comments (short excerpt), new tasks and rework — counts per person and the latest events, for the last N hours (default 24) or a date range. Filter by a team (department or a person's team), person or brand.",
  params: z.object({
    hours: z.number().int().min(1).max(336).optional().describe("Look back this many hours (default 24, max 336)."),
    from: periodParams.from,
    to: periodParams.to,
    team: filterParams.team,
    teamScope: teamScopeParam,
    person: filterParams.person,
    brand: filterParams.brand,
    limit: limitParam,
  }),
  async run(args) {
    const ref = await loadRefData();
    const { users, team, applied } = await peopleScope(ref, args);
    const brand = args.brand ? brandIdByName(ref, args.brand) : null;
    if (brand) applied.brand = brand.label;
    const end = args.to ? appDayStart(keyFromDay(dayFromKey(args.to) + 1)) : new Date();
    const start = args.from ? appDayStart(args.from) : new Date(end.getTime() - (args.hours ?? 24) * 3_600_000);
    // History has no createdAt index: the _id (creation time) range uses the primary index.
    const match: Record<string, unknown> = {
      _id: { $gte: mongoose.Types.ObjectId.createFromTime(Math.floor(start.getTime() / 1000)), $lt: mongoose.Types.ObjectId.createFromTime(Math.ceil(end.getTime() / 1000)) },
      action: { $in: ACTIVITY_ACTIONS },
    };
    if (users) match.actor = { $in: [...users].map(oid) };
    const events = await TaskHistory.find(match).sort({ _id: -1 }).limit(5000).lean();
    const tasks = await Task.find({ _id: { $in: [...new Set(events.map((e) => String(e.task)))].map(oid) } })
      .select("shortCode title project")
      .lean();
    const taskById = new Map(tasks.map((t) => [String(t._id), t]));
    const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: appTimeZone(), month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    type Counts = { name: string; updates: number; statusChanges: number; completed: number; submitted: number; comments: number; created: number };
    const byPerson = new Map<string, Counts>();
    const list: Array<Record<string, unknown>> = [];
    for (const e of events) {
      const t = taskById.get(String(e.task));
      if (!t) continue;
      const p = t.project ? ref.projects.get(String(t.project)) : null;
      if (brand && p?.brand !== brand.id) continue;
      const actor = e.actor ? String(e.actor) : null;
      const name = actor ? (ref.users.get(actor)?.name ?? null) : null;
      if (!name) continue; // system / guests
      const d = (e.details ?? {}) as Record<string, unknown>;
      const c = byPerson.get(actor!) ?? { name, updates: 0, statusChanges: 0, completed: 0, submitted: 0, comments: 0, created: 0 };
      byPerson.set(actor!, c);
      c.updates++;
      if (e.action === "status_changed") c.statusChanges++;
      if (e.action === "status_changed" && d.to === "completed") c.completed++;
      if (e.action === "submitted") c.submitted++;
      if (e.action === "comment_added") c.comments++;
      if (e.action === "created") c.created++;
      const detail =
        e.action === "status_changed"
          ? `${String(d.from ?? "?").replace("_", " ")} → ${String(d.to ?? "?").replace("_", " ")}`
          : e.action === "comment_added"
            ? excerpt(String(d.excerpt ?? ""), 100)
            : e.action === "submitted"
              ? excerpt(String(d.submissionNotes ?? ""), 100)
              : e.action === "rework_added"
                ? String(d.shortCode ?? d.title ?? "")
                : "";
      list.push({
        at: fmt.format(new Date(Number.parseInt(String(e._id).slice(0, 8), 16) * 1000)),
        person: name,
        id: String(t._id),
        code: t.shortCode ?? "",
        title: t.title,
        action: ACTIVITY_LABEL[e.action] ?? e.action,
        detail,
        brand: p?.brand ? (ref.brands.get(p.brand)?.name ?? null) : null,
      });
    }
    const people = [...byPerson.values()].sort((a, b) => b.updates - a.updates || a.name.localeCompare(b.name));
    return {
      period: { from: start.toISOString(), to: end.toISOString(), label: args.from ? `${args.from} to ${args.to ?? "now"}` : `last ${args.hours ?? 24} hours` },
      filters: applied,
      ...teamInfo(team),
      totals: { updates: list.length, people: people.length, completed: people.reduce((s, p) => s + p.completed, 0), comments: people.reduce((s, p) => s + p.comments, 0), submitted: people.reduce((s, p) => s + p.submitted, 0) },
      byPerson: take(people, args.limit, 40),
      events: take(list, args.limit, 60),
      eventCount: list.length,
    };
  },
});

export const INSIGHT_TOOLS: InsightTool[] = [
  teamDay,
  taskActivity,
  tasksSummary,
  lateTasks,
  scopeUsage,
  timeLogged,
  manpowerLoad,
  pitchPipeline,
  reworkStats,
  pearityStats,
  approvalsWaiting,
];

export const TOOL_BY_NAME = new Map(INSIGHT_TOOLS.map((t) => [t.name, t]));

/** OpenAI function definitions (JSON Schema from the zod params). */
export function openAiToolDefs() {
  return INSIGHT_TOOLS.map((t) => {
    const { $schema: _s, ...parameters } = z.toJSONSchema(t.params, { io: "input" }) as Record<string, unknown>;
    return { type: "function" as const, function: { name: t.name, description: t.description, parameters } };
  });
}

/** Validates the model's arguments and runs one tool; errors come back as `{ error }` for the model. */
export async function runTool(name: string, rawArgs: string, ctx: ToolContext): Promise<{ args: unknown; result: unknown; ok: boolean }> {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return { args: rawArgs, result: { error: `Unknown tool ${name}` }, ok: false };
  let parsedJson: unknown;
  try {
    parsedJson = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { args: rawArgs, result: { error: "Arguments were not valid JSON" }, ok: false };
  }
  const parsed = tool.params.safeParse(parsedJson);
  if (!parsed.success) {
    return { args: parsedJson, result: { error: "Invalid arguments", issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) }, ok: false };
  }
  try {
    return { args: parsed.data, result: await tool.run(parsed.data, ctx), ok: true };
  } catch (err) {
    if (err instanceof ToolInputError) return { args: parsed.data, result: { error: err.message, suggestions: err.suggestions }, ok: false };
    console.error(`[insights] tool ${name} failed`, err);
    return { args: parsed.data, result: { error: "This data couldn't be loaded." }, ok: false };
  }
}
