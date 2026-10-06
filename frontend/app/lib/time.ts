import { format } from "date-fns";

import { currencySymbol, formatDate, formatDateOnly, formatTimeOfDay } from "@/lib/format";

import type { TimeLogStatus, TimesheetStatus } from "@/types";

/* ------------------------------------------------------------------ */
/* Durations & money                                                   */
/* ------------------------------------------------------------------ */

/** 135 → "2h 15m", 45 → "45m", 0 → "0m". */
export function formatMinutes(minutes: number | null | undefined): string {
  const total = Math.max(0, Math.round(minutes ?? 0));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

/** 135 → "2.25" (decimal hours, for tables and charts). */
export function minutesToHours(minutes: number, digits = 2): number {
  return Number((minutes / 60).toFixed(digits));
}

/** Elapsed seconds → "01:02:03". */
export function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((part) => String(part).padStart(2, "0")).join(":");
}

const currency = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** Single app currency (Settings → App) — symbol + grouped number, no conversion. */
export function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${currencySymbol()}${currency.format(value)}`;
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

/** Local calendar date as "YYYY-MM-DD". */
export function dateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Parses "YYYY-MM-DD" as a local date (no timezone shift). */
export function parseDateKey(key: string): Date {
  const [year, month, day] = key.slice(0, 10).split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}

/** Adds days to a "YYYY-MM-DD" key. */
export function addDaysKey(key: string, days: number): string {
  const date = parseDateKey(key);
  date.setDate(date.getDate() + days);
  return dateKey(date);
}

/** Monday of the week containing `key` (or today). */
export function mondayOf(key?: string): string {
  const date = key ? parseDateKey(key) : new Date();
  const weekday = (date.getDay() + 6) % 7; // Mon = 0
  date.setDate(date.getDate() - weekday);
  return dateKey(date);
}

/** First day of the current month as "YYYY-MM-DD". */
export function monthStartKey(): string {
  const now = new Date();
  return dateKey(new Date(now.getFullYear(), now.getMonth(), 1));
}

/** "Mon 6" style label for a date key. */
export function formatDayLabel(key: string): { weekday: string; day: string } {
  const date = parseDateKey(key);
  return {
    weekday: date.toLocaleDateString("en-US", { weekday: "short" }),
    day: date.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  };
}

/** "Oct 6 – Oct 12, 2026" for a week starting on `mondayKey`. */
export function formatWeekRange(mondayKey: string): string {
  const start = parseDateKey(mondayKey);
  const end = parseDateKey(addDaysKey(mondayKey, 6));
  const startLabel = start.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const endLabel = end.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${startLabel} – ${endLabel}`;
}

/** Local time in the configured clock ("9:05 AM" / "09:05"). */
export function formatTime(iso: string): string {
  return formatTimeOfDay(iso);
}

/** Local date in the configured date format. */
export function formatLocalDate(iso: string): string {
  return formatDate(iso);
}

/** ISO → value for <input type="datetime-local">. */
export function toDateTimeInput(iso: string | Date): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

/** <input type="datetime-local"> value → ISO (interpreted in local time). */
export function fromDateTimeInput(value: string): string {
  return new Date(value).toISOString();
}

/* ------------------------------------------------------------------ */
/* Status metadata (theme tokens only)                                 */
/* ------------------------------------------------------------------ */

export const TIMELOG_STATUS_META: Record<
  TimeLogStatus,
  { label: string; dot: string; badge: "default" | "secondary" | "destructive" | "outline" }
> = {
  pending: { label: "Pending", dot: "bg-chart-4", badge: "outline" },
  approved: { label: "Approved", dot: "bg-primary", badge: "secondary" },
  rejected: { label: "Rejected", dot: "bg-destructive", badge: "destructive" },
};

export const TIMESHEET_STATUS_META: Record<
  TimesheetStatus,
  { label: string; dot: string; badge: "default" | "secondary" | "destructive" | "outline" }
> = {
  draft: { label: "Draft", dot: "bg-muted-foreground", badge: "outline" },
  submitted: { label: "Submitted", dot: "bg-chart-4", badge: "default" },
  approved: { label: "Approved", dot: "bg-primary", badge: "secondary" },
  rejected: { label: "Rejected", dot: "bg-destructive", badge: "destructive" },
};

/** Elapsed seconds of a running/paused timer, excluding breaks. */
export function timerElapsedSeconds(
  timer: { startTime: string; breaks: { startTime: string; endTime: string | null }[] },
  now = Date.now()
): number {
  const start = new Date(timer.startTime).getTime();
  let breakMs = 0;
  for (const brk of timer.breaks) {
    const bStart = new Date(brk.startTime).getTime();
    const bEnd = brk.endTime ? new Date(brk.endTime).getTime() : now;
    breakMs += Math.max(0, bEnd - bStart);
  }
  return Math.max(0, (now - start - breakMs) / 1000);
}

/**
 * Date-only API value (UTC-midnight ISO or "YYYY-MM-DD") → the configured
 * date format, or a custom date-fns `pattern` (e.g. "d MMM" for compact,
 * year-less labels). Reads the date part only, so it never shifts by the
 * browser timezone.
 */
export function formatPlainDate(value: string | null | undefined, pattern?: string): string {
  if (!value) return "—";
  if (!pattern) return formatDateOnly(value);
  return format(parseDateKey(value.slice(0, 10)), pattern);
}
