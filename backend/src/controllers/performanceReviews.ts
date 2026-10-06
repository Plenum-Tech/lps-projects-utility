import type { Request, Response } from "express";
import mongoose from "mongoose";
import { logActivity } from "../lib/activityLog.js";
import { notify } from "../lib/notifications.js";
import { parsePagination, searchRegex } from "../lib/pagination.js";
import { pushToUsers, createEvent } from "../lib/sse.js";
import { inngest } from "../inngest/index.js";
import {
  PerformanceReview,
  type IPerformanceReview,
  type ReviewStatus,
  type GoalStatus,
} from "../models/PerformanceReview.js";
import { REVIEW_STATUSES } from "../models/PerformanceReview.js";
import { GOAL_STATUSES } from "../models/PerformanceReview.js";
import { User } from "../models/User.js";
import { Notification } from "../models/Notification.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MAX_RATINGS = 10;
const MAX_CATEGORY_LENGTH = 100;
const MAX_RATING_COMMENT = 1000;
const MAX_GOALS = 20;
const MAX_GOAL_TITLE = 200;
const MAX_GOAL_DESCRIPTION = 2000;
const MAX_TEXT = 5000;

/** Content fields that may only change while a review is still a draft. */
const CONTENT_FIELDS = [
  "ratings",
  "goals",
  "strengths",
  "improvements",
  "summary",
] as const;

/**
 * AI drafting (Gemini via Inngest) is opt-in: `AI_REVIEW_DRAFTS=true` on the
 * server. Reviews are written manually by default.
 */
export function aiReviewDraftsEnabled(): boolean {
  return process.env.AI_REVIEW_DRAFTS === "true";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isInvalidObjectId(id: string): boolean {
  return !mongoose.isValidObjectId(id);
}

/** Express 5 types params as `string | string[] | undefined` — normalize to a single value. */
function param(req: Request, name: string): string | undefined {
  const value = req.params[name];
  return typeof value === "string" ? value : undefined;
}

function isReviewStatus(value: unknown): value is ReviewStatus {
  return (
    typeof value === "string" &&
    (REVIEW_STATUSES as readonly string[]).includes(value)
  );
}

function isGoalStatus(value: unknown): value is GoalStatus {
  return (
    typeof value === "string" &&
    (GOAL_STATUSES as readonly string[]).includes(value)
  );
}

async function getReviewOr404(
  req: Request,
  res: Response
): Promise<IPerformanceReview | undefined> {
  const id = param(req, "id");
  if (!id || isInvalidObjectId(id)) {
    res.status(404).json({ error: "Performance review not found" });
    return undefined;
  }
  const review = await PerformanceReview.findById(id);
  if (!review) {
    res.status(404).json({ error: "Performance review not found" });
    return undefined;
  }
  return review;
}

function goalIndexParam(req: Request): number | undefined {
  const raw = param(req, "goalIndex");
  if (raw === undefined) return undefined;
  const idx = parseInt(raw, 10);
  return Number.isFinite(idx) && idx >= 0 ? idx : undefined;
}

/** Only the review's author or an admin may change a review. */
function canManageReview(
  review: IPerformanceReview,
  user: NonNullable<Request["user"]>
): boolean {
  return user.role === "admin" || review.reviewer.equals(user._id);
}

/** Re-reads a review with employee/reviewer populated, as list/detail responses are. */
async function populatedReviewJSON(review: IPerformanceReview) {
  const populated = await PerformanceReview.findById(review._id)
    .populate("employee", "name email department")
    .populate("reviewer", "name email");
  return (populated ?? review).toJSON();
}

type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

interface ValidRating {
  category: string;
  score: number;
  comment?: string;
}

interface ValidGoal {
  title: string;
  description?: string;
  status: GoalStatus;
  dueDate?: Date;
  completedAt?: Date;
}

/** Validates a ratings array: 1–5 integer scores, unique non-empty categories. */
function validateRatings(input: unknown): Validated<ValidRating[]> {
  if (!Array.isArray(input)) return { ok: false, error: "ratings must be an array" };
  if (input.length > MAX_RATINGS) {
    return { ok: false, error: `A review can have at most ${MAX_RATINGS} ratings` };
  }
  const seen = new Set<string>();
  const out: ValidRating[] = [];
  for (const r of input) {
    if (typeof r !== "object" || r === null) {
      return { ok: false, error: "Each rating must have a category (string) and score (number)" };
    }
    const { category, score, comment } = r as Record<string, unknown>;
    if (typeof category !== "string" || typeof score !== "number") {
      return { ok: false, error: "Each rating must have a category (string) and score (number)" };
    }
    const name = category.trim();
    if (!name) return { ok: false, error: "Rating categories can't be empty" };
    if (name.length > MAX_CATEGORY_LENGTH) {
      return { ok: false, error: `Rating categories must be at most ${MAX_CATEGORY_LENGTH} characters` };
    }
    const key = name.toLowerCase();
    if (seen.has(key)) return { ok: false, error: `Duplicate rating category: ${name}` };
    seen.add(key);
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      return { ok: false, error: "Rating scores must be whole numbers between 1 and 5" };
    }
    if (comment !== undefined && comment !== null && typeof comment !== "string") {
      return { ok: false, error: "Rating comments must be strings" };
    }
    const text = typeof comment === "string" ? comment.trim() : "";
    if (text.length > MAX_RATING_COMMENT) {
      return { ok: false, error: `Rating comments must be at most ${MAX_RATING_COMMENT} characters` };
    }
    out.push({ category: name, score, ...(text ? { comment: text } : {}) });
  }
  return { ok: true, value: out };
}

function parseDate(value: unknown): Date | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Validates a goals array (title required, optional description/due date). */
function validateGoals(input: unknown): Validated<ValidGoal[]> {
  if (!Array.isArray(input)) return { ok: false, error: "goals must be an array" };
  if (input.length > MAX_GOALS) {
    return { ok: false, error: `A review can have at most ${MAX_GOALS} goals` };
  }
  const out: ValidGoal[] = [];
  for (const g of input) {
    if (typeof g !== "object" || g === null) {
      return { ok: false, error: "Each goal must have a title (string)" };
    }
    const { title, description, status, dueDate, completedAt } = g as Record<string, unknown>;
    if (typeof title !== "string" || !title.trim()) {
      return { ok: false, error: "Each goal must have a title" };
    }
    if (title.trim().length > MAX_GOAL_TITLE) {
      return { ok: false, error: `Goal titles must be at most ${MAX_GOAL_TITLE} characters` };
    }
    if (description !== undefined && description !== null && typeof description !== "string") {
      return { ok: false, error: "Goal descriptions must be strings" };
    }
    const desc = typeof description === "string" ? description.trim() : "";
    if (desc.length > MAX_GOAL_DESCRIPTION) {
      return { ok: false, error: `Goal descriptions must be at most ${MAX_GOAL_DESCRIPTION} characters` };
    }
    const due = parseDate(dueDate);
    if (due === null) return { ok: false, error: "Goal due dates must be valid dates" };
    const done = parseDate(completedAt);
    if (done === null) return { ok: false, error: "Goal completion dates must be valid dates" };
    out.push({
      title: title.trim(),
      ...(desc ? { description: desc } : {}),
      status: isGoalStatus(status) ? status : "not_started",
      ...(due ? { dueDate: due } : {}),
      ...(done ? { completedAt: done } : {}),
    });
  }
  return { ok: true, value: out };
}

/** Validates an optional free-text field; `undefined` means "not provided". */
function validateText(
  input: unknown,
  label: string
): Validated<string | undefined> {
  if (input === undefined) return { ok: true, value: undefined };
  if (typeof input !== "string") return { ok: false, error: `${label} must be a string` };
  const text = input.trim();
  if (text.length > MAX_TEXT) {
    return { ok: false, error: `${label} must be at most ${MAX_TEXT} characters` };
  }
  return { ok: true, value: text };
}

/** Overall score = average of category scores, one decimal; undefined when unrated. */
export function computeOverallScore(
  ratings: { score: number }[]
): number | undefined {
  if (ratings.length === 0) return undefined;
  const total = ratings.reduce((sum, r) => sum + r.score, 0);
  return Math.round((total / ratings.length) * 10) / 10;
}

// ---------------------------------------------------------------------------
// Config — tells the UI whether AI drafting is available (admin/head)
// ---------------------------------------------------------------------------

export function reviewConfig(_req: Request, res: Response): void {
  res.json({ aiDraftsEnabled: aiReviewDraftsEnabled() });
}

// ---------------------------------------------------------------------------
// Create — admin or head writes a review (manual; optional AI draft)
// ---------------------------------------------------------------------------

interface CreateReviewBody {
  employeeId?: unknown;
  period?: unknown;
  ratings?: unknown;
  goals?: unknown;
  summary?: unknown;
  strengths?: unknown;
  improvements?: unknown;
  aiDraft?: unknown;
}

export async function createReview(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const body = (req.body ?? {}) as CreateReviewBody;
  const { employeeId, period, aiDraft } = body;

  if (typeof employeeId !== "string" || isInvalidObjectId(employeeId)) {
    res.status(400).json({ error: "employeeId must be a valid user ID" });
    return;
  }
  if (typeof period !== "string" || !period.trim()) {
    res.status(400).json({ error: "period is required (e.g. 'Q1 2026')" });
    return;
  }
  if (period.trim().length > 50) {
    res.status(400).json({ error: "period must be at most 50 characters" });
    return;
  }
  if (aiDraft !== undefined && typeof aiDraft !== "boolean") {
    res.status(400).json({ error: "aiDraft must be a boolean" });
    return;
  }
  if (aiDraft === true && !aiReviewDraftsEnabled()) {
    res.status(400).json({ error: "AI drafting is not enabled" });
    return;
  }

  let ratings: ValidRating[] = [];
  if (body.ratings !== undefined) {
    const result = validateRatings(body.ratings);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    ratings = result.value;
  }

  let goals: ValidGoal[] = [];
  if (body.goals !== undefined) {
    const result = validateGoals(body.goals);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    goals = result.value;
  }

  const texts: Partial<Record<"summary" | "strengths" | "improvements", string>> = {};
  for (const [key, label] of [
    ["summary", "summary"],
    ["strengths", "strengths"],
    ["improvements", "improvements"],
  ] as const) {
    const result = validateText(body[key], label);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    if (result.value) texts[key] = result.value;
  }

  if (employeeId === user._id.toString()) {
    res.status(400).json({ error: "You can't write a performance review for yourself" });
    return;
  }

  const employee = await User.findById(employeeId);
  if (!employee) {
    res.status(404).json({ error: "Employee not found" });
    return;
  }

  // Heads can only review employees in their own department.
  if (user.role === "head" && employee.department?.toString() !== user.department?.toString()) {
    res.status(403).json({
      error: "You can only create reviews for employees in your department",
    });
    return;
  }

  const review = await PerformanceReview.create({
    employee: employeeId,
    reviewer: user._id,
    period: period.trim(),
    status: "draft",
    ratings,
    goals,
    overallScore: computeOverallScore(ratings),
    ...texts,
    aiGenerated: false,
  });

  logActivity({
    action: "review_created",
    actor: user,
    targetType: "performance_review",
    targetId: review._id,
    targetName: `review for ${employee.name}`,
    details: { period: period.trim(), employeeName: employee.name, aiDraft: aiDraft === true },
    ip: req.ip,
  });

  // The review starts as a draft — the employee is notified when it's sent
  // to them (status → pending_acknowledgment), not now.
  pushToUsers(
    [user._id.toString()],
    createEvent("review-updated", {
      reviewId: review._id,
      action: "created",
      period: period.trim(),
      employeeName: employee.name,
    })
  );

  const warnings: string[] = [];
  if (aiDraft === true) {
    // Opt-in AI draft in the background. A failure to enqueue must never
    // fail the request — the review already exists and can be written by hand.
    try {
      await inngest.send({
        name: "performance/generate-review",
        data: { reviewId: review._id.toString() },
      });
    } catch (err) {
      console.error(
        "[performance-reviews] AI draft dispatch failed for review",
        review._id.toString(),
        err instanceof Error ? err.message : err
      );
      warnings.push("AI drafting couldn't start — fill the review in manually.");
    }
  }

  res.status(201).json({
    review: review.toJSON(),
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}

// ---------------------------------------------------------------------------
// List all reviews — admin/head, filterable by employee, status, period
// ---------------------------------------------------------------------------

export async function listReviews(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const { limit, offset } = parsePagination(req);
  const search = searchRegex(req.query.search);
  const status = req.query.status;
  const employeeId = req.query.employeeId;
  const period = req.query.period;
  const aiDraftsEnabled = aiReviewDraftsEnabled();

  const filter: Record<string, unknown> = {};

  // Heads only see reviews they wrote or reviews of their department's people.
  if (user.role === "head") {
    const deptUsers = user.department
      ? await User.find({ department: user.department }).select("_id")
      : [];
    filter.$or = [
      { reviewer: user._id },
      { employee: { $in: deptUsers.map((u) => u._id) } },
    ];
  }

  if (status !== undefined) {
    if (!isReviewStatus(status)) {
      res.status(400).json({
        error: "status must be one of: draft, pending_acknowledgment, acknowledged, completed",
      });
      return;
    }
    filter.status = status;
  }

  if (typeof employeeId === "string" && !isInvalidObjectId(employeeId)) {
    filter.employee = employeeId;
  }

  if (typeof period === "string" && period.trim()) {
    filter.period = period.trim();
  }

  if (search) {
    // Search over populated employee — resolve matching user ids first.
    const matchingUsers = await User.find({
      $or: [{ name: search }, { email: search }],
    }).select("_id");
    const ids = matchingUsers.map((u) => u._id);
    if (ids.length === 0) {
      res.json({ reviews: [], total: 0, limit, offset, aiDraftsEnabled });
      return;
    }
    filter.employee = { $in: ids };
  }

  let query = PerformanceReview.find(filter)
    .populate("employee", "name email department")
    .populate("reviewer", "name email")
    .sort({ createdAt: -1 });

  if (limit !== null) {
    query = query.skip(offset).limit(limit);
  }

  const [reviews, total] = await Promise.all([
    query,
    PerformanceReview.countDocuments(filter),
  ]);

  res.json({
    reviews: reviews.map((r) => r.toJSON()),
    total,
    limit,
    offset,
    aiDraftsEnabled,
  });
}

// ---------------------------------------------------------------------------
// My reviews — employee views their own reviews (drafts stay with the reviewer)
// ---------------------------------------------------------------------------

export async function myReviews(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const { limit, offset } = parsePagination(req);
  const search = searchRegex(req.query.search);
  const status = req.query.status;

  const filter: Record<string, unknown> = {
    employee: user._id,
    status: { $ne: "draft" },
  };

  if (status !== undefined) {
    if (!isReviewStatus(status)) {
      res.status(400).json({
        error: "status must be one of: draft, pending_acknowledgment, acknowledged, completed",
      });
      return;
    }
    if (status === "draft") {
      res.json({ reviews: [], total: 0, limit, offset });
      return;
    }
    filter.status = status;
  }

  if (search) {
    filter.$or = [{ period: search }, { summary: search }];
  }

  let query = PerformanceReview.find(filter)
    .populate("reviewer", "name email")
    .sort({ createdAt: -1 });

  if (limit !== null) {
    query = query.skip(offset).limit(limit);
  }

  const [reviews, total] = await Promise.all([
    query,
    PerformanceReview.countDocuments(filter),
  ]);

  res.json({
    reviews: reviews.map((r) => r.toJSON()),
    total,
    limit,
    offset,
  });
}

// ---------------------------------------------------------------------------
// Get single review — owner (once sent), reviewer, or admin
// ---------------------------------------------------------------------------

export async function getReview(req: Request, res: Response): Promise<void> {
  const review = await getReviewOr404(req, res);
  if (!review) return;

  const user = req.user!;
  const isOwner = review.employee.equals(user._id);
  const isReviewer = review.reviewer.equals(user._id);
  const isAdmin = user.role === "admin";

  if (!isOwner && !isReviewer && !isAdmin) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  // Drafts aren't visible to the employee until they're sent.
  if (isOwner && !isReviewer && !isAdmin && review.status === "draft") {
    res.status(404).json({ error: "Performance review not found" });
    return;
  }

  const populated = await PerformanceReview.findById(review._id)
    .populate("employee", "name email department")
    .populate("reviewer", "name email");

  res.json({ review: populated!.toJSON() });
}

// ---------------------------------------------------------------------------
// Update review — reviewer/admin edits a draft's content, or moves its status
// ---------------------------------------------------------------------------

interface UpdateReviewBody {
  ratings?: unknown;
  goals?: unknown;
  status?: unknown;
  strengths?: unknown;
  improvements?: unknown;
  summary?: unknown;
}

export async function updateReview(req: Request, res: Response): Promise<void> {
  const review = await getReviewOr404(req, res);
  if (!review) return;
  const user = req.user!;
  const body = (req.body ?? {}) as UpdateReviewBody;
  const { ratings, goals, status } = body;

  const contentFields = CONTENT_FIELDS.filter((key) => body[key] !== undefined);

  if (contentFields.length === 0 && status === undefined) {
    res
      .status(400)
      .json({ error: "At least one field to update is required" });
    return;
  }

  if (!canManageReview(review, user)) {
    res
      .status(403)
      .json({ error: "Only the reviewer or an admin can update this review" });
    return;
  }

  if (contentFields.length > 0 && review.status !== "draft") {
    res.status(409).json({
      error:
        "This review has already been sent to the employee, so its content can no longer be edited",
    });
    return;
  }

  let validRatings: ValidRating[] | undefined;
  if (ratings !== undefined) {
    const result = validateRatings(ratings);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    validRatings = result.value;
  }

  let validGoals: ValidGoal[] | undefined;
  if (goals !== undefined) {
    const result = validateGoals(goals);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    validGoals = result.value;
  }

  const texts: Partial<Record<"summary" | "strengths" | "improvements", string>> = {};
  for (const key of ["summary", "strengths", "improvements"] as const) {
    const result = validateText(body[key], key);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    if (result.value !== undefined) texts[key] = result.value;
  }

  if (status !== undefined && !isReviewStatus(status)) {
    res.status(400).json({
      error: "status must be one of: draft, pending_acknowledgment, acknowledged, completed",
    });
    return;
  }

  if (validRatings) {
    review.ratings = validRatings;
    review.overallScore = computeOverallScore(validRatings);
  }
  if (validGoals) review.goals = validGoals;
  for (const [key, value] of Object.entries(texts) as [
    "summary" | "strengths" | "improvements",
    string,
  ][]) {
    review[key] = value || undefined;
  }

  const previousStatus = review.status;
  if (status !== undefined) review.status = status;
  const sentToEmployee =
    previousStatus === "draft" && review.status === "pending_acknowledgment";

  await review.save();

  logActivity({
    action: "review_created", // reuse for updates
    actor: user,
    targetType: "performance_review",
    targetId: review._id,
    targetName: `review for employee`,
    details: {
      period: review.period,
      updatedFields: Object.keys(req.body ?? {}),
    },
    ip: req.ip,
  });

  if (sentToEmployee) {
    notify({
      recipient: review.employee,
      actor: user,
      type: "review_assigned",
      title: "Performance review ready",
      message: `Your ${review.period} performance review is ready for you to read and acknowledge.`,
      link: "/performance-reviews",
      data: { period: review.period, reviewerName: user.name, reviewId: review._id.toString() },
    });
  }

  // Real-time SSE push — the employee only hears about non-draft reviews.
  pushToUsers(
    review.status === "draft"
      ? [review.reviewer.toString()]
      : [review.employee.toString(), review.reviewer.toString()],
    createEvent("review-updated", {
      reviewId: review._id,
      action: sentToEmployee ? "assigned" : "updated",
      period: review.period,
      status: review.status,
      updatedFields: Object.keys(req.body ?? {}),
    })
  );

  res.json({ review: await populatedReviewJSON(review) });
}


// ---------------------------------------------------------------------------
// Delete review — admin only
// ---------------------------------------------------------------------------

export async function deleteReview(req: Request, res: Response): Promise<void> {
  const review = await getReviewOr404(req, res);
  if (!review) return;

  const user = req.user!;

  // Only admins can delete performance reviews.
  if (user.role !== "admin") {
    res.status(403).json({ error: "Only admins can delete performance reviews" });
    return;
  }

  await PerformanceReview.findByIdAndDelete(review._id);

  logActivity({
    action: "review_deleted",
    actor: user,
    targetType: "performance_review",
    targetId: review._id,
    targetName: `review for employee`,
    details: { period: review.period, employeeId: review.employee },
    ip: req.ip,
  });

  // Real-time SSE push to employee and reviewer
  pushToUsers(
    [review.employee.toString(), review.reviewer.toString()],
    createEvent("review-updated", {
      reviewId: review._id,
      action: "deleted",
      period: review.period,
    })
  );

  // Clean up notifications linked to this review.
  await Notification.deleteMany({
    $or: [
      { "data.reviewId": review._id.toString() },
      { link: "/performance-reviews" },
    ],
  });

  res.json({ message: "Performance review deleted successfully" });
}

// ---------------------------------------------------------------------------
// Acknowledge review — employee confirms they've seen the feedback
// ---------------------------------------------------------------------------

interface AcknowledgeBody {
  comments?: unknown;
}

export async function acknowledgeReview(
  req: Request,
  res: Response
): Promise<void> {
  const review = await getReviewOr404(req, res);
  if (!review) return;
  const user = req.user!;

  if (!review.employee.equals(user._id)) {
    res.status(403).json({ error: "You can only acknowledge your own reviews" });
    return;
  }

  if (
    review.status !== "pending_acknowledgment" &&
    review.status !== "acknowledged"
  ) {
    res.status(400).json({
      error: "This review is not pending acknowledgment",
    });
    return;
  }

  const { comments } = (req.body ?? {}) as AcknowledgeBody;
  if (comments !== undefined && typeof comments !== "string") {
    res.status(400).json({ error: "comments must be a string" });
    return;
  }

  review.status = "acknowledged";
  review.acknowledgedAt = new Date();
  if (typeof comments === "string" && comments.trim()) {
    review.employeeComments = comments.trim();
  }

  await review.save();

  logActivity({
    action: "review_acknowledged",
    actor: user,
    targetType: "performance_review",
    targetId: review._id,
    targetName: `review for ${user.name}`,
    details: { period: review.period },
    ip: req.ip,
  });

  // Notify the reviewer that the employee acknowledged.
  notify({
    recipient: review.reviewer,
    actor: user,
    type: "review_acknowledged",
    title: "Review acknowledged",
    message: `${user.name} has acknowledged their ${review.period} performance review.`,
    link: "/performance-reviews",
    data: { employeeName: user.name, period: review.period },
  });

  // Real-time SSE push to reviewer and employee
  pushToUsers(
    [review.reviewer.toString(), user._id.toString()],
    createEvent("review-updated", {
      reviewId: review._id,
      action: "acknowledged",
      period: review.period,
      employeeName: user.name,
    })
  );

  res.json({ review: review.toJSON() });
}

// ---------------------------------------------------------------------------
// Update goal status — admin/head updates a specific goal within a review
// ---------------------------------------------------------------------------

interface UpdateGoalBody {
  status?: unknown;
  description?: unknown;
}

export async function updateGoal(req: Request, res: Response): Promise<void> {
  const review = await getReviewOr404(req, res);
  if (!review) return;

  const idx = goalIndexParam(req);
  if (idx === undefined || idx >= review.goals.length) {
    res.status(404).json({ error: "Goal not found" });
    return;
  }

  if (!canManageReview(review, req.user!)) {
    res
      .status(403)
      .json({ error: "Only the reviewer or an admin can update this review" });
    return;
  }

  const { status, description } = (req.body ?? {}) as UpdateGoalBody;
  const goal = review.goals[idx]!;

  if (status !== undefined) {
    if (!isGoalStatus(status)) {
      res.status(400).json({
        error: "status must be one of: not_started, in_progress, completed",
      });
      return;
    }
    goal.status = status;
    if (status === "completed") {
      goal.completedAt = new Date();
    } else {
      goal.completedAt = undefined;
    }
  }

  if (typeof description === "string") {
    if (description.trim().length > MAX_GOAL_DESCRIPTION) {
      res.status(400).json({
        error: `Goal descriptions must be at most ${MAX_GOAL_DESCRIPTION} characters`,
      });
      return;
    }
    goal.description = description.trim();
  }

  await review.save();

  logActivity({
    action: "goal_updated",
    actor: req.user,
    targetType: "performance_review",
    targetId: review._id,
    targetName: `goal: ${goal.title}`,
    details: { goalTitle: goal.title, newStatus: goal.status },
    ip: req.ip,
  });

  // Real-time SSE push to employee and reviewer
  pushToUsers(
    [review.employee.toString(), review.reviewer.toString()],
    createEvent("review-updated", {
      reviewId: review._id,
      action: "goal-updated",
      period: review.period,
      goalTitle: goal.title,
      goalStatus: goal.status,
    })
  );

  res.json({ review: await populatedReviewJSON(review) });
}
