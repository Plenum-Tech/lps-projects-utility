import mongoose from "mongoose";
import type { IUser } from "../models/User.js";
import { User } from "../models/User.js";
import { parseDateOnly } from "./taskAccess.js";

// ---------------------------------------------------------------------------
// HR profile fields, visibility rules and date-only helpers shared by the users
// controller, the personal dashboard, employee documents and the HR job.
// Date-only values are stored as UTC midnight of the calendar date; "today" is
// always `appToday()` (APP_TIMEZONE).
// ---------------------------------------------------------------------------

export const HR_DATE_FIELDS = [
  "dateOfBirth",
  "joiningDate",
  "probationEndDate",
  "internshipEndDate",
  "noticePeriodStart",
  "noticePeriodEnd",
] as const;
export type HrDateField = (typeof HR_DATE_FIELDS)[number];

/** Dates only the person, their department head and admins may see. */
export const RESTRICTED_HR_FIELDS = [
  "probationEndDate",
  "internshipEndDate",
  "noticePeriodStart",
  "noticePeriodEnd",
] as const;

export const HR_LIMITS = { designationMax: 100, employeeIdMax: 30 } as const;
const EMPLOYEE_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._\-/ ]*$/;

const MS_PER_DAY = 86_400_000;

/** Whole days from date-only `from` to date-only `to` (negative when `to` is earlier). */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Month/day of `date` in `year` — 29 Feb falls on 28 Feb in non-leap years. */
export function anniversaryIn(date: Date, year: number): Date {
  const month = date.getUTCMonth();
  let day = date.getUTCDate();
  if (month === 1 && day === 29 && !isLeapYear(year)) day = 28;
  return new Date(Date.UTC(year, month, day));
}

/** Next occurrence (today or later) of a yearly date such as a birthday. */
export function nextAnniversary(date: Date, today: Date): Date {
  const thisYear = anniversaryIn(date, today.getUTCFullYear());
  return thisYear.getTime() >= today.getTime() ? thisYear : anniversaryIn(date, today.getUTCFullYear() + 1);
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

export type HrScope = "all" | "department" | "self";

/** Which colleagues' restricted HR data (dates, documents) `viewer` may see. */
export function hrScopeOf(viewer: Pick<IUser, "role" | "department">): HrScope {
  if (viewer.role === "admin") return "all";
  if (viewer.role === "head" && viewer.department) return "department";
  return "self";
}

/** True when `viewer` may see `target`'s restricted HR dates and documents. */
export function canViewHrOf(
  viewer: Pick<IUser, "_id" | "role" | "department">,
  target: { _id: mongoose.Types.ObjectId | string; department?: mongoose.Types.ObjectId | null }
): boolean {
  if (viewer._id.toString() === target._id.toString()) return true;
  const scope = hrScopeOf(viewer);
  if (scope === "all") return true;
  if (scope === "department") {
    return Boolean(
      target.department && viewer.department && target.department.toString() === viewer.department.toString()
    );
  }
  return false;
}

/** Ids of the heads of a department (role "head" with that department). */
export async function departmentHeadIds(
  department: mongoose.Types.ObjectId | null | undefined
): Promise<mongoose.Types.ObjectId[]> {
  if (!department) return [];
  const heads = await User.find({ role: "head", department }).select("_id").lean();
  return heads.map((h) => h._id as mongoose.Types.ObjectId);
}

/** "Jane Doe" → "JD" (max 2 letters). */
export function initialsOf(name: string | undefined | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const letters =
    parts.length === 1 ? parts[0]!.slice(0, 2) : `${parts[0]![0]}${parts[parts.length - 1]![0]}`;
  return letters.toUpperCase();
}

// ---------------------------------------------------------------------------
// Body parsing (admin create/update user)
// ---------------------------------------------------------------------------

export interface HrFieldUpdates {
  designation?: string;
  /** undefined = untouched / auto on create. */
  employeeId?: string;
  dates: Partial<Record<HrDateField, Date | null>>;
  changed: string[];
}

/** Accepts "YYYY-MM-DD" (or a full ISO string — only the date part is used) or null. */
function parseDateInput(raw: unknown): Date | null | undefined | "invalid" {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string") return "invalid";
  const value = /^\d{4}-\d{2}-\d{2}T/.test(raw) ? raw.slice(0, 10) : raw;
  return parseDateOnly(value) ?? "invalid";
}

/**
 * Validates the HR fields of a create/update body. `current` = the stored user
 * (for cross-field checks such as notice end >= start). Returns an error string
 * or the parsed updates.
 */
export function parseHrFields(
  body: Record<string, unknown>,
  current?: Partial<Record<HrDateField, Date | null>>,
  options: { creating?: boolean } = {}
): HrFieldUpdates | string {
  const result: HrFieldUpdates = { dates: {}, changed: [] };

  if (body.designation !== undefined) {
    if (body.designation !== null && typeof body.designation !== "string") return "designation must be a string";
    const value = ((body.designation as string | null) ?? "").trim();
    if (value.length > HR_LIMITS.designationMax) {
      return `designation must be at most ${HR_LIMITS.designationMax} characters`;
    }
    result.designation = value;
    result.changed.push("designation");
  }

  if (body.employeeId !== undefined) {
    const raw = body.employeeId;
    const value = typeof raw === "string" ? raw.trim() : raw;
    if (value === null || value === "") {
      // Blank on create = auto sequence; an existing ID can't be cleared.
      if (!options.creating) return "employeeId cannot be empty";
    } else {
      if (typeof value !== "string") return "employeeId must be a string";
      if (value.length > HR_LIMITS.employeeIdMax) {
        return `employeeId must be at most ${HR_LIMITS.employeeIdMax} characters`;
      }
      if (!EMPLOYEE_ID_REGEX.test(value)) return "employeeId may contain letters, digits, spaces and . _ - /";
      result.employeeId = value;
      result.changed.push("employeeId");
    }
  }

  for (const field of HR_DATE_FIELDS) {
    const parsed = parseDateInput(body[field]);
    if (parsed === undefined) continue;
    if (parsed === "invalid") return `${field} must be a date (YYYY-MM-DD) or null`;
    result.dates[field] = parsed;
    result.changed.push(field);
  }

  const next = (field: HrDateField): Date | null =>
    field in result.dates ? (result.dates[field] ?? null) : (current?.[field] ?? null);

  const dob = result.dates.dateOfBirth;
  if (dob && dob.getTime() > Date.now()) return "dateOfBirth cannot be in the future";
  const start = next("noticePeriodStart");
  const end = next("noticePeriodEnd");
  if (start && end && end.getTime() < start.getTime()) {
    return "noticePeriodEnd must be on or after noticePeriodStart";
  }

  return result;
}

/** Applies parsed HR updates to a user document (save separately). */
export function applyHrFields(user: IUser, updates: HrFieldUpdates): void {
  if (updates.designation !== undefined) user.designation = updates.designation;
  if (updates.employeeId !== undefined) user.employeeId = updates.employeeId;
  for (const field of HR_DATE_FIELDS) {
    if (field in updates.dates) user[field] = updates.dates[field] ?? null;
  }
}

/** True for a duplicate-key error on the employeeId index (vs. the email index). */
export function isEmployeeIdConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { keyPattern?: Record<string, unknown>; message?: string };
  return Boolean(e.keyPattern?.employeeId) || /employeeId/.test(e.message ?? "");
}
