import type { Request, Response } from "express";
import mongoose from "mongoose";
import { Brand } from "../models/Brand.js";
import { ManpowerPlan, APPROVED_PLAN } from "../models/ManpowerPlan.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";
import { linkProjectsToRows } from "../lib/manpower/match.js";
import { appDateKey, appTimeZone } from "../lib/appTime.js";
import { EXPORT_ROW_LIMIT, sendSheet, type CsvValue } from "../lib/csv.js";
import { briefCheckConfigured, briefCheckModel } from "../lib/briefCheck.js";
import { BRIEF_RULE_KEYS, briefRules, loadBriefInputs, scoreBrief, type BriefInput, type BriefScore } from "../lib/delivery/briefs.js";
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
  type Range,
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
const MONTHS_CAP = 24;

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

function parseFilters(req: Request): { periodKey: PeriodKey; filters: DeliveryFilters; custom: Range | null } {
  const period = queryString(req, "period") ?? "30d";
  if (!(PERIODS as readonly string[]).includes(period)) throw new BadRequest(`period must be one of: ${PERIODS.join(", ")}`);
  let custom: Range | null = null;
  if (period === "custom") {
    const from = queryString(req, "from");
    const to = queryString(req, "to");
    const valid = (v: string | null) => v !== null && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
    if (!valid(from) || !valid(to)) throw new BadRequest("A custom period needs from and to dates (YYYY-MM-DD)");
    const start = dayFromKey(from!);
    const end = Math.min(dayFromKey(to!), dayFromKey(appDateKey()));
    if (start > end) throw new BadRequest("from must be on or before to (and not in the future)");
    if (end - start > 3 * 366) throw new BadRequest("A custom period can cover at most 3 years");
    custom = { start, end };
  }
  const team = queryString(req, "team");
  if (team && team !== OTHER_TEAM && !isId(team)) throw new BadRequest('team must be a department id or "other"');
  const brand = queryString(req, "brand");
  if (brand && brand !== NO_BRAND && !isId(brand)) throw new BadRequest('brand must be a brand id or "none"');
  const person = queryString(req, "person");
  if (person && !isId(person)) throw new BadRequest("person must be a user id");
  return {
    periodKey: period as PeriodKey,
    filters: { team: team?.toLowerCase() ?? null, brand: brand?.toLowerCase() ?? null, person: person?.toLowerCase() ?? null },
    custom,
  };
}

/** Delivery Pulse is view-only and not sensitive: everyone sees the whole company. */
function scopeOf(_req: Request): DeliveryScope {
  return { kind: "all", department: null };
}

async function buildCtx(req: Request, overrides: Partial<DeliveryFilters> = {}): Promise<Ctx> {
  const { periodKey, filters: parsed, custom } = parseFilters(req);
  const filters = { ...parsed, ...overrides };
  const scope = scopeOf(req);
  const [settings, ref] = await Promise.all([getDeliverySettings(), loadRefData()]);
  const today = dayFromKey(appDateKey());
  const window = factsWindowStart(periodKey, today, dayFromKey(settings.teamMapStartDate), custom);
  const { facts, minCreatedDay } = await loadFacts(settings, ref, scope, filters, window);
  return { period: resolvePeriod(periodKey, today, minCreatedDay, custom), periodKey, filters, scope, settings, ref, facts, today };
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
    const { periodKey, filters, custom } = parseFilters(req);
    key = `resp:${endpoint}:${JSON.stringify([periodKey, custom, { ...filters, ...options.overrides }, scopeOf(req), options.extra ?? null, appDateKey()])}`;
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
    await sendSheet(res, sheet.name, sheet.headers, rows, { rows: rows.length, total: sheet.rows.length });
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
    reworkInternal: s.reworkInternal,
    reworkExternal: s.reworkExternal,
    reworkNotSet: s.reworkNotSet,
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
    // "Added this week": tasks briefed (created) in the last 7 days vs the 7 days before (period filter doesn't apply).
    const createdIn = (start: number, end: number) => ctx.facts.filter((f) => f.createdDay >= start && f.createdDay <= end).length;
    const addedThisWeek = createdIn(ctx.today - 6, ctx.today);
    const addedPrevWeek = createdIn(ctx.today - 13, ctx.today - 7);
    return {
      kpis: statsRow(s.current),
      previous: s.previous ? statsRow(s.previous) : null,
      deltas: s.deltas,
      addedThisWeek: { count: addedThisWeek, delta: delta(addedThisWeek, addedPrevWeek, "neutral") },
    };
  });
}

/** GET /weekly — per-week completed, mean cycle days, overdue %, rework % (≤ 104 weeks). */
export async function getWeekly(req: Request, res: Response): Promise<void> {
  await respond(req, res, "weekly", (ctx) => {
    const { weeks, capped } = weeksFor(ctx.period);
    return { capped, maxWeeks: 104, weeks: weeklySeries(ctx.facts, weeks) };
  });
}

/** Facts per doer. */
function factsByPerson(facts: TaskFact[]): Map<string, TaskFact[]> {
  const byPerson = new Map<string, TaskFact[]>();
  for (const f of facts) {
    for (const d of f.doers) {
      const list = byPerson.get(d);
      if (list) list.push(f);
      else byPerson.set(d, [f]);
    }
  }
  return byPerson;
}

type Performer = { person: ReturnType<typeof userRef>; why: string };

/**
 * Best and bottom performer of a team: people with at least `minCompleted`
 * completed in the period, ranked on on-time rate, mean days, rework share,
 * overdue count and volume (completed). Each metric gives a 0–1 rank (1 = best
 * in the team); the mean of the ranks decides. Null when fewer than 2 qualify.
 */
function teamPerformers(
  ctx: Ctx,
  people: Array<{ id: string; stats: Stats }>,
  minCompleted: number
): { best: Performer; bottom: Performer } | null {
  const ranked = people.filter((p) => p.stats.completed >= minCompleted);
  if (ranked.length < 2) return null;
  const metrics: Array<{ value: (s: Stats) => number | null; higher: boolean }> = [
    { value: (s) => s.onTimePct, higher: true },
    { value: (s) => s.meanDays, higher: false },
    { value: (s) => s.reworkPct, higher: false },
    { value: (s) => s.overdue, higher: false },
    { value: (s) => s.completed, higher: true },
  ];
  const scores = new Map<string, { sum: number; n: number }>(ranked.map((p) => [p.id, { sum: 0, n: 0 }]));
  for (const m of metrics) {
    const withValue = ranked.filter((p) => m.value(p.stats) !== null);
    if (withValue.length < 2) continue;
    for (const p of withValue) {
      const v = m.value(p.stats)!;
      // Share of the others this person beats (ties count half).
      let beats = 0;
      for (const o of withValue) {
        if (o.id === p.id) continue;
        const ov = m.value(o.stats)!;
        if (v === ov) beats += 0.5;
        else if (m.higher ? v > ov : v < ov) beats += 1;
      }
      const s = scores.get(p.id)!;
      s.sum += beats / (withValue.length - 1);
      s.n += 1;
    }
  }
  const order = ranked
    .map((p) => ({ p, score: scores.get(p.id)!.n ? scores.get(p.id)!.sum / scores.get(p.id)!.n : 0.5 }))
    .sort((a, b) => b.score - a.score || b.p.stats.completed - a.p.stats.completed || userRef(ctx, a.p.id).name.localeCompare(userRef(ctx, b.p.id).name));
  const why = (s: Stats) =>
    [
      s.onTimePct !== null ? `${Math.round(s.onTimePct)}% on time` : null,
      s.meanDays !== null ? `${s.meanDays}d mean` : null,
      s.reworkPct !== null && s.reworkPct > 0 ? `${Math.round(s.reworkPct)}% rework` : null,
      s.overdue > 0 ? `${s.overdue} overdue` : null,
    ]
      .filter(Boolean)
      .join(" · ") || `${s.completed} completed`;
  const first = order[0]!.p;
  const last = order[order.length - 1]!.p;
  return {
    best: { person: userRef(ctx, first.id), why: why(first.stats) },
    bottom: { person: userRef(ctx, last.id), why: why(last.stats) },
  };
}

type TeamsData = {
  minCompletedToRank: number;
  rows: Array<
    ReturnType<typeof statsRow> & {
      team: { id: string; name: string };
      volume: number;
      /** People in the team (by department) with work in the period. */
      people: number;
      /** Mean days brief → done for tasks completed in the last 30 days. */
      meanDays30: number | null;
      best: Performer | null;
      bottom: Performer | null;
    }
  >;
};

/** GET /teams — per dashboard team (a task counts once for each team of its doers). */
export async function getTeams(req: Request, res: Response): Promise<void> {
  await respond<TeamsData>(
    req,
    res,
    "teams",
    (ctx) => {
      const groups = groupStats(ctx.facts, (f) => f.teams, ctx.period.current, ctx.today);
      const last30 = groupStats(ctx.facts, (f) => f.teams, { start: ctx.today - 29, end: ctx.today }, ctx.today);
      const configured = ctx.settings.dashboardTeams ?? [...ctx.ref.departments.keys()];
      const keys = new Set<string>([...configured.filter((id) => ctx.ref.departments.has(id)), ...[...groups.keys()].filter((k): k is string => k !== null)]);
      // People per team (their own department's team), with work in the period.
      const teamPeople = new Map<string, Array<{ id: string; stats: Stats }>>();
      for (const [id, facts] of factsByPerson(ctx.facts)) {
        const stats = statsFor(facts, ctx.period.current, ctx.today);
        if (isEmptyStats(stats)) continue;
        const team = teamOfDepartment(ctx, ctx.ref.users.get(id)?.department ?? null);
        const list = teamPeople.get(team);
        if (list) list.push({ id, stats });
        else teamPeople.set(team, [{ id, stats }]);
      }
      const minCompleted = ctx.settings.minCompletedToRank;
      const rows = [...keys]
        .map((key) => {
          const s = groups.get(key) ?? statsFor([], ctx.period.current, ctx.today);
          const people = teamPeople.get(key) ?? [];
          const performers = teamPerformers(ctx, people, minCompleted);
          return {
            team: { id: key, name: teamName(ctx, key) },
            ...statsRow(s),
            volume: s.completed,
            people: people.length,
            meanDays30: last30.get(key)?.meanDays ?? null,
            best: performers?.best ?? null,
            bottom: performers?.bottom ?? null,
          };
        })
        .filter((r) => r.team.id !== OTHER_TEAM || r.created + r.completed + r.open > 0)
        .sort((a, b) => b.completed - a.completed || a.team.name.localeCompare(b.team.name));
      return { minCompletedToRank: minCompleted, rows };
    },
    {
      csv: (d) => ({
        name: "delivery-teams",
        headers: [
          "Team", "People", "Completed", "On time %", "Mean days", "Mean days · 30d", "Mean start → done", "Rework %",
          "Rework (internal)", "Rework (external)", "Rework (not set)", "Overdue now", "Open", "Created",
          "Best performer", "Bottom performer",
        ],
        rows: d.rows.map((r) => [
          r.team.name, r.people, r.completed, pctText(r.onTimePct), pctText(r.meanDays), pctText(r.meanDays30), pctText(r.startToDoneDays),
          pctText(r.reworkPct), r.reworkInternal, r.reworkExternal, r.reworkNotSet, r.overdue, r.open, r.created,
          r.best ? `${r.best.person.name} (${r.best.why})` : "", r.bottom ? `${r.bottom.person.name} (${r.bottom.why})` : "",
        ]),
      }),
    }
  );
}

type ScoredBrief = { input: BriefInput; score: BriefScore };

/**
 * Brief inputs and LPS rule scores for `facts`. "Doer on the map" uses the
 * team-map sources of the team-map coverage table (manpower plan of the task's
 * creation month, else the brand team map).
 */
async function scoreBriefs(ctx: Ctx, facts: TaskFact[]): Promise<ScoredBrief[]> {
  if (facts.length === 0) return [];
  const minDay = facts.reduce((m, f) => Math.min(m, f.createdDay), ctx.today);
  const [inputs, projects] = await Promise.all([loadBriefInputs(facts), loadPlanProjects()]);
  const plans = await planMapsFor(keyFromDay(minDay).slice(0, 7), keyFromDay(ctx.today).slice(0, 7), projects);
  const { mapForFact } = teamMapSources(ctx.settings, projects, plans);
  return inputs.map((input) => {
    const f = input.fact;
    const brandName = f.brand ? (ctx.ref.brands.get(f.brand)?.name ?? null) : null;
    return { input, score: scoreBrief(input, ctx.settings, brandName, mapForFact(f, brandKey(ctx, f)).set) };
  });
}

const meanScore = (list: ScoredBrief[]): number | null => {
  const scores = list.map((s) => s.score.score).filter((s): s is number => s !== null);
  return scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
};

const createdInRange = (f: TaskFact, r: Range) => f.createdDay >= r.start && f.createdDay <= r.end;

type WarningFlag = "reworkUp" | "onTimeDown" | "overdueUp";

type BrandsData = {
  rows: Array<
    ReturnType<typeof statsRow> & {
      brand: ReturnType<typeof brandRef>;
      previous: ReturnType<typeof statsRow> | null;
      deltas: Record<string, ReturnType<typeof delta>> | null;
      /** Mean LPS brief score (0–100) of the brand's tasks created in the period. */
      briefScore: number | null;
      briefsScored: number;
      /** Warning signs vs the previous period: rework up, on time down, overdue up (null without a previous period). */
      warnings: { count: number; flags: WarningFlag[] } | null;
    }
  >;
};

/** GET /brands — per brand for the period, with the previous period and deltas ("Brand movement"). */
export async function getBrands(req: Request, res: Response): Promise<void> {
  await respond<BrandsData>(
    req,
    res,
    "brands",
    async (ctx) => {
      const key = (f: TaskFact) => [brandKey(ctx, f)];
      const cur = groupStats(ctx.facts, key, ctx.period.current, ctx.today);
      const prev = ctx.period.previous ? groupStats(ctx.facts, key, ctx.period.previous, ctx.period.previous.end) : null;
      const keys = new Set<string>([...cur.keys(), ...(prev?.keys() ?? [])].filter((k): k is string => k !== null));
      const scored = await scoreBriefs(ctx, ctx.facts.filter((f) => createdInRange(f, ctx.period.current)));
      const scoredByBrand = new Map<string, ScoredBrief[]>();
      for (const s of scored) {
        const k = brandKey(ctx, s.input.fact);
        const list = scoredByBrand.get(k);
        if (list) list.push(s);
        else scoredByBrand.set(k, [s]);
      }
      const rows = [...keys]
        .map((k) => {
          const c = cur.get(k) ?? statsFor([], ctx.period.current, ctx.today);
          const p = prev?.get(k) ?? null;
          const had = p !== null && !isEmptyStats(p);
          const pv = <T extends number | null>(v: T | undefined): T | null => (had && v !== undefined ? v : null);
          const deltas = ctx.period.previous
            ? {
                created: delta(c.created, pv(p?.created), "neutral"),
                completed: delta(c.completed, pv(p?.completed), "higher"),
                onTimePct: delta(c.onTimePct, pv(p?.onTimePct), "higher"),
                meanDays: delta(c.meanDays, pv(p?.meanDays), "lower"),
                reworkPct: delta(c.reworkPct, pv(p?.reworkPct), "lower"),
                overdue: delta(c.overdue, pv(p?.overdue), "lower"),
              }
            : null;
          const flags: WarningFlag[] = deltas
            ? [
                ...(deltas.reworkPct.direction === "up" ? (["reworkUp"] as const) : []),
                ...(deltas.onTimePct.direction === "down" ? (["onTimeDown"] as const) : []),
                ...(deltas.overdue.direction === "up" ? (["overdueUp"] as const) : []),
              ]
            : [];
          const brandScored = scoredByBrand.get(k) ?? [];
          return {
            brand: brandRef(ctx, k === NO_BRAND ? null : k),
            ...statsRow(c),
            previous: p ? statsRow(p) : null,
            deltas,
            briefScore: meanScore(brandScored),
            briefsScored: brandScored.filter((s) => s.score.score !== null).length,
            warnings: deltas ? { count: flags.length, flags } : null,
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
          "Brand", "Created", "Completed", "On time %", "Mean days", "Rework %",
          "Rework (internal)", "Rework (external)", "Rework (not set)", "Overdue now", "Brief score",
          "Created (prev)", "Completed (prev)", "On time % (prev)", "Mean days (prev)", "Rework % (prev)", "Overdue (prev)", "Warning signs",
        ],
        rows: d.rows.map((r) => [
          r.brand.name, r.created, r.completed, pctText(r.onTimePct), pctText(r.meanDays), pctText(r.reworkPct),
          r.reworkInternal, r.reworkExternal, r.reworkNotSet, r.overdue, pctText(r.briefScore),
          r.previous?.created ?? "", r.previous?.completed ?? "", pctText(r.previous?.onTimePct ?? null),
          pctText(r.previous?.meanDays ?? null), pctText(r.previous?.reworkPct ?? null), r.previous?.overdue ?? "", r.warnings?.count ?? "",
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
        headers: ["Code", "Task", "Brand", "Project", "Doers", "Briefed by", "Created", "Due", "Days late", "Status"],
        rows: d.rows.map((r) => [
          r.code, r.title, r.brand.name, r.project ? `${r.project.code} · ${r.project.name}` : "",
          r.doers.map((u) => u.name).join("; "), r.briefer.name, r.createdDate, r.dueDate ?? "", r.daysLate ?? "", r.status,
        ]),
      }),
    }
  );
}

/**
 * GET /briefs — LPS brief rules (check pass rates, score by briefer, weakest briefs), brief coverage (the task has a description or an attachment)
 * by briefer for the period, the AI brief check per briefer, and recent briefs
 * needing attention (missing, flagged or weak; last 30 days).
 */
export async function getBriefs(req: Request, res: Response): Promise<void> {
  await respond(req, res, "briefs", async (ctx) => {
    const { current } = ctx.period;
    const recentStart = ctx.today - WEAKEST_DAYS + 1;
    const candidates = ctx.facts.filter(
      (f) => (f.createdDay >= current.start && f.createdDay <= current.end) || (f.createdDay >= recentStart && f.createdDay <= ctx.today)
    );
    const scored = await scoreBriefs(ctx, candidates);
    const rows = scored.map(({ input, score }) => ({
      fact: input.fact,
      description: input.description,
      covered: input.description.trim().length > 0 || input.fileCount > 0,
      hasDescription: input.description.trim().length > 0,
      fileCount: input.fileCount,
      ai: input.ai,
      rules: score,
    }));
    type Row = (typeof rows)[number];
    const summarize = (list: Row[]) => {
      const covered = list.filter((r) => r.covered).length;
      const checked = list.filter((r) => r.ai);
      const count = (v: "ok" | "weak" | "flagged") => checked.filter((r) => r.ai!.verdict === v).length;
      const scores = checked.map((r) => r.ai!.score).filter((s): s is number => typeof s === "number");
      const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
      const ruleScores = list.map((r) => r.rules.score).filter((s): s is number => s !== null);
      return {
        briefs: list.length,
        /** Mean LPS brief score (0–100). */
        score: ruleScores.length ? Math.round(ruleScores.reduce((a, b) => a + b, 0) / ruleScores.length) : null,
        /** Per LPS rule: tasks passing ÷ tasks where the rule applies. */
        checks: Object.fromEntries(
          BRIEF_RULE_KEYS.map((k) => {
            const applicable = list.filter((r) => r.rules.results[k] !== "na").length;
            const passed = list.filter((r) => r.rules.results[k] === "pass").length;
            return [k, { passed, applicable, pct: pct(passed, applicable) }];
          })
        ),
        covered,
        coveragePct: pct(covered, list.length),
        ai: {
          checked: checked.length,
          ok: count("ok"),
          weak: count("weak"),
          flagged: count("flagged"),
          okPct: pct(count("ok"), checked.length),
          avgScore,
        },
        rework: list.filter((r) => r.fact.rework).length,
        reworkPct: pct(list.filter((r) => r.fact.rework).length, list.length),
      };
    };

    const inPeriod = rows.filter((r) => r.fact.createdDay >= current.start && r.fact.createdDay <= current.end);
    const byBriefer = new Map<string, Row[]>();
    for (const r of inPeriod) {
      const key = r.fact.briefer ?? "unknown";
      const list = byBriefer.get(key);
      if (list) list.push(r);
      else byBriefer.set(key, [r]);
    }
    const briefers = [...byBriefer]
      .map(([id, list]) => ({ briefer: userRef(ctx, id === "unknown" ? null : id), ...summarize(list) }))
      .sort((a, b) => b.briefs - a.briefs || a.briefer.name.localeCompare(b.briefer.name));

    const rank = (r: Row) => (r.ai?.verdict === "flagged" ? 0 : !r.covered ? 1 : r.ai?.verdict === "weak" ? 2 : 9);
    const attention = rows
      .filter((r) => r.fact.createdDay >= recentStart && rank(r) < 9)
      .sort((a, b) => rank(a) - rank(b) || b.fact.createdAt.getTime() - a.fact.createdAt.getTime())
      .slice(0, WEAKEST_COUNT)
      .map((r) => ({
        ...taskRow(ctx, r.fact),
        issue: r.ai?.verdict === "flagged" ? "flagged" : !r.covered ? "missing" : "weak",
        reason: r.ai?.reason || (!r.covered ? "No description and no attachment" : ""),
      }));

    // Weakest briefs: lowest LPS score among the period's tasks, newest first among ties.
    const weakest = inPeriod
      .filter((r) => r.rules.score !== null && r.rules.score < 100)
      .sort((a, b) => a.rules.score! - b.rules.score! || b.fact.createdAt.getTime() - a.fact.createdAt.getTime())
      .slice(0, WEAKEST_COUNT)
      .map((r) => ({
        ...taskRow(ctx, r.fact),
        score: r.rules.score!,
        passed: r.rules.passed,
        applicable: r.rules.applicable,
        failed: r.rules.failed,
        snippet: r.description.replace(/\s+/g, " ").trim().slice(0, 160),
      }));

    return {
      aiConfigured: briefCheckConfigured(),
      aiModel: briefCheckConfigured() ? briefCheckModel() : null,
      rules: briefRules(ctx.settings),
      totals: summarize(inPeriod),
      byBriefer: briefers,
      weakest,
      attentionWindowDays: WEAKEST_DAYS,
      attention,
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
  // Completed in the last 7 / 30 days (whatever the period).
  const completedSince = (days: number) =>
    facts.filter((f) => f.completedDay !== null && f.completedDay > ctx.today - days && f.completedDay <= ctx.today).length;
  return {
    ...statsRow(s),
    brandCount: brands.size,
    ranked: s.completed >= ctx.settings.minCompletedToRank,
    completedThisWeek: completedSince(7),
    completed30d: completedSince(30),
  };
}

function personInfo(ctx: Ctx, id: string) {
  const u = ctx.ref.users.get(id);
  const team = teamOfDepartment(ctx, u?.department ?? null);
  return {
    ...userRef(ctx, id),
    designation: u?.designation ?? "",
    role: u?.role ?? null,
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
      const byPerson = factsByPerson(ctx.facts);
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
        headers: ["Person", "Designation", "Team", "Completed", "This week", "30 days", "On time %", "Mean days", "Mean start → done", "Rework %", "Rework (internal)", "Rework (external)", "Rework (not set)", "Overdue now", "Open now", "Brands", "Ranked"],
        rows: d.rows.map((r) => [
          r.person.name, r.person.designation, r.person.team.name, r.completed, r.completedThisWeek, r.completed30d, pctText(r.onTimePct), pctText(r.meanDays), pctText(r.startToDoneDays), pctText(r.reworkPct),
          r.reworkInternal, r.reworkExternal, r.reworkNotSet, r.overdue, r.open, r.brandCount, r.ranked ? "Yes" : "No",
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
      // Month by month (calendar months within the period, newest first, latest 24).
      const monthly: Array<{ month: string; completed: number; meanDays: number | null; onTimePct: number | null; completedWithDue: number }> = [];
      for (let end = ctx.period.current.end; end >= ctx.period.current.start && monthly.length < MONTHS_CAP; ) {
        const month = keyFromDay(end).slice(0, 7);
        const start = Math.max(dayFromKey(`${month}-01`), ctx.period.current.start);
        const s = statsFor(facts, { start, end }, end);
        monthly.push({ month, completed: s.completed, meanDays: s.meanDays, onTimePct: s.onTimePct, completedWithDue: s.completedWithDue });
        end = dayFromKey(`${month}-01`) - 1;
      }
      return {
        person: personInfo(ctx, id),
        minCompletedToRank: ctx.settings.minCompletedToRank,
        stats: personStats(ctx, facts),
        brands,
        weekly: { capped, weeks: weeklySeries(facts, weeks) },
        monthly,
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

type PlanProject = {
  _id: mongoose.Types.ObjectId;
  name: string;
  brand?: mongoose.Types.ObjectId | null;
  members?: Array<{ user?: mongoose.Types.ObjectId | null }>;
  manager?: mongoose.Types.ObjectId | null;
  naming?: { brand?: mongoose.Types.ObjectId; type?: string; month?: string; title?: string } | null;
  deadline?: Date | null;
  manpowerRow?: string | null;
};
type PlanMonthMaps = { projectRow: Map<string, string>; rowUsers: Map<string, Set<string>>; brandUsers: Map<string, Set<string>> };

/** Latest plan version of each month in [fromMonth, toMonth], as on-map sets. */
async function planMapsFor(fromMonth: string, toMonth: string, projects: PlanProject[]): Promise<Map<string, PlanMonthMaps>> {
  const [plans, brandDocs] = await Promise.all([
    ManpowerPlan.aggregate<{
      _id: string;
      rows: Array<{ key: string; brand: mongoose.Types.ObjectId | null; type: string | null; name: string; cells: Array<{ users: mongoose.Types.ObjectId[] }> }>;
    }>([
      { $match: { month: { $gte: fromMonth, $lte: toMonth }, ...APPROVED_PLAN } },
      { $sort: { month: 1, version: -1 } },
      { $group: { _id: "$month", rows: { $first: "$rows" } } },
    ]),
    Brand.find({}).select("name").lean(),
  ]);
  const out = new Map<string, PlanMonthMaps>();
  if (plans.length === 0) return out;
  const brandNames = new Map(brandDocs.map((b) => [String(b._id), b.name]));
  const linkable = projects.map((p) => ({
    _id: String(p._id),
    name: p.name,
    brand: p.brand ? String(p.brand) : p.naming?.brand ? String(p.naming.brand) : null,
    naming: p.naming ? { type: p.naming.type, month: p.naming.month, title: p.naming.title } : null,
    deadline: p.deadline ?? null,
    manpowerRow: p.manpowerRow ?? null,
  }));
  for (const plan of plans) {
    const rowUsers = new Map<string, Set<string>>();
    const brandUsers = new Map<string, Set<string>>();
    for (const r of plan.rows) {
      const users = new Set(r.cells.flatMap((c) => c.users.map(String)));
      rowUsers.set(r.key, users);
      if (!r.brand) continue;
      const b = String(r.brand);
      const set = brandUsers.get(b) ?? new Set<string>();
      for (const u of users) set.add(u);
      brandUsers.set(b, set);
    }
    const projectRow = linkProjectsToRows(
      plan._id,
      plan.rows.map((r) => ({ key: r.key, brand: r.brand ? String(r.brand) : null, type: r.type, name: r.name })),
      linkable,
      brandNames
    );
    out.set(plan._id, { projectRow, rowUsers, brandUsers });
  }
  return out;
}

/**
 * GET /team-map — on-map / off-map coverage per brand since the tracking start date.
 * A task is checked against the manpower plan of the month it was created in:
 * the people on its project's plan row, else everyone planned on its brand that
 * month. Months or brands without a plan use the configured brand team map, or
 * one derived from the brand's project members and managers (flagged `derived`).
 */
function loadPlanProjects(): Promise<PlanProject[]> {
  return Project.find({}).select("brand members.user manager name naming deadline manpowerRow").lean<PlanProject[]>();
}

/**
 * On-map sets for tasks: the people on the task's project line of its creation
 * month's approved manpower plan (else everyone planned on its brand that
 * month); months / brands without a plan use the configured brand team map, or
 * one derived from the brand's project members and managers.
 */
function teamMapSources(settings: DeliverySettingsSnapshot, projects: PlanProject[], plans: Map<string, PlanMonthMaps>) {
  const traffic = new Set(settings.trafficManagers);
  const configured = new Map(settings.brandTeamMap.filter((e) => e.users.length > 0).map((e) => [e.brand, new Set(e.users)]));
  const derived = new Map<string, Set<string>>();
  for (const p of projects) {
    if (!p.brand) continue;
    const brand = String(p.brand);
    if (configured.has(brand)) continue;
    const set = derived.get(brand) ?? new Set<string>();
    for (const m of p.members ?? []) if (m.user && !traffic.has(String(m.user))) set.add(String(m.user));
    if (p.manager && !traffic.has(String(p.manager))) set.add(String(p.manager));
    if (set.size) derived.set(brand, set);
  }
  const fallbackOf = (brand: string) => configured.get(brand) ?? derived.get(brand) ?? null;

  /** The on-map set for one task, and the plan month it came from (null = fallback map). */
  const mapForFact = (f: TaskFact, brand: string): { set: Set<string> | null; planMonth: string | null } => {
    const month = keyFromDay(f.createdDay).slice(0, 7);
    const plan = plans.get(month);
    if (plan) {
      const rowKey = f.project ? plan.projectRow.get(f.project) : undefined;
      const set = (rowKey ? plan.rowUsers.get(rowKey) : undefined) ?? plan.brandUsers.get(brand);
      if (set) return { set, planMonth: month };
    }
    return { set: fallbackOf(brand), planMonth: null };
  };
  return { configured, derived, fallbackOf, mapForFact };
}

export async function getTeamMap(req: Request, res: Response): Promise<void> {
  const projects = await loadPlanProjects();
  const settingsNow = await getDeliverySettings();
  const plans = await planMapsFor(settingsNow.teamMapStartDate.slice(0, 7), appDateKey().slice(0, 7), projects);
  await respond(req, res, "team-map", (ctx) => {
    const start = dayFromKey(ctx.settings.teamMapStartDate);
    const { configured, derived, fallbackOf, mapForFact } = teamMapSources(ctx.settings, projects, plans);

    type Agg = { tasks: number; offMap: number; working: Map<string, number>; onMap: Set<string>; planMonths: Set<string> };
    const emptyAgg = (): Agg => ({ tasks: 0, offMap: 0, working: new Map(), onMap: new Set(), planMonths: new Set() });
    const perBrand = new Map<string, Agg>();
    for (const f of ctx.facts) {
      const created = f.createdDay >= start && f.createdDay <= ctx.today;
      const completed = f.completedDay !== null && f.completedDay >= start && f.completedDay <= ctx.today;
      if (!created && !completed) continue;
      const brand = brandKey(ctx, f);
      const agg = perBrand.get(brand) ?? emptyAgg();
      perBrand.set(brand, agg);
      agg.tasks++;
      for (const d of f.doers) agg.working.set(d, (agg.working.get(d) ?? 0) + 1);
      const { set, planMonth } = mapForFact(f, brand);
      if (planMonth) agg.planMonths.add(planMonth);
      if (!set) continue;
      for (const u of set) agg.onMap.add(u);
      if (f.doers.length > 0 && f.doers.every((d) => !set.has(d))) agg.offMap++;
    }

    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
    const known = (u: string) => ctx.ref.users.has(u);
    const rows = [...ctx.ref.brands]
      .filter(([id, b]) => b.active || perBrand.has(id))
      .map(([id]) => {
        const agg = perBrand.get(id) ?? emptyAgg();
        // On-map people: the plan sets used for this brand's tasks, plus the fallback map.
        const map = new Set([...agg.onMap, ...(fallbackOf(id) ?? [])]);
        const hasMap = map.size > 0;
        const workers = [...agg.working];
        const ranked = (list: Array<[string, number]>) =>
          list.map(([u, count]) => ({ person: userRef(ctx, u), count })).sort((a, b) => b.count - a.count || byName(a.person, b.person));
        return {
          brand: brandRef(ctx, id),
          mapped: [...map].filter(known).map((u) => userRef(ctx, u)).sort(byName),
          derived: agg.planMonths.size === 0 && !configured.has(id) && derived.has(id),
          planMonths: [...agg.planMonths].sort(),
          tasks: agg.tasks,
          offMapTasks: hasMap ? agg.offMap : null,
          offMapPct: hasMap && agg.tasks > 0 ? Math.round((agg.offMap / agg.tasks) * 100) : null,
          onMapWorking: hasMap ? ranked(workers.filter(([u]) => map.has(u))) : [],
          offMapWorking: hasMap ? ranked(workers.filter(([u]) => !map.has(u))) : ranked(workers),
          mappedUnused: hasMap ? [...map].filter((u) => !agg.working.has(u) && known(u)).map((u) => userRef(ctx, u)).sort(byName) : [],
        };
      })
      .sort((a, b) => (b.offMapTasks ?? -1) - (a.offMapTasks ?? -1) || b.tasks - a.tasks || a.brand.name.localeCompare(b.brand.name));

    return {
      startDate: ctx.settings.teamMapStartDate,
      mappedBrands: configured.size,
      derivedBrands: derived.size,
      planMonths: [...plans.keys()].sort(),
      totals: {
        tasks: rows.reduce((n, r) => n + r.tasks, 0),
        offMapTasks: rows.reduce((n, r) => n + (r.offMapTasks ?? 0), 0),
      },
      rows,
    };
  });
}

/**
 * GET /traffic — the traffic desk (traffic managers' routing):
 *  - waiting: open tasks whose only assignees are traffic managers (not routed to the team yet);
 *  - routed: tasks that came in via a traffic manager and were assigned onwards in the period,
 *    with the average / median time to assign.
 * A task counts as the team member's job once routed (traffic managers are never doers).
 */
export async function getTraffic(req: Request, res: Response): Promise<void> {
  await respond(req, res, "traffic", async (ctx) => {
    const tms = ctx.settings.trafficManagers;
    if (tms.length === 0) return { configured: false, managers: [], waiting: [], totals: { waiting: 0, routed: 0, avgHours: null, medianHours: null } };
    const tmIds = tms.map((id) => new mongoose.Types.ObjectId(id));
    const tmSet = new Set(tms);
    const periodStart = new Date(`${keyFromDay(ctx.period.current.start)}T00:00:00.000Z`);
    const periodEnd = new Date(`${keyFromDay(ctx.period.current.end)}T23:59:59.999Z`);
    const [openWithTm, routed] = await Promise.all([
      Task.find({ status: { $ne: "completed" }, assignees: { $in: tmIds } })
        .select("title shortCode number assignees createdAt project dueDate")
        .lean(),
      Task.find({ trafficVia: { $in: tmIds }, assignedAt: { $gte: periodStart, $lte: periodEnd } })
        .select("trafficVia assignedAt createdAt")
        .lean(),
    ]);
    const now = Date.now();
    const waiting = openWithTm
      .filter((t) => t.assignees.length > 0 && t.assignees.every((a) => tmSet.has(String(a))))
      .map((t) => ({
        id: String(t._id),
        code: t.shortCode ?? (t.number ? `#${t.number}` : ""),
        title: t.title,
        manager: userRef(ctx, String(t.assignees[0])),
        project: t.project ? ctx.ref.projects.get(String(t.project))?.name ?? null : null,
        waitingDays: Math.floor((now - new Date(t.createdAt).getTime()) / 86_400_000),
        dueDate: t.dueDate ? new Date(t.dueDate).toISOString().slice(0, 10) : null,
      }))
      .sort((a, b) => b.waitingDays - a.waitingDays);
    const hoursOf = (t: { assignedAt?: Date | null; createdAt: Date }) =>
      Math.max(0, (new Date(t.assignedAt!).getTime() - new Date(t.createdAt).getTime()) / 3_600_000);
    const stats = (list: Array<{ assignedAt?: Date | null; createdAt: Date }>) => {
      const hours = list.map(hoursOf).sort((a, b) => a - b);
      if (hours.length === 0) return { avgHours: null, medianHours: null };
      const avg = hours.reduce((n, h) => n + h, 0) / hours.length;
      const mid = Math.floor(hours.length / 2);
      const median = hours.length % 2 ? hours[mid]! : (hours[mid - 1]! + hours[mid]!) / 2;
      return { avgHours: Math.round(avg * 10) / 10, medianHours: Math.round(median * 10) / 10 };
    };
    const managers = tms
      .map((id) => {
        const mine = routed.filter((t) => String(t.trafficVia) === id);
        return {
          person: userRef(ctx, id),
          waiting: waiting.filter((w) => w.manager.id === id).length,
          routed: mine.length,
          ...stats(mine),
        };
      })
      .sort((a, b) => b.waiting - a.waiting || b.routed - a.routed);
    return {
      configured: true,
      managers,
      waiting: waiting.slice(0, 50),
      totals: { waiting: waiting.length, routed: routed.length, ...stats(routed) },
    };
  });
}
