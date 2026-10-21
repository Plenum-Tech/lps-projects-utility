import type { Request, Response } from "express";
import mongoose from "mongoose";
import { logActivity } from "../lib/activityLog.js";
import { appToday } from "../lib/appTime.js";
import { notify, notifyUsers } from "../lib/notifications.js";
import { getPolicies, policyFor } from "../lib/leavePolicies.js";
import { parsePagination, searchRegex } from "../lib/pagination.js";
import { pushToUsers, createEvent } from "../lib/sse.js";
import { Leave } from "../models/Leave.js";
import type { ILeave } from "../models/Leave.js";
import {
  BALANCE_TRACKED_TYPES,
  LEAVE_STATUSES,
  LEAVE_TYPES,
  type BalanceTrackedType,
  type LeaveStatus,
  type LeaveType,
} from "../models/LeaveType.js";
import type { IUser, LeaveBalance } from "../models/User.js";
import { STAFF_FILTER, User } from "../models/User.js";

const MS_PER_DAY = 86_400_000;

interface CreateLeaveBody {
  leaveType?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  reason?: unknown;
}

interface DecideLeaveBody {
  decision?: unknown;
  note?: unknown;
}

interface AdjustBalanceBody {
  leaveType?: unknown;
  days?: unknown;
}

function isInvalidObjectId(id: string): boolean {
  return !mongoose.isValidObjectId(id);
}

/** Express 5 types params as `string | string[] | undefined` — normalize to a single value. */
function param(req: Request, name: string): string | undefined {
  const value = req.params[name];
  return typeof value === "string" ? value : undefined;
}

async function getLeaveOr404(req: Request, res: Response): Promise<ILeave | undefined> {
  const id = param(req, "id");
  if (!id || isInvalidObjectId(id)) {
    res.status(404).json({ error: "Leave request not found" });
    return undefined;
  }
  const leave = await Leave.findById(id);
  if (!leave) {
    res.status(404).json({ error: "Leave request not found" });
    return undefined;
  }
  return leave;
}

/** Parses a "YYYY-MM-DD" string as a UTC-midnight date; null when invalid or impossible. */
function parseDateOnly(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  // Reject dates like 2026-02-31 that roll over silently.
  if (date.toISOString().slice(0, 10) !== value) return null;
  return date;
}

/** Inclusive calendar days between two UTC-midnight dates. */
function countDays(start: Date, end: Date): number {
  return Math.floor((end.getTime() - start.getTime()) / MS_PER_DAY) + 1;
}

function todayUtc(): Date {
  const today = new Date();
  return new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
}

function currentYear(): number {
  return new Date().getFullYear();
}

function isBalanceTracked(type: LeaveType): type is BalanceTrackedType {
  return (BALANCE_TRACKED_TYPES as readonly LeaveType[]).includes(type);
}

/** Returns the user's current-year balance, lazily resetting from policy entitlements after a year rollover. */
async function getBalance(user: IUser, policies: Awaited<ReturnType<typeof getPolicies>>): Promise<LeaveBalance> {
  const year = currentYear();
  const current = user.leaveBalance;
  if (current && current.year === year) {
    return { year, annual: current.annual, sick: current.sick, personal: current.personal };
  }

  const balance: LeaveBalance = { year, annual: 0, sick: 0, personal: 0 };
  for (const type of BALANCE_TRACKED_TYPES) {
    balance[type] = policyFor(policies, type)?.maxDaysPerYear ?? 0;
  }
  user.leaveBalance = balance;
  await user.save();
  return balance;
}

/** Adds `delta` days to the user's current-year balance for a tracked type and persists it. */
async function applyBalanceDelta(
  user: IUser,
  policies: Awaited<ReturnType<typeof getPolicies>>,
  type: BalanceTrackedType,
  delta: number
): Promise<LeaveBalance> {
  const balance = await getBalance(user, policies);
  balance[type] = Math.max(0, balance[type] + delta);
  user.leaveBalance = balance;
  await user.save();
  return balance;
}

// ---------------------------------------------------------------------------
// Review scope — admins review everyone; a department head reviews only the
// employees of their own department (never their own, another head's or an
// admin's request — those go to an admin).
// ---------------------------------------------------------------------------

type LeaveOwner = Pick<IUser, "_id" | "role" | "department">;

/** True when `actor` may view and approve/reject `owner`'s leave requests. */
function canReviewLeavesOf(actor: IUser, owner: LeaveOwner): boolean {
  if (actor.role === "admin") return true;
  if (actor.role !== "head" || !actor.department) return false;
  if (owner._id.equals(actor._id)) return false;
  return owner.role === "employee" && !!owner.department && owner.department.equals(actor.department);
}

/** Mongo user filter for the people a non-admin reviewer may see; null = everyone (admin). */
function reviewableUsersFilter(actor: IUser): Record<string, unknown> | null {
  if (actor.role === "admin") return null;
  if (actor.role !== "head" || !actor.department) return { _id: { $in: [] } };
  return { department: actor.department, role: "employee", _id: { $ne: actor._id } };
}

/** Everyone who may decide `owner`'s requests: admins + (for employees) their department's heads. */
async function leaveReviewerIds(owner: LeaveOwner): Promise<mongoose.Types.ObjectId[]> {
  const or: Record<string, unknown>[] = [{ role: "admin" }];
  if (owner.role === "employee" && owner.department) {
    or.push({ role: "head", department: owner.department });
  }
  const reviewers = await User.find({ $or: or, _id: { $ne: owner._id } }).select("_id").lean();
  return reviewers.map((reviewer) => reviewer._id);
}

/** Fire-and-forget: pushes a `leave-updated` SSE event to `extraUserIds` plus every reviewer of `owner`. */
function broadcastLeaveUpdate(
  owner: LeaveOwner | null,
  extraUserIds: string[],
  payload: Record<string, unknown>
): void {
  void (owner ? leaveReviewerIds(owner) : Promise.resolve([] as mongoose.Types.ObjectId[]))
    .then((reviewerIds) => {
      const ids = [...new Set([...extraUserIds, ...reviewerIds.map((id) => id.toString())])];
      if (ids.length > 0) pushToUsers(ids, createEvent("leave-updated", payload));
    })
    .catch((err) => {
      console.error("[leaves] Failed to broadcast leave update:", err);
    });
}

/** Fire-and-forget: in-app notification + email (emailPreferences.leaveRequests) to the applicant's reviewers. */
function notifyLeaveReviewers(applicant: IUser, leave: ILeave): void {
  const startLabel = leave.startDate.toISOString().slice(0, 10);
  const endLabel = leave.endDate.toISOString().slice(0, 10);
  const typeLabel = leave.leaveType.charAt(0).toUpperCase() + leave.leaveType.slice(1);
  void leaveReviewerIds(applicant)
    .then((reviewerIds) => {
      if (reviewerIds.length === 0) return;
      notifyUsers({
        recipients: reviewerIds,
        actor: applicant,
        type: "leave_requested",
        title: "New leave request",
        message: `${applicant.name} requested ${leave.days} day(s) of ${leave.leaveType} leave (${startLabel} → ${endLabel}).`,
        link: "/leaves?tab=team",
        email: {
          subject: `Leave request from ${applicant.name}`,
          heading: "New Leave Request",
          intro: `${applicant.name} applied for leave and is waiting for a decision.`,
          rows: [
            ["Employee", applicant.name],
            ["Leave type", typeLabel],
            ["Dates", `${startLabel} → ${endLabel}`],
            ["Days", String(leave.days)],
          ],
          quote: leave.reason,
          quoteAuthor: applicant.name,
          buttonLabel: "Review request",
        },
      });
    })
    .catch((err) => {
      console.error("[leaves] Failed to notify leave reviewers:", err);
    });
}

/** Any authenticated user (admins included): applies for leave. */
export async function createLeave(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const { leaveType, startDate, endDate, reason } = (req.body ?? {}) as CreateLeaveBody;

  if (typeof leaveType !== "string" || !LEAVE_TYPES.includes(leaveType as LeaveType)) {
    res.status(400).json({
      error: "leaveType must be one of: annual, sick, personal, unpaid",
    });
    return;
  }
  const type = leaveType as LeaveType;

  const start = parseDateOnly(startDate);
  const end = parseDateOnly(endDate);
  if (!start || !end) {
    res.status(400).json({ error: "startDate and endDate must be valid dates (YYYY-MM-DD)" });
    return;
  }
  if (end.getTime() < start.getTime()) {
    res.status(400).json({ error: "endDate must be on or after startDate" });
    return;
  }
  if (start.getTime() < todayUtc().getTime()) {
    res.status(400).json({ error: "Leave cannot start in the past" });
    return;
  }
  if (typeof reason !== "string" || !reason.trim()) {
    res.status(400).json({ error: "reason is required" });
    return;
  }

  const days = countDays(start, end);
  const policies = await getPolicies();
  const policy = policyFor(policies, type);
  if (!policy) {
    res.status(400).json({ error: "No leave policy is configured for this type" });
    return;
  }
  if (days > policy.maxDaysPerRequest) {
    res.status(400).json({
      error: `Leave requests of this type are limited to ${policy.maxDaysPerRequest} day(s) per request`,
    });
    return;
  }

  if (isBalanceTracked(type)) {
    const balance = await getBalance(user, policies);
    if (days > balance[type]) {
      res.status(400).json({
        error: `Insufficient ${type} leave balance (${balance[type]} day(s) left)`,
      });
      return;
    }
  }

  // No overlapping pending/approved requests (prevents double-booking).
  const overlap = await Leave.findOne({
    user: user._id,
    status: { $in: ["pending", "approved"] },
    startDate: { $lte: end },
    endDate: { $gte: start },
  });
  if (overlap) {
    res.status(400).json({
      error: "You already have a pending or approved request overlapping these dates",
    });
    return;
  }

  const leave = await Leave.create({
    user: user._id,
    leaveType: type,
    startDate: start,
    endDate: end,
    days,
    reason: reason.trim(),
    status: "pending",
  });

  logActivity({
    action: "leave_created",
    actor: user,
    targetType: "leave",
    targetId: leave._id,
    targetName: `${type} leave`,
    details: { leaveType: type, days },
    ip: req.ip,
  });

  // Real-time refresh + notification for everyone who may decide it: admins
  // and (for employees) the head of the applicant's department.
  broadcastLeaveUpdate(user, [], {
    leaveId: leave._id,
    action: "created",
    leaveType: type,
    days,
    status: "pending",
    requestedBy: user.name,
  });
  notifyLeaveReviewers(user, leave);

  res.status(201).json({ leave: leave.toJSON() });
}

/** Any authenticated user: their own requests, newest first, with optional search + pagination. */
export async function myLeaves(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const { limit, offset } = parsePagination(req);
  const search = searchRegex(req.query.search);

  const filter: Record<string, unknown> = { user: user._id };
  if (search) {
    filter.$or = [{ leaveType: search }, { status: search }, { reason: search }];
  }

  let query = Leave.find(filter)
    .populate("user", "name email")
    .populate("decidedBy", "name")
    .sort({ createdAt: -1 });
  if (limit !== null) {
    query = query.skip(offset).limit(limit);
  }

  const [leaves, total] = await Promise.all([query, Leave.countDocuments(filter)]);
  res.json({ leaves: leaves.map((leave) => leave.toJSON()), total, limit, offset });
}

/** Any authenticated user: their current-year leave balance. */
export async function myBalance(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const policies = await getPolicies();
  const balance = await getBalance(user, policies);
  res.json({ balance });
}

/**
 * Admin: all requests. Head: requests of the employees in their own department
 * (not their own, nor other heads' / admins'). Optional status filter, employee
 * search and pagination.
 */
export async function listLeaves(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const status = req.query.status;
  const { limit, offset } = parsePagination(req);
  const search = searchRegex(req.query.search);

  const filter: Record<string, unknown> = {};
  if (status !== undefined) {
    if (typeof status !== "string" || !LEAVE_STATUSES.includes(status as LeaveStatus)) {
      res.status(400).json({
        error: "status must be one of: pending, approved, rejected, cancelled",
      });
      return;
    }
    filter.status = status;
  }

  const scope = reviewableUsersFilter(actor);
  if (search || scope) {
    // Search / scope over the populated employee — population can't be filtered
    // directly, so resolve matching user ids first, then narrow the leaves by them.
    const userFilter: Record<string, unknown> = { ...(scope ?? {}) };
    if (search) userFilter.$or = [{ name: search }, { email: search }];
    const matchingUsers = await User.find(userFilter).select("_id");
    const ids = matchingUsers.map((user) => user._id);
    if (ids.length === 0) {
      res.json({ leaves: [], total: 0, limit, offset });
      return;
    }
    filter.user = { $in: ids };
  }

  let query = Leave.find(filter)
    .populate("user", "name email")
    .populate("decidedBy", "name")
    .sort({ createdAt: -1 });
  if (limit !== null) {
    query = query.skip(offset).limit(limit);
  }

  const [leaves, total] = await Promise.all([query, Leave.countDocuments(filter)]);
  res.json({ leaves: leaves.map((leave) => leave.toJSON()), total, limit, offset });
}

/**
 * Admin, or the head of the requester's department (employees only — a head's
 * own request needs an admin): approves or rejects a pending request. Approval
 * deducts the balance exactly once (the pending → decided transition is atomic).
 */
export async function decideLeave(req: Request, res: Response): Promise<void> {
  const leave = await getLeaveOr404(req, res);
  if (!leave) return;
  const actor = req.user!;

  const owner = await User.findById(leave.user);
  const allowed = owner ? canReviewLeavesOf(actor, owner) : actor.role === "admin";
  if (!allowed) {
    res.status(403).json({
      error:
        owner && owner._id.equals(actor._id)
          ? "Your own leave requests must be decided by an admin"
          : "You can only decide leave requests of employees in your department",
    });
    return;
  }

  const { decision, note } = (req.body ?? {}) as DecideLeaveBody;
  if (decision !== "approved" && decision !== "rejected") {
    res.status(400).json({ error: "decision must be approved or rejected" });
    return;
  }
  if (note !== undefined && (typeof note !== "string" || note.trim().length > 500)) {
    res.status(400).json({ error: "note must be a short string" });
    return;
  }
  if (leave.status !== "pending") {
    res.status(400).json({ error: "Only pending requests can be decided" });
    return;
  }

  const isApproved = decision === "approved";
  const policies = await getPolicies();
  if (isApproved) {
    if (!owner) {
      res.status(404).json({ error: "The leave owner no longer exists" });
      return;
    }
    if (isBalanceTracked(leave.leaveType)) {
      const balance = await getBalance(owner, policies);
      if (leave.days > balance[leave.leaveType]) {
        res.status(400).json({
          error: `Insufficient ${leave.leaveType} leave balance (${balance[leave.leaveType]} day(s) left)`,
        });
        return;
      }
    }
  }

  // Claim the request atomically so two reviewers deciding at once can't both
  // succeed (and deduct the balance twice).
  const trimmedNote = typeof note === "string" ? note.trim() || undefined : undefined;
  const update: Record<string, unknown> = {
    $set: {
      status: decision,
      decidedBy: actor._id,
      decidedAt: new Date(),
      ...(trimmedNote ? { decisionNote: trimmedNote } : {}),
    },
  };
  if (note !== undefined && !trimmedNote) update.$unset = { decisionNote: 1 };
  const decided = await Leave.findOneAndUpdate({ _id: leave._id, status: "pending" }, update, {
    new: true,
  });
  if (!decided) {
    res.status(400).json({ error: "Only pending requests can be decided" });
    return;
  }

  if (isApproved && owner && isBalanceTracked(decided.leaveType)) {
    await applyBalanceDelta(owner, policies, decided.leaveType, -decided.days);
  }

  logActivity({
    action: isApproved ? "leave_approved" : "leave_rejected",
    actor,
    targetType: "leave",
    targetId: decided._id,
    targetName: `${decided.leaveType} leave`,
    details: {
      leaveType: decided.leaveType,
      days: decided.days,
      note: decided.decisionNote,
      employee: owner?.name,
      decidedByRole: actor.role,
    },
    ip: req.ip,
  });

  // Notify the leave owner about the decision, naming who decided it.
  notify({
    recipient: decided.user,
    actor,
    type: isApproved ? "leave_approved" : "leave_rejected",
    title: isApproved ? "Leave approved" : "Leave rejected",
    message: `Your ${decided.leaveType} leave request for ${decided.days} day(s) has been ${decision} by ${actor.name}.`,
    link: "/leaves",
    data: {
      leaveType: decided.leaveType,
      startDate: decided.startDate.toISOString().slice(0, 10),
      endDate: decided.endDate.toISOString().slice(0, 10),
      days: decided.days,
      note: decided.decisionNote,
      decidedBy: actor.name,
    },
  });

  // Real-time refresh for the employee, the decider and every other reviewer.
  broadcastLeaveUpdate(owner, [decided.user.toString(), actor._id.toString()], {
    leaveId: decided._id,
    action: decision,
    leaveType: decided.leaveType,
    days: decided.days,
    status: decision,
  });

  await decided.populate("decidedBy", "name");
  res.json({ leave: decided.toJSON() });
}

/**
 * Cancels a pending or approved request (approved refunds the days). The owner
 * cancels a pending request any time and an approved one until it starts; an
 * approved leave that has started (or passed) is cancelled only by an admin or
 * whoever may decide the owner's requests.
 */
export async function cancelLeave(req: Request, res: Response): Promise<void> {
  const leave = await getLeaveOr404(req, res);
  if (!leave) return;
  const user = req.user!;

  const own = leave.user.equals(user._id);
  const owner = own ? user : await User.findById(leave.user);
  const reviewer = owner ? canReviewLeavesOf(user, owner) : user.role === "admin";
  const started = leave.status === "approved" && leave.startDate.getTime() <= appToday().getTime();
  // Already cancelled / rejected: say so to the owner and their reviewers.
  if ((own || reviewer) && leave.status !== "pending" && leave.status !== "approved") {
    res.status(400).json({ error: "Only pending or approved requests can be cancelled" });
    return;
  }
  // Reviewers only step in for a started leave; the rest stays with the owner.
  if (!own && !(reviewer && started)) {
    res.status(403).json({ error: "You can only cancel your own leave requests" });
    return;
  }
  if (started && !reviewer) {
    res.status(403).json({ error: "This leave has already started. Ask your manager or HR to cancel it." });
    return;
  }

  // Claim the cancellation atomically so a double click refunds the days once.
  const wasApproved = leave.status === "approved";
  const cancelled = await Leave.findOneAndUpdate(
    { _id: leave._id, status: leave.status },
    { $set: { status: "cancelled" } },
    { new: true }
  );
  if (!cancelled) {
    res.status(400).json({ error: "Only pending or approved requests can be cancelled" });
    return;
  }

  if (wasApproved && owner && isBalanceTracked(cancelled.leaveType)) {
    const policies = await getPolicies();
    await applyBalanceDelta(owner, policies, cancelled.leaveType, cancelled.days);
  }

  logActivity({
    action: "leave_cancelled",
    actor: user,
    targetType: "leave",
    targetId: cancelled._id,
    targetName: `${cancelled.leaveType} leave`,
    details: {
      leaveType: cancelled.leaveType,
      days: cancelled.days,
      refunded: wasApproved,
      ...(own ? {} : { employee: owner?.name, cancelledByRole: user.role }),
    },
    ip: req.ip,
  });

  // Real-time refresh for the owner, the canceller and everyone who reviews the owner's requests.
  broadcastLeaveUpdate(owner, [cancelled.user.toString(), user._id.toString()], {
    leaveId: cancelled._id,
    action: "cancelled",
    leaveType: cancelled.leaveType,
    days: cancelled.days,
    status: "cancelled",
  });

  res.json({ leave: cancelled.toJSON() });
}

/** Admin-only: users with their current-year balances, sorted by name, with optional search + pagination. */
export async function listBalances(req: Request, res: Response): Promise<void> {
  const { limit, offset } = parsePagination(req);
  const search = searchRegex(req.query.search);

  const filter: Record<string, unknown> = { ...STAFF_FILTER };
  if (search) {
    filter.$or = [{ name: search }, { email: search }];
  }

  let query = User.find(filter).sort({ name: 1 }).select("name email leaveBalance");
  if (limit !== null) {
    query = query.skip(offset).limit(limit);
  }

  const [users, total] = await Promise.all([query, User.countDocuments(filter)]);
  const policies = await getPolicies();

  const balances = await Promise.all(
    users.map(async (user) => {
      const balance = await getBalance(user, policies);
      return {
        user: { _id: user._id, name: user.name, email: user.email },
        balance,
      };
    })
  );

  res.json({ balances, total, limit, offset });
}

/** Admin-only: sets a user's remaining days for a tracked leave type this year. */
export async function adjustBalance(req: Request, res: Response): Promise<void> {
  const userId = param(req, "userId");
  if (!userId || isInvalidObjectId(userId)) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const user = await User.findById(userId);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const { leaveType, days } = (req.body ?? {}) as AdjustBalanceBody;
  if (typeof leaveType !== "string" || !isBalanceTracked(leaveType as LeaveType)) {
    res.status(400).json({ error: "leaveType must be one of: annual, sick, personal" });
    return;
  }
  if (typeof days !== "number" || !Number.isInteger(days) || days < 0) {
    res.status(400).json({ error: "days must be a non-negative integer" });
    return;
  }

  const type = leaveType as BalanceTrackedType;
  const policies = await getPolicies();
  const balance = await getBalance(user, policies);
  balance[type] = days;
  user.leaveBalance = balance;
  await user.save();

  logActivity({
    action: "leave_balance_adjusted",
    actor: req.user,
    targetType: "user",
    targetId: user._id,
    targetName: user.name,
    details: { leaveType: type, days },
    ip: req.ip,
  });

  res.json({ balance });
}
