import type { Request, Response } from "express";
import mongoose from "mongoose";
import { notifyUsers } from "../lib/notifications.js";
import { parsePagination } from "../lib/pagination.js";
import {
  canContribute,
  canManageProject,
  canViewProject,
  ensureNotArchived,
  getProjectOr404,
  getViewableProjectOr404,
  isInvalidObjectId,
  param,
  projectLink,
  pushProjectUpdate,
  recordProjectActivity,
} from "../lib/projectAccess.js";
import type { IProject } from "../models/Project.js";
import { NOTE_VISIBILITIES, ProjectNote } from "../models/ProjectNote.js";
import type { IProjectNote, NoteVisibility } from "../models/ProjectNote.js";
import type { IUser } from "../models/User.js";
import { User } from "../models/User.js";

const NOTE_POPULATE = [
  { path: "author", select: "name email" },
  { path: "sharedWith", select: "name email" },
];

interface NoteBody {
  title?: unknown;
  body?: unknown;
  visibility?: unknown;
  sharedWith?: unknown;
}

/** members-visible notes: anyone who can view the project; private: author, sharedWith, admins. */
function canSeeNote(user: IUser, note: IProjectNote, project: IProject): boolean {
  if (user.role === "admin" || note.author.equals(user._id)) return true;
  if (note.sharedWith.some((id) => id.equals(user._id))) return true;
  return note.visibility === "members" && canViewProject(user, project);
}

function canEditNote(user: IUser, note: IProjectNote, project: IProject): boolean {
  return note.author.equals(user._id) || canManageProject(user, project);
}

async function parseSharedWith(raw: unknown): Promise<mongoose.Types.ObjectId[] | string> {
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string" || isInvalidObjectId(id))) {
    return "sharedWith must be an array of user IDs";
  }
  const ids = [...new Set(raw as string[])];
  if (ids.length > 100) return "sharedWith can contain at most 100 users";
  const count = await User.countDocuments({ _id: { $in: ids } });
  if (count !== ids.length) return "sharedWith user not found";
  return ids.map((id) => new mongoose.Types.ObjectId(id));
}

/** `project_note`: members-visible → manager + members; private → sharedWith. */
function notifyNote(project: IProject, note: IProjectNote, actor: IUser, recipients: mongoose.Types.ObjectId[]): void {
  if (recipients.length === 0) return;
  const projectId = project._id as mongoose.Types.ObjectId;
  notifyUsers({
    recipients,
    // Email people the note was shared with and the project's owners; members see it in the bell.
    emailOnly: [...note.sharedWith, ...(project.manager ? [project.manager] : []), project.createdBy],
    actor,
    type: "project_note",
    title: "New project note",
    message: `${actor.name} added a note "${note.title}" to ${project.code} · ${project.name}.`,
    link: projectLink(projectId, "notes"),
    project: projectId,
    email: {
      subject: `📝 ${project.name}: ${note.title}`,
      heading: note.visibility === "private" ? "A Note Was Shared With You" : "New Project Note",
      intro: `${actor.name} added a note to ${project.code} · ${project.name}.`,
      cardTitle: note.title,
      quote: note.body ? note.body.slice(0, 1000) : null,
      quoteAuthor: note.body ? actor.name : null,
      buttonLabel: "Open Notes",
    },
  });
}

function audienceFor(project: IProject, note: IProjectNote): mongoose.Types.ObjectId[] {
  if (note.visibility === "private") return [...note.sharedWith];
  return [...(project.manager ? [project.manager] : []), ...project.members.map((m) => m.user), ...note.sharedWith];
}

async function getNoteOr404(req: Request, res: Response, project: IProject): Promise<IProjectNote | undefined> {
  const nid = param(req, "nid");
  const note = nid && !isInvalidObjectId(nid) ? await ProjectNote.findOne({ _id: nid, project: project._id }) : null;
  if (!note || !canSeeNote(req.user!, note, project)) {
    res.status(404).json({ error: "Note not found" });
    return undefined;
  }
  return note;
}

/** GET /api/projects/:id/notes — notes the caller can see, newest first. */
export async function listNotes(req: Request, res: Response): Promise<void> {
  const project = await getViewableProjectOr404(req, res);
  if (!project) return;
  const user = req.user!;
  const { limit, offset } = parsePagination(req);
  const filter: Record<string, unknown> = { project: project._id };
  if (user.role !== "admin") {
    filter.$or = [{ visibility: "members" }, { author: user._id }, { sharedWith: user._id }];
  }
  let query = ProjectNote.find(filter).populate(NOTE_POPULATE).sort({ createdAt: -1 });
  if (limit !== null) query = query.skip(offset).limit(limit);
  const [notes, total] = await Promise.all([query, ProjectNote.countDocuments(filter)]);
  res.json({
    notes: notes.map((n) => ({
      ...(n.toJSON() as unknown as Record<string, unknown>),
      canEdit: canEditNote(user, n, project) && !project.archivedAt,
    })),
    total,
    limit,
    offset,
  });
}

/** POST /api/projects/:id/notes — `{ title, body?, visibility?, sharedWith? }`. */
export async function createNote(req: Request, res: Response): Promise<void> {
  const project = await getProjectOr404(req, res);
  if (!project) return;
  const actor = req.user!;
  if (!canContribute(actor, project)) {
    res.status(403).json({ error: "Only project members can add notes" });
    return;
  }
  if (!ensureNotArchived(project, res)) return;

  const { title, body, visibility, sharedWith } = (req.body ?? {}) as NoteBody;
  if (typeof title !== "string" || !title.trim() || title.trim().length > 150) {
    res.status(400).json({ error: "title is required (150 characters or fewer)" });
    return;
  }
  if (body !== undefined && body !== null && (typeof body !== "string" || body.length > 10000)) {
    res.status(400).json({ error: "body must be 10000 characters or fewer" });
    return;
  }
  if (visibility !== undefined && (typeof visibility !== "string" || !NOTE_VISIBILITIES.includes(visibility as NoteVisibility))) {
    res.status(400).json({ error: "visibility must be members or private" });
    return;
  }
  let shared: mongoose.Types.ObjectId[] = [];
  if (sharedWith !== undefined) {
    const parsed = await parseSharedWith(sharedWith);
    if (typeof parsed === "string") {
      res.status(400).json({ error: parsed });
      return;
    }
    shared = parsed;
  }

  const note = await ProjectNote.create({
    project: project._id,
    author: actor._id,
    title: title.trim(),
    body: typeof body === "string" ? body : "",
    visibility: (visibility as NoteVisibility) ?? "members",
    sharedWith: shared,
  });
  const projectId = project._id as mongoose.Types.ObjectId;
  recordProjectActivity(projectId, actor, "note_added", { title: note.title, visibility: note.visibility });
  notifyNote(project, note, actor, audienceFor(project, note));
  pushProjectUpdate(project, "note-changed", { noteId: note._id.toString() });

  const populated = await ProjectNote.findById(note._id).populate(NOTE_POPULATE);
  res.status(201).json({ note: { ...(populated!.toJSON() as unknown as Record<string, unknown>), canEdit: true } });
}

/** PATCH /api/projects/:id/notes/:nid — author or project manager/admin. */
export async function updateNote(req: Request, res: Response): Promise<void> {
  const project = await getProjectOr404(req, res);
  if (!project) return;
  const actor = req.user!;
  const note = await getNoteOr404(req, res, project);
  if (!note) return;
  if (!canEditNote(actor, note, project)) {
    res.status(403).json({ error: "Only the author or a project manager can edit this note" });
    return;
  }
  if (!ensureNotArchived(project, res)) return;

  const { title, body, visibility, sharedWith } = (req.body ?? {}) as NoteBody;
  if (title !== undefined) {
    if (typeof title !== "string" || !title.trim() || title.trim().length > 150) {
      res.status(400).json({ error: "title is required (150 characters or fewer)" });
      return;
    }
    note.title = title.trim();
  }
  if (body !== undefined) {
    if (body !== null && (typeof body !== "string" || body.length > 10000)) {
      res.status(400).json({ error: "body must be 10000 characters or fewer" });
      return;
    }
    note.body = typeof body === "string" ? body : "";
  }
  if (visibility !== undefined) {
    if (typeof visibility !== "string" || !NOTE_VISIBILITIES.includes(visibility as NoteVisibility)) {
      res.status(400).json({ error: "visibility must be members or private" });
      return;
    }
    note.visibility = visibility as NoteVisibility;
  }
  let newlyShared: mongoose.Types.ObjectId[] = [];
  if (sharedWith !== undefined) {
    const parsed = await parseSharedWith(sharedWith);
    if (typeof parsed === "string") {
      res.status(400).json({ error: parsed });
      return;
    }
    const before = new Set(note.sharedWith.map(String));
    newlyShared = parsed.filter((id) => !before.has(id.toString()));
    note.sharedWith = parsed;
  }
  await note.save();

  recordProjectActivity(project._id as mongoose.Types.ObjectId, actor, "note_updated", { title: note.title });
  notifyNote(project, note, actor, newlyShared);
  pushProjectUpdate(project, "note-changed", { noteId: note._id.toString() });
  const populated = await ProjectNote.findById(note._id).populate(NOTE_POPULATE);
  res.json({ note: { ...(populated!.toJSON() as unknown as Record<string, unknown>), canEdit: true } });
}

/** DELETE /api/projects/:id/notes/:nid */
export async function deleteNote(req: Request, res: Response): Promise<void> {
  const project = await getProjectOr404(req, res);
  if (!project) return;
  const actor = req.user!;
  const note = await getNoteOr404(req, res, project);
  if (!note) return;
  if (!canEditNote(actor, note, project)) {
    res.status(403).json({ error: "Only the author or a project manager can delete this note" });
    return;
  }
  if (!ensureNotArchived(project, res)) return;
  await note.deleteOne();
  recordProjectActivity(project._id as mongoose.Types.ObjectId, actor, "note_deleted", { title: note.title });
  pushProjectUpdate(project, "note-changed", { noteId: note._id.toString(), deleted: true });
  res.json({ success: true });
}
