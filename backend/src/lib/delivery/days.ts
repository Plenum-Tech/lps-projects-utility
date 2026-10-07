// Day numbers: whole days since 1970-01-01 for app-timezone calendar dates.
// Date-only arithmetic on integers (no DST, no timezone) once keys are derived.

const DAY_MS = 86_400_000;

/** "YYYY-MM-DD" → day number. */
export function dayFromKey(key: string): number {
  return Math.round(Date.parse(`${key}T00:00:00.000Z`) / DAY_MS);
}

/** Day number → "YYYY-MM-DD". */
export function keyFromDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday (1970-01-01 was a Thursday). */
export function weekdayOf(day: number): number {
  return (((day + 4) % 7) + 7) % 7;
}

/** Monday of the week containing `day`. */
export function mondayOfDay(day: number): number {
  return day - ((weekdayOf(day) + 6) % 7);
}
