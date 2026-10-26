import { z } from "zod/v4";
import type { IUser } from "../../models/User.js";
import { appDateKey } from "../appTime.js";
import { richTextToPlain } from "../richText.js";
import { editDistance, soundKey } from "../voiceParse.js";
import { dayFromKey, keyFromDay } from "../delivery/days.js";
import type { RefData } from "../delivery/facts.js";

// ---------------------------------------------------------------------------
// Shared pieces of the Leadership Insights tools (lib/insights/tools.ts):
// the period / filter params every tool takes, the name → id lookups (the
// model passes names, never ids) and the row cap. Tools are read-only and
// return small aggregated JSON — never emails, rates, costs or HR data.
// ---------------------------------------------------------------------------

/** Hard cap on rows any tool returns. */
export const MAX_ROWS = 200;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const QUARTER = /^\d{4}-Q[1-4]$/;

export const periodParams = {
  from: z.string().regex(DATE).optional().describe("Start date YYYY-MM-DD (inclusive)."),
  to: z.string().regex(DATE).optional().describe("End date YYYY-MM-DD (inclusive)."),
  month: z.string().regex(MONTH).optional().describe("A calendar month YYYY-MM (instead of from/to)."),
  quarter: z.string().regex(QUARTER).optional().describe("A quarter like 2026-Q4 (instead of from/to)."),
};

export const filterParams = {
  brand: z.string().max(80).optional().describe("Brand name (or part of it)."),
  team: z.string().max(80).optional().describe("Team / department name (or part of it)."),
  person: z.string().max(80).optional().describe("Person's name (or part of it)."),
};

export const limitParam = z.number().int().min(1).max(MAX_ROWS).optional().describe(`Max rows to return (default 25, max ${MAX_ROWS}).`);

export interface Period {
  /** Inclusive day numbers (app timezone). */
  start: number;
  end: number;
  /** "YYYY-MM-DD" keys and a readable label. */
  from: string;
  to: string;
  label: string;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const todayDay = () => dayFromKey(appDateKey());

export function monthRange(month: string): { start: number; end: number } {
  const [y, m] = month.split("-").map(Number);
  const start = dayFromKey(`${month}-01`);
  const next = m === 12 ? `${y! + 1}-01-01` : `${y}-${String(m! + 1).padStart(2, "0")}-01`;
  return { start, end: dayFromKey(next) - 1 };
}

export const monthLabel = (month: string) => `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
export const currentMonth = () => appDateKey().slice(0, 7);

/** The period from month / quarter / from-to (default: the last `defaultDays` days to today). */
export function resolvePeriod(p: { from?: string; to?: string; month?: string; quarter?: string }, defaultDays = 30): Period {
  let start: number;
  let end: number;
  let label: string;
  if (p.month) {
    ({ start, end } = monthRange(p.month));
    label = monthLabel(p.month);
  } else if (p.quarter) {
    const year = p.quarter.slice(0, 4);
    const q = Number(p.quarter.slice(6));
    const first = `${year}-${String((q - 1) * 3 + 1).padStart(2, "0")}`;
    const last = `${year}-${String((q - 1) * 3 + 3).padStart(2, "0")}`;
    start = monthRange(first).start;
    end = monthRange(last).end;
    label = `Q${q} ${year}`;
  } else {
    const today = todayDay();
    end = p.to ? dayFromKey(p.to) : today;
    start = p.from ? dayFromKey(p.from) : end - defaultDays + 1;
    if (start > end) [start, end] = [end, start];
    label = `${keyFromDay(start)} to ${keyFromDay(end)}`;
  }
  // At most ~3 years in one question.
  if (end - start > 3 * 366) start = end - 3 * 366;
  return { start, end, from: keyFromDay(start), to: keyFromDay(end), label };
}

/** Thrown for a filter that matches nothing: the model gets the message (and suggestions) back. */
export class ToolInputError extends Error {
  constructor(message: string, readonly suggestions: string[] = []) {
    super(message);
  }
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** How far a name is from the query: 0 = a word sounds the same, else the smallest edit distance of a word. */
function closeness(query: string, name: string): number {
  const qWords = norm(query).split(" ").filter(Boolean);
  const nWords = norm(name).split(/[\s|,-]+/).filter(Boolean);
  let best = Infinity;
  for (const q of qWords) {
    for (const n of nWords) {
      if (q.length >= 3 && soundKey(q) === soundKey(n)) return 0;
      best = Math.min(best, editDistance(q, n));
    }
  }
  return best;
}

/** The closest names (sound-alike, typo-tolerant), for "did you mean" suggestions. */
export function closestNames<T>(query: string, items: Array<{ id: T; names: string[]; label: string }>, max = 5): string[] {
  return items
    .map((i) => ({ label: i.label, d: Math.min(...i.names.map((n) => closeness(query, n))) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(norm(query).length / 3)))
    .sort((a, b) => a.d - b.d || a.label.localeCompare(b.label))
    .slice(0, max)
    .map((x) => x.label);
}

/**
 * Exact (case-insensitive) match first, then "contains", then a single sound-alike / 1–2 letter
 * typo match (as the voice assistant reads names). No match or several → error WITH suggestions.
 */
export function matchName<T>(kind: string, query: string, items: Array<{ id: T; names: string[]; label: string }>, fuzzy = true): { id: T; label: string } {
  const q = norm(query);
  const exact = items.filter((i) => i.names.some((n) => norm(n) === q));
  if (exact.length === 1) return exact[0]!;
  const partial = exact.length > 1 ? exact : items.filter((i) => i.names.some((n) => norm(n).includes(q)));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) throw new ToolInputError(`"" matches several s — be more specific.`, partial.slice(0, 10).map((i) => i.label));
  const near = fuzzy ? items.filter((i) => i.names.some((n) => closeness(query, n) <= (q.length >= 5 ? 1 : 0))) : [];
  if (near.length === 1) return near[0]!;
  const suggestions = near.length ? near.slice(0, 10).map((i) => i.label) : closestNames(query, items);
  throw new ToolInputError(`No  matches "".`, suggestions);
}

export function brandIdByName(ref: RefData, query: string): { id: string; label: string } {
  return matchName(
    "brand",
    query,
    [...ref.brands].map(([id, b]) => ({ id, names: [b.name, b.shortName].filter(Boolean), label: b.name }))
  );
}

export function teamIdByName(ref: RefData, query: string): { id: string; label: string } {
  return matchName("team", query, [...ref.departments].map(([id, name]) => ({ id, names: [name], label: name })));
}

export function personIdByName(ref: RefData, query: string): { id: string; label: string } {
  return matchName("person", query, [...ref.users].map(([id, u]) => ({ id, names: [u.name], label: u.name })));
}

/** Plain-text excerpt (outcome notes are rich text). */
export function excerpt(text: string | null | undefined, max = 160): string {
  const plain = richTextToPlain(text).replace(/\s+/g, " ").trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

export const round1 = (n: number) => Math.round(n * 10) / 10;
export const pctOf = (part: number, whole: number): number | null => (whole > 0 ? round1((part / whole) * 100) : null);

/** Groups smaller than this are flagged `lowVolume` and ranked after the others when sorting by a rate. */
export const LOW_VOLUME = 5;

export const sortDirParam = z.enum(["desc", "asc"]).optional().describe("Sort direction (default desc).");

/**
 * Sorts tool rows by `key` (nulls last). For rates, rows flagged lowVolume go after
 * the others so 1 of 1 = 100% doesn't top a ranking.
 */
export function sortRows<T extends Record<string, unknown>>(rows: T[], key: string, dir: "asc" | "desc" = "desc", rate = false): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (rate && Boolean(a.lowVolume) !== Boolean(b.lowVolume)) return a.lowVolume ? 1 : -1;
    const x = a[key];
    const y = b[key];
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
    if (typeof x === "number" && typeof y === "number") return (x - y) * sign;
    return String(x).localeCompare(String(y)) * sign;
  });
}

/** Who asks (leadership; their own visibility is applied where a helper takes it). */
export interface ToolContext {
  user: IUser;
}
