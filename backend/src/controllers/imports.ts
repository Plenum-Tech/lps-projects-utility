import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import multer from "multer";
import { appDateKey } from "../lib/taskJobs.js";
import { fieldsFor, suggestMapping } from "../lib/imports/fields.js";
import {
  failIfStale,
  ImportFileError,
  ImportRequestError,
  purgeExpiredImportFiles,
  readJobTable,
  startRun,
  storeImportFile,
  sweepImportFilesSoon,
  undoImport,
  validateAndStore,
} from "../lib/imports/jobs.js";
import { cellText, fileFormat, parseSpreadsheet, type ParsedTable } from "../lib/imports/parse.js";
import { canImportTasks } from "../lib/imports/tasks.js";
import { buildErrorReport, buildTemplate } from "../lib/imports/workbooks.js";
import { canCreateProject } from "../lib/projectAccess.js";
import { deleteFromGridFs } from "../lib/gridfs.js";
import { ImportJob, IMPORT_LIMITS, IMPORT_TYPES } from "../models/ImportJob.js";
import type { IImportJob, ImportType } from "../models/ImportJob.js";
import { User } from "../models/User.js";
import type { IUser } from "../models/User.js";
import { IMPORTS_BUCKET } from "../lib/imports/jobs.js";

// ---------------------------------------------------------------------------
// /api/imports — Projects & Tasks import from .xlsx / .csv.
// ---------------------------------------------------------------------------

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function fail(res: Response, status: number, error: string): void {
  res.status(status).json({ error });
}

function handleError(res: Response, err: unknown): void {
  if (err instanceof ImportRequestError || err instanceof ImportFileError) return fail(res, err.status, err.message);
  throw err;
}

function parseType(raw: unknown): ImportType | null {
  return typeof raw === "string" && (IMPORT_TYPES as readonly string[]).includes(raw) ? (raw as ImportType) : null;
}

/** Projects: admin / head (own department). Tasks: admin, head, project managers. */
async function mayImport(actor: IUser, type: ImportType): Promise<boolean> {
  return type === "projects" ? actor.role !== "employee" && canCreateProject(actor) : canImportTasks(actor);
}

const FORBIDDEN: Record<ImportType, string> = {
  projects: "Only admins and department heads can import projects",
  tasks: "Only admins, department heads and project managers can import tasks",
};

// --- upload middleware ----------------------------------------------------------

class UnsupportedTypeError extends Error {}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMPORT_LIMITS.maxBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (fileFormat(file.originalname)) cb(null, true);
    else cb(new UnsupportedTypeError("Upload an .xlsx or .csv file"));
  },
});

/** Optional single `file` field; multipart errors → 413 / 415 / 400 JSON. */
export function importUploadMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!req.is("multipart/form-data")) {
    next();
    return;
  }
  upload.single("file")(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof UnsupportedTypeError) return fail(res, 415, err.message);
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") return fail(res, 413, `Files can be at most ${IMPORT_LIMITS.maxBytes / 1024 / 1024} MB`);
      return fail(res, 400, err.message);
    }
    next(err);
  });
}

// --- serialization --------------------------------------------------------------

function serializeJob(job: IImportJob, options: { rows?: boolean; createdByName?: string | null } = {}) {
  const now = Date.now();
  const fileAvailable = Boolean(job.fileId && job.fileExpiresAt && job.fileExpiresAt.getTime() > now);
  return {
    id: job._id.toString(),
    type: job.type,
    status: job.status,
    fileName: job.fileName,
    fileSize: job.fileSize,
    fileAvailable,
    fileExpiresAt: fileAvailable ? job.fileExpiresAt : null,
    sheets: job.sheets,
    sheet: job.sheet ?? null,
    headerRow: job.headerRow,
    columns: job.columns.map((c) => ({ index: c.index, header: c.header })),
    rowCount: job.rowCount,
    mapping: job.mapping ?? {},
    options: job.options ?? {},
    resultsOf: job.resultsOf ?? null,
    totals: job.totals,
    progress: job.progress,
    createdCount: job.createdIds.length,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    undoUntil: job.undoUntil ?? null,
    canUndo:
      (job.status === "completed" || job.status === "failed") &&
      job.createdIds.length > 0 &&
      Boolean(job.undoUntil && job.undoUntil.getTime() > now),
    undoneAt: job.undoneAt ?? null,
    undoResult: job.undoResult ?? null,
    error: job.error ?? null,
    hasErrorReport: job.rowsResult.some((r) => r.status === "error"),
    createdBy: { id: job.createdBy.toString(), name: options.createdByName ?? null },
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(options.rows
      ? {
          rows: job.rowsResult.map((r) => ({
            row: r.row,
            status: r.status,
            action: r.action ?? null,
            messages: r.messages,
            recordId: r.recordId ? r.recordId.toString() : null,
            recordRef: r.recordRef ?? null,
          })),
        }
      : {}),
  };
}

/** Loads a job the caller may see (owner or admin); responds 404/400 otherwise. */
async function loadJob(req: Request, res: Response): Promise<IImportJob | undefined> {
  const id = req.params.jobId;
  if (typeof id !== "string" || !mongoose.isValidObjectId(id)) {
    fail(res, 400, "Invalid import ID");
    return undefined;
  }
  const job = await ImportJob.findById(id);
  const actor = req.user!;
  if (!job || (actor.role !== "admin" && !job.createdBy.equals(actor._id))) {
    fail(res, 404, "Import not found");
    return undefined;
  }
  return failIfStale(job);
}

function previewPayload(job: IImportJob, table: ParsedTable) {
  return {
    jobId: job._id.toString(),
    job: serializeJob(job),
    fileName: job.fileName,
    format: table.format,
    sheets: table.sheets,
    sheet: table.sheet,
    headerRow: job.headerRow,
    rowCount: table.rows.length,
    columns: table.headers.map((header, index) => ({
      index,
      header,
      samples: table.rows.slice(0, 3).map((r) => cellText(r.cells[index] ?? null).slice(0, 200)),
    })),
    sampleRows: table.rows.slice(0, IMPORT_LIMITS.sampleRows).map((r) => ({
      row: r.row,
      cells: r.cells.map((c) => cellText(c).slice(0, 500)),
    })),
    suggestedMapping: suggestMapping(job.type, table.headers),
    fields: fieldsFor(job.type).map(({ synonyms: _s, ...f }) => f),
    limits: { maxBytes: IMPORT_LIMITS.maxBytes, maxRows: IMPORT_LIMITS.maxRows, inlineRows: IMPORT_LIMITS.inlineRows },
  };
}

function headerRowFlag(raw: unknown): boolean | string {
  if (raw === undefined || raw === null || raw === "") return true;
  if (raw === true || raw === "true" || raw === "1") return true;
  if (raw === false || raw === "false" || raw === "0") return false;
  return "headerRow must be true or false";
}

// --- handlers -------------------------------------------------------------------

/** GET /templates/:type — template .xlsx with an Instructions sheet. */
export async function downloadTemplate(req: Request, res: Response): Promise<void> {
  const type = parseType(req.params.type);
  if (!type) return fail(res, 404, "Unknown import type");
  const buffer = await buildTemplate(type);
  res.setHeader("Content-Type", XLSX_TYPE);
  res.setHeader("Content-Disposition", `attachment; filename="${type}-import-template.xlsx"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(buffer);
}

/**
 * POST /:type/preview — multipart `file` (+ `sheet`, `headerRow`) creates a job;
 * JSON `{ jobId, sheet?, headerRow? }` re-reads the stored file of that job.
 */
export async function previewImport(req: Request, res: Response): Promise<void> {
  const type = parseType(req.params.type);
  if (!type) return fail(res, 404, "Unknown import type");
  const actor = req.user!;
  if (!(await mayImport(actor, type))) return fail(res, 403, FORBIDDEN[type]);
  sweepImportFilesSoon();

  const body = (req.body ?? {}) as Record<string, unknown>;
  const headerRow = headerRowFlag(body.headerRow);
  if (typeof headerRow === "string") return fail(res, 400, headerRow);
  const sheet = typeof body.sheet === "string" && body.sheet.trim() ? body.sheet : null;

  try {
    if (req.file) {
      const table = await parseSpreadsheet(req.file.buffer, req.file.originalname, { sheet, headerRow });
      if (table.rows.length === 0) return fail(res, 422, "No data rows found");
      const stored = await storeImportFile(req.file.buffer, req.file.originalname, actor._id as mongoose.Types.ObjectId);
      let job: IImportJob;
      try {
        job = await ImportJob.create({
          type,
          createdBy: actor._id,
          fileName: req.file.originalname.slice(0, 255),
          fileSize: req.file.size,
          fileId: stored.fileId,
          fileExpiresAt: stored.expiresAt,
          sheets: table.sheets,
          sheet: table.sheet,
          headerRow,
          columns: table.headers.map((header, index) => ({ index, header })),
          rowCount: table.rows.length,
          progress: { processed: 0, total: table.rows.length },
        });
      } catch (err) {
        await deleteFromGridFs(stored.fileId, IMPORTS_BUCKET);
        throw err;
      }
      res.status(201).json(previewPayload(job, table));
      return;
    }

    if (typeof body.jobId !== "string" || !mongoose.isValidObjectId(body.jobId)) {
      return fail(res, 400, "Upload a file (multipart field \"file\") or pass the jobId of an earlier preview");
    }
    const job = await ImportJob.findById(body.jobId);
    if (!job || job.type !== type || !job.createdBy.equals(actor._id)) return fail(res, 404, "Import not found");
    if (job.status !== "previewed") return fail(res, 409, "This import has already run");
    job.sheet = sheet ?? job.sheet ?? null;
    job.headerRow = headerRow;
    const table = await readJobTable(job);
    if (table.rows.length === 0) return fail(res, 422, "No data rows found");
    job.sheet = table.sheet;
    job.columns = table.headers.map((header, index) => ({ index, header }));
    job.rowCount = table.rows.length;
    job.mapping = {};
    job.rowsResult = [];
    job.resultsOf = null;
    job.progress = { processed: 0, total: table.rows.length };
    await job.save();
    res.json(previewPayload(job, table));
  } catch (err) {
    handleError(res, err);
  }
}

/** POST /:jobId/validate — `{ mapping, options }` → per-row results (no writes). */
export async function validateImport(req: Request, res: Response): Promise<void> {
  const job = await loadJob(req, res);
  if (!job) return;
  const actor = req.user!;
  if (!job.createdBy.equals(actor._id)) return fail(res, 403, "Only the person who uploaded the file can import it");
  if (!(await mayImport(actor, job.type))) return fail(res, 403, FORBIDDEN[job.type]);
  if (job.status !== "previewed") return fail(res, 409, "This import has already run");
  const body = (req.body ?? {}) as { mapping?: unknown; options?: unknown };
  try {
    const updated = await validateAndStore(job, actor, body.mapping, body.options);
    res.json({ job: serializeJob(updated, { rows: true }) });
  } catch (err) {
    handleError(res, err);
  }
}

/** POST /:jobId/run — `{ mapping?, options? }`; ≤ 200 rows inline (200), else background (202). */
export async function runImport(req: Request, res: Response): Promise<void> {
  const job = await loadJob(req, res);
  if (!job) return;
  const actor = req.user!;
  if (!job.createdBy.equals(actor._id)) return fail(res, 403, "Only the person who uploaded the file can import it");
  if (!(await mayImport(actor, job.type))) return fail(res, 403, FORBIDDEN[job.type]);
  if (job.status !== "previewed") return fail(res, 409, "This import is already running or has finished");
  const body = (req.body ?? {}) as { mapping?: unknown; options?: unknown };
  try {
    const result = await startRun(job, actor, req.ip, body.mapping, body.options);
    const running = result.status === "running";
    res.status(running ? 202 : 200).json({ job: serializeJob(result, { rows: !running }) });
  } catch (err) {
    handleError(res, err);
  }
}

/** GET /:jobId — status, progress, totals (+ rows once not running). */
export async function getImport(req: Request, res: Response): Promise<void> {
  const job = await loadJob(req, res);
  if (!job) return;
  const owner = await User.findById(job.createdBy).select("name").lean<{ name: string }>();
  res.setHeader("Cache-Control", "no-store");
  res.json({ job: serializeJob(job, { rows: job.status !== "running", createdByName: owner?.name ?? null }) });
}

/** GET /:jobId/errors.xlsx — failing rows + reason. */
export async function downloadErrors(req: Request, res: Response): Promise<void> {
  const job = await loadJob(req, res);
  if (!job) return;
  if (!job.rowsResult.some((r) => r.status === "error")) return fail(res, 404, "This import has no failing rows");
  const buffer = await buildErrorReport(job);
  const base = job.fileName.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_").slice(0, 60) || job.type;
  res.setHeader("Content-Type", XLSX_TYPE);
  res.setHeader("Content-Disposition", `attachment; filename="${base}-errors-${appDateKey()}.xlsx"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(buffer);
}

/** POST /:jobId/undo — deletes unedited created records (24 h). Idempotent. */
export async function undoImportHandler(req: Request, res: Response): Promise<void> {
  const job = await loadJob(req, res);
  if (!job) return;
  try {
    const result = await undoImport(job, req.user!, req.ip);
    // 202 while a large undo runs in the background (poll GET /:jobId until undoResult is set).
    res.status(result.status === "undone" && !result.undoResult ? 202 : 200).json({ job: serializeJob(result) });
  } catch (err) {
    handleError(res, err);
  }
}

/** GET / — my recent imports (admins: everyone's; `?mine=true` for own). `?type=&limit=` */
export async function listImports(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const filter: Record<string, unknown> = {};
  if (actor.role !== "admin" || req.query.mine === "true") filter.createdBy = actor._id;
  if (req.query.type !== undefined) {
    const type = parseType(req.query.type);
    if (!type) return fail(res, 400, "type must be projects or tasks");
    filter.type = type;
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const [jobs, total] = await Promise.all([
    ImportJob.find(filter).select("-rowsResult.values").sort({ createdAt: -1 }).skip(offset).limit(limit),
    ImportJob.countDocuments(filter),
  ]);
  const users = await User
    .find({ _id: { $in: [...new Set(jobs.map((j) => j.createdBy.toString()))] } })
    .select("name")
    .lean<Array<{ _id: mongoose.Types.ObjectId; name: string }>>();
  const names = new Map(users.map((u) => [u._id.toString(), u.name]));
  const fresh = await Promise.all(jobs.map((j) => failIfStale(j)));
  res.setHeader("Cache-Control", "no-store");
  res.json({
    imports: fresh.map((j) => serializeJob(j, { createdByName: names.get(j.createdBy.toString()) ?? null })),
    total,
    limit,
    offset,
  });
}

/** Scheduled cleanup entry point (scheduler / dev loop). */
export { purgeExpiredImportFiles };
