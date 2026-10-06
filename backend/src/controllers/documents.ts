import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import multer from "multer";
import { logActivity } from "../lib/activityLog.js";
import { addDays, appToday } from "../lib/appTime.js";
import { EMPLOYEE_DOCUMENTS_BUCKET, deleteFromGridFs, openGridFsDownload, uploadToGridFs } from "../lib/gridfs.js";
import { canViewHrOf, daysBetween, hrScopeOf } from "../lib/hr.js";
import { parsePagination, searchRegex } from "../lib/pagination.js";
import { parseDateOnly } from "../lib/taskAccess.js";
import {
  EMPLOYEE_DOCUMENT_EXTENSIONS,
  EMPLOYEE_DOCUMENT_LIMITS,
  EMPLOYEE_DOCUMENT_MIME_TYPES,
  EMPLOYEE_DOCUMENT_TYPES,
  EmployeeDocument,
  type EmployeeDocumentType,
  type IEmployeeDocument,
} from "../models/EmployeeDocument.js";
import type { IUser } from "../models/User.js";
import { User } from "../models/User.js";

// ---------------------------------------------------------------------------
// Employee documents (passport, visa, contract...) with an optional file in the
// `employeeDocuments` GridFS bucket.
// Access: owner (view + add own), admins (everything), heads (view their
// department, read-only). Edit/delete: admins and the uploader.
// ---------------------------------------------------------------------------

class UnsupportedTypeError extends Error {}

function isAllowedFile(file: Express.Multer.File): boolean {
  if (EMPLOYEE_DOCUMENT_MIME_TYPES.includes(file.mimetype)) return true;
  const ext = file.originalname.split(".").pop()?.toLowerCase() ?? "";
  return file.mimetype === "application/octet-stream" && EMPLOYEE_DOCUMENT_EXTENSIONS.has(ext);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: EMPLOYEE_DOCUMENT_LIMITS.maxBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (isAllowedFile(file)) cb(null, true);
    else cb(new UnsupportedTypeError(`"${file.originalname}" is not an allowed file type (PDF, images, Office documents)`));
  },
});

/**
 * Optional single `file` field (multipart). JSON bodies pass straight through.
 * 413 for size/count limits, 415 for disallowed types.
 */
export function uploadDocumentFileMiddleware(req: Request, res: Response, next: NextFunction): void {
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
        res.status(413).json({ error: `Files must be ${EMPLOYEE_DOCUMENT_LIMITS.maxBytes / (1024 * 1024)} MB or smaller` });
        return;
      }
      if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
        res.status(413).json({ error: 'Upload a single file using the "file" field' });
        return;
      }
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DOC_POPULATE = [
  { path: "user", select: "name email designation employeeId department", populate: { path: "department", select: "name" } },
  { path: "uploadedBy", select: "name email" },
];

function isInvalidObjectId(id: string): boolean {
  return !mongoose.isValidObjectId(id);
}

function paramId(req: Request): string | undefined {
  const id = req.params.id;
  return typeof id === "string" ? id : undefined;
}

type OwnerRef = { _id: mongoose.Types.ObjectId; department?: mongoose.Types.ObjectId | null };

/** What `viewer` may do with `doc` (owner given as id + department). */
function documentPermissions(viewer: IUser, doc: IEmployeeDocument, owner: OwnerRef | null) {
  const isAdmin = viewer.role === "admin";
  const isUploader = doc.uploadedBy.equals(viewer._id);
  const view = isAdmin || isUploader || (owner ? canViewHrOf(viewer, owner) : false);
  return { view, edit: isAdmin || isUploader, delete: isAdmin || isUploader };
}

/** Owner ref of a document whose `user` may be populated (or null when the owner is gone). */
function ownerOf(doc: IEmployeeDocument): OwnerRef | null {
  const user = doc.user as unknown;
  if (!user) return null;
  if (user instanceof mongoose.Types.ObjectId) return null;
  const populated = user as { _id: mongoose.Types.ObjectId; department?: { _id: mongoose.Types.ObjectId } | mongoose.Types.ObjectId | null };
  const dept = populated.department;
  const department = !dept ? null : dept instanceof mongoose.Types.ObjectId ? dept : dept._id;
  return { _id: populated._id, department };
}

function serialize(viewer: IUser, doc: IEmployeeDocument, today: Date) {
  const json = doc.toJSON() as Record<string, unknown>;
  const perms = documentPermissions(viewer, doc, ownerOf(doc));
  return {
    ...json,
    inDays: doc.expiryDate ? daysBetween(today, doc.expiryDate) : null,
    permissions: { edit: perms.edit, delete: perms.delete },
  };
}

/** Loads a document (populated) and checks view permission on every request. */
async function getViewableDocumentOr404(req: Request, res: Response): Promise<IEmployeeDocument | undefined> {
  const id = paramId(req);
  const doc = id && !isInvalidObjectId(id) ? await EmployeeDocument.findById(id).populate(DOC_POPULATE) : null;
  if (!doc || !documentPermissions(req.user!, doc, ownerOf(doc)).view) {
    // 404 (not 403) so ids of other people's documents aren't confirmed.
    res.status(404).json({ error: "Document not found" });
    return undefined;
  }
  return doc;
}

/** "YYYY-MM-DD" | ISO | "" | "null" | null → Date | null | undefined (absent) | "invalid". */
function parseDateField(raw: unknown): Date | null | undefined | "invalid" {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "" || raw === "null") return null;
  if (typeof raw !== "string") return "invalid";
  const value = /^\d{4}-\d{2}-\d{2}T/.test(raw) ? raw.slice(0, 10) : raw;
  return parseDateOnly(value) ?? "invalid";
}

interface ParsedFields {
  type?: EmployeeDocumentType;
  name?: string;
  issueDate?: Date | null;
  expiryDate?: Date | null;
  notes?: string;
}

/** Validates the editable fields (JSON or multipart strings). */
function parseFields(body: Record<string, unknown>, creating: boolean): ParsedFields | string {
  const out: ParsedFields = {};
  if (body.type !== undefined || creating) {
    if (typeof body.type !== "string" || !EMPLOYEE_DOCUMENT_TYPES.includes(body.type as EmployeeDocumentType)) {
      return `type must be one of: ${EMPLOYEE_DOCUMENT_TYPES.join(", ")}`;
    }
    out.type = body.type as EmployeeDocumentType;
  }
  if (body.name !== undefined || creating) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return "name is required";
    if (name.length > EMPLOYEE_DOCUMENT_LIMITS.nameMax) {
      return `name must be at most ${EMPLOYEE_DOCUMENT_LIMITS.nameMax} characters`;
    }
    out.name = name;
  }
  for (const key of ["issueDate", "expiryDate"] as const) {
    const parsed = parseDateField(body[key]);
    if (parsed === "invalid") return `${key} must be a date (YYYY-MM-DD) or null`;
    if (parsed !== undefined) out[key] = parsed;
  }
  if (body.notes !== undefined) {
    if (body.notes !== null && typeof body.notes !== "string") return "notes must be a string";
    const notes = ((body.notes as string | null) ?? "").trim();
    if (notes.length > EMPLOYEE_DOCUMENT_LIMITS.notesMax) {
      return `notes must be at most ${EMPLOYEE_DOCUMENT_LIMITS.notesMax} characters`;
    }
    out.notes = notes;
  }
  return out;
}

async function storeFile(
  file: Express.Multer.File,
  ownerId: mongoose.Types.ObjectId,
  uploaderId: mongoose.Types.ObjectId
) {
  const filename = file.originalname.slice(0, 255) || "file";
  const gridFsId = await uploadToGridFs(
    file.buffer,
    filename,
    { user: ownerId, contentType: file.mimetype, uploadedBy: uploaderId },
    EMPLOYEE_DOCUMENTS_BUCKET
  );
  return { filename, mimeType: file.mimetype, size: file.size, gridFsId };
}

/** RFC 5987 Content-Disposition with an ASCII fallback. */
function contentDisposition(filename: string, inline: boolean): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Deletes every document of a user, including their GridFS files (user delete
 * cascade). Never throws — failures are logged.
 */
export async function deleteUserDocuments(userId: mongoose.Types.ObjectId): Promise<number> {
  try {
    const docs = await EmployeeDocument.find({ user: userId }).select("file").lean();
    if (docs.length === 0) return 0;
    await EmployeeDocument.deleteMany({ user: userId });
    await Promise.all(
      docs
        .filter((d) => d.file?.gridFsId)
        .map((d) => deleteFromGridFs(d.file!.gridFsId as mongoose.Types.ObjectId, EMPLOYEE_DOCUMENTS_BUCKET))
    );
    return docs.length;
  } catch (err) {
    console.error("[documents] Cascade delete failed for user", userId.toString(), err);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

/**
 * GET /api/documents — `?user=<id>|all` (default: me), `?expiring=N` (expiry
 * within N days, incl. expired), `?type=`, `?search=` (name), pagination.
 * `user=all`: admins → everyone, heads → their department, employees → 403.
 */
export async function listDocuments(req: Request, res: Response): Promise<void> {
  const viewer = req.user!;
  const { limit, offset } = parsePagination(req);
  const scope = hrScopeOf(viewer);
  const and: Record<string, unknown>[] = [];

  const rawUser = req.query.user;
  if (rawUser === undefined || rawUser === "" || rawUser === "me") {
    and.push({ user: viewer._id });
  } else if (rawUser === "all") {
    if (scope === "self") {
      res.status(403).json({ error: "Only admins and department heads can list other users' documents" });
      return;
    }
    if (scope === "department") {
      const members = await User.find({ department: viewer.department }).select("_id").lean();
      and.push({ user: { $in: [viewer._id, ...members.map((m) => m._id)] } });
    }
  } else {
    if (typeof rawUser !== "string" || isInvalidObjectId(rawUser)) {
      res.status(400).json({ error: 'user must be a user ID, "me" or "all"' });
      return;
    }
    const target = await User.findById(rawUser).select("_id department").lean();
    if (!target || !canViewHrOf(viewer, { _id: target._id as mongoose.Types.ObjectId, department: target.department ?? null })) {
      res.status(403).json({ error: "You cannot view this user's documents" });
      return;
    }
    and.push({ user: target._id });
  }

  const today = appToday();
  const rawExpiring = req.query.expiring;
  let expiringSort = false;
  if (rawExpiring !== undefined && rawExpiring !== "") {
    const days = Number(rawExpiring);
    if (!Number.isInteger(days) || days < 0 || days > 3650) {
      res.status(400).json({ error: "expiring must be a whole number of days (0-3650)" });
      return;
    }
    and.push({ expiryDate: { $ne: null, $lte: addDays(today, days) } });
    expiringSort = true;
  }
  const type = req.query.type;
  if (type !== undefined && type !== "") {
    if (typeof type !== "string" || !EMPLOYEE_DOCUMENT_TYPES.includes(type as EmployeeDocumentType)) {
      res.status(400).json({ error: `type must be one of: ${EMPLOYEE_DOCUMENT_TYPES.join(", ")}` });
      return;
    }
    and.push({ type });
  }
  const search = searchRegex(req.query.search);
  if (search) and.push({ name: search });

  const filter = and.length > 0 ? { $and: and } : {};
  let query = EmployeeDocument.find(filter)
    .populate(DOC_POPULATE)
    .sort(expiringSort ? { expiryDate: 1, _id: 1 } : { createdAt: -1, _id: -1 });
  if (limit !== null) query = query.skip(offset).limit(limit);
  const [docs, total] = await Promise.all([query, EmployeeDocument.countDocuments(filter)]);

  res.json({ documents: docs.map((d) => serialize(viewer, d, today)), total, limit, offset });
}

/** GET /api/documents/:id */
export async function getDocument(req: Request, res: Response): Promise<void> {
  const doc = await getViewableDocumentOr404(req, res);
  if (!doc) return;
  res.json({ document: serialize(req.user!, doc, appToday()) });
}

/**
 * POST /api/documents — multipart (or JSON without a file): `type`, `name`,
 * `issueDate?`, `expiryDate?`, `notes?`, `file?`, `user?` (admins only; default me).
 */
export async function createDocument(req: Request, res: Response): Promise<void> {
  const viewer = req.user!;
  const body = (req.body ?? {}) as Record<string, unknown>;

  let ownerId = viewer._id as mongoose.Types.ObjectId;
  if (body.user !== undefined && body.user !== "" && body.user !== null && body.user !== "me") {
    if (typeof body.user !== "string" || isInvalidObjectId(body.user)) {
      res.status(400).json({ error: "user must be a valid user ID" });
      return;
    }
    if (body.user !== viewer._id.toString()) {
      if (viewer.role !== "admin") {
        res.status(403).json({ error: "Only admins can add documents for other users" });
        return;
      }
      const target = await User.exists({ _id: body.user });
      if (!target) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      ownerId = new mongoose.Types.ObjectId(body.user);
    }
  }

  const fields = parseFields(body, true);
  if (typeof fields === "string") {
    res.status(400).json({ error: fields });
    return;
  }
  if (fields.issueDate && fields.expiryDate && fields.expiryDate < fields.issueDate) {
    res.status(400).json({ error: "expiryDate must be on or after issueDate" });
    return;
  }

  const file = req.file ? await storeFile(req.file, ownerId, viewer._id as mongoose.Types.ObjectId) : null;
  let doc: IEmployeeDocument;
  try {
    doc = await EmployeeDocument.create({
      user: ownerId,
      type: fields.type,
      name: fields.name,
      issueDate: fields.issueDate ?? null,
      expiryDate: fields.expiryDate ?? null,
      notes: fields.notes ?? "",
      file,
      uploadedBy: viewer._id,
      reminderKeys: [],
    });
  } catch (error) {
    if (file) await deleteFromGridFs(file.gridFsId, EMPLOYEE_DOCUMENTS_BUCKET);
    throw error;
  }

  logActivity({
    action: "document_created",
    actor: viewer,
    targetType: "employee_document",
    targetId: doc._id as mongoose.Types.ObjectId,
    targetName: doc.name,
    details: { type: doc.type, user: ownerId.toString(), hasFile: Boolean(file) },
    ip: req.ip,
  });

  const populated = await EmployeeDocument.findById(doc._id).populate(DOC_POPULATE);
  res.status(201).json({ document: serialize(viewer, populated!, appToday()) });
}

/**
 * PATCH /api/documents/:id — admins and the uploader. Any of `type`, `name`,
 * `issueDate`, `expiryDate`, `notes`; multipart `file` replaces the file,
 * `removeFile=true` drops it. Changing the expiry date re-arms the reminders.
 */
export async function updateDocument(req: Request, res: Response): Promise<void> {
  const viewer = req.user!;
  const doc = await getViewableDocumentOr404(req, res);
  if (!doc) return;
  if (!documentPermissions(viewer, doc, ownerOf(doc)).edit) {
    res.status(403).json({ error: "Only admins and the uploader can edit this document" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const fields = parseFields(body, false);
  if (typeof fields === "string") {
    res.status(400).json({ error: fields });
    return;
  }
  const removeFile = body.removeFile === true || body.removeFile === "true";
  const changed = Object.keys(fields);
  if (changed.length === 0 && !req.file && !removeFile) {
    res.status(400).json({ error: "At least one field to update is required" });
    return;
  }
  const nextIssue = fields.issueDate !== undefined ? fields.issueDate : (doc.issueDate ?? null);
  const nextExpiry = fields.expiryDate !== undefined ? fields.expiryDate : (doc.expiryDate ?? null);
  if (nextIssue && nextExpiry && nextExpiry < nextIssue) {
    res.status(400).json({ error: "expiryDate must be on or after issueDate" });
    return;
  }

  const expiryChanged =
    fields.expiryDate !== undefined && (fields.expiryDate?.getTime() ?? null) !== (doc.expiryDate?.getTime() ?? null);
  if (fields.type !== undefined) doc.type = fields.type;
  if (fields.name !== undefined) doc.name = fields.name;
  if (fields.issueDate !== undefined) doc.issueDate = fields.issueDate;
  if (fields.expiryDate !== undefined) doc.expiryDate = fields.expiryDate;
  if (fields.notes !== undefined) doc.notes = fields.notes;
  if (expiryChanged) doc.reminderKeys = [];

  const previousFile = doc.file?.gridFsId ?? null;
  const ownerId = (ownerOf(doc)?._id ?? doc.user) as mongoose.Types.ObjectId;
  let newFile: Awaited<ReturnType<typeof storeFile>> | null = null;
  if (req.file) {
    newFile = await storeFile(req.file, ownerId, viewer._id as mongoose.Types.ObjectId);
    doc.file = newFile;
    changed.push("file");
  } else if (removeFile && doc.file) {
    doc.file = null;
    changed.push("file");
  }

  try {
    await doc.save();
  } catch (error) {
    if (newFile) await deleteFromGridFs(newFile.gridFsId, EMPLOYEE_DOCUMENTS_BUCKET);
    throw error;
  }
  if (previousFile && (newFile || removeFile)) await deleteFromGridFs(previousFile, EMPLOYEE_DOCUMENTS_BUCKET);

  logActivity({
    action: "document_updated",
    actor: viewer,
    targetType: "employee_document",
    targetId: doc._id as mongoose.Types.ObjectId,
    targetName: doc.name,
    details: { changed },
    ip: req.ip,
  });

  const populated = await EmployeeDocument.findById(doc._id).populate(DOC_POPULATE);
  res.json({ document: serialize(viewer, populated!, appToday()) });
}

/** DELETE /api/documents/:id — admins and the uploader; removes the GridFS file too. */
export async function deleteDocument(req: Request, res: Response): Promise<void> {
  const viewer = req.user!;
  const doc = await getViewableDocumentOr404(req, res);
  if (!doc) return;
  if (!documentPermissions(viewer, doc, ownerOf(doc)).delete) {
    res.status(403).json({ error: "Only admins and the uploader can delete this document" });
    return;
  }

  const gridFsId = doc.file?.gridFsId ?? null;
  await doc.deleteOne();
  if (gridFsId) await deleteFromGridFs(gridFsId, EMPLOYEE_DOCUMENTS_BUCKET);

  logActivity({
    action: "document_deleted",
    actor: viewer,
    targetType: "employee_document",
    targetId: doc._id as mongoose.Types.ObjectId,
    targetName: doc.name,
    details: { type: doc.type, user: (ownerOf(doc)?._id ?? doc.user).toString() },
    ip: req.ip,
  });

  res.json({ success: true });
}

/**
 * GET /api/documents/:id/file — streams the file (permission re-checked on
 * every request). `?inline=true` for in-browser preview of PDFs/images.
 */
export async function downloadDocumentFile(req: Request, res: Response): Promise<void> {
  const doc = await getViewableDocumentOr404(req, res);
  if (!doc) return;
  const file = doc.file;
  if (!file) {
    res.status(404).json({ error: "This document has no file" });
    return;
  }

  const inline =
    req.query.inline === "true" && (file.mimeType === "application/pdf" || file.mimeType.startsWith("image/"));
  res.setHeader("Content-Type", file.mimeType);
  res.setHeader("Content-Length", String(file.size));
  res.setHeader("Content-Disposition", contentDisposition(file.filename, inline));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");

  await new Promise<void>((resolve) => {
    const stream = openGridFsDownload(file.gridFsId, EMPLOYEE_DOCUMENTS_BUCKET);
    stream.once("error", (err) => {
      console.error("[documents] Download failed", doc._id.toString(), err.message);
      if (!res.headersSent) {
        res.removeHeader("Content-Disposition");
        res.removeHeader("Content-Length");
        res.status(404).json({ error: "File content not found" });
      } else {
        res.end();
      }
      resolve();
    });
    stream.once("end", () => resolve());
    stream.pipe(res);
  });
}
