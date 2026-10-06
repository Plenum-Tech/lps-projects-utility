import type { DateFormat, TimeFormat, WeekStart } from "@/types";

/**
 * Settings-aware date / time formatting.
 *
 * The display settings (date format, 12h/24h, week start) come from
 * `GET /settings/public`; `AppShell` loads them before any page renders and
 * calls `setDisplaySettings`, then remounts the page when they change. Until
 * then the defaults below apply — they match the app's historic behaviour
 * (DD-MM-YYYY, 12-hour clock, weeks starting Monday).
 *
 * Timestamps are shown in the viewer's browser timezone; date-only API values
 * (UTC-midnight ISO or "YYYY-MM-DD") are read by their date part so they never
 * shift by a day.
 */
export interface DisplaySettings {
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  weekStart: WeekStart;
  /** Project budgets / rates — display only, no conversion. */
  currency: { code: string; symbol: string };
}

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  dateFormat: "DD-MM-YYYY",
  timeFormat: "12h",
  weekStart: "monday",
  currency: { code: "INR", symbol: "₹" },
};

let current: DisplaySettings = DEFAULT_DISPLAY_SETTINGS;

export function setDisplaySettings(next: Partial<DisplaySettings> | null | undefined) {
  current = {
    dateFormat: next?.dateFormat ?? DEFAULT_DISPLAY_SETTINGS.dateFormat,
    timeFormat: next?.timeFormat ?? DEFAULT_DISPLAY_SETTINGS.timeFormat,
    weekStart: next?.weekStart ?? DEFAULT_DISPLAY_SETTINGS.weekStart,
    currency: next?.currency ?? DEFAULT_DISPLAY_SETTINGS.currency,
  };
}

/** The configured currency symbol, e.g. "₹". */
export function currencySymbol(): string {
  return current.currency.symbol;
}

export function getDisplaySettings(): DisplaySettings {
  return current;
}

/** Stable string that changes whenever a display setting changes (used as a remount key). */
export function displaySettingsKey(settings: DisplaySettings = current): string {
  return `${settings.dateFormat}|${settings.timeFormat}|${settings.weekStart}|${settings.currency.code}|${settings.currency.symbol}`;
}

/** 0 = Sunday, 1 = Monday — for date-fns `weekStartsOn` and day pickers. */
export function weekStartsOn(): 0 | 1 {
  return current.weekStart === "sunday" ? 0 : 1;
}

/** date-fns pattern for the configured date format, e.g. "dd-MM-yyyy". */
export function datePattern(): string {
  switch (current.dateFormat) {
    case "MM-DD-YYYY":
      return "MM-dd-yyyy";
    case "YYYY-MM-DD":
      return "yyyy-MM-dd";
    default:
      return "dd-MM-yyyy";
  }
}

/** date-fns pattern for the configured clock, e.g. "h:mm a" or "HH:mm". */
export function timePattern(): string {
  return current.timeFormat === "24h" ? "HH:mm" : "h:mm a";
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Year / month (1-12) / day → configured date string. */
export function formatYMD(year: number | string, month: number | string, day: number | string): string {
  const y = String(year);
  const m = pad(Number(month));
  const d = pad(Number(day));
  switch (current.dateFormat) {
    case "MM-DD-YYYY":
      return `${m}-${d}-${y}`;
    case "YYYY-MM-DD":
      return `${y}-${m}-${d}`;
    default:
      return `${d}-${m}-${y}`;
  }
}

function toDate(value: Date | string | number): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Timestamp (or Date) → configured date in the viewer's timezone. */
export function formatDate(value: Date | string | number | null | undefined, fallback = "—"): string {
  if (value === null || value === undefined || value === "") return fallback;
  const date = toDate(value);
  if (!date) return fallback;
  return formatYMD(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

/** Date-only API value ("YYYY-MM-DD" or UTC-midnight ISO) → configured date, no timezone shift. */
export function formatDateOnly(value: string | null | undefined, fallback = "—"): string {
  if (!value) return fallback;
  const [year, month, day] = value.slice(0, 10).split("-");
  if (!year || !month || !day) return fallback;
  return formatYMD(year, month, day);
}

/** Timestamp → configured clock time ("9:05 AM" / "09:05"). */
export function formatTimeOfDay(value: Date | string | number | null | undefined, fallback = "—"): string {
  if (value === null || value === undefined || value === "") return fallback;
  const date = toDate(value);
  if (!date) return fallback;
  if (current.timeFormat === "24h") return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const hours = date.getHours() % 12 || 12;
  return `${hours}:${pad(date.getMinutes())} ${date.getHours() < 12 ? "AM" : "PM"}`;
}

/** Timestamp → "<date> · <time>" in the configured formats. */
export function formatDateTime(value: Date | string | number | null | undefined, fallback = "—"): string {
  if (value === null || value === undefined || value === "") return fallback;
  const date = toDate(value);
  if (!date) return fallback;
  return `${formatDate(date)} · ${formatTimeOfDay(date)}`;
}

/** Short weekday names in calendar order for the configured week start. */
export function weekdayOrder<T>(mondayFirst: readonly T[]): T[] {
  // `mondayFirst` is Mon..Sun; rotate Sunday to the front when weeks start on Sunday.
  if (weekStartsOn() === 1) return [...mondayFirst];
  return [mondayFirst[6], ...mondayFirst.slice(0, 6)];
}
