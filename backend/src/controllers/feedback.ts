import type { Request, Response } from "express";
import mongoose from "mongoose";
import { logActivity } from "../lib/activityLog.js";
import { notify } from "../lib/notifications.js";
import { parsePagination, searchRegex } from "../lib/pagination.js";
import { Feedback } from "../models/Feedback.js";
import type { IFeedback } from "../models/Feedback.js";
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_STATUSES,
  type FeedbackCategory,
  type FeedbackStatus,
} from "../models/Feedback.js";
import { User } from "../models/User.js";

const AUTHOR_SELECT = "name email";
const RESPONDER_SELECT = "name";

interface CreateFeedbackBody {
  message?: unknown;
  category?: unknown;
  isAnonymous?: unknown;
}

interface UpdateFeedbackBody {
  response?: unknown;
  status?: unknown;
}

function isInvalidObjectId(id: string): boolean {
  return !mongoose.isValidObjectId(id);
}

/** Express 5 types params as `string | string[] | undefined` — normalize to a single id. */
function paramId(req: Request): string | undefined {
  const id = req.params.id;
  return typeof id === "string" ? id : undefined;
}

async function getFeedbackOr404(req: Request, res: Response): Promise<IFeedback | undefined> {
  const id = paramId(req);
  if (!id || isInvalidObjectId(id)) {
    res.status(404).json({ error: "Feedback not found" });
    return undefined;
  }
  const feedback = await Feedback.findById(id);
  if (!feedback) {
    res.status(404).json({ error: "Feedback not found" });
    return undefined;
  }
  return feedback;
}

function isCategory(value: unknown): value is FeedbackCategory {
  return typeof value === "string" && FEEDBACK_CATEGORIES.includes(value as FeedbackCategory);
}

function isStatus(value: unknown): value is FeedbackStatus {
  return typeof value === "string" && FEEDBACK_STATUSES.includes(value as FeedbackStatus);
}

/** Returns the JSON — anonymous authors are always nulled out so the identity never leaks. */
function toJson(feedback: IFeedback): Record<string, unknown> {
  const json = feedback.toJSON() as unknown as Record<string, unknown>;
  if (feedback.isAnonymous) json.author = null;
  return json;
}

/** Standard population for every feedback response (author + latest responder). */
const POPULATE = [
  { path: "author", select: AUTHOR_SELECT },
  { path: "response.respondedBy", select: RESPONDER_SELECT },
];

/**
 * Any authenticated user: submits feedback with a category and an optional
 * anonymity flag. The author is always stored so the submitter can track
 * their own submission; admins see anonymous ones without the identity.
 */
export async function createFeedback(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const { message, category, isAnonymous } = (req.body ?? {}) as CreateFeedbackBody;

  if (typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  if (message.trim().length > 2000) {
    res.status(400).json({ error: "message must be 2000 characters or fewer" });
    return;
  }
  if (!isCategory(category)) {
    res.status(400).json({
      error: "category must be one of: suggestion, complaint, praise, other",
    });
    return;
  }
  const anonymous = isAnonymous === true;

  const feedback = await Feedback.create({
    author: user._id,
    isAnonymous: anonymous,
    category,
    message: message.trim(),
    status: "open",
  });

  // Anonymous: nothing in the log may lead back to the author — no actor, email,
  // role or IP, and no feedback id (the feedback record itself stores its author).
  logActivity({
    action: "feedback_created",
    ...(anonymous ? { actorName: "Anonymous" } : { actor: user, targetId: feedback._id, ip: req.ip }),
    targetType: "feedback",
    targetName: `${category} feedback`,
    details: { category, isAnonymous: anonymous },
  });

  const populated = await feedback.populate(POPULATE);
  res.status(201).json({ feedback: toJson(populated) });
}

/** Any authenticated user: their own submissions, newest first, with optional status filter, search, and pagination. */
export async function myFeedback(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const { limit, offset } = parsePagination(req);
  const search = searchRegex(req.query.search);
  const status = req.query.status;

  const filter: Record<string, unknown> = { author: user._id };
  if (status !== undefined) {
    if (!isStatus(status)) {
      res.status(400).json({ error: "status must be one of: open, resolved" });
      return;
    }
    filter.status = status;
  }
  if (search) {
    filter.message = search;
  }

  let query = Feedback.find(filter).populate(POPULATE).sort({ createdAt: -1 });
  if (limit !== null) {
    query = query.skip(offset).limit(limit);
  }

  const [feedback, total] = await Promise.all([query, Feedback.countDocuments(filter)]);
  res.json({
    feedback: feedback.map((item) => toJson(item)),
    total,
    limit,
    offset,
  });
}

/**
 * Admin-only: every submission, optionally filtered by status/category and
 * searched/paginated. Search matches message text; name/email matches only
 * surface attributed (non-anonymous) rows so anonymity is preserved.
 */
export async function listFeedback(req: Request, res: Response): Promise<void> {
  const { limit, offset } = parsePagination(req);
  const search = searchRegex(req.query.search);
  const status = req.query.status;
  const category = req.query.category;

  const filter: Record<string, unknown> = {};
  if (status !== undefined) {
    if (!isStatus(status)) {
      res.status(400).json({ error: "status must be one of: open, resolved" });
      return;
    }
    filter.status = status;
  }
  if (category !== undefined) {
    if (!isCategory(category)) {
      res.status(400).json({
        error: "category must be one of: suggestion, complaint, praise, other",
      });
      return;
    }
    filter.category = category;
  }

  if (search) {
    // Population can't be filtered directly — resolve matching user ids first.
    const matchingUsers = await User.find({
      $or: [{ name: search }, { email: search }],
    }).select("_id");
    const or: Record<string, unknown>[] = [{ message: search }];
    if (matchingUsers.length > 0) {
      // Name/email matches must never surface anonymous submissions.
      or.push({
        author: { $in: matchingUsers.map((match) => match._id) },
        isAnonymous: { $ne: true },
      });
    }
    filter.$or = or;
  }

  let query = Feedback.find(filter).populate(POPULATE).sort({ createdAt: -1 });
  if (limit !== null) {
    query = query.skip(offset).limit(limit);
  }

  const [feedback, total] = await Promise.all([query, Feedback.countDocuments(filter)]);
  res.json({
    feedback: feedback.map((item) => toJson(item)),
    total,
    limit,
    offset,
  });
}

/** Admin-only: responds to a submission and/or changes its status (resolve/reopen). */
export async function updateFeedback(req: Request, res: Response): Promise<void> {
  const feedback = await getFeedbackOr404(req, res);
  if (!feedback) return;
  const admin = req.user!;

  const { response, status } = (req.body ?? {}) as UpdateFeedbackBody;
  const hasAnyField = response !== undefined || status !== undefined;
  if (!hasAnyField) {
    res.status(400).json({ error: "At least one of response or status is required" });
    return;
  }

  const performed: string[] = [];
  const details: Record<string, unknown> = {
    category: feedback.category,
    isAnonymous: feedback.isAnonymous,
  };

  if (status !== undefined) {
    if (!isStatus(status)) {
      res.status(400).json({ error: "status must be one of: open, resolved" });
      return;
    }
    if (status !== feedback.status) {
      const previous = feedback.status;
      feedback.status = status;
      details.previous = previous;
      performed.push(status === "resolved" ? "feedback_resolved" : "feedback_reopened");
    }
  }

  if (response !== undefined) {
    if (typeof response !== "string" || !response.trim()) {
      res.status(400).json({ error: "response must be a non-empty message" });
      return;
    }
    feedback.response = {
      body: response.trim(),
      respondedBy: admin._id,
      respondedAt: new Date(),
    };
    performed.push("feedback_responded");
  }

  await feedback.save();

  for (const action of performed) {
    logActivity({
      action: action as
        | "feedback_responded"
        | "feedback_resolved"
        | "feedback_reopened",
      actor: admin,
      targetType: "feedback",
      targetId: feedback._id,
      targetName: `${feedback.category} feedback`,
      details,
      ip: req.ip,
    });
  }

  // Notify the feedback author about the response (skip anonymous submissions).
  if (feedback.response && !feedback.isAnonymous && feedback.author) {
    notify({
      recipient: feedback.author,
      actor: admin,
      type: "feedback_responded",
      title: "Feedback response",
      message: `An admin responded to your ${feedback.category} feedback.`,
      link: "/feedback",
      data: {
        category: feedback.category,
        responseBody: feedback.response.body,
      },
    });
  }

  const populated = await feedback.populate(POPULATE);
  res.json({ feedback: toJson(populated) });
}
