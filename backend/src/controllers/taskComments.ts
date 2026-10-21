import type { Request, Response } from "express";
import mongoose from "mongoose";
import { notifyTask } from "../lib/notifications.js";
import { parsePagination } from "../lib/pagination.js";
import {
  canManageTaskAsync,
  canViewTask,
  getReadableTaskOr404,
  getViewableTaskOr404,
  isInvalidObjectId,
  param,
  pushTaskUpdate,
  recordTaskHistory,
  taskDepartmentIds,
} from "../lib/taskAccess.js";
import type { ITask } from "../models/Task.js";
import { TaskComment } from "../models/TaskComment.js";
import type { ITaskComment } from "../models/TaskComment.js";
import type { IUser } from "../models/User.js";
import { User } from "../models/User.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_BODY = 5000;
const COMMENT_POPULATE = [
  { path: "author", select: "name email" },
  { path: "mentions", select: "name email" },
];

/** `@[Jane Doe](64f…)` — the frontend inserts these tokens from the mention picker. */
const MENTION_TOKEN = /@\[([^\]]{1,100})\]\(([a-f0-9]{24})\)/gi;

/**
 * Parses mention tokens into user ids, keeping only users who can view the task.
 * Others are ignored silently.
 */
export async function resolveMentions(body: string, task: ITask): Promise<mongoose.Types.ObjectId[]> {
  const ids = new Set<string>();
  for (const match of body.matchAll(MENTION_TOKEN)) {
    if (match[2]) ids.add(match[2].toLowerCase());
  }
  if (ids.size === 0) return [];

  const [users, departments] = await Promise.all([
    User.find({ _id: { $in: [...ids] } }).select("_id role department"),
    taskDepartmentIds(task),
  ]);
  return users.filter((u) => canViewTask(u, task, departments)).map((u) => u._id);
}

/** `@[Jane](id)` → `@Jane` for notification/email text. */
export function plainText(body: string): string {
  return body.replace(MENTION_TOKEN, (_m, name: string) => `@${name}`);
}

export function excerpt(body: string, max = 140): string {
  const text = plainText(body).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function validateBody(body: unknown): string | { error: string } {
  if (typeof body !== "string" || !body.trim()) return { error: "body is required" };
  if (body.trim().length > MAX_BODY) return { error: `body must be ${MAX_BODY} characters or fewer` };
  return body.trim();
}

async function getCommentOr404(
  req: Request,
  res: Response,
  task: ITask
): Promise<ITaskComment | undefined> {
  const commentId = param(req, "commentId");
  const comment =
    commentId && !isInvalidObjectId(commentId)
      ? await TaskComment.findOne({ _id: commentId, task: task._id })
      : null;
  if (!comment) {
    res.status(404).json({ error: "Comment not found" });
    return undefined;
  }
  return comment;
}

/** task_mention to mentioned users; task_comment to creator + assignees minus mentioned. */
function notifyComment(
  task: ITask,
  comment: ITaskComment,
  actor: IUser,
  mentioned: mongoose.Types.ObjectId[],
  includeCommentRecipients: boolean
): void {
  const emailTask = { _id: task._id as mongoose.Types.ObjectId, title: task.title, dueDate: task.dueDate, priority: task.priority };
  const quote = plainText(comment.body);

  if (mentioned.length > 0) {
    notifyTask({
      recipients: mentioned,
      actor,
      type: "task_mention",
      task: emailTask,
      title: "You were mentioned",
      message: `${actor.name} mentioned you on "${task.title}": ${excerpt(comment.body)}`,
      email: {
        subject: `💬 ${actor.name} mentioned you on: ${task.title}`,
        heading: "You Were Mentioned",
        intro: `${actor.name} mentioned you in a comment.`,
        quote,
        quoteAuthor: actor.name,
        buttonLabel: "Reply",
      },
    });
  }

  if (!includeCommentRecipients) return;
  const mentionedSet = new Set(mentioned.map((id) => id.toString()));
  const recipients = [...task.assignees, task.assignedBy].filter(
    (id) => !mentionedSet.has(id.toString())
  );
  notifyTask({
    recipients,
    actor,
    type: "task_comment",
    task: emailTask,
    title: "New comment",
    message: `${actor.name} commented on "${task.title}": ${excerpt(comment.body)}`,
    email: {
      subject: `💬 New comment on: ${task.title}`,
      heading: "New Comment",
      intro: `${actor.name} commented on this task.`,
      quote,
      quoteAuthor: actor.name,
      buttonLabel: "Reply",
    },
  });
}

interface CommentBody {
  body?: unknown;
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

/** Any signed-in user (read-only viewers too): comments oldest first, with pagination. */
export async function listComments(req: Request, res: Response): Promise<void> {
  const task = await getReadableTaskOr404(req, res);
  if (!task) return;

  const { limit, offset } = parsePagination(req);
  const filter = { task: task._id };

  let query = TaskComment.find(filter).populate(COMMENT_POPULATE).sort({ createdAt: 1 });
  if (limit !== null) {
    query = query.skip(offset).limit(limit);
  }

  const [comments, total] = await Promise.all([query, TaskComment.countDocuments(filter)]);
  res.json({ comments: comments.map((c) => c.toJSON()), total, limit, offset });
}

/** Anyone who can view the task: adds a comment `{ body }` (with @mentions). */
export async function addComment(req: Request, res: Response): Promise<void> {
  const task = await getViewableTaskOr404(req, res);
  if (!task) return;

  const user = req.user!;
  const body = validateBody(((req.body ?? {}) as CommentBody).body);
  if (typeof body !== "string") {
    res.status(400).json({ error: body.error });
    return;
  }

  const mentions = await resolveMentions(body, task);
  const comment = await TaskComment.create({
    task: task._id,
    author: user._id,
    body,
    mentions,
  });
  const taskId = task._id as mongoose.Types.ObjectId;

  recordTaskHistory(taskId, user, "comment_added", {
    commentId: comment._id.toString(),
    excerpt: excerpt(body),
  });
  notifyComment(task, comment, user, mentions, true);
  pushTaskUpdate(task, "comment-added", { commentId: comment._id.toString() });

  const populated = await TaskComment.findById(comment._id).populate(COMMENT_POPULATE);
  res.status(201).json({ comment: populated!.toJSON() });
}

/** Author only: edits a comment. Newly mentioned users are notified. */
export async function updateComment(req: Request, res: Response): Promise<void> {
  const task = await getViewableTaskOr404(req, res);
  if (!task) return;

  const comment = await getCommentOr404(req, res, task);
  if (!comment) return;

  const user = req.user!;
  if (!comment.author.equals(user._id)) {
    res.status(403).json({ error: "You can only edit your own comments" });
    return;
  }

  const body = validateBody(((req.body ?? {}) as CommentBody).body);
  if (typeof body !== "string") {
    res.status(400).json({ error: body.error });
    return;
  }

  const previous = new Set(comment.mentions.map((id) => id.toString()));
  const mentions = await resolveMentions(body, task);
  comment.body = body;
  comment.mentions = mentions;
  comment.editedAt = new Date();
  await comment.save();

  const newlyMentioned = mentions.filter((id) => !previous.has(id.toString()));
  if (newlyMentioned.length > 0) {
    notifyComment(task, comment, user, newlyMentioned, false);
  }
  pushTaskUpdate(task, "comment-updated", { commentId: comment._id.toString() });

  const populated = await TaskComment.findById(comment._id).populate(COMMENT_POPULATE);
  res.json({ comment: populated!.toJSON() });
}

/** Author, or anyone who manages the task (admin, creator, project manager): deletes a comment. */
export async function deleteComment(req: Request, res: Response): Promise<void> {
  const task = await getViewableTaskOr404(req, res);
  if (!task) return;

  const comment = await getCommentOr404(req, res, task);
  if (!comment) return;

  const user = req.user!;
  if (!comment.author.equals(user._id) && !(await canManageTaskAsync(user, task))) {
    res.status(403).json({ error: "You can only delete your own comments" });
    return;
  }

  await comment.deleteOne();
  pushTaskUpdate(task, "comment-deleted", { commentId: comment._id.toString() });

  res.json({ success: true });
}
