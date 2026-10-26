import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod/v4";
import { pearityReport } from "../../controllers/pearityReport.js";
import { Brand } from "../../models/Brand.js";
import { ChangeRequest } from "../../models/ChangeRequest.js";
import { APPROVED_PLAN, latestPlan, ManpowerPlan } from "../../models/ManpowerPlan.js";
import { Project } from "../../models/Project.js";
import { Task } from "../../models/Task.js";
import { TimeLog } from "../../models/TimeLog.js";
import { appTimeZone } from "../appTime.js";
import { dayFromKey, keyFromDay, mondayOfDay } from "../delivery/days.js";
import { loadFacts, loadRefData, OTHER_TEAM, type DeliveryFilters, type RefData, type TaskFact } from "../delivery/facts.js";
import { addFact, emptyAcc, finalize, openAt, statsFor, type Acc } from "../delivery/metrics.js";
import { getDeliverySettings } from "../delivery/settings.js";
import { MANPOWER_ROLES } from "../manpowerRoles.js";
import { currentQuarter, loadPitchRows, pitchToday, brandLabel } from "../pitches.js";
import { projectVisibilityFilter } from "../projectAccess.js";
import { scopeTotals, scopeUnitOf, type ScopeItem } from "../scopeUnits.js";
import {
  brandIdByName,
  currentMonth,
  excerpt,
  filterParams,
  limitParam,
  matchName,
  monthLabel,
  pctOf,
  periodParams,
  personIdByName,
  resolvePeriod,
  round1,
  teamIdByName,
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
const take = <T>(rows: T[], limit: number | undefined, fallback = 25) => rows.slice(0, limit ?? fallback);

// -- Delivery facts (tasks, late, rework) -------------------------------------

interface FactCtx {
  ref: RefData;
  facts: TaskFact[];
  period: Period;
  today: number;
  applied: Record<string, string>;
}

async function loadTaskFacts(args: { brand?: string; team?: string; person?: string }, period: Period): Promise<FactCtx> {
  const [settings, ref] = await Promise.all([getDeliverySettings(), loadRefData()]);
  const applied: Record<string, string> = {};
  const filters: DeliveryFilters = { team: null, brand: null, person: null };
  if (args.brand) {
    const b = brandIdByName(ref, args.brand);
    filters.brand = b.id;
    applied.brand = b.label;
  }
  if (args.team) {
    const t = teamIdByName(ref, args.team);
    filters.team = t.id;
    applied.team = t.label;
  }
  if (args.person) {
    const p = personIdByName(ref, args.person);
    filters.person = p.id;
    applied.person = p.label;
  }
  const { facts } = await loadFacts(settings, ref, { kind: "all", department: null }, filters, period.start);
  return { ref, facts, period, today: todayDay(), applied };
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
    ...filterParams,
    groupBy: z.enum(GROUPS).optional().describe("Group rows by this (default none)."),
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
            .sort((a, b) => b.stats.created + b.stats.completed - (a.stats.created + a.stats.completed) || a.name.localeCompare(b.name))
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
            }));
    return {
      period: { from: period.from, to: period.to, label: period.label, openAsOf: keyFromDay(asOf) },
      filters: c.applied,
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
      groups: take(groups, args.limit),
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
    ...filterParams,
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
      total: rows.length,
      closedLate: rows.filter((r) => r.kind === "closed_late").length,
      overdue: rows.filter((r) => r.kind === "overdue").length,
      tasks: shown.map((r) => {
        const p = r.f.project ? c.ref.projects.get(r.f.project) : null;
        return {
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
    "Rework among tasks created in the period: count, rate (% of tasks created), split internal (our review) vs external (client) vs not set; optionally grouped by brand, team or person. Default period: last 30 days.",
  params: z.object({
    ...periodParams,
    ...filterParams,
    groupBy: z.enum(["none", "brand", "team", "person"]).optional().describe("Group rows by this (default none)."),
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
            }))
            .sort((a, b) => b.rework - a.rework || b.created - a.created);
    return {
      period: { from: period.from, to: period.to, label: period.label },
      filters: c.applied,
      totals: {
        created: s.created,
        rework: s.rework,
        reworkPct: s.reworkPct,
        internal: s.reworkInternal,
        external: s.reworkExternal,
        notSet: s.reworkNotSet,
      },
      groupBy: by,
      groups: take(groups, args.limit),
      groupCount: groups.length,
    };
  },
});

// -- Scope usage --------------------------------------------------------------

const scopeUsage = defineTool({
  name: "scopeUsage",
  description:
    "Scope usage of a month's projects (project naming month): per brand and project, per scope unit (e.g. Static, Video), the approved scope total and the amount used by new-work tasks (rework excluded, rejected over-scope excluded); 'over' when used > total. Also counts over-scope task requests (pending / approved). Default month: the current one.",
  params: z.object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional().describe("Month YYYY-MM (default current)."),
    brand: filterParams.brand,
    overOnly: z.boolean().optional().describe("Only brands / projects over scope."),
    limit: limitParam,
  }),
  async run(args) {
    const month = args.month ?? currentMonth();
    const ref = await loadRefData();
    const brandFilter = args.brand ? brandIdByName(ref, args.brand) : null;
    const projects = await Project.find({
      "naming.month": month,
      archivedAt: null,
      ...(brandFilter ? { brand: oid(brandFilter.id) } : {}),
    })
      .select("code name brand scopeItems requiresScope")
      .lean();
    const ids = projects.map((p) => p._id);
    const [used, overScope] = await Promise.all([
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
    ]);
    const usedBy = new Map(used.map((u) => [`${u._id.project}:${u._id.unit.trim()}`, u.used]));
    const overBy = new Map(overScope.map((o) => [`${o._id.project}:${o._id.status}`, o.n]));

    type UnitRow = { unit: string; total: number; used: number; over: number };
    const projectRows = projects.map((p) => {
      const units: UnitRow[] = [];
      const totals = scopeTotals(p.scopeItems as ScopeItem[]);
      const seen = new Set<string>();
      for (const [key, t] of totals) {
        seen.add(key);
        const u = usedBy.get(`${p._id}:${key}`) ?? 0;
        units.push({ unit: t.unit, total: t.total, used: u, over: Math.max(0, u - t.total) });
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
        if (def && !seen.has(def.name.toLowerCase())) units.push({ unit: def.name, total: 0, used: u, over: u });
        else if (!def) unknownUnits += u;
      }
      return {
        brandId: p.brand ? String(p.brand) : null,
        code: p.code,
        name: p.name,
        hasScope: totals.size > 0,
        tasksOnUnknownUnits: unknownUnits,
        units,
        overScopeTasksPending: overBy.get(`${p._id}:pending`) ?? 0,
        overScopeTasksApproved: overBy.get(`${p._id}:approved`) ?? 0,
      };
    });

    const brands = new Map<string, { brand: string; units: Map<string, UnitRow>; projects: number; projectsOver: number; pending: number; approved: number }>();
    for (const p of projectRows) {
      const key = p.brandId ?? "none";
      const b = brands.get(key) ?? {
        brand: p.brandId ? (ref.brands.get(p.brandId)?.name ?? "Unknown brand") : "No brand",
        units: new Map(),
        projects: 0,
        projectsOver: 0,
        pending: 0,
        approved: 0,
      };
      brands.set(key, b);
      b.projects++;
      if (p.units.some((u) => u.over > 0)) b.projectsOver++;
      b.pending += p.overScopeTasksPending;
      b.approved += p.overScopeTasksApproved;
      for (const u of p.units) {
        const k = u.unit.toLowerCase();
        const acc = b.units.get(k) ?? { unit: u.unit, total: 0, used: 0, over: 0 };
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
        totalScope: units.reduce((s, u) => s + u.total, 0),
        totalUsed: units.reduce((s, u) => s + u.used, 0),
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
    brandRows.sort((a, b) => b.overUnits - a.overUnits || b.totalUsed - a.totalUsed);
    projectList.sort((a, b) => b.units.reduce((s, u) => s + u.over, 0) - a.units.reduce((s, u) => s + u.over, 0));
    return {
      month,
      label: monthLabel(month),
      filters: brandFilter ? { brand: brandFilter.label } : {},
      projectCount: projects.length,
      projectsWithoutScope: projectRows.filter((p) => !p.hasScope).length,
      brands: take(brandRows, args.limit, 40),
      projects: take(projectList, args.limit, 40),
      note: "used = sum of task quantities (new work, not rework) per scope unit; over = used beyond the approved total. A brand is over scope when work on a scope unit goes beyond its approved total (overUnits > 0). Over-scope task requests (approved = allowed beyond scope, pending = waiting) are counted separately. Describe this in plain words, not field names.",
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
    ...filterParams,
    project: z.string().max(80).optional().describe("Project code or name (or part of it)."),
    groupBy: z.enum(["person", "brand", "project", "team", "week"]).optional().describe("Group rows by this (default person)."),
    limit: limitParam,
  }),
  async run(args) {
    const period = resolvePeriod(args);
    const ref = await loadRefData();
    const applied: Record<string, string> = {};
    const brand = args.brand ? brandIdByName(ref, args.brand) : null;
    const team = args.team ? teamIdByName(ref, args.team) : null;
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
      if (team && u.department !== team.id) continue;
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
    ...filterParams,
    groupBy: z.enum(["brand", "person"]).optional().describe("Rows by brand (default) or person."),
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
      const t = teamIdByName(ref, args.team);
      query.department = t.id;
      applied.team = t.label;
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
        rows
          .map((r) => ({ name: String(r.name ?? ""), ...pickPearity(r) }))
          .sort((a, b) => Number((b as Record<string, unknown>).closed) - Number((a as Record<string, unknown>).closed) || a.name.localeCompare(b.name)),
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

export const INSIGHT_TOOLS: InsightTool[] = [
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
