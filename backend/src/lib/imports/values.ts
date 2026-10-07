import type { DateFormat } from "../../models/CompanySettings.js";
import type { TaskPriority, TaskStatus } from "../../models/Task.js";
import type { ProgressMode } from "../../models/Project.js";
import { appDateKey } from "../taskJobs.js";
import { cellText, type CellValue } from "./parse.js";

// ---------------------------------------------------------------------------
// Cell value conversions for imports. Each returns the parsed value, null for
// an empty cell, or `{ error }` with a user-facing reason.
// ---------------------------------------------------------------------------

export interface ValueError {
  error: string;
}

export function isValueError(v: unknown): v is ValueError {
  return typeof v === "object" && v !== null && "error" in v && !(v instanceof Date);
}

export function text(v: CellValue | undefined): string {
  return cellText(v ?? null).trim();
}

/** Splits "a, b; c" (and line breaks) into unique trimmed items. */
export function list(v: CellValue | undefined, separators = /[,;\n\r]+/): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text(v).split(separators)) {
    const item = part.trim();
    if (item && !seen.has(item.toLowerCase())) {
      seen.add(item.toLowerCase());
      out.push(item);
    }
  }
  return out;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function ymd(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** Excel serial day number (1900 date system) → "YYYY-MM-DD". */
function fromSerial(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 109_574) return null; // up to 2199-12-31
  const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000);
  return date.toISOString().slice(0, 10);
}

/**
 * Date-only value → "YYYY-MM-DD" (stored as UTC midnight like every date-only
 * field). Accepts Excel dates and serials, YYYY-MM-DD, DD-MM-YYYY (or
 * MM-DD-YYYY when that is the configured format), "15 Jan 2026", "Jan 15, 2026"
 * and ISO date-times (converted to the app-timezone calendar date).
 */
export function dateOnly(v: CellValue | undefined, format: DateFormat): string | null | ValueError {
  if (v === null || v === undefined || (typeof v === "string" && !v.trim())) return null;
  const bad = { error: `"${text(v).slice(0, 40)}" is not a valid date` };
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return bad;
    return ymd(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate()) ?? bad;
  }
  if (typeof v === "number") return fromSerial(v) ?? bad;
  if (typeof v === "boolean") return bad;
  const s = v.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return ymd(+m[1]!, +m[2]!, +m[3]!) ?? bad;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) {
    const a = +m[1]!;
    const b = +m[2]!;
    const y = +m[3]!;
    const preferMdy = format === "MM-DD-YYYY";
    return (preferMdy ? ymd(y, a, b) ?? ymd(y, b, a) : ymd(y, b, a) ?? ymd(y, a, b)) ?? bad;
  }
  m = /^(\d{1,2})[\s-]+([a-z]{3,9})\.?[\s,-]+(\d{4})$/i.exec(s);
  if (m) {
    const month = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()) + 1;
    return month ? ymd(+m[3]!, month, +m[1]!) ?? bad : bad;
  }
  m = /^([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(s);
  if (m) {
    const month = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1;
    return month ? ymd(+m[3]!, month, +m[2]!) ?? bad : bad;
  }
  if (/^\d{5}(\.\d+)?$/.test(s)) return fromSerial(Number(s)) ?? bad;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    const instant = new Date(s);
    return Number.isNaN(instant.getTime()) ? bad : appDateKey(instant);
  }
  return bad;
}

/** Non-negative number ("1,250", "$300", "12.5"), capped at `max`. */
export function number(v: CellValue | undefined, label: string, max: number): number | null | ValueError {
  if (v === null || v === undefined || (typeof v === "string" && !v.trim())) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[\s,$€£₹]/g, ""));
  if (!Number.isFinite(n) || n < 0 || n > max) return { error: `${label} must be a number between 0 and ${max}` };
  return Math.round(n * 100) / 100;
}

export function bool(v: CellValue | undefined, label: string): boolean | null | ValueError {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  const s = text(v).toLowerCase();
  if (!s) return null;
  if (["yes", "y", "true", "1", "public"].includes(s)) return true;
  if (["no", "n", "false", "0", "private"].includes(s)) return false;
  return { error: `${label} must be yes/no/true/false/1/0` };
}

/** "2h 30m", "2.5" (hours), "150m", "2:30", "90 mins", "1.5 hours" → minutes. */
export function estimateMinutes(v: CellValue | undefined, max: number): number | null | ValueError {
  if (v === null || v === undefined || (typeof v === "string" && !v.trim())) return null;
  const bad = { error: `Estimate "${text(v).slice(0, 30)}" is not valid (use 2h 30m, 2.5 or 150m)` };
  let minutes: number | null = null;
  if (typeof v === "number") minutes = v * 60;
  else {
    const s = text(v).toLowerCase().replace(/\s+/g, " ");
    let m: RegExpExecArray | null;
    if (/^\d+(\.\d+)?$/.test(s)) minutes = Number(s) * 60;
    else if ((m = /^(\d+):(\d{1,2})$/.exec(s))) minutes = +m[1]! * 60 + +m[2]!;
    else if ((m = /^(?:(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours))?\s*(?:(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes))?$/.exec(s)) && (m[1] || m[2])) {
      minutes = (m[1] ? Number(m[1]) * 60 : 0) + (m[2] ? Number(m[2]) : 0);
    }
  }
  if (minutes === null || !Number.isFinite(minutes) || minutes < 0) return bad;
  const rounded = Math.round(minutes);
  if (rounded > max) return { error: `Estimate must be at most ${max / 60} hours` };
  return rounded;
}

function key(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const TASK_STATUS_ALIASES: Record<string, TaskStatus> = {
  todo: "todo", incomplete: "todo", pending: "todo", open: "todo", notstarted: "todo", new: "todo", backlog: "todo",
  inprogress: "in_progress", doing: "in_progress", started: "in_progress", wip: "in_progress", working: "in_progress", ongoing: "in_progress",
  inreview: "in_review", review: "in_review", underreview: "in_review", awaitingreview: "in_review", pendingreview: "in_review", waitingapproval: "in_review",
  completed: "completed", complete: "completed", done: "completed", finished: "completed", closed: "completed",
  rejected: "rejected", declined: "rejected", cancelled: "rejected", canceled: "rejected",
};

export function taskStatus(raw: string): TaskStatus | null {
  return TASK_STATUS_ALIASES[key(raw)] ?? null;
}

const PRIORITY_ALIASES: Record<string, TaskPriority> = {
  low: "low", lowest: "low", minor: "low",
  medium: "medium", normal: "medium", moderate: "medium", med: "medium",
  high: "high", major: "high",
  urgent: "urgent", critical: "urgent", highest: "urgent", blocker: "urgent",
};

export function priority(raw: string): TaskPriority | null {
  return PRIORITY_ALIASES[key(raw)] ?? null;
}

const PROGRESS_ALIASES: Record<string, ProgressMode> = {
  manual: "manual", manually: "manual",
  taskcompletion: "task_completion", tasks: "task_completion", task: "task_completion", taskprogress: "task_completion", auto: "task_completion",
  totaltime: "total_time", time: "total_time", hours: "total_time", timelogged: "total_time",
  deadline: "deadline", date: "deadline", projectdeadline: "deadline",
};

export function progressMode(raw: string): ProgressMode | null {
  return PROGRESS_ALIASES[key(raw)] ?? null;
}

/** Project status name comparison key ("Canceled" ≡ "Cancelled", "Not Started" ≡ "not started"). */
export function statusKey(raw: string): string {
  return key(raw).replace(/canceled/, "cancelled").replace(/complete$/, "completed");
}

/** "Website Redesign 2026" → "WR2026"-style code candidate (2-10 A-Z0-9). */
export function codeFromName(name: string): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  let code = words.length > 1 ? words.map((w) => (/^\d+$/.test(w) ? w : w[0])).join("") : (words[0] ?? "");
  if (code.length < 2) code = (words.join("") + "PRJ").slice(0, 3);
  return code.slice(0, 10);
}
