import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import multer from "multer";
import { logActivity } from "../lib/activityLog.js";
import { deleteFromGridFs, openGridFsDownload, uploadToGridFs } from "../lib/gridfs.js";
import { parsePagination, searchRegex } from "../lib/pagination.js";
import { departmentUserIds, isProjectManager, isProjectMember, canViewProject } from "../lib/projectAccess.js";
import { isInvalidObjectId, loadTaskDetail, param, parseDateOnly } from "../lib/taskAccess.js";
import { appToday } from "../lib/appTime.js";
import { appUrl } from "../lib/email.js";
import { aiEnabled, AiExtractionError, extractActionItems } from "../lib/transcripts/ai.js";
import type { AiItem } from "../lib/transcripts/ai.js";
import { EXPORT_HINT } from "../lib/transcripts/common.js";
import { buildAttendees, cleanTitle, generateHints, hintSegmentIdxs } from "../lib/transcripts/hints.js";
import type { HintSuggestion } from "../lib/transcripts/hints.js";
import { fileExtension, formatTimestamp, parseTranscriptFile, parseTranscriptText, TranscriptError } from "../lib/transcripts/index.js";
import type { ParseResult } from "../lib/transcripts/index.js";
import { candidateUsers, canonicalSpeakerName, matchName, matchSpeakers, normalizeName } from "../lib/transcripts/match.js";
import type { CandidateUser } from "../lib/transcripts/match.js";
import { MEETING_FILES_BUCKET, MEETING_LIMITS, Meeting } from "../models/Meeting.js";
import type { ActionItemStatus, IActionItem, IMeeting } from "../models/Meeting.js";
import { Project } from "../models/Project.js";
import type { IProject } from "../models/Project.js";
import { Task, TASK_PRIORITIES } from "../models/Task.js";
import type { TaskPriority } from "../models/Task.js";
import type { IUser } from "../models/User.js";
import { User } from "../models/User.js";
import { createTaskCore, isInvalid } from "./tasks.js";
import type { CreateTaskBody, Invalid } from "./tasks.js";

// ---------------------------------------------------------------------------
// Meeting transcripts → action items → tasks (/api/meetings)
// ---------------------------------------------------------------------------

const PREVIEW_SEGMENTS = 50;
const TEXT_MIMES: Record<string, string> = {
  vtt: "text/vtt",
  txt: "text/plain",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function send(res: Response, invalid: Invalid): void {
  res.status(invalid.status).json({ error: invalid.error });
}

function bad(error: string, status = 400): Invalid {
  return { status, error };
}

// ---------------------------------------------------------------------------
// Upload middleware (single "file" field, memory storage → GridFS)
// ---------------------------------------------------------------------------

class UnsupportedTypeError extends Error {}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MEETING_LIMITS.maxFileBytes, files: 1, fieldSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = fileExtension(file.originalname);
    if (ext === "vtt" || ext === "docx" || ext === "txt") cb(null, true);
    else cb(new UnsupportedTypeError(`"${file.originalname}" isn't a supported transcript. ${EXPORT_HINT}`));
  },
});

/** multer for the optional `file` field; 413 for size, 415 for type. JSON bodies pass straight through. */
export function uploadTranscriptMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!req.is("multipart/form-data")) {
    next();
    return;
  }
  upload.single("file")(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof UnsupportedTypeError) {
      res.status(415).json({ error: err.message });
      return;
    }
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: `Transcript files must be ${MEETING_LIMITS.maxFileBytes / (1024 * 1024)} MB or smaller` });
        return;
      }
      if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
        res.status(400).json({ error: 'Upload one transcript using the "file" field' });
        return;
      }
      if (err.code === "LIMIT_FIELD_VALUE") {
        res.status(413).json({ error: "The pasted transcript is too long" });
        return;
      }
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  });
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

type ProjectLike = Pick<IProject, "manager" | "members" | "createdBy" | "departments" | "isPublic" | "archivedAt"> & {
  _id: unknown;
};

/** Create a meeting in a project: admins, heads who can view it, members and the manager. */
function canCreateMeetingIn(user: IUser, project: ProjectLike): boolean {
  if (user.role === "admin") return true;
  if (user.role === "head" && canViewProject(user, project)) return true;
  return isProjectMember(user, project) || isProjectManager(user, project);
}

export interface MeetingPermissions {
  canView: boolean;
  /** Notes, speaker mapping, suggestions, regenerate hints, AI extraction. */
  canEdit: boolean;
  canDelete: boolean;
  /** Create tasks from items (each task still goes through the task rules). */
  canCreateTasks: boolean;
}

/**
 * View: creator, admins; for project meetings also project members/manager,
 * mapped speakers and the head of the creator's department. Meetings without a
 * project are private to the creator and admins.
 * Edit/delete: creator, admins, the project manager.
 */
async function meetingPermissions(
  user: IUser,
  meeting: Pick<IMeeting, "createdBy" | "project" | "speakers">,
  project: ProjectLike | null
): Promise<MeetingPermissions> {
  const isCreator = meeting.createdBy.equals(user._id);
  const manager = Boolean(project && isProjectManager(user, project));
  const edit = user.role === "admin" || isCreator || manager;
  let view = edit;
  if (!view && meeting.project && project) {
    if (isProjectMember(user, project)) view = true;
    else if (meeting.speakers.some((s) => s.user && s.user.equals(user._id))) view = true;
    else if (user.role === "head" && user.department) {
      view = Boolean(await User.exists({ _id: meeting.createdBy, department: user.department }));
    }
  }
  return { canView: view, canEdit: edit, canDelete: edit, canCreateTasks: view };
}

/** Mongo filter for every meeting `user` may view (mirrors `meetingPermissions`). */
async function meetingVisibilityFilter(user: IUser): Promise<Record<string, unknown>> {
  if (user.role === "admin") return {};
  const projects = await Project.find({ $or: [{ "members.user": user._id }, { manager: user._id }] }).select("_id").lean();
  const or: Record<string, unknown>[] = [
    { createdBy: user._id },
    { project: { $in: projects.map((p) => p._id) } },
    { project: { $ne: null }, "speakers.user": user._id },
  ];
  if (user.role === "head" && user.department) {
    const ids = await departmentUserIds(user.department);
    or.push({ project: { $ne: null }, createdBy: { $in: ids } });
  }
  return { $or: or };
}

interface LoadedMeeting {
  meeting: IMeeting;
  project: IProject | null;
  permissions: MeetingPermissions;
}

/** Loads `:id` and enforces view (or edit) access: 404 / 403. */
async function loadMeeting(req: Request, res: Response, need: "view" | "edit" = "view"): Promise<LoadedMeeting | undefined> {
  const id = param(req, "id");
  const meeting = id && !isInvalidObjectId(id) ? await Meeting.findById(id) : null;
  if (!meeting) {
    res.status(404).json({ error: "Meeting not found" });
    return undefined;
  }
  const project = meeting.project ? await Project.findById(meeting.project) : null;
  const permissions = await meetingPermissions(req.user!, meeting, project);
  if (!permissions.canView) {
    res.status(403).json({ error: "You don't have access to this meeting" });
    return undefined;
  }
  if (need === "edit" && !permissions.canEdit) {
    res.status(403).json({ error: "Only the meeting creator, the project manager or an admin can change this meeting" });
    return undefined;
  }
  return { meeting, project, permissions };
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

/** Resolves an optional `project` field for create/preview/patch. */
async function resolveMeetingProject(user: IUser, raw: unknown): Promise<IProject | null | Invalid> {
  if (raw === undefined || raw === null || raw === "" || raw === "null") return null;
  if (typeof raw !== "string" || isInvalidObjectId(raw)) return bad("project must be a valid project ID or null");
  const project = await Project.findById(raw);
  if (!project) return bad("Project not found", 404);
  if (project.archivedAt) return bad("This project is archived and read-only", 409);
  if (!canCreateMeetingIn(user, project)) return bad("You can only add meetings to projects you're a member or manager of", 403);
  return project;
}

/** Parses the uploaded file (multipart `file`) or `text`. */
async function parseRequestTranscript(req: Request): Promise<{ parsed: ParseResult; source: "upload" | "paste" } | Invalid> {
  try {
    if (req.file) {
      return { parsed: await parseTranscriptFile(req.file.buffer, req.file.originalname), source: "upload" };
    }
    const text = (req.body as { text?: unknown } | undefined)?.text;
    if (typeof text === "string" && text.trim()) {
      return { parsed: parseTranscriptText(text), source: "paste" };
    }
    return bad(`Upload a transcript file or paste the transcript text. ${EXPORT_HINT}`);
  } catch (err) {
    if (err instanceof TranscriptError) return bad(err.message, err.status);
    console.error("[meetings] transcript parse failed:", err);
    return bad(`The transcript couldn't be read. ${EXPORT_HINT}`);
  }
}

/** Optional date-only field; undefined = absent. */
function parseMeetingDate(raw: unknown): Date | undefined | Invalid {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const date = parseDateOnly(raw);
  return date ?? bad("meetingDate must be a valid date (YYYY-MM-DD)");
}

function parseTitle(raw: unknown, fallback: string | null): string | Invalid {
  const title = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!title) {
    if (fallback) return fallback.slice(0, MEETING_LIMITS.titleMax);
    return bad("title is required");
  }
  if (title.length > MEETING_LIMITS.titleMax) return bad(`title must be ${MEETING_LIMITS.titleMax} characters or fewer`);
  return title;
}

/** `[{ name, user }]` (array, or a JSON string from multipart) → name(lower) → user id | null. */
async function parseSpeakerMapping(raw: unknown): Promise<Map<string, mongoose.Types.ObjectId | null> | undefined | Invalid> {
  if (raw === undefined || raw === null || raw === "") return undefined;
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return bad("speakers must be a JSON array of { name, user }");
    }
  }
  if (!Array.isArray(value) || value.length > MEETING_LIMITS.maxSpeakers) {
    return bad("speakers must be an array of { name, user }");
  }
  const map = new Map<string, mongoose.Types.ObjectId | null>();
  const ids = new Set<string>();
  for (const entry of value) {
    const e = (entry ?? {}) as { name?: unknown; user?: unknown };
    if (typeof e.name !== "string" || !e.name.trim()) return bad("Each speaker needs a name");
    if (e.user === null || e.user === undefined || e.user === "") {
      map.set(e.name.trim().toLowerCase(), null);
      continue;
    }
    if (typeof e.user !== "string" || isInvalidObjectId(e.user)) return bad("speakers[].user must be a user ID or null");
    ids.add(e.user);
    map.set(e.name.trim().toLowerCase(), new mongoose.Types.ObjectId(e.user));
  }
  if (ids.size > 0) {
    const found = await User.countDocuments({ _id: { $in: [...ids] } });
    if (found !== ids.size) return bad("Speaker user not found", 404);
  }
  return map;
}

function parsePriority(raw: unknown): TaskPriority | undefined | Invalid {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !TASK_PRIORITIES.includes(raw as TaskPriority)) {
    return bad("priority must be one of: low, medium, high, urgent");
  }
  return raw as TaskPriority;
}

function parseSegmentIdxs(raw: unknown, segmentCount: number): number[] | Invalid {
  if (!Array.isArray(raw) || raw.length === 0) return bad("segmentIdxs must be a non-empty array of segment indexes");
  if (raw.length > MEETING_LIMITS.maxSegmentsPerItem) return bad(`Select at most ${MEETING_LIMITS.maxSegmentsPerItem} segments`);
  if (raw.some((n) => !Number.isInteger(n) || (n as number) < 0 || (n as number) >= segmentCount)) {
    return bad("segmentIdxs contains an unknown segment");
  }
  return [...new Set(raw as number[])].sort((a, b) => a - b);
}

function quoteOf(meeting: Pick<IMeeting, "segments">, idxs: number[]): string {
  const byIdx = new Map(meeting.segments.map((s) => [s.idx, s]));
  return idxs
    .map((i) => byIdx.get(i)?.text ?? "")
    .filter(Boolean)
    .join(" ")
    .slice(0, MEETING_LIMITS.quoteMax);
}

function overlaps(a: number[], b: number[]): boolean {
  const set = new Set(a);
  return b.some((n) => set.has(n));
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

const DETAIL_POPULATE = [
  { path: "project", select: "name code archivedAt" },
  { path: "createdBy", select: "name email" },
  { path: "speakers.user", select: "name email" },
  { path: "actionItems.assignee", select: "name email" },
  { path: "actionItems.task", select: "title status shortCode number dueDate" },
];

function dateKey(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/** Full meeting for GET /:id (and every mutation response). */
async function meetingDetail(id: mongoose.Types.ObjectId, permissions: MeetingPermissions): Promise<Record<string, unknown> | null> {
  const meeting = await Meeting.findById(id).populate(DETAIL_POPULATE);
  if (!meeting) return null;
  const json = meeting.toJSON() as unknown as Record<string, unknown> & {
    file?: Record<string, unknown> | null;
    actionItems: Array<Record<string, unknown>>;
  };
  if (json.file) delete json.file.gridFsId;
  return {
    meeting: {
      ...json,
      meetingDate: dateKey(meeting.meetingDate),
      actionItems: json.actionItems.map((item) => ({
        ...item,
        dueDate: dateKey(item.dueDate as Date | null),
        task: item.task ?? null,
      })),
      hintSegmentIdxs: hintSegmentIdxs(meeting.segments, meeting.meetingDate, meeting.speakers.map((sp) => ({ name: sp.name }))),
    },
    permissions: { canEdit: permissions.canEdit, canDelete: permissions.canDelete, canCreateTasks: permissions.canCreateTasks },
    aiEnabled: aiEnabled(),
  };
}

/** One populated action item (items endpoints). */
async function itemDetail(meetingId: mongoose.Types.ObjectId, itemId: mongoose.Types.ObjectId): Promise<Record<string, unknown> | null> {
  const meeting = await Meeting.findById(meetingId).select("actionItems").populate(DETAIL_POPULATE.slice(3));
  const item = meeting?.actionItems.id(itemId);
  if (!item) return null;
  const json = item.toJSON() as unknown as Record<string, unknown>;
  return { ...json, dueDate: dateKey(item.dueDate ?? null), task: json.task ?? null };
}

function hintToItem(h: HintSuggestion): Partial<IActionItem> {
  return {
    segmentIdxs: h.segmentIdxs,
    quote: h.quote,
    title: h.title,
    assignee: h.assignee,
    assigneeName: h.assigneeName,
    dueDate: h.dueDate,
    priority: h.priority,
    origin: "hint",
    status: "suggested",
    task: null,
  };
}

/** Keeps the best-scoring hints when there are more than `room`, in transcript order. */
function capHints(hints: HintSuggestion[], room: number): HintSuggestion[] {
  if (hints.length <= room) return hints;
  return [...hints]
    .sort((a, b) => b.score - a.score || a.segmentIdxs[0]! - b.segmentIdxs[0]!)
    .slice(0, Math.max(0, room))
    .sort((a, b) => a.segmentIdxs[0]! - b.segmentIdxs[0]!);
}

function speakerList(
  names: string[],
  mapping: Map<string, mongoose.Types.ObjectId | null> | undefined,
  matches: Map<string, CandidateUser | null>
): Array<{ name: string; user: mongoose.Types.ObjectId | null }> {
  return names.map((name) => {
    const key = name.toLowerCase();
    if (mapping?.has(key)) return { name, user: mapping.get(key) ?? null };
    return { name, user: matches.get(name)?._id ?? null };
  });
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

/** GET /config — `{ aiEnabled }`. */
export function meetingConfig(_req: Request, res: Response): void {
  res.json({ aiEnabled: aiEnabled() });
}

/** GET / — meetings the caller can view. Filters: project (id | "none"), from, to, search; pagination. */
export async function listMeetings(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const and: Record<string, unknown>[] = [await meetingVisibilityFilter(user)];

  const project = req.query.project;
  if (project === "none") and.push({ project: null });
  else if (typeof project === "string" && project) {
    if (isInvalidObjectId(project)) return send(res, bad("project must be a project ID or \"none\""));
    and.push({ project: new mongoose.Types.ObjectId(project) });
  }
  const from = req.query.from !== undefined ? parseDateOnly(req.query.from) : undefined;
  const to = req.query.to !== undefined ? parseDateOnly(req.query.to) : undefined;
  if (from === null || to === null) return send(res, bad("from/to must be dates (YYYY-MM-DD)"));
  if (from || to) {
    const range: Record<string, Date> = {};
    if (from) range.$gte = from;
    if (to) range.$lte = to;
    and.push({ meetingDate: range });
  }
  const search = searchRegex(req.query.search);
  if (search) and.push({ $or: [{ title: search }, { notes: search }] });

  const filter = { $and: and };
  const { limit, offset } = parsePagination(req);
  const statusCount = (status: ActionItemStatus) => ({
    $size: { $filter: { input: "$actionItems", cond: { $eq: ["$$this.status", status] } } },
  });
  const pipeline: mongoose.PipelineStage[] = [{ $match: filter }, { $sort: { meetingDate: -1, createdAt: -1 } }];
  if (offset) pipeline.push({ $skip: offset });
  if (limit !== null) pipeline.push({ $limit: limit });
  pipeline.push({
    $project: {
      title: 1,
      meetingDate: 1,
      project: 1,
      source: 1,
      "file.filename": 1,
      "file.mimeType": 1,
      "file.size": 1,
      speakers: 1,
      createdBy: 1,
      aiExtractedAt: 1,
      createdAt: 1,
      updatedAt: 1,
      counts: {
        segments: { $size: "$segments" },
        suggested: statusCount("suggested"),
        tasksCreated: statusCount("task_created"),
        dismissed: statusCount("dismissed"),
      },
    },
  });

  const [rows, total] = await Promise.all([Meeting.aggregate(pipeline), Meeting.countDocuments(filter)]);
  await Meeting.populate(rows, [
    { path: "project", select: "name code archivedAt" },
    { path: "createdBy", select: "name email" },
    { path: "speakers.user", select: "name email" },
  ]);
  const meetings = (rows as Array<Record<string, unknown>>).map((r) => ({
    ...r,
    meetingDate: dateKey(r.meetingDate as Date),
    file: r.file && (r.file as Record<string, unknown>).filename ? r.file : null,
  }));
  res.json({ meetings, total, limit, offset });
}

/** POST /preview — parse without saving: first 50 segments, count, speakers with auto-matched users. */
export async function previewMeeting(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const project = await resolveMeetingProject(user, (req.body as { project?: unknown } | undefined)?.project);
  if (isInvalid(project)) return send(res, project);
  const result = await parseRequestTranscript(req);
  if (isInvalid(result)) return send(res, result);
  const { parsed } = result;

  const candidates = await candidateUsers(user, project);
  const matches = matchSpeakers(parsed.speakers, candidates);
  res.json({
    source: result.source,
    filename: req.file?.originalname ?? null,
    segments: parsed.segments.slice(0, PREVIEW_SEGMENTS),
    segmentCount: parsed.segments.length,
    speakers: parsed.speakers.map((name) => {
      const m = matches.get(name);
      return { name, matchedUser: m ? { _id: m._id, name: m.name, email: m.email } : null };
    }),
    warnings: parsed.warnings,
    candidates: candidates.map((c) => ({ _id: c._id, name: c.name, email: c.email })),
  });
}

/** POST / — parse, store (file → GridFS), generate hint suggestions; returns the meeting detail. */
export async function createMeeting(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const body = (req.body ?? {}) as { title?: unknown; meetingDate?: unknown; project?: unknown; speakers?: unknown; notes?: unknown };

  const project = await resolveMeetingProject(user, body.project);
  if (isInvalid(project)) return send(res, project);
  const meetingDate = parseMeetingDate(body.meetingDate);
  if (isInvalid(meetingDate)) return send(res, meetingDate);
  const date = meetingDate ?? appToday();
  const fallbackTitle = req.file ? req.file.originalname.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim() : `Meeting on ${dateKey(date)}`;
  const title = parseTitle(body.title, fallbackTitle || `Meeting on ${dateKey(date)}`);
  if (isInvalid(title)) return send(res, title);
  const mapping = await parseSpeakerMapping(body.speakers);
  if (isInvalid(mapping)) return send(res, mapping);
  if (body.notes !== undefined && (typeof body.notes !== "string" || body.notes.length > MEETING_LIMITS.notesMax)) {
    return send(res, bad(`notes must be ${MEETING_LIMITS.notesMax} characters or fewer`));
  }

  const result = await parseRequestTranscript(req);
  if (isInvalid(result)) return send(res, result);
  const { parsed, source } = result;

  const candidates = await candidateUsers(user, project);
  const speakers = speakerList(parsed.speakers, mapping, matchSpeakers(parsed.speakers, candidates));
  const hints = capHints(generateHints(parsed.segments, speakers, date, candidates), MEETING_LIMITS.maxActionItems);

  let gridFsId: mongoose.Types.ObjectId | null = null;
  if (req.file) {
    gridFsId = await uploadToGridFs(
      req.file.buffer,
      req.file.originalname,
      { uploadedBy: user._id, kind: "meetingTranscript" },
      MEETING_FILES_BUCKET
    );
  }
  let meeting: IMeeting;
  try {
    meeting = await Meeting.create({
      title,
      meetingDate: date,
      project: project ? project._id : null,
      source,
      file:
        req.file && gridFsId
          ? {
              filename: req.file.originalname,
              mimeType: TEXT_MIMES[fileExtension(req.file.originalname)] ?? req.file.mimetype,
              size: req.file.size,
              gridFsId,
            }
          : null,
      segments: parsed.segments,
      speakers,
      notes: typeof body.notes === "string" ? body.notes : "",
      actionItems: hints.map(hintToItem),
      createdBy: user._id,
    });
  } catch (err) {
    if (gridFsId) await deleteFromGridFs(gridFsId, MEETING_FILES_BUCKET);
    throw err;
  }
  const meetingId = meeting._id as mongoose.Types.ObjectId;

  logActivity({
    action: "meeting_created",
    actor: user,
    targetType: "meeting",
    targetId: meetingId,
    targetName: meeting.title,
    details: { source, segments: parsed.segments.length, suggestions: hints.length, project: project?.code ?? null },
    ip: req.ip,
  });

  const permissions = await meetingPermissions(user, meeting, project);
  const detail = await meetingDetail(meetingId, permissions);
  res.status(201).json({ ...detail, warnings: parsed.warnings });
}

/** GET /:id — full meeting with segments, speakers, populated suggestions and permissions. */
export async function getMeeting(req: Request, res: Response): Promise<void> {
  const loaded = await loadMeeting(req, res);
  if (!loaded) return;
  res.json(await meetingDetail(loaded.meeting._id as mongoose.Types.ObjectId, loaded.permissions));
}

/** GET /:id/assignees — users items can be assigned / speakers mapped to (project members, else the assignable rule). */
export async function meetingAssignees(req: Request, res: Response): Promise<void> {
  const loaded = await loadMeeting(req, res);
  if (!loaded) return;
  const users = await candidateUsers(req.user!, loaded.project);
  res.json({ users: users.map((u) => ({ _id: u._id, name: u.name, email: u.email })) });
}

/** PATCH /:id — title, meetingDate, project, notes, speakers (re-maps matching suggestion owners). */
export async function updateMeeting(req: Request, res: Response): Promise<void> {
  const loaded = await loadMeeting(req, res, "edit");
  if (!loaded) return;
  const { meeting } = loaded;
  let { project } = loaded;
  const user = req.user!;
  const body = (req.body ?? {}) as { title?: unknown; meetingDate?: unknown; project?: unknown; notes?: unknown; speakers?: unknown };

  if (body.title !== undefined) {
    const title = parseTitle(body.title, null);
    if (isInvalid(title)) return send(res, title);
    meeting.title = title;
  }
  if (body.meetingDate !== undefined) {
    const date = parseMeetingDate(body.meetingDate);
    if (isInvalid(date)) return send(res, date);
    if (!date) return send(res, bad("meetingDate can't be empty"));
    meeting.meetingDate = date;
  }
  if (body.project !== undefined) {
    const current = meeting.project?.toString() ?? null;
    const next = body.project === null || body.project === "" ? null : body.project;
    if (next !== current) {
      const resolved = await resolveMeetingProject(user, next);
      if (isInvalid(resolved)) return send(res, resolved);
      project = resolved;
      meeting.project = resolved ? (resolved._id as mongoose.Types.ObjectId) : null;
    }
  }
  if (body.notes !== undefined) {
    if (body.notes !== null && typeof body.notes !== "string") return send(res, bad("notes must be a string"));
    const notes = (body.notes ?? "") as string;
    if (notes.length > MEETING_LIMITS.notesMax) return send(res, bad(`notes must be ${MEETING_LIMITS.notesMax} characters or fewer`));
    meeting.notes = notes;
  }
  if (body.speakers !== undefined) {
    const mapping = await parseSpeakerMapping(body.speakers);
    if (isInvalid(mapping)) return send(res, mapping);
    for (const [key, userId] of mapping ?? []) {
      const speaker = meeting.speakers.find((s) => s.name.toLowerCase() === key);
      if (!speaker) return send(res, bad(`Unknown speaker "${key}"`));
      const changed = String(speaker.user ?? "") !== String(userId ?? "");
      speaker.user = userId;
      if (!changed) continue;
      // Re-map un-actioned suggestions owned by this speaker.
      for (const item of meeting.actionItems) {
        if (item.status === "suggested" && item.assigneeName && item.assigneeName.toLowerCase() === key) item.assignee = userId;
      }
    }
  }
  await meeting.save();
  const permissions = await meetingPermissions(user, meeting, project);
  res.json(await meetingDetail(meeting._id as mongoose.Types.ObjectId, permissions));
}

/** DELETE /:id — deletes the meeting and its GridFS file; tasks are kept with `sourceMeeting` unset. */
export async function deleteMeeting(req: Request, res: Response): Promise<void> {
  const loaded = await loadMeeting(req, res, "edit");
  if (!loaded) return;
  const { meeting } = loaded;
  const meetingId = meeting._id as mongoose.Types.ObjectId;
  const unlinked = await Task.updateMany({ "sourceMeeting.meeting": meetingId }, { $set: { sourceMeeting: null } });
  await Meeting.deleteOne({ _id: meetingId });
  if (meeting.file?.gridFsId) await deleteFromGridFs(meeting.file.gridFsId, MEETING_FILES_BUCKET);
  logActivity({
    action: "meeting_deleted",
    actor: req.user!,
    targetType: "meeting",
    targetId: meetingId,
    targetName: meeting.title,
    details: { tasksUnlinked: unlinked.modifiedCount },
    ip: req.ip,
  });
  res.json({ success: true, tasksUnlinked: unlinked.modifiedCount });
}

/** RFC 5987 Content-Disposition with an ASCII fallback. */
function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** GET /:id/file — downloads the original transcript (404 for pasted meetings). */
export async function downloadMeetingFile(req: Request, res: Response): Promise<void> {
  const loaded = await loadMeeting(req, res);
  if (!loaded) return;
  const file = loaded.meeting.file;
  if (!file?.gridFsId) {
    res.status(404).json({ error: "This meeting has no uploaded file" });
    return;
  }
  const stream = openGridFsDownload(file.gridFsId, MEETING_FILES_BUCKET);
  stream.once("error", () => {
    if (!res.headersSent) res.status(404).json({ error: "File not found" });
    else res.end();
  });
  stream.once("file", () => {
    res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
    res.setHeader("Content-Length", String(file.size));
    res.setHeader("Content-Disposition", contentDisposition(file.filename));
    res.setHeader("X-Content-Type-Options", "nosniff");
  });
  stream.pipe(res);
}

/** POST /:id/hints — regenerates hint suggestions (only un-actioned hint suggestions are replaced). */
export async function regenerateHints(req: Request, res: Response): Promise<void> {
  const loaded = await loadMeeting(req, res, "edit");
  if (!loaded) return;
  const { meeting, project, permissions } = loaded;

  const removed = meeting.actionItems.filter((i) => i.origin === "hint" && i.status === "suggested");
  for (const item of removed) meeting.actionItems.pull(item._id);
  const kept = meeting.actionItems.map((i) => i.segmentIdxs);

  const candidates = await candidateUsers(req.user!, project);
  const hints = generateHints(meeting.segments, meeting.speakers, meeting.meetingDate, candidates).filter(
    (h) => !kept.some((idxs) => overlaps(idxs, h.segmentIdxs))
  );
  const added = capHints(hints, MEETING_LIMITS.maxActionItems - meeting.actionItems.length);
  for (const h of added) meeting.actionItems.push(hintToItem(h));
  await meeting.save();
  res.json({ ...(await meetingDetail(meeting._id as mongoose.Types.ObjectId, permissions)), added: added.length, removed: removed.length });
}

/** POST /:id/extract-ai — synchronous Gemini extraction; adds `origin: "ai"` suggestions. 400 when disabled, 502 on failure. */
export async function extractWithAi(req: Request, res: Response): Promise<void> {
  if (!aiEnabled()) {
    res.status(400).json({ error: "AI extraction is not enabled (set MEETING_AI_EXTRACTION=true and GEMINI_API_KEY)" });
    return;
  }
  const loaded = await loadMeeting(req, res, "edit");
  if (!loaded) return;
  const { meeting, project, permissions } = loaded;
  const meetingId = meeting._id as mongoose.Types.ObjectId;

  let items: AiItem[];
  try {
    items = await extractActionItems({ title: meeting.title, meetingDate: meeting.meetingDate, segments: meeting.segments });
  } catch (err) {
    const message = err instanceof AiExtractionError ? err.message : "Unexpected error while calling Gemini.";
    if (!(err instanceof AiExtractionError)) console.error("[meetings] AI extraction failed:", err);
    res.status(502).json({ error: `AI extraction failed: ${message} The meeting was not changed.` });
    return;
  }

  // Resolve owners: speakers first (exact/canonical/unique first name), then assignable users.
  const candidates = await candidateUsers(req.user!, project);
  const attendees = buildAttendees(meeting.speakers, candidates);
  const resolveOwner = (owner: string | null): { assignee: mongoose.Types.ObjectId | null; assigneeName: string | null } => {
    if (!owner) return { assignee: null, assigneeName: null };
    const key = normalizeName(canonicalSpeakerName(owner));
    const attendee = attendees.find((a) => a.aliases.includes(key)) ?? attendees.find((a) => a.aliases.includes(key.split(" ")[0]!));
    if (attendee) return { assignee: attendee.user, assigneeName: attendee.name };
    const user = matchName(owner, candidates);
    return user ? { assignee: user._id, assigneeName: user.name } : { assignee: null, assigneeName: owner };
  };

  // Re-read so suggestions added meanwhile are de-duplicated too.
  const fresh = await Meeting.findById(meetingId).select("actionItems segments");
  if (!fresh) {
    res.status(404).json({ error: "Meeting not found" });
    return;
  }
  const taken = fresh.actionItems.map((i) => i.segmentIdxs);
  const additions: Array<Record<string, unknown>> = [];
  const now = new Date();
  for (const item of items) {
    if (taken.some((idxs) => overlaps(idxs, item.segmentIdxs))) continue;
    if (fresh.actionItems.length + additions.length >= MEETING_LIMITS.maxActionItems) break;
    taken.push(item.segmentIdxs);
    additions.push({
      _id: new mongoose.Types.ObjectId(),
      createdAt: now,
      updatedAt: now,
      segmentIdxs: item.segmentIdxs,
      quote: quoteOf(fresh, item.segmentIdxs),
      title: item.title,
      ...resolveOwner(item.owner),
      dueDate: item.dueDate,
      priority: item.priority,
      origin: "ai",
      status: "suggested",
      task: null,
    });
  }
  await Meeting.updateOne({ _id: meetingId }, { $push: { actionItems: { $each: additions } }, $set: { aiExtractedAt: now } });
  res.json({ ...(await meetingDetail(meetingId, permissions)), added: additions.length, proposed: items.length });
}

interface ItemBody {
  segmentIdxs?: unknown;
  title?: unknown;
  assignee?: unknown;
  dueDate?: unknown;
  priority?: unknown;
  status?: unknown;
}

/** Validates an assignee id; the owner name is the mapped speaker's name, else the user's name. */
async function resolveItemAssignee(
  meeting: IMeeting,
  raw: unknown
): Promise<{ assignee: mongoose.Types.ObjectId | null; assigneeName: string | null } | Invalid> {
  if (raw === null || raw === "") return { assignee: null, assigneeName: null };
  if (typeof raw !== "string" || isInvalidObjectId(raw)) return bad("assignee must be a user ID or null");
  const user = await User.findById(raw).select("name");
  if (!user) return bad("Assignee not found", 404);
  const speaker = meeting.speakers.find((s) => s.user && s.user.equals(user._id));
  return { assignee: user._id as mongoose.Types.ObjectId, assigneeName: speaker?.name ?? user.name };
}

/** POST /:id/items — adds a manual suggestion from the selected segments. */
export async function addItem(req: Request, res: Response): Promise<void> {
  const loaded = await loadMeeting(req, res, "edit");
  if (!loaded) return;
  const { meeting } = loaded;
  const body = (req.body ?? {}) as ItemBody;
  if (meeting.actionItems.length >= MEETING_LIMITS.maxActionItems) {
    return send(res, bad(`A meeting can have at most ${MEETING_LIMITS.maxActionItems} action items`, 409));
  }
  const idxs = parseSegmentIdxs(body.segmentIdxs, meeting.segments.length);
  if (isInvalid(idxs)) return send(res, idxs);
  const quote = quoteOf(meeting, idxs);

  let title: string;
  if (body.title === undefined || body.title === null || body.title === "") {
    title = cleanTitle(quote.split(/(?<=[.!?])\s+/)[0] ?? quote, buildAttendees(meeting.speakers)).slice(0, MEETING_LIMITS.itemTitleMax);
  } else {
    if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > MEETING_LIMITS.itemTitleMax) {
      return send(res, bad(`title must be 1-${MEETING_LIMITS.itemTitleMax} characters`));
    }
    title = body.title.trim();
  }
  let owner: { assignee: mongoose.Types.ObjectId | null; assigneeName: string | null } = { assignee: null, assigneeName: null };
  if (body.assignee !== undefined) {
    const resolved = await resolveItemAssignee(meeting, body.assignee);
    if (isInvalid(resolved)) return send(res, resolved);
    owner = resolved;
  }
  let dueDate: Date | null = null;
  if (body.dueDate !== undefined && body.dueDate !== null && body.dueDate !== "") {
    dueDate = parseDateOnly(body.dueDate);
    if (!dueDate) return send(res, bad("dueDate must be a valid date (YYYY-MM-DD)"));
  }
  const priority = parsePriority(body.priority);
  if (isInvalid(priority)) return send(res, priority);

  meeting.actionItems.push({
    segmentIdxs: idxs,
    quote,
    title,
    ...owner,
    dueDate,
    priority: priority ?? "medium",
    origin: "manual",
    status: "suggested",
    task: null,
  });
  await meeting.save();
  const created = meeting.actionItems[meeting.actionItems.length - 1]!;
  res.status(201).json({ item: await itemDetail(meeting._id as mongoose.Types.ObjectId, created._id) });
}

function findItem(meeting: IMeeting, req: Request, res: Response) {
  const itemId = param(req, "itemId");
  const item = itemId && !isInvalidObjectId(itemId) ? meeting.actionItems.id(itemId) : null;
  if (!item) {
    res.status(404).json({ error: "Action item not found" });
    return undefined;
  }
  if (item.status === "task_created") {
    res.status(409).json({ error: "A task was already created from this action item" });
    return undefined;
  }
  return item;
}

/** PATCH /:id/items/:itemId — edit a suggestion (title, assignee, dueDate, priority, segmentIdxs) or dismiss/restore via `status`. */
export async function updateItem(req: Request, res: Response): Promise<void> {
  const loaded = await loadMeeting(req, res, "edit");
  if (!loaded) return;
  const { meeting } = loaded;
  const item = findItem(meeting, req, res);
  if (!item) return;
  const body = (req.body ?? {}) as ItemBody;

  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > MEETING_LIMITS.itemTitleMax) {
      return send(res, bad(`title must be 1-${MEETING_LIMITS.itemTitleMax} characters`));
    }
    item.title = body.title.trim();
  }
  if (body.segmentIdxs !== undefined) {
    const idxs = parseSegmentIdxs(body.segmentIdxs, meeting.segments.length);
    if (isInvalid(idxs)) return send(res, idxs);
    item.segmentIdxs = idxs;
    item.quote = quoteOf(meeting, idxs);
  }
  if (body.assignee !== undefined) {
    const resolved = await resolveItemAssignee(meeting, body.assignee);
    if (isInvalid(resolved)) return send(res, resolved);
    item.assignee = resolved.assignee;
    item.assigneeName = resolved.assigneeName;
  }
  if (body.dueDate !== undefined) {
    if (body.dueDate === null || body.dueDate === "") item.dueDate = null;
    else {
      const date = parseDateOnly(body.dueDate);
      if (!date) return send(res, bad("dueDate must be a valid date (YYYY-MM-DD)"));
      item.dueDate = date;
    }
  }
  if (body.priority !== undefined) {
    const priority = parsePriority(body.priority);
    if (isInvalid(priority)) return send(res, priority);
    item.priority = priority!;
  }
  if (body.status !== undefined) {
    if (body.status !== "suggested" && body.status !== "dismissed") {
      return send(res, bad('status must be "suggested" or "dismissed"'));
    }
    item.status = body.status;
  }
  await meeting.save();
  res.json({ item: await itemDetail(meeting._id as mongoose.Types.ObjectId, item._id) });
}

/** DELETE /:id/items/:itemId — dismisses a suggestion (restore with PATCH `{ status: "suggested" }`). */
export async function dismissItem(req: Request, res: Response): Promise<void> {
  const loaded = await loadMeeting(req, res, "edit");
  if (!loaded) return;
  const { meeting } = loaded;
  const item = findItem(meeting, req, res);
  if (!item) return;
  item.status = "dismissed";
  await meeting.save();
  res.json({ item: await itemDetail(meeting._id as mongoose.Types.ObjectId, item._id) });
}

interface TaskItemInput {
  itemId?: unknown;
  segmentIdxs?: unknown;
  title?: unknown;
  description?: unknown;
  assignees?: unknown;
  dueDate?: unknown;
  priority?: unknown;
  project?: unknown;
  milestone?: unknown;
  labels?: unknown;
}

const DESCRIPTION_MAX = 2000;


function displayDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date);
}

/**
 * Task description: optional user text, the quote as a blockquote, "From meeting
 * **{title}** on {date} at {mm:ss}" and a link to the transcript line. The quote
 * is shortened so the whole thing fits the 2000-character task limit.
 */
export function buildTaskDescription(
  meeting: Pick<IMeeting, "_id" | "title" | "meetingDate" | "segments">,
  segmentIdx: number,
  quote: string,
  extra: string
): string {
  const segment = meeting.segments.find((s) => s.idx === segmentIdx);
  const time = formatTimestamp(segment?.start ?? null);
  const footer = `From meeting **${meeting.title}** on ${displayDate(meeting.meetingDate)}${time ? ` at ${time}` : ""}\n${appUrl()}/meetings/${String(meeting._id)}?seg=${segmentIdx}`;
  const head = extra.trim() ? `${extra.trim()}\n\n` : "";
  const budget = DESCRIPTION_MAX - head.length - footer.length - 4;
  let q = quote.replace(/\s+/g, " ").trim();
  if (q.length > budget) q = budget > 20 ? `${q.slice(0, budget - 1).trimEnd()}…` : "";
  const block = q ? `> ${q}\n\n` : "";
  return `${head}${block}${footer}`;
}

/**
 * POST /:id/tasks — `{ items: [...] }` (max 50). Each item goes through the
 * shared `createTaskCore` (same permissions, short codes, numbers,
 * notifications, history, SSE). Returns `{ created, skipped }`.
 */
export async function createTasksFromItems(req: Request, res: Response): Promise<void> {
  const loaded = await loadMeeting(req, res);
  if (!loaded) return;
  const { meeting } = loaded;
  const actor = req.user!;
  const meetingId = meeting._id as mongoose.Types.ObjectId;
  const raw = (req.body as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(raw) || raw.length === 0) return send(res, bad("items must be a non-empty array"));
  if (raw.length > MEETING_LIMITS.maxTasksPerRequest) {
    return send(res, bad(`Create at most ${MEETING_LIMITS.maxTasksPerRequest} tasks at once`));
  }

  const created: Array<{ itemId: string; task: Record<string, unknown> }> = [];
  const skipped: Array<{ itemId: string | null; reason: string }> = [];
  const seenItems = new Set<string>();

  for (const entry of raw as TaskItemInput[]) {
    const input = (entry ?? {}) as TaskItemInput;
    const rawItemId = typeof input.itemId === "string" && input.itemId ? input.itemId : null;
    const skip = (reason: string) => skipped.push({ itemId: rawItemId, reason });

    if (input.itemId !== undefined && input.itemId !== null && input.itemId !== "" && (!rawItemId || isInvalidObjectId(rawItemId))) {
      skip("itemId must be an action item ID");
      continue;
    }
    const existing = rawItemId ? meeting.actionItems.id(rawItemId) : null;
    if (rawItemId && !existing) {
      skip("Action item not found");
      continue;
    }
    if (rawItemId && seenItems.has(rawItemId)) {
      skip("Duplicate item in this request");
      continue;
    }
    if (rawItemId) seenItems.add(rawItemId);

    const idxs =
      input.segmentIdxs === undefined && existing ? existing.segmentIdxs : parseSegmentIdxs(input.segmentIdxs, meeting.segments.length);
    if (isInvalid(idxs)) {
      skip(idxs.error);
      continue;
    }
    if (idxs.length === 0) {
      skip("segmentIdxs must select at least one segment");
      continue;
    }
    if (input.description !== undefined && input.description !== null && typeof input.description !== "string") {
      skip("description must be a string");
      continue;
    }

    // Claim the item atomically so the same suggestion can never become two tasks.
    let previousStatus: ActionItemStatus | null = null;
    if (existing) {
      previousStatus = existing.status;
      const claim = await Meeting.updateOne(
        { _id: meetingId, actionItems: { $elemMatch: { _id: existing._id, status: { $ne: "task_created" } } } },
        { $set: { "actionItems.$.status": "task_created" } }
      );
      if (claim.modifiedCount === 0) {
        skip("A task was already created from this action item");
        continue;
      }
    }

    const quote = existing && input.segmentIdxs === undefined ? existing.quote || quoteOf(meeting, idxs) : quoteOf(meeting, idxs);
    // Unspecified fields fall back to the suggestion's values.
    const body: CreateTaskBody = {
      title: input.title !== undefined ? input.title : existing?.title,
      description: buildTaskDescription(meeting, idxs[0]!, quote, typeof input.description === "string" ? input.description : ""),
      assignees: input.assignees !== undefined ? input.assignees : existing?.assignee ? [existing.assignee.toString()] : undefined,
      dueDate: input.dueDate !== undefined ? input.dueDate : existing?.dueDate ? dateKey(existing.dueDate) : undefined,
      priority: input.priority !== undefined ? input.priority : existing?.priority,
      // Default project (and milestone) come from the meeting; null/"" creates a standalone task.
      project: input.project !== undefined ? input.project : meeting.project ? meeting.project.toString() : undefined,
      milestone: input.milestone,
      labels: input.labels,
    };
    const releaseClaim = async () => {
      if (!existing || !previousStatus) return;
      await Meeting.updateOne({ _id: meetingId, "actionItems._id": existing._id }, { $set: { "actionItems.$.status": previousStatus } });
    };
    let result: Awaited<ReturnType<typeof createTaskCore>>;
    try {
      result = await createTaskCore(
        actor,
        body,
        req.ip,
        { meeting: meetingId.toString(), meetingTitle: meeting.title, segmentIdx: idxs[0] },
        { historyAction: "created_from_meeting", sourceMeeting: { meeting: meetingId, segmentIdx: idxs[0]! } }
      );
    } catch (err) {
      await releaseClaim();
      throw err;
    }
    if (isInvalid(result)) {
      await releaseClaim();
      skip(result.error);
      continue;
    }

    const task = await Task.findById(result.taskId).select("title assignees dueDate priority");
    const fields = {
      title: (task?.title ?? String(input.title)).slice(0, MEETING_LIMITS.itemTitleMax),
      assignee: task?.assignees[0] ?? null,
      dueDate: task?.dueDate ?? null,
      priority: task?.priority ?? "medium",
      task: result.taskId,
    };
    let itemId: mongoose.Types.ObjectId;
    if (existing) {
      itemId = existing._id;
      await Meeting.updateOne(
        { _id: meetingId, "actionItems._id": existing._id },
        {
          $set: {
            "actionItems.$.status": "task_created",
            "actionItems.$.title": fields.title,
            "actionItems.$.assignee": fields.assignee,
            "actionItems.$.dueDate": fields.dueDate,
            "actionItems.$.priority": fields.priority,
            "actionItems.$.task": fields.task,
            "actionItems.$.segmentIdxs": idxs,
          },
        }
      );
    } else {
      itemId = new mongoose.Types.ObjectId();
      const assigneeUser = fields.assignee ? meeting.speakers.find((s) => s.user && s.user.equals(fields.assignee!)) : undefined;
      await Meeting.updateOne(
        { _id: meetingId },
        {
          $push: {
            actionItems: {
              _id: itemId,
              segmentIdxs: idxs,
              quote,
              title: fields.title,
              assignee: fields.assignee,
              assigneeName: assigneeUser?.name ?? null,
              dueDate: fields.dueDate,
              priority: fields.priority,
              origin: "manual",
              status: "task_created",
              task: fields.task,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
        }
      );
    }
    const detail = await loadTaskDetail(result.taskId, actor);
    created.push({ itemId: itemId.toString(), task: { ...(detail?.task ?? { _id: result.taskId }), warnings: result.warnings } });
  }

  if (created.length > 0) {
    logActivity({
      action: "meeting_tasks_created",
      actor,
      targetType: "meeting",
      targetId: meetingId,
      targetName: meeting.title,
      details: { created: created.length, skipped: skipped.length },
      ip: req.ip,
    });
  }
  res.json({ created, skipped });
}
