import { addDays, appDateKey, appTimeZone, appToday } from "./taskJobs.js";

// ---------------------------------------------------------------------------
// Wall-clock helpers in APP_TIMEZONE. Instants are stored in UTC; date-only
// values (week starts, entry dates) are stored as UTC midnight of the calendar
// date — the same convention as task due dates.
// ---------------------------------------------------------------------------

export { addDays, appDateKey, appTimeZone, appToday };

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Calendar/clock parts of `date` in the app timezone. */
export function zonedParts(date: Date): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: appTimeZone(),
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
  };
}

/** Offset (ms) of the app timezone from UTC at `date` (e.g. +5:30 → 19_800_000). */
function offsetMs(date: Date): number {
  const p = zonedParts(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** UTC instant of a wall-clock time in the app timezone. */
export function zonedToUtc(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let result = guess - offsetMs(new Date(guess));
  // Second pass corrects for DST transitions between the guess and the result.
  result = guess - offsetMs(new Date(result));
  return new Date(result);
}

/** UTC instant of 00:00 (app timezone) on the calendar date `key` ("YYYY-MM-DD") or date-only Date. */
export function appDayStart(day: string | Date): Date {
  const key = typeof day === "string" ? day : day.toISOString().slice(0, 10);
  const [y, m, d] = key.split("-").map(Number);
  return zonedToUtc(y!, m!, d!);
}

/** UTC instant of "HH:mm" (app timezone) on a calendar date. */
export function appTimeOn(day: string | Date, hhmm: string): Date {
  const key = typeof day === "string" ? day : day.toISOString().slice(0, 10);
  const [y, m, d] = key.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  return zonedToUtc(y!, m!, d!, h!, mi!);
}

/** Minutes since local midnight (app timezone). */
export function appMinutesOfDay(now: Date = new Date()): number {
  const p = zonedParts(now);
  return p.hour * 60 + p.minute;
}

/** "HH:mm" → minutes since midnight (null when invalid). */
export function parseHhmm(value: unknown): number | null {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [h, m] = value.split(":").map(Number);
  return h! * 60 + m!;
}

/** True on Saturday/Sunday in the app timezone. */
export function isAppWeekend(now: Date = new Date()): boolean {
  const day = zonedParts(now).weekday;
  return day === 0 || day === 6;
}

/** Monday (date-only, UTC midnight) of the week containing the date-only value `day`. */
export function mondayOf(day: Date): Date {
  const dow = day.getUTCDay(); // date-only values: UTC day == calendar day
  return addDays(day, dow === 0 ? -6 : 1 - dow);
}

/** Monday of the current week in the app timezone. */
export function currentWeekStart(now: Date = new Date()): Date {
  return mondayOf(appToday(now));
}

/** Calendar date key of an instant in the app timezone. */
export function instantDateKey(date: Date): string {
  return appDateKey(date);
}
