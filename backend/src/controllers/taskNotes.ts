import type { Request, Response } from "express";
import mongoose from "mongoose";
import { isGuestUser, withoutPeopleEmails } from "../lib/guests.js";
import { notifyTask } from "../lib/notifications.js";
import {
  canManageTaskAsync,
  getViewableTaskOr404,
  isInvalidObjectId,
  param,
  pushTaskUpdate,
  recordTaskHistory,
} from "../lib/taskAccess.js";
import type { ITask } from "../models/Task.js";
import { TaskNote, TASK_NOTE_LIMITS, TASK_NOTE_VISIBILITIES } from "../models/TaskNote.js";
import type { ITaskNote, TaskNoteVisibility } from "../models/TaskNote.js";
import type { IUser } from "../models/User.js";
import { excerpt, plainText, resolveMentions } from "./taskComments.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOTE_POPULATE = [
  { path: "author", select: "name email" },
  { path: "mentions", select: "name email" },
];

interface NoteBody {
  title?: unknown;
  body?: unknown;
  visibility?: unknown;
  pinned?: unknown;
}

type Invalid = { error: string };

function isInvalid(value: unknown): value is Invalid {
  return typeof value === "object" && value !== null && "error" in value;
}

function parseTitle(raw: unknown): string | Invalid {
  if (raw === null || raw === undefined) return "";
  if (typeof raw !== "string") return { error: "title must be a string" };
  if (raw.trim().length > TASK_NOTE_LIMITS.maxTitle) {
    return { error: `title must be ${TASK_NOTE_LIMITS.maxTitle} characters or fewer` };
  }
  return raw.trim();
}

function parseBody(raw: unknown): string | Invalid {
  if (typeof raw !== "string" || !raw.trim()) return { error: "body is required" };
  if (raw.trim().length > TASK_NOTE_LIMITS.maxBody) {
    return { error: `body must be ${TASK_NOTE_LIMITS.maxBody} characters or fewer` };
  }
  return raw.trim();
}

function parseVisibility(raw: unknown): TaskNoteVisibility | Invalid {
  if (typeof raw === "string" && (TASK_NOTE_VISIBILITIES as readonly string[]).includes(raw)) {
    return raw as TaskNoteVisibility;
  }
  return { error: 'visibility must be "task" or "private"' };
}

/** Private notes are visible to their author and admins only. */
function canSeeNote(user: IUser, note: Pick<ITaskNote, "visibility" | "author">): boolean {
  return note.visibility === "task" || note.author.equals(user._id) || user.role === "admin";
}

/** Loads `:noteId` on the task — 404 when missing or private to someone else. */
async function getNoteOr404(req: Request, res: Response, task: ITask): Promise<ITaskNote | undefined> {
  const noteId = param(req, "noteId");
  const note =
    noteId && !isInvalidObjectId(noteId) ? await TaskNote.findOne({ _id: noteId, task: task._id }) : null;
  if (!note || !canSeeNote(req.user!, note)) {
    res.status(404).json({ error: "Note not found" });
    return undefined;
  }
  return note;
}

/** Serialized note + what the caller may do with it. */
function serializeNote(note: ITaskNote, user: IUser, manager: boolean): Record<string, unknown> {
  const json = note.toJSON() as Record<string, unknown>;
  const authorId = (note.author as unknown as { _id?: mongoose.Types.ObjectId })._id ?? note.author;
  const isAuthor = (authorId as mongoose.Types.ObjectId).equals(user._id);
  return {
    ...json,
    canEdit: isAuthor,
    canPin: isAuthor || manager,
    canDelete: isAuthor || manager || user.role === "admin",
  };
}

function noteLink(taskId: mongoose.Types.ObjectId): string {
  return `/tasks?task=${taskId.toString()}&tab=notes`;
}

/** Quote for the email: optional title line + plain-text body (mentions flattened). */
function noteQuote(note: Pick<ITaskNote, "title" | "body">): string {
  const body = plainText(note.body);
  const clipped = body.length > 1500 ? `${body.slice(0, 1499)}…` : body;
  return note.title ? `${note.title}\n\n${clipped}` : clipped;
}

/** task_note_mention to mentioned users; task_note to creator + assignees minus mentioned. */
function notifyNote(
  task: ITask,
  note: ITaskNote,
  actor: IUser,
  mentioned: mongoose.Types.ObjectId[],
  includeNoteRecipients: boolean
): void {
  if (note.visibility !== "task") return;
  const taskId = task._id as mongoose.Types.ObjectId;
  const emailTask = { _id: taskId, title: task.title, dueDate: task.dueDate, priority: task.priority };
  const label = note.title ? `"${note.title}"` : "a note";
  const quote = noteQuote(note);

  if (mentioned.length > 0) {
    notifyTask({
      recipients: mentioned,
      actor,
      type: "task_note_mention",
      task: emailTask,
      link: noteLink(taskId),
      title: "You were mentioned in a note",
      message: `${actor.name} mentioned you in ${label} on "${task.title}": ${excerpt(note.body)}`,
      email: {
        subject: `📝 ${actor.name} mentioned you in a note on: ${task.title}`,
        heading: "Mentioned in a Note",
        intro: `${actor.name} mentioned you in a task note.`,
        quote,
        quoteAuthor: actor.name,
        buttonLabel: "Open note",
      },
    });
  }

  if (!includeNoteRecipients) return;
  const mentionedSet = new Set(mentioned.map((id) => id.toString()));
  notifyTask({
    recipients: [...task.assignees, task.assignedBy].filter((id) => !mentionedSet.has(id.toString())),
    actor,
    type: "task_note",
    task: emailTask,
    link: noteLink(taskId),
    title: "New task note",
    message: `${actor.name} added ${label} to "${task.title}".`,
    email: {
      subject: `📝 New note on: ${task.title}`,
      heading: "New Task Note",
      intro: `${actor.name} added a note to this task.`,
      quote,
      quoteAuthor: actor.name,
      buttonLabel: "Open note",
    },
  });
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

/** Anyone who can view the task: notes they may see, pinned first then newest. */
export async function listNotes(req: Request, res: Response): Promise<void> {
  const task = await getViewableTaskOr404(req, res);
  if (!task) return;

  const user = req.user!;
  const filter: Record<string, unknown> = { task: task._id };
  if (user.role !== "admin") {
    filter.$or = [{ visibility: "task" }, { author: user._id }];
  }
  const [notes, manager] = await Promise.all([
    TaskNote.find(filter).populate(NOTE_POPULATE).sort({ pinned: -1, createdAt: -1 }).limit(200),
    canManageTaskAsync(user, task),
  ]);
  const rows = notes.map((n) => serializeNote(n, user, manager));
  res.json({ notes: isGuestUser(user) ? withoutPeopleEmails(rows) : rows, total: notes.length });
}

/** Anyone who can view the task: adds a note `{ title?, body, visibility }`. */
export async function addNote(req: Request, res: Response): Promise<void> {
  const task = await getViewableTaskOr404(req, res);
  if (!task) return;

  const user = req.user!;
  const input = (req.body ?? {}) as NoteBody;
  const title = parseTitle(input.title);
  if (isInvalid(title)) {
    res.status(400).json({ error: title.error });
    return;
  }
  const body = parseBody(input.body);
  if (isInvalid(body)) {
    res.status(400).json({ error: body.error });
    return;
  }
  const visibility = input.visibility === undefined ? "task" : parseVisibility(input.visibility);
  if (isInvalid(visibility)) {
    res.status(400).json({ error: visibility.error });
    return;
  }

  // Private notes ignore mentions (nobody else can read them).
  const mentions = visibility === "task" ? await resolveMentions(body, task) : [];
  const note = await TaskNote.create({ task: task._id, author: user._id, title, body, visibility, mentions });
  const taskId = task._id as mongoose.Types.ObjectId;

  if (visibility === "task") {
    recordTaskHistory(taskId, user, "note_added", { noteId: note._id.toString(), title: title || null });
  }
  notifyNote(task, note, user, mentions, true);
  pushTaskUpdate(task, "note-added", { noteId: note._id.toString() });

  const [populated, manager] = await Promise.all([
    TaskNote.findById(note._id).populate(NOTE_POPULATE),
    canManageTaskAsync(user, task),
  ]);
  res.status(201).json({ note: serializeNote(populated!, user, manager) });
}

/**
 * Author: edits `{ title?, body?, visibility? }`. Author or task manager:
 * `{ pinned }`. Newly mentioned users are notified (task-visible notes only).
 */
export async function updateNote(req: Request, res: Response): Promise<void> {
  const task = await getViewableTaskOr404(req, res);
  if (!task) return;
  const note = await getNoteOr404(req, res, task);
  if (!note) return;

  const user = req.user!;
  const input = (req.body ?? {}) as NoteBody;
  const isAuthor = note.author.equals(user._id);
  const manager = await canManageTaskAsync(user, task);
  const editing = input.title !== undefined || input.body !== undefined || input.visibility !== undefined;

  if (!editing && input.pinned === undefined) {
    res.status(400).json({ error: "At least one field to update is required" });
    return;
  }
  if (editing && !isAuthor) {
    res.status(403).json({ error: "You can only edit your own notes" });
    return;
  }
  if (input.pinned !== undefined) {
    if (!isAuthor && !manager) {
      res.status(403).json({ error: "Only the author or the task's managers can pin notes" });
      return;
    }
    if (typeof input.pinned !== "boolean") {
      res.status(400).json({ error: "pinned must be a boolean" });
      return;
    }
  }

  const fields: string[] = [];
  if (input.title !== undefined) {
    const title = parseTitle(input.title);
    if (isInvalid(title)) {
      res.status(400).json({ error: title.error });
      return;
    }
    if ((note.title ?? "") !== title) {
      note.title = title;
      fields.push("title");
    }
  }
  if (input.body !== undefined) {
    const body = parseBody(input.body);
    if (isInvalid(body)) {
      res.status(400).json({ error: body.error });
      return;
    }
    if (note.body !== body) {
      note.body = body;
      fields.push("body");
    }
  }
  if (input.visibility !== undefined) {
    const visibility = parseVisibility(input.visibility);
    if (isInvalid(visibility)) {
      res.status(400).json({ error: visibility.error });
      return;
    }
    if (note.visibility !== visibility) {
      note.visibility = visibility;
      fields.push("visibility");
    }
  }
  if (typeof input.pinned === "boolean" && note.pinned !== input.pinned) {
    note.pinned = input.pinned;
    fields.push("pinned");
  }

  const previous = new Set(note.mentions.map((id) => id.toString()));
  let newlyMentioned: mongoose.Types.ObjectId[] = [];
  if (fields.some((f) => f === "body" || f === "visibility")) {
    const mentions = note.visibility === "task" ? await resolveMentions(note.body, task) : [];
    newlyMentioned = mentions.filter((id) => !previous.has(id.toString()));
    note.mentions = mentions;
  }
  if (fields.some((f) => f !== "pinned")) note.editedAt = new Date();
  await note.save();

  const taskId = task._id as mongoose.Types.ObjectId;
  if (fields.length > 0 && note.visibility === "task") {
    recordTaskHistory(taskId, user, "note_updated", {
      noteId: note._id.toString(),
      title: note.title || null,
      fields,
    });
  }
  if (newlyMentioned.length > 0) notifyNote(task, note, user, newlyMentioned, false);
  pushTaskUpdate(task, "note-updated", { noteId: note._id.toString() });

  const populated = await TaskNote.findById(note._id).populate(NOTE_POPULATE);
  res.json({ note: serializeNote(populated!, user, manager) });
}

/** Author, task manager or admin: deletes a note. */
export async function deleteNote(req: Request, res: Response): Promise<void> {
  const task = await getViewableTaskOr404(req, res);
  if (!task) return;
  const note = await getNoteOr404(req, res, task);
  if (!note) return;

  const user = req.user!;
  if (!note.author.equals(user._id) && !(await canManageTaskAsync(user, task))) {
    res.status(403).json({ error: "You can only delete your own notes" });
    return;
  }

  await note.deleteOne();
  if (note.visibility === "task") {
    recordTaskHistory(task._id as mongoose.Types.ObjectId, user, "note_removed", {
      noteId: note._id.toString(),
      title: note.title || null,
    });
  }
  pushTaskUpdate(task, "note-deleted", { noteId: note._id.toString() });
  res.json({ success: true });
}
