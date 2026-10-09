import type { Request, Response } from "express";
import mongoose from "mongoose";
import { appDateKey, appTimeZone } from "../lib/appTime.js";
import { EXPORT_ROW_LIMIT, sendCsv, toCsv, type CsvValue } from "../lib/csv.js";
import { BRIEF_RULES, loadBriefInputs, scoreBrief } from "../lib/delivery/briefs.js";
import { deliveryCached } from "../lib/delivery/cache.js";
import { dayFromKey, keyFromDay } from "../lib/delivery/days.js";
import {
  loadFacts,
  loadRefData,
  NO_BRAND,
  OTHER_TEAM,
  type DeliveryFilters,
  type DeliveryScope,
  type RefData,
  type TaskFact,
} from "../lib/delivery/facts.js";
import {
  delta,
  factsWindowStart,
  groupStats,
  isEmptyStats,
  openAt,
  pct,
  PERIODS,
  resolvePeriod,
  round1,
  statsFor,
  summarize,
  weeklySeries,
  weeksFor,
  type PeriodInfo,
  type PeriodKey,
  type Stats,
} from "../lib/delivery/metrics.js";
import { getDeliverySettings, type DeliverySettingsSnapshot } from "../lib/delivery/settings.js";

// ---------------------------------------------------------------------------
// /api/analytics/delivery/* — Delivery Pulse (admin + head). Heads only see
// tasks where any doer is in their department. Query: period, team, brand,
// person. Responses are cached 60 s per (endpoint, filters, scope); see
// backend/API-CONTRACT-pulse.md for the shapes.
// ---------------------------------------------------------------------------

const DELAYED_ROW_CAP = 1000;
const WEAKEST_COUNT = 20;
const WEAKEST_DAYS = 30;

class BadRequest extends Error {}

interface Ctx {
  period: PeriodInfo;
  periodKey: PeriodKey;
  filters: DeliveryFilters;
  scope: DeliveryScope;
  settings: DeliverySettingsSnapshot;
  ref: RefData;
  facts: TaskFact[];
  today: number;
}

const isId = (v: string) => /^[a-f0-9]{24}$/i.test(v);

function queryString(req: Request, name: string): string | null {
  const raw = req.query[name];
  if (raw === undefined || raw === "") return null;
  if (typeof raw !== "string") throw new BadRequest(`${name} must be a single value`);
  return raw.trim() || null;
}

function parseFilters(req: Request): { periodKey: PeriodKey; filters: DeliveryFilters } {
  const period = queryString(req, "period") ?? "30d";
  if (!(PERIODS as readonly string[]).includes(period)) throw new BadRequest(`period must be one of: ${PERIODS.join(", ")}`);
  const team = queryString(req, "team");
  if (team && team !== OTHER_TEAM && !isId(team)) throw new BadRequest('team must be a department id or "other"');
  const brand = queryString(req, "brand");
  if (brand && brand !== NO_BRAND && !isId(brand)) throw new BadRequest('brand must be a brand id or "none"');
  const person = queryString(req, "person");
  if (person && !isId(person)) throw new BadRequest("person must be a user id");
  return {
    periodKey: period as PeriodKey,
    filters: { team: team?.toLowerCase() ?? null, brand: brand?.toLowerCase() ?? null, person: person?.toLowerCase() ?? null },
  };
}

function scopeOf(req: Request): DeliveryScope {
  const user = req.user!;
  if (user.role === "admin") return { kind: "all", department: null };
  return { kind: "department", department: user.department ? String(user.department) : null };
}

async function buildCtx(req: Request, overrides: Partial<DeliveryFilters> = {}): Promise<Ctx> {
  const { periodKey, filters: parsed } = parseFilters(req);
  const filters = { ...parsed, ...overrides };
  const scope = scopeOf(req);
  const [settings, ref] = await Promise.all([getDeliverySettings(), loadRefData()]);
  const today = dayFromKey(appDateKey());
  const window = factsWindowStart(periodKey, today, dayFromKey(settings.teamMapStartDate));
  const { facts, minCreatedDay } = await loadFacts(settings, ref, scope, filters, window);
  return { period: resolvePeriod(periodKey, today, minCreatedDay), periodKey, filters, scope, settings, ref, facts, today };
}

function meta(ctx: Ctx) {
  const { period, scope, filters, ref } = ctx;
  return {
    period: ctx.periodKey,
    days: period.days,
    today: keyFromDay(ctx.today),
    range: { start: keyFromDay(period.current.start), end: keyFromDay(period.current.end) },
    previous: period.previous ? { start: keyFromDay(period.previous.start), end: keyFromDay(period.previous.end) } : null,
    asOf: new Date().toISOString(),
    timezone: appTimeZone(),
    filters,
    scope: {
      kind: scope.kind,
      departmentId: scope.department,
      departmentName: scope.department ? (ref.departments.get(scope.department) ?? null) : null,
      noDepartment: scope.kind === "department" && !scope.department,
    },
  };
}

/** Runs `compute` through the 60 s response cache; JSON or (?format=csv) CSV. */
async function respond<T>(
  req: Request,
  res: Response,
  endpoint: string,
  compute: (ctx: Ctx) => T | Promise<T>,
  options: { overrides?: Partial<DeliveryFilters>; extra?: unknown; csv?: (data: T) => { name: string; headers: string[]; rows: CsvValue[][] } } = {}
): Promise<void> {
  let key: string;
  try {
    const { periodKey, filters } = parseFilters(req);
    key = `resp:${endpoint}:${JSON.stringify([periodKey, { ...filters, ...options.overrides }, scopeOf(req), options.extra ?? null, appDateKey()])}`;
  } catch (err) {
    if (err instanceof BadRequest) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
  const data = await deliveryCached(key, async () => {
    const ctx = await buildCtx(req, options.overrides);
    return { meta: meta(ctx), ...(await compute(ctx)) };
  });
  if (req.query.format === "csv" && options.csv) {
    const sheet = options.csv(data as T);
    const rows = sheet.rows.slice(0, EXPORT_ROW_LIMIT);
    sendCsv(res, sheet.name, toCsv(sheet.headers, rows), { rows: rows.length, total: sheet.rows.length });
    return;
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.json(data);
}

// -- Reference helpers ----------------------------------------------------------

function userRef(ctx: Ctx, id: string | null) {
  const u = id ? ctx.ref.users.get(id) : undefined;
  return { id, name: u?.name ?? "Former user", former: !u };
}

function brandRef(ctx: Ctx, id: string | null) {
  if (!id) return { id: NO_BRAND, name: "No brand", shortName: "", color: "muted", active: true, noBrand: true };
  const b = ctx.ref.brands.get(id);
  if (!b) return { id: NO_BRAND, name: "No brand", shortName: "", color: "muted", active: true, noBrand: true };
  return { id, name: b.name, shortName: b.shortName, color: b.color, active: b.active, noBrand: false };
}

/** Facts keyed by the displayed brand (unknown brand ids fold into "No brand"). */
function brandKey(ctx: Ctx, f: TaskFact): string {
  return f.brand && ctx.ref.brands.has(f.brand) ? f.brand : NO_BRAND;
}

function teamName(ctx: Ctx, key: string): string {
  return key === OTHER_TEAM ? "Other" : (ctx.ref.departments.get(key) ?? "Other");
}

function teamOfDepartment(ctx: Ctx, department: string | null): string {
  if (!department) return OTHER_TEAM;
  const teams = ctx.settings.dashboardTeams;
  return teams === null || teams.includes(department) ? department : OTHER_TEAM;
}

function taskRow(ctx: Ctx, f: TaskFact) {
  const project = f.project ? ctx.ref.projects.get(f.project) : undefined;
  const daysLate = f.dueDay !== null && f.dueDay < ctx.today && f.status !== "completed" ? ctx.today - f.dueDay : null;
  return {
    id: f.id,
    code: f.code,
    title: f.title,
    status: f.status,
    brand: brandRef(ctx, f.brand),
    project: f.project ? { id: f.project, code: project?.code ?? "", name: project?.name ?? "Deleted project" } : null,
    doers: f.doers.map((d) => userRef(ctx, d)),
    briefer: userRef(ctx, f.briefer),
    createdDate: keyFromDay(f.createdDay),
    dueDate: f.dueDay !== null ? keyFromDay(f.dueDay) : null,
    daysLate,
  };
}

function statsRow(s: Stats) {
  return {
    created: s.created,
    completed: s.completed,
    completedWithDue: s.completedWithDue,
    completedNoDue: s.completedNoDue,
    onTimePct: s.onTimePct,
    meanDays: s.meanDays,
    startToDoneDays: s.startToDoneDays,
    startedCompleted: s.startedCompleted,
    lateStartPct: s.lateStartPct,
    lateStarts: s.lateStarts,
    startsWithPlan: s.startsWithPlan,
    rework: s.rework,
    reworkPct: s.reworkPct,
    open: s.open,
    overdue: s.overdue,
  };
}

const pctText = (v: number | null) => (v === null ? "" : v);

// -- Endpoints --------------------------------------------------------------------

/** GET /summary — KPIs and deltas. */
export async function getSummary(req: Request, res: Response): Promise<void> {
  await respond(req, res, "summary", (ctx) => {
    const s = summarize(ctx.facts, ctx.period);
    return { kpis: statsRow(s.current), previous: s.previous ? statsRow(s.previous) : null, deltas: s.deltas };
  });
}

/** GET /weekly — per-week completed, mean cycle days, overdue %, rework % (≤ 104 weeks). */
export async function getWeekly(req: Request, res: Response): Promise<void> {
  await respond(req, res, "weekly", (ctx) => {
    const { weeks, capped } = weeksFor(ctx.period);
    return { capped, maxWeeks: 104, weeks: weeklySeries(ctx.facts, weeks) };
  });
}

type TeamsData = { rows: Array<ReturnType<typeof statsRow> & { team: { id: string; name: string }; volume: number }> };

/** GET /teams — per dashboard team (a task counts once for each team of its doers). */
export async function getTeams(req: Request, res: Response): Promise<void> {
  await respond<TeamsData>(
    req,
    res,
    "teams",
    (ctx) => {
      const groups = groupStats(ctx.facts, (f) => f.teams, ctx.period.current, ctx.today);
      const configured = ctx.settings.dashboardTeams ?? [...ctx.ref.departments.keys()];
      const keys = new Set<string>([...configured.filter((id) => ctx.ref.departments.has(id)), ...[...groups.keys()].filter((k): k is string => k !== null)]);
      const rows = [...keys]
        .map((key) => {
          const s = groups.get(key) ?? statsFor([], ctx.period.current, ctx.today);
          return { team: { id: key, name: teamName(ctx, key) }, ...statsRow(s), volume: s.completed };
        })
        .filter((r) => r.team.id !== OTHER_TEAM || r.created + r.completed + r.open > 0)
        .sort((a, b) => b.completed - a.completed || a.team.name.localeCompare(b.team.name));
      return { rows };
    },
    {
      csv: (d) => ({
        name: "delivery-teams",
        headers: ["Team", "Completed", "On time %", "Mean days", "Mean start → done", "Rework %", "Overdue now", "Open", "Created"],
        rows: d.rows.map((r) => [r.team.name, r.completed, pctText(r.onTimePct), pctText(r.meanDays), pctText(r.startToDoneDays), pctText(r.reworkPct), r.overdue, r.open, r.created]),
      }),
    }
  );
}

type BrandsData = {
  rows: Array<
    ReturnType<typeof statsRow> & {
      brand: ReturnType<typeof brandRef>;
      previous: ReturnType<typeof statsRow> | null;
      deltas: Record<string, ReturnType<typeof delta>> | null;
    }
  >;
};

/** GET /brands — per brand for the period, with the previous period and deltas ("Brand movement"). */
export async function getBrands(req: Request, res: Response): Promise<void> {
  await respond<BrandsData>(
    req,
    res,
    "brands",
    (ctx) => {
      const key = (f: TaskFact) => [brandKey(ctx, f)];
      const cur = groupStats(ctx.facts, key, ctx.period.current, ctx.today);
      const prev = ctx.period.previous ? groupStats(ctx.facts, key, ctx.period.previous, ctx.period.previous.end) : null;
      const keys = new Set<string>([...cur.keys(), ...(prev?.keys() ?? [])].filter((k): k is string => k !== null));
      const rows = [...keys]
        .map((k) => {
          const c = cur.get(k) ?? statsFor([], ctx.period.current, ctx.today);
          const p = prev?.get(k) ?? null;
          const had = p !== null && !isEmptyStats(p);
          const pv = <T extends number | null>(v: T | undefined): T | null => (had && v !== undefined ? v : null);
          return {
            brand: brandRef(ctx, k === NO_BRAND ? null : k),
            ...statsRow(c),
            previous: p ? statsRow(p) : null,
            deltas: ctx.period.previous
              ? {
                  created: delta(c.created, pv(p?.created), "neutral"),
                  completed: delta(c.completed, pv(p?.completed), "higher"),
                  onTimePct: delta(c.onTimePct, pv(p?.onTimePct), "higher"),
                  meanDays: delta(c.meanDays, pv(p?.meanDays), "lower"),
                  reworkPct: delta(c.reworkPct, pv(p?.reworkPct), "lower"),
                  overdue: delta(c.overdue, pv(p?.overdue), "lower"),
                }
              : null,
          };
        })
        .filter((r) => !isEmptyStats(r) || (r.previous !== null && !isEmptyStats(r.previous)))
        .sort((a, b) => b.created - a.created || b.completed - a.completed || a.brand.name.localeCompare(b.brand.name));
      return { rows };
    },
    {
      csv: (d) => ({
        name: "delivery-brands",
        headers: [
          "Brand", "Created", "Completed", "On time %", "Mean days", "Rework %", "Overdue now",
          "Created (prev)", "Completed (prev)", "On time % (prev)", "Mean days (prev)", "Rework % (prev)",
        ],
        rows: d.rows.map((r) => [
          r.brand.name, r.created, r.completed, pctText(r.onTimePct), pctText(r.meanDays), pctText(r.reworkPct), r.overdue,
          r.previous?.created ?? "", r.previous?.completed ?? "", pctText(r.previous?.onTimePct ?? null),
          pctText(r.previous?.meanDays ?? null), pctText(r.previous?.reworkPct ?? null),
        ]),
      }),
    }
  );
}

type DelayedData = {
  staleDays: number;
  includeStale: boolean;
  total: number;
  hiddenStale: number;
  truncated: boolean;
  rows: Array<ReturnType<typeof taskRow> & { stale: boolean; rejected: boolean }>;
};

/** GET /delayed?stale=0|1 — open tasks past due plus rejected (sent back) tasks. */
export async function getDelayed(req: Request, res: Response): Promise<void> {
  const includeStale = req.query.stale === "1" || req.query.stale === "true";
  await respond<DelayedData>(
    req,
    res,
    "delayed",
    (ctx) => {
      const staleDays = ctx.settings.staleDays;
      const all = ctx.facts
        .filter((f) => f.status === "rejected" || (openAt(f, ctx.today) && f.dueDay !== null && f.dueDay < ctx.today))
        .map((f) => {
          const row = taskRow(ctx, f);
          return { ...row, stale: row.daysLate !== null && row.daysLate > staleDays, rejected: f.status === "rejected" };
        });
      const visible = all
        .filter((r) => includeStale || !r.stale)
        .sort((a, b) => (b.daysLate ?? -1) - (a.daysLate ?? -1) || a.code.localeCompare(b.code));
      return {
        staleDays,
        includeStale,
        total: visible.length,
        hiddenStale: all.length - visible.length,
        truncated: visible.length > DELAYED_ROW_CAP && req.query.format !== "csv",
        rows: req.query.format === "csv" ? visible : visible.slice(0, DELAYED_ROW_CAP),
      };
    },
    {
      extra: { includeStale, csv: req.query.format === "csv" },
      csv: (d) => ({
        name: "delivery-delayed",
        headers: ["Code", "Task", "Brand", "Project", "Doers", "Briefer", "Due", "Days late", "Status"],
        rows: d.rows.map((r) => [
          r.code, r.title, r.brand.name, r.project ? `${r.project.code} · ${r.project.name}` : "",
          r.doers.map((u) => u.name).join("; "), r.briefer.name, r.dueDate ?? "", r.daysLate ?? "", r.status,
        ]),
      }),
    }
  );
}

/** GET /briefs — brief coverage by briefer (period) and the weakest recent briefs (last 30 days). */
export async function getBriefs(req: Request, res: Response): Promise<void> {
  await respond(req, res, "briefs", async (ctx) => {
    const { current } = ctx.period;
    const recentStart = ctx.today - WEAKEST_DAYS + 1;
    const candidates = ctx.facts.filter(
      (f) => (f.createdDay >= current.start && f.createdDay <= current.end) || (f.createdDay >= recentStart && f.createdDay <= ctx.today)
    );
    const inputs = await loadBriefInputs(candidates);
    const scored = inputs.map((input) => ({ fact: input.fact, ...scoreBrief(input, ctx.settings) }));

    const inPeriod = scored.filter((s) => s.fact.createdDay >= current.start && s.fact.createdDay <= current.end);
    const ruleRates = (list: typeof scored) =>
      BRIEF_RULES.map((rule, i) => {
        const applicable = list.filter((s) => s.results[i] !== "na").length;
        const passed = list.filter((s) => s.results[i] === "pass").length;
        return { id: rule.id, passed, applicable, pct: pct(passed, applicable) };
      });
    const avgScore = (list: typeof scored) => {
      const scores = list.flatMap((s) => (s.score === null ? [] : [s.score]));
      return scores.length ? round1((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) : null;
    };

    const byBriefer = new Map<string, typeof scored>();
    for (const s of inPeriod) {
      const key = s.fact.briefer ?? "unknown";
      const list = byBriefer.get(key);
      if (list) list.push(s);
      else byBriefer.set(key, [s]);
    }
    const briefers = [...byBriefer].map(([id, list]) => ({
      briefer: userRef(ctx, id === "unknown" ? null : id),
      briefs: list.length,
      avgScore: avgScore(list),
      rules: ruleRates(list),
      rework: list.filter((s) => s.fact.rework).length,
      reworkPct: pct(list.filter((s) => s.fact.rework).length, list.length),
    }));
    briefers.sort((a, b) => b.briefs - a.briefs || a.briefer.name.localeCompare(b.briefer.name));

    const weakest = scored
      .filter((s) => s.fact.createdDay >= recentStart && s.score !== null)
      .sort((a, b) => a.score! - b.score! || b.fact.createdAt.getTime() - a.fact.createdAt.getTime())
      .slice(0, WEAKEST_COUNT)
      .map((s) => ({
        ...taskRow(ctx, s.fact),
        score: round1(s.score! * 100),
        passed: s.passed,
        applicable: s.applicable,
        results: s.results,
        failed: s.failed,
      }));

    return {
      rules: BRIEF_RULES.map((r) => ({ ...r })),
      settings: {
        briefingWeekday: ctx.settings.briefingWeekday,
        minLeadDays: ctx.settings.minLeadDays,
        briefMinLength: ctx.settings.briefMinLength,
      },
      totals: { briefs: inPeriod.length, avgScore: avgScore(inPeriod), rules: ruleRates(inPeriod) },
      byBriefer: briefers,
      weakestWindowDays: WEAKEST_DAYS,
      weakest,
    };
  });
}

function personStats(ctx: Ctx, facts: TaskFact[]) {
  const s = statsFor(facts, ctx.period.current, ctx.today);
  const brands = new Set(
    facts
      .filter(
        (f) =>
          (f.createdDay >= ctx.period.current.start && f.createdDay <= ctx.period.current.end) ||
          (f.completedDay !== null && f.completedDay >= ctx.period.current.start && f.completedDay <= ctx.period.current.end) ||
          openAt(f, ctx.today)
      )
      .map((f) => brandKey(ctx, f))
  );
  return { ...statsRow(s), brandCount: brands.size, ranked: s.completed >= ctx.settings.minCompletedToRank };
}

function personInfo(ctx: Ctx, id: string) {
  const u = ctx.ref.users.get(id);
  const team = teamOfDepartment(ctx, u?.department ?? null);
  return {
    ...userRef(ctx, id),
    department: u?.department ? { id: u.department, name: ctx.ref.departments.get(u.department) ?? "" } : null,
    team: { id: team, name: teamName(ctx, team) },
    isTrafficManager: ctx.settings.trafficManagers.includes(id),
  };
}

type PeopleData = {
  minCompletedToRank: number;
  rows: Array<ReturnType<typeof personStats> & { person: ReturnType<typeof personInfo> }>;
};

/** GET /people — doers only (traffic managers excluded). */
export async function getPeople(req: Request, res: Response): Promise<void> {
  await respond<PeopleData>(
    req,
    res,
    "people",
    (ctx) => {
      const byPerson = new Map<string, TaskFact[]>();
      for (const f of ctx.facts) {
        for (const d of f.doers) {
          const list = byPerson.get(d);
          if (list) list.push(f);
          else byPerson.set(d, [f]);
        }
      }
      if (ctx.filters.person) for (const id of [...byPerson.keys()]) if (id !== ctx.filters.person) byPerson.delete(id);
      const rows = [...byPerson]
        .map(([id, facts]) => ({ person: personInfo(ctx, id), ...personStats(ctx, facts) }))
        .filter((r) => r.created + r.completed + r.open > 0)
        .sort((a, b) => Number(b.ranked) - Number(a.ranked) || b.completed - a.completed || a.person.name.localeCompare(b.person.name));
      return { minCompletedToRank: ctx.settings.minCompletedToRank, rows };
    },
    {
      csv: (d) => ({
        name: "delivery-people",
        headers: ["Person", "Team", "Completed", "On time %", "Mean days", "Mean start → done", "Rework %", "Overdue now", "Open now", "Brands", "Ranked"],
        rows: d.rows.map((r) => [
          r.person.name, r.person.team.name, r.completed, pctText(r.onTimePct), pctText(r.meanDays), pctText(r.startToDoneDays), pctText(r.reworkPct),
          r.overdue, r.open, r.brandCount, r.ranked ? "Yes" : "No",
        ]),
      }),
    }
  );
}

/** GET /people/:id — drawer: stats, brand breakdown, weekly trend, open work. */
export async function getPerson(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? "").toLowerCase();
  if (!isId(id)) {
    res.status(400).json({ error: "id must be a user id" });
    return;
  }
  const ref = await loadRefData();
  if (!ref.users.has(id) && !(await mongoose.connection.collection("tasks").findOne({ assignees: new mongoose.Types.ObjectId(id) }, { projection: { _id: 1 } }))) {
    res.status(404).json({ error: "Person not found" });
    return;
  }
  await respond(
    req,
    res,
    "person",
    (ctx) => {
      const facts = ctx.facts.filter((f) => f.doers.includes(id));
      const brandGroups = groupStats(facts, (f) => [brandKey(ctx, f)], ctx.period.current, ctx.today);
      const brands = [...brandGroups]
        .filter(([, s]) => !isEmptyStats(s))
        .map(([k, s]) => ({ brand: brandRef(ctx, k === NO_BRAND ? null : k), ...statsRow(s) }))
        .sort((a, b) => b.completed - a.completed || b.open - a.open);
      const { weeks, capped } = weeksFor(ctx.period);
      const openWork = facts
        .filter((f) => openAt(f, ctx.today))
        .map((f) => taskRow(ctx, f))
        .sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || a.code.localeCompare(b.code));
      return {
        person: personInfo(ctx, id),
        minCompletedToRank: ctx.settings.minCompletedToRank,
        stats: personStats(ctx, facts),
        brands,
        weekly: { capped, weeks: weeklySeries(facts, weeks) },
        openWork,
      };
    },
    { overrides: { person: id } }
  );
}

const STRUCTURE_TASKS_PER_PROJECT = 25;

/**
 * GET /brand-structure — brand › project › tasks and the people assigned, for
 * tasks active in the period (created or completed in it, or still open).
 */
export async function getBrandStructure(req: Request, res: Response): Promise<void> {
  await respond(req, res, "brand-structure", (ctx) => {
    const { start, end } = ctx.period.current;
    type Counts = { total: number; open: number; completed: number; overdue: number };
    const counts = (): Counts => ({ total: 0, open: 0, completed: 0, overdue: 0 });
    const bump = (c: Counts, f: TaskFact) => {
      c.total++;
      if (f.closedDay === null) {
        c.open++;
        if (f.dueDay !== null && f.dueDay < ctx.today) c.overdue++;
      } else if (f.completedDay !== null) c.completed++;
    };
    type People = Map<string, Counts>;
    type ProjectAgg = { counts: Counts; people: People; tasks: TaskFact[] };
    type BrandAgg = { counts: Counts; people: People; projects: Map<string, ProjectAgg> };
    const brands = new Map<string, BrandAgg>();

    for (const f of ctx.facts) {
      const createdIn = f.createdDay >= start && f.createdDay <= end;
      const completedIn = f.completedDay !== null && f.completedDay >= start && f.completedDay <= end;
      const stillOpen = f.closedDay === null && f.createdDay <= end;
      if (!createdIn && !completedIn && !stillOpen) continue;
      const brandId = brandKey(ctx, f);
      const brand = brands.get(brandId) ?? { counts: counts(), people: new Map(), projects: new Map() };
      brands.set(brandId, brand);
      const projectId = f.project ?? "none";
      const project = brand.projects.get(projectId) ?? { counts: counts(), people: new Map(), tasks: [] };
      brand.projects.set(projectId, project);
      bump(brand.counts, f);
      bump(project.counts, f);
      project.tasks.push(f);
      for (const d of f.doers) {
        const bp = brand.people.get(d) ?? counts();
        bump(bp, f);
        brand.people.set(d, bp);
        const pp = project.people.get(d) ?? counts();
        bump(pp, f);
        project.people.set(d, pp);
      }
    }

    const peopleList = (people: People) =>
      [...people]
        .map(([id, c]) => ({ person: userRef(ctx, id), ...c }))
        .sort((a, b) => b.total - a.total || a.person.name.localeCompare(b.person.name));
    const taskOrder = (a: TaskFact, b: TaskFact) => {
      const ao = a.closedDay === null ? 0 : 1;
      const bo = b.closedDay === null ? 0 : 1;
      if (ao !== bo) return ao - bo;
      return (a.dueDay ?? Number.MAX_SAFE_INTEGER) - (b.dueDay ?? Number.MAX_SAFE_INTEGER) || b.createdDay - a.createdDay;
    };

    const result = [...brands]
      .map(([brandId, b]) => ({
        brand: brandRef(ctx, brandId),
        ...b.counts,
        people: peopleList(b.people),
        projects: [...b.projects]
          .map(([projectId, p]) => {
            const ref = projectId === "none" ? null : (ctx.ref.projects.get(projectId) ?? null);
            const sorted = p.tasks.sort(taskOrder);
            return {
              project: { id: projectId === "none" ? null : projectId, code: ref?.code ?? "", name: ref?.name ?? (projectId === "none" ? "No project" : "(deleted project)") },
              ...p.counts,
              people: peopleList(p.people),
              tasks: sorted.slice(0, STRUCTURE_TASKS_PER_PROJECT).map((f) => ({
                id: f.id,
                code: f.code,
                title: f.title,
                status: f.status,
                dueDate: f.dueDay === null ? null : keyFromDay(f.dueDay),
                overdue: f.closedDay === null && f.dueDay !== null && f.dueDay < ctx.today,
                assignees: f.doers.map((d) => userRef(ctx, d)),
              })),
              moreTasks: Math.max(0, sorted.length - STRUCTURE_TASKS_PER_PROJECT),
            };
          })
          .sort((a, b) => b.total - a.total || a.project.name.localeCompare(b.project.name)),
      }))
      .sort((a, b) => b.total - a.total || a.brand.name.localeCompare(b.brand.name));

    const totals = result.reduce(
      (acc, b) => ({ brands: acc.brands + 1, projects: acc.projects + b.projects.length, tasks: acc.tasks + b.total, open: acc.open + b.open }),
      { brands: 0, projects: 0, tasks: 0, open: 0 }
    );
    return { totals, brands: result };
  });
}

/** GET /team-map — brand team map coverage since the tracking start date. */
export async function getTeamMap(req: Request, res: Response): Promise<void> {
  await respond(req, res, "team-map", (ctx) => {
    const start = dayFromKey(ctx.settings.teamMapStartDate);
    const maps = new Map(ctx.settings.brandTeamMap.filter((e) => e.users.length > 0).map((e) => [e.brand, new Set(e.users)]));

    const offMap = new Map<string, Map<string, number>>();
    const usedOnBrand = new Map<string, Set<string>>();
    const tasksPerBrand = new Map<string, number>();
    for (const f of ctx.facts) {
      const created = f.createdDay >= start && f.createdDay <= ctx.today;
      const completed = f.completedDay !== null && f.completedDay >= start && f.completedDay <= ctx.today;
      if (!created && !completed) continue;
      const brand = brandKey(ctx, f);
      tasksPerBrand.set(brand, (tasksPerBrand.get(brand) ?? 0) + 1);
      const used = usedOnBrand.get(brand) ?? new Set<string>();
      for (const d of f.doers) used.add(d);
      usedOnBrand.set(brand, used);
      const map = maps.get(brand);
      if (!map || !completed) continue;
      for (const d of f.doers) {
        if (map.has(d)) continue;
        const people = offMap.get(brand) ?? new Map<string, number>();
        people.set(d, (people.get(d) ?? 0) + 1);
        offMap.set(brand, people);
      }
    }

    return {
      startDate: ctx.settings.teamMapStartDate,
      mappedBrands: maps.size,
      offMap: [...offMap]
        .map(([brand, people]) => ({
          brand: brandRef(ctx, brand),
          total: [...people.values()].reduce((a, b) => a + b, 0),
          people: [...people]
            .map(([id, count]) => ({ person: userRef(ctx, id), count }))
            .sort((a, b) => b.count - a.count || a.person.name.localeCompare(b.person.name)),
        }))
        .sort((a, b) => b.total - a.total),
      mappedUnused: [...maps]
        .map(([brand, users]) => ({
          brand: brandRef(ctx, brand),
          people: [...users]
            .filter((u) => !usedOnBrand.get(brand)?.has(u))
            .map((u) => userRef(ctx, u))
            .sort((a, b) => a.name.localeCompare(b.name)),
        }))
        .filter((r) => r.people.length > 0 && !r.brand.noBrand),
      unmappedBrands: [...ctx.ref.brands]
        .filter(([id, b]) => b.active && !maps.has(id))
        .map(([id]) => ({ brand: brandRef(ctx, id), tasks: tasksPerBrand.get(id) ?? 0 }))
        .sort((a, b) => b.tasks - a.tasks || a.brand.name.localeCompare(b.brand.name)),
    };
  });
}
