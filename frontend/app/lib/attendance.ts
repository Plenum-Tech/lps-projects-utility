import { formatDateOnly, formatTimeOfDay, formatYMD } from "@/lib/format";
import type { AttendanceStatus } from "@/types";

/** Fixed attendance statuses — mirrors the backend enum. */
export const ATTENDANCE_STATUSES: AttendanceStatus[] = [
  "present",
  "absent",
  "late",
  "half_day",
  "on_leave",
];

/** Human-readable labels for each attendance status. */
export const ATTENDANCE_STATUS_LABELS: Record<AttendanceStatus, string> = {
  present: "Present",
  absent: "Absent",
  late: "Late",
  half_day: "Half Day",
  on_leave: "On Leave",
};

/**
 * Badge variant and display metadata for each attendance status.
 * Uses shadcn badge variant names for consistent styling.
 */
export const ATTENDANCE_STATUS_META: Record<
  AttendanceStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  present: { label: "Present", variant: "default" },
  absent: { label: "Absent", variant: "destructive" },
  late: { label: "Late", variant: "secondary" },
  half_day: { label: "Half Day", variant: "outline" },
  on_leave: { label: "On Leave", variant: "secondary" },
};

/** Formats a date string (YYYY-MM-DD or ISO) for display. */
export function formatAttendanceDate(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date.slice(0, 10) + "T00:00:00.000Z") : date;
  const weekday = d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const formatted =
    typeof date === "string"
      ? formatDateOnly(date)
      : formatYMD(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  return `${weekday}, ${formatted}`;
}

/** Formats a time string or ISO datetime for display (e.g. "9:00 AM"). */
export function formatTime(value: string | null | undefined): string {
  return formatTimeOfDay(value);
}

/** Returns today's date as YYYY-MM-DD in UTC. */
export function todayString(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
}

/** Returns the first day of the current month as YYYY-MM-DD. */
export function startOfMonthString(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}
