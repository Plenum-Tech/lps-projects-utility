import type { Cell, Dataset, DatasetColumn } from "@/lib/insights/types";

// ---------------------------------------------------------------------------
// Table sorting for Insights blocks: values are compared by meaning (numbers,
// percentages, "2h 30m" durations, dates, then text), and every table gets a
// smart default sort — the metric the question names, else the first rate
// column, else the main number; date tables show the latest first. Charts use
// the same order.
// ---------------------------------------------------------------------------

export interface SortState {
  key: string;
  dir: "asc" | "desc";
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Date-ish strings → epoch ms ("2026-10-21", "Week of 2026-10-05", "Oct 2026", "21 Oct 2026"); null otherwise. */
export function dateValue(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const iso = /(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(v);
  if (iso) return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3] ?? 1));
  const named = /^(?:(\d{1,2})\s+)?([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(v.trim());
  if (named) {
    const m = MONTHS.indexOf(named[2]!.toLowerCase());
    if (m >= 0) return Date.UTC(Number(named[3]), m, Number(named[1] ?? 1));
  }
  return null;
}

/** Numbers, "47.8%", "1,200", "2h 30m" → a number; null otherwise. */
export function numberValue(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return null;
  const s = v.trim();
  const dur = /^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+)\s*m)?$/i.exec(s);
  if (dur && (dur[1] || dur[2])) return Number(dur[1] ?? 0) + Number(dur[2] ?? 0) / 60;
  const num = /^-?[\d,]+(?:\.\d+)?\s*%?$/.exec(s);
  return num ? Number(s.replace(/[,%\s]/g, "")) : null;
}

type Kind = "number" | "date" | "text";

export function columnKind(rows: Array<Record<string, Cell>>, col: DatasetColumn): Kind {
  if (col.numeric) return "number";
  const values = rows.map((r) => r[col.key]).filter((v) => v !== null && v !== "" && v !== undefined);
  if (values.length === 0) return "text";
  if (values.every((v) => dateValue(v) !== null)) return "date";
  if (values.every((v) => numberValue(v) !== null)) return "number";
  return "text";
}

const isRate = (c: DatasetColumn) => c.unit === "%" || /%|rate|pct/i.test(`${c.label} ${c.key}`);
const METRIC_WORDS = /\b(rate|%|percent|most|top|highest|lowest|least|worst|best|frequently|often|biggest|largest|ranking|rank)\b/i;

/**
 * The default sort: explicit (block / model) → the metric the question names → the server's
 * ranking → the first rate column → the main numeric column; date tables: latest first.
 */
export function defaultSort(dataset: Dataset, question: string, explicit?: { sortBy?: string; sortDir?: "asc" | "desc" }): SortState | null {
  const cols = dataset.columns;
  if (explicit?.sortBy && cols.some((c) => c.key === explicit.sortBy)) return { key: explicit.sortBy, dir: explicit.sortDir ?? "desc" };
  const numeric = cols.filter((c) => columnKind(dataset.rows, c) === "number");
  const q = question.toLowerCase();
  if (q && METRIC_WORDS.test(q)) {
    const wantsRate = /\b(rate|%|percent)\b|%/.test(q);
    const words = q.split(/[^a-z%]+/).filter((w) => w.length > 2);
    const named = numeric.filter((c) => words.some((w) => c.label.toLowerCase().includes(w) || c.key.toLowerCase().includes(w)));
    const pick = (wantsRate ? named.find(isRate) ?? numeric.find(isRate) : undefined) ?? named.find(isRate) ?? named[0];
    if (pick) return { key: pick.key, dir: /\b(lowest|least)\b/.test(q) ? "asc" : "desc" };
  }
  if (dataset.sortedBy && cols.some((c) => c.key === dataset.sortedBy!.key)) return dataset.sortedBy;
  const date = cols.find((c) => columnKind(dataset.rows, c) === "date");
  if (date && (dataset.ordered || numeric.length === 0)) return { key: date.key, dir: "desc" };
  const rate = numeric.find(isRate);
  if (rate) return { key: rate.key, dir: "desc" };
  const main = numeric.find((c) => c.key === dataset.series[0]) ?? numeric[0];
  if (main) return { key: main.key, dir: "desc" };
  return date ? { key: date.key, dir: "desc" } : null;
}

/** Rows sorted by `sort` (nulls last); for a rate column low-volume rows go after the others. */
export function sortRows(dataset: Dataset, sort: SortState | null): Array<Record<string, Cell>> {
  if (!sort) return dataset.rows;
  const col = dataset.columns.find((c) => c.key === sort.key);
  if (!col) return dataset.rows;
  const kind = columnKind(dataset.rows, col);
  const rate = isRate(col);
  const value = (v: Cell): number | string | null =>
    v === null || v === undefined || v === "" ? null : kind === "number" ? numberValue(v) : kind === "date" ? dateValue(v) : String(v).toLowerCase();
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...dataset.rows].sort((a, b) => {
    if (rate && Boolean(a.lowVolume) !== Boolean(b.lowVolume)) return a.lowVolume ? 1 : -1;
    const x = value(a[col.key]);
    const y = value(b[col.key]);
    if (x === null || y === null) return x === null ? (y === null ? 0 : 1) : -1;
    if (typeof x === "number" && typeof y === "number") return (x - y) * sign;
    return String(x).localeCompare(String(y)) * sign;
  });
}
