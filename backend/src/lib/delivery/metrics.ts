import { keyFromDay, mondayOfDay } from "./days.js";
import type { TaskFact } from "./facts.js";

// ---------------------------------------------------------------------------
// Pure metric reductions over TaskFact rows (see prompts/delivery-pulse.md,
// "Metric definitions"). All comparisons are on app-timezone day numbers.
// ---------------------------------------------------------------------------

export const PERIODS = ["7d", "30d", "90d", "12m", "all", "custom"] as const;
export type PeriodKey = (typeof PERIODS)[number];
const PERIOD_DAYS: Record<Exclude<PeriodKey, "all" | "custom">, number> = { "7d": 7, "30d": 30, "90d": 90, "12m": 365 };

export const MAX_WEEKS = 104;

/** Inclusive day-number range. */
export interface Range {
  start: number;
  end: number;
}

export interface PeriodInfo {
  key: PeriodKey;
  days: number;
  today: number;
  current: Range;
  /** Same-length window immediately before `current` (null for "all"). */
  previous: Range | null;
}

export function resolvePeriod(key: PeriodKey, today: number, minCreatedDay: number | null, custom?: Range | null): PeriodInfo {
  if (key === "custom" && custom) {
    const days = custom.end - custom.start + 1;
    return { key, days, today, current: { ...custom }, previous: { start: custom.start - days, end: custom.start - 1 } };
  }
  if (key === "all") {
    const start = Math.min(minCreatedDay ?? today, today);
    return { key, days: today - start + 1, today, current: { start, end: today }, previous: null };
  }
  const days = PERIOD_DAYS[key === "custom" ? "30d" : key];
  const start = today - days + 1;
  return { key, days, today, current: { start, end: today }, previous: { start: start - days, end: start - 1 } };
}

/** Earliest day any endpoint needs for a period (facts scan window); null = no limit ("all"). */
export function factsWindowStart(key: PeriodKey, today: number, teamMapStartDay: number, custom?: Range | null): number | null {
  if (key === "all") return null;
  const p = resolvePeriod(key, today, null, custom);
  return Math.min(p.previous!.start, mondayOfDay(p.current.start), today - 29, teamMapStartDay);
}

/** Open at the end of day `day`: created by then and not yet closed. */
export function openAt(f: TaskFact, day: number): boolean {
  return f.createdDay <= day && (f.closedDay === null || f.closedDay > day);
}

/** Open and past due at the end of day `day`. */
export function overdueAt(f: TaskFact, day: number): boolean {
  return openAt(f, day) && f.dueDay !== null && f.dueDay < day;
}

export interface Acc {
  created: number;
  rework: number;
  completed: number;
  completedWithDue: number;
  onTime: number;
  cycleDaysSum: number;
  /** Completed in range with an actual start: start → done days. */
  startedCompleted: number;
  startDoneDaysSum: number;
  /** Actual start in range with a planned start; late = actual start date after the planned one. */
  startsWithPlan: number;
  lateStarts: number;
  open: number;
  overdue: number;
}

export function emptyAcc(): Acc {
  return {
    created: 0,
    rework: 0,
    completed: 0,
    completedWithDue: 0,
    onTime: 0,
    cycleDaysSum: 0,
    startedCompleted: 0,
    startDoneDaysSum: 0,
    startsWithPlan: 0,
    lateStarts: 0,
    open: 0,
    overdue: 0,
  };
}

const inRange = (day: number | null, r: Range) => day !== null && day >= r.start && day <= r.end;

/** Adds one task: created/rework/completed counts for `range`, open/overdue as of `asOf`. */
export function addFact(acc: Acc, f: TaskFact, range: Range, asOf: number): void {
  if (inRange(f.createdDay, range)) {
    acc.created += 1;
    if (f.rework) acc.rework += 1;
  }
  if (f.completedDay !== null && inRange(f.completedDay, range)) {
    acc.completed += 1;
    acc.cycleDaysSum += Math.max(0, f.completedDay - f.createdDay);
    if (f.dueDay !== null) {
      acc.completedWithDue += 1;
      if (f.completedDay <= f.dueDay) acc.onTime += 1;
    }
    if (f.actualStartDay !== null) {
      acc.startedCompleted += 1;
      acc.startDoneDaysSum += Math.max(0, (f.actualEndDay ?? f.completedDay) - f.actualStartDay);
    }
  }
  if (f.actualStartDay !== null && f.startDay !== null && inRange(f.actualStartDay, range)) {
    acc.startsWithPlan += 1;
    if (f.actualStartDay > f.startDay) acc.lateStarts += 1;
  }
  if (openAt(f, asOf)) {
    acc.open += 1;
    if (f.dueDay !== null && f.dueDay < asOf) acc.overdue += 1;
  }
}

export const round1 = (n: number) => Math.round(n * 10) / 10;
export const pct = (num: number, den: number): number | null => (den > 0 ? round1((num / den) * 100) : null);

export interface Stats {
  /** Tasks created in the range. */
  created: number;
  /** Rework tasks created in the range. */
  rework: number;
  reworkPct: number | null;
  completed: number;
  /** Completed in range with a due date (on-time denominator). */
  completedWithDue: number;
  onTime: number;
  onTimePct: number | null;
  /** Completed in range without a due date (excluded from on-time %). */
  completedNoDue: number;
  meanDays: number | null;
  /** Mean days from the actual start to done (completed in range with an actual start). */
  startToDoneDays: number | null;
  /** Completed in range with an actual start (start → done denominator). */
  startedCompleted: number;
  /** Actual starts in range with a planned start, and those that started after the planned day. */
  startsWithPlan: number;
  lateStarts: number;
  lateStartPct: number | null;
  /** Open / overdue at the end of the as-of day. */
  open: number;
  overdue: number;
}

export function finalize(acc: Acc): Stats {
  return {
    created: acc.created,
    rework: acc.rework,
    reworkPct: pct(acc.rework, acc.created),
    completed: acc.completed,
    completedWithDue: acc.completedWithDue,
    onTime: acc.onTime,
    onTimePct: pct(acc.onTime, acc.completedWithDue),
    completedNoDue: acc.completed - acc.completedWithDue,
    meanDays: acc.completed > 0 ? round1(acc.cycleDaysSum / acc.completed) : null,
    startToDoneDays: acc.startedCompleted > 0 ? round1(acc.startDoneDaysSum / acc.startedCompleted) : null,
    startedCompleted: acc.startedCompleted,
    startsWithPlan: acc.startsWithPlan,
    lateStarts: acc.lateStarts,
    lateStartPct: pct(acc.lateStarts, acc.startsWithPlan),
    open: acc.open,
    overdue: acc.overdue,
  };
}

export function statsFor(facts: TaskFact[], range: Range, asOf: number): Stats {
  const acc = emptyAcc();
  for (const f of facts) addFact(acc, f, range, asOf);
  return finalize(acc);
}

/** Stats per group; a task counts once for each key it maps to. */
export function groupStats(
  facts: TaskFact[],
  keys: (f: TaskFact) => readonly (string | null)[],
  range: Range,
  asOf: number
): Map<string | null, Stats> {
  const accs = new Map<string | null, Acc>();
  for (const f of facts) {
    for (const k of new Set(keys(f))) {
      let acc = accs.get(k);
      if (!acc) accs.set(k, (acc = emptyAcc()));
      addFact(acc, f, range, asOf);
    }
  }
  return new Map([...accs].map(([k, acc]) => [k, finalize(acc)]));
}

/** True when the stats have no activity at all (nothing created, completed or open). */
export function isEmptyStats(s: Pick<Stats, "created" | "completed" | "open">): boolean {
  return s.created === 0 && s.completed === 0 && s.open === 0;
}

// -- Deltas -------------------------------------------------------------------

export type BetterWhen = "higher" | "lower" | "neutral";

export interface Delta {
  current: number | null;
  previous: number | null;
  /** current − previous (percentage points for % metrics); null without both values. */
  change: number | null;
  direction: "up" | "down" | "flat" | null;
  /** Whether the change is good for this metric (null = neutral or no comparison). */
  good: boolean | null;
  betterWhen: BetterWhen;
  /** True when the previous period has no data to compare with. */
  noPreviousData: boolean;
}

export function delta(current: number | null, previous: number | null, betterWhen: BetterWhen): Delta {
  if (current === null || previous === null) {
    return { current, previous, change: null, direction: null, good: null, betterWhen, noPreviousData: previous === null };
  }
  const change = round1(current - previous);
  const direction = change > 0 ? "up" : change < 0 ? "down" : "flat";
  const good =
    betterWhen === "neutral" || direction === "flat" ? null : (direction === "up") === (betterWhen === "higher");
  return { current, previous, change, direction, good, betterWhen, noPreviousData: false };
}

export interface SummaryKpis {
  current: Stats;
  previous: Stats | null;
  deltas: {
    created: Delta;
    completed: Delta;
    onTimePct: Delta;
    meanDays: Delta;
    startToDoneDays: Delta;
    lateStartPct: Delta;
    reworkPct: Delta;
    open: Delta;
    overdue: Delta;
  };
}

/**
 * KPIs and deltas. Tasks and rework compare tasks created in each period; on
 * time / completed / mean days compare tasks completed in each period; open
 * and overdue compare now with the state at the start of the period.
 */
export function summarize(facts: TaskFact[], period: PeriodInfo): SummaryKpis {
  const current = statsFor(facts, period.current, period.today);
  const previous = period.previous ? statsFor(facts, period.previous, period.previous.end) : null;
  const had = previous !== null && !isEmptyStats(previous);
  const prev = <T extends number | null>(value: T): T | null => (had ? value : null);
  return {
    current,
    previous,
    deltas: {
      created: delta(current.created, prev(previous?.created ?? null), "neutral"),
      completed: delta(current.completed, prev(previous?.completed ?? null), "higher"),
      onTimePct: delta(current.onTimePct, prev(previous?.onTimePct ?? null), "higher"),
      meanDays: delta(current.meanDays, prev(previous?.meanDays ?? null), "lower"),
      startToDoneDays: delta(current.startToDoneDays, prev(previous?.startToDoneDays ?? null), "lower"),
      lateStartPct: delta(current.lateStartPct, prev(previous?.lateStartPct ?? null), "lower"),
      reworkPct: delta(current.reworkPct, prev(previous?.reworkPct ?? null), "lower"),
      open: delta(current.open, prev(previous?.open ?? null), "neutral"),
      overdue: delta(current.overdue, prev(previous?.overdue ?? null), "lower"),
    },
  };
}

// -- Weekly series ---------------------------------------------------------------

export interface WeekRow {
  weekStart: string;
  /** Last day counted (Sunday, or today for the current week). */
  weekEnd: string;
  created: number;
  completed: number;
  onTimePct: number | null;
  meanDays: number | null;
  /** Mean days actual start → done (tasks completed that week with an actual start). */
  startToDoneDays: number | null;
  /** Open / overdue at the end of the week. */
  open: number;
  overdue: number;
  overduePct: number | null;
  rework: number;
  reworkPct: number | null;
}

/** Monday-start weeks covering the period, capped at the most recent MAX_WEEKS. */
export function weeksFor(period: PeriodInfo): { weeks: Range[]; capped: boolean } {
  const last = mondayOfDay(period.today);
  let first = mondayOfDay(period.current.start);
  let capped = false;
  if ((last - first) / 7 + 1 > MAX_WEEKS) {
    first = last - (MAX_WEEKS - 1) * 7;
    capped = true;
  }
  const weeks: Range[] = [];
  for (let ws = first; ws <= last; ws += 7) weeks.push({ start: ws, end: Math.min(ws + 6, period.today) });
  return { weeks, capped };
}

export function weeklySeries(facts: TaskFact[], weeks: Range[]): WeekRow[] {
  return weeks.map((w) => {
    const s = statsFor(facts, w, w.end);
    return {
      weekStart: keyFromDay(w.start),
      weekEnd: keyFromDay(w.end),
      created: s.created,
      completed: s.completed,
      onTimePct: s.onTimePct,
      meanDays: s.meanDays,
      startToDoneDays: s.startToDoneDays,
      open: s.open,
      overdue: s.overdue,
      overduePct: pct(s.overdue, s.open),
      rework: s.rework,
      reworkPct: s.reworkPct,
    };
  });
}
