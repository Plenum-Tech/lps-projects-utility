import type { VariantProps } from "class-variance-authority";

import { badgeVariants } from "@/components/ui/badge";
import { formatDate, formatDateOnly } from "@/lib/format";
import { dateKey } from "@/lib/time";
import type { Leave, LeaveStatus, LeaveType } from "@/types";

export const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
  annual: "Annual leave",
  sick: "Sick leave",
  personal: "Personal leave",
  unpaid: "Unpaid leave",
};

export const LEAVE_STATUS_META: Record<
  LeaveStatus,
  { label: string; variant: NonNullable<VariantProps<typeof badgeVariants>["variant"]> }
> = {
  pending: { label: "Pending", variant: "secondary" },
  approved: { label: "Approved", variant: "default" },
  rejected: { label: "Rejected", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "outline" },
};

/** Inclusive calendar days between two "YYYY-MM-DD" strings; null when either date is invalid or end precedes start. */
export function countLeaveDays(start: string, end: string): number | null {
  if (!start || !end) return null;
  const startDate = new Date(`${start}T00:00:00.000Z`);
  const endDate = new Date(`${end}T00:00:00.000Z`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return null;
  if (endDate.getTime() < startDate.getTime()) return null;
  return Math.floor((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}(T00:00:00(\.000)?Z)?$/;

/** Formats a date-only value or a timestamp in the configured date format. */
export function formatLeaveDate(value: string): string {
  return DATE_ONLY.test(value) ? formatDateOnly(value) : formatDate(value);
}

/** Name of the admin / department head who decided a request, when the API populated it. */
export function leaveDecidedByName(leave: Pick<Leave, "decidedBy">): string | null {
  const decidedBy = leave.decidedBy;
  return decidedBy && typeof decidedBy === "object" ? decidedBy.name : null;
}

/**
 * An approved leave whose first day is today or earlier. Only an admin or the
 * owner's approver may cancel it then (the API re-checks in the app timezone).
 */
export function leaveHasStarted(leave: Pick<Leave, "status" | "startDate">): boolean {
  return leave.status === "approved" && leave.startDate.slice(0, 10) <= dateKey(new Date());
}
