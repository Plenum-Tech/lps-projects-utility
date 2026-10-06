import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import multer from "multer";
import { deleteFromGridFs, openGridFsDownload, uploadToGridFs } from "../lib/gridfs.js";
import { parsePagination } from "../lib/pagination.js";
import {
  canManageTaskAsync,
  getViewableTaskOr404,
  isInvalidObjectId,
  param,
  pushTaskUpdate,
  recordTaskHistory,
} from "../lib/taskAccess.js";
import type { ITask } from "../models/Task.js";
import { TaskFile } from "../models/TaskFile.js";
import type { ITaskFile } from "../models/TaskFile.js";
import { TASK_FILE_LIMITS, TASK_FILE_MIME_TYPES } from "../models/TaskFile.js";

// ---------------------------------------------------------------------------
// Upload middleware — multer memory storage, then streamed into GridFS
// ---------------------------------------------------------------------------

const MAX_FILES_PER_REQUEST = 10;

/** Browsers sometimes send a generic type — fall back to the extension. */
const ALLOWED_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg",
  "pdf",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "txt", "csv", "zip",
]);

function isAllowedFile(file: Express.Multer.File): boolean {
  if (TASK_FILE_MIME_TYPES.includes(file.mimetype)) return true;
  const ext = file.originalname.split(".").pop()?.toLowerCase() ?? "";
  // Windows browsers send a generic or empty type for files with no registered handler.
  return (file.mimetype === "application/octet-stream" || file.mimetype === "") && ALLOWED_EXTENSIONS.has(ext);
}

class UnsupportedTypeError extends Error {}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TASK_FILE_LIMITS.maxBytes, files: MAX_FILES_PER_REQUEST },
  fileFilter: (_req, file, cb) => {
    if (isAllowedFile(file)) cb(null, true);
    else cb(new UnsupportedTypeError(`"${file.originalname}" is not an allowed file type (images, PDF, Office documents, TXT, CSV, ZIP)`));
  },
});

/**
 * Runs multer for the `files` field and turns its errors into clean JSON:
 * 413 for size/count limits, 415 for disallowed types.
 */
export function uploadTaskFilesMiddleware(req: Request, res: Response, next: NextFunction): void {
  upload.array("files", MAX_FILES_PER_REQUEST)(req, res, (err: unknown) => {
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
        res.status(413).json({ error: `Files must be ${TASK_FILE_LIMITS.maxBytes / (1024 * 1024)} MB or smaller` });
        return;
      }
      if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
        res.status(413).json({ error: `Upload at most ${MAX_FILES_PER_REQUEST} files at once using the "files" field` });
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

const FILE_POPULATE = { path: "uploadedBy", select: "name email" };

async function getFileOr404(req: Request, res: Response, task: ITask): Promise<ITaskFile | undefined> {
  const fileId = param(req, "fileId");
  const file =
    fileId && !isInvalidObjectId(fileId) ? await TaskFile.findOne({ _id: fileId, task: task._id }) : null;
  if (!file) {
    res.status(404).json({ error: "File not found" });
    return undefined;
  }
  return file;
}

/** RFC 5987 Content-Disposition with an ASCII fallback. */
function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

/** Anyone who can view the task: attachments newest first (`?subtask=<id>|none` filters). */
export async function listFiles(req: Request, res: Response): Promise<void> {
  const task = await getViewableTaskOr404(req, res);
  if (!task) return;

  const { limit, offset } = parsePagination(req);
  const filter: Record<string, unknown> = { task: task._id };
  const subtaskParam = req.query.subtask;
  if (subtaskParam === "none") {
    filter.subtask = null;
  } else if (typeof subtaskParam === "string" && subtaskParam) {
    if (isInvalidObjectId(subtaskParam)) {
      res.status(400).json({ error: "subtask must be a subtask ID or \"none\"" });
      return;
    }
    filter.subtask = new mongoose.Types.ObjectId(subtaskParam);
  }

  let query = TaskFile.find(filter).populate(FILE_POPULATE).sort({ createdAt: -1 });
  if (limit !== null) {
    query = query.skip(offset).limit(limit);
  }

  const [files, total] = await Promise.all([query, TaskFile.countDocuments(filter)]);
  res.json({ files: files.map((f) => f.toJSON()), total, limit, offset });
}

/** Anyone who can view the task: uploads files (multipart field `files`, max 20 per task). */
export async function uploadFiles(req: Request, res: Response): Promise<void> {
  const task = await getViewableTaskOr404(req, res);
  if (!task) return;
  await storeFiles(req, res, task, null);
}

/**
 * Anyone who can view the task: attaches files to a subtask. Same storage,
 * limits and download/delete endpoints as task files (they count toward the
 * task's 20-file limit).
 */
export async function uploadSubtaskFiles(req: Request, res: Response): Promise<void> {
  const task = await getViewableTaskOr404(req, res);
  if (!task) return;
  const subId = param(req, "subId");
  const subtask = subId && !isInvalidObjectId(subId) ? task.subtasks.id(subId) : null;
  if (!subtask) {
    res.status(404).json({ error: "Subtask not found" });
    return;
  }
  await storeFiles(req, res, task, { _id: subtask._id, title: subtask.title });
}

async function storeFiles(
  req: Request,
  res: Response,
  task: ITask,
  subtask: { _id: mongoose.Types.ObjectId; title: string } | null
): Promise<void> {
  const user = req.user!;
  const incoming = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (incoming.length === 0) {
    res.status(400).json({ error: 'No files uploaded — send multipart/form-data with a "files" field' });
    return;
  }

  const existing = await TaskFile.countDocuments({ task: task._id });
  if (existing + incoming.length > TASK_FILE_LIMITS.maxFilesPerTask) {
    res.status(413).json({
      error: `A task can have at most ${TASK_FILE_LIMITS.maxFilesPerTask} files (${existing} already attached)`,
    });
    return;
  }

  const taskId = task._id as mongoose.Types.ObjectId;
  const created: ITaskFile[] = [];
  for (const file of incoming) {
    const filename = file.originalname.slice(0, 255) || "file";
    const gridFsId = await uploadToGridFs(file.buffer, filename, {
      task: taskId,
      contentType: file.mimetype,
      uploadedBy: user._id,
    });
    const doc = await TaskFile.create({
      task: taskId,
      subtask: subtask?._id ?? null,
      uploadedBy: user._id,
      filename,
      mimeType: file.mimetype,
      size: file.size,
      gridFsId,
    });
    created.push(doc);
    recordTaskHistory(taskId, user, "file_added", {
      fileId: doc._id.toString(),
      filename,
      size: file.size,
      ...(subtask ? { subtask: { id: subtask._id.toString(), title: subtask.title } } : {}),
    });
  }

  pushTaskUpdate(task, "file-added", {
    fileIds: created.map((f) => f._id.toString()),
    ...(subtask ? { subtaskId: subtask._id.toString() } : {}),
  });

  const populated = await TaskFile.find({ _id: { $in: created.map((f) => f._id) } })
    .populate(FILE_POPULATE)
    .sort({ createdAt: -1 });
  res.status(201).json({ files: populated.map((f) => f.toJSON()) });
}

/** Anyone who can view the task: streams the file as an attachment. */
export async function downloadFile(req: Request, res: Response): Promise<void> {
  const task = await getViewableTaskOr404(req, res);
  if (!task) return;

  const file = await getFileOr404(req, res, task);
  if (!file) return;

  res.setHeader("Content-Type", file.mimeType);
  res.setHeader("Content-Length", String(file.size));
  res.setHeader("Content-Disposition", contentDisposition(file.filename));
  res.setHeader("X-Content-Type-Options", "nosniff");

  await new Promise<void>((resolve) => {
    const stream = openGridFsDownload(file.gridFsId);
    stream.once("error", (err) => {
      console.error("[files] Download failed", file._id.toString(), err.message);
      if (!res.headersSent) {
        res.removeHeader("Content-Disposition");
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

/** Uploader, task creator, project manager or admin: deletes a file and its GridFS chunks. */
export async function deleteFile(req: Request, res: Response): Promise<void> {
  const task = await getViewableTaskOr404(req, res);
  if (!task) return;

  const file = await getFileOr404(req, res, task);
  if (!file) return;

  const user = req.user!;
  if (!file.uploadedBy.equals(user._id) && !(await canManageTaskAsync(user, task))) {
    res.status(403).json({ error: "You can only delete files you uploaded" });
    return;
  }

  await file.deleteOne();
  await deleteFromGridFs(file.gridFsId);

  const taskId = task._id as mongoose.Types.ObjectId;
  recordTaskHistory(taskId, user, "file_removed", {
    fileId: file._id.toString(),
    filename: file.filename,
  });
  pushTaskUpdate(task, "file-removed", { fileId: file._id.toString() });

  res.json({ success: true });
}
