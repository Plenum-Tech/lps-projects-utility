import { ExceptionBatch } from "../changeRequests.js";
import mongoose from "mongoose";
import { applyTaskDelete } from "../../controllers/tasks.js";
import { ImportJob, IMPORT_LIMITS } from "../../models/ImportJob.js";
import type { IImportCreated, IImportJob, IImportRowResult, IImportTotals } from "../../models/ImportJob.js";
import { Milestone } from "../../models/Milestone.js";
import { Notification } from "../../models/Notification.js";
import { Project } from "../../models/Project.js";
import { ProjectActivity } from "../../models/ProjectActivity.js";
import { ProjectFile } from "../../models/ProjectFile.js";
import { ProjectNote } from "../../models/ProjectNote.js";
import { Task } from "../../models/Task.js";
import { TaskComment } from "../../models/TaskComment.js";
import { TaskFile } from "../../models/TaskFile.js";
import { TaskHistory } from "../../models/TaskHistory.js";
import { TaskNote } from "../../models/TaskNote.js";
import { TimeLog } from "../../models/TimeLog.js";
import { User } from "../../models/User.js";
import type { IUser } from "../../models/User.js";
import { logActivity } from "../activityLog.js";
import { deleteFromGridFs, openGridFsDownload, uploadToGridFs } from "../gridfs.js";
import { pushProjectUpdate } from "../projectAccess.js";
import { mappingColumns, parseOptions, type ImportOptions, type RowPlan } from "./context.js";
import { fieldsFor } from "./fields.js";
import { cellText, ImportFileError, parseSpreadsheet, type ParsedTable } from "./parse.js";
import { runProjectRow, validateProjectRows, type ProjectPlan, type RunRowResult } from "./projects.js";
import { runTaskRow, validateTaskRows, type TaskPlan } from "./tasks.js";

// ---------------------------------------------------------------------------
// Import job lifecycle: raw file storage (GridFS, ≤ 1 h), validation, the run
// (inline or background with persisted progress), undo, and file cleanup.
// ---------------------------------------------------------------------------

export const IMPORTS_BUCKET = "imports";
/** A background run whose heartbeat is older than this was interrupted (restart). */
const STALE_RUN_MS = 2 * 60_000;
const PROGRESS_EVERY_ROWS = 25;
/** Characters of original cell text kept for error rows (error report after the file is gone). */
const VALUES_BUDGET = 2_000_000;
const VALUE_MAX = 1_000;

export class ImportRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

// --- raw file ---------------------------------------------------------------

export async function storeImportFile(buffer: Buffer, fileName: string, userId: mongoose.Types.ObjectId) {
  const expiresAt = new Date(Date.now() + IMPORT_LIMITS.fileTtlMs);
  const fileId = await uploadToGridFs(buffer, fileName, { uploadedBy: userId, expiresAt }, IMPORTS_BUCKET);
  return { fileId, expiresAt };
}

async function readImportFile(job: IImportJob): Promise<Buffer> {
  if (!job.fileId || !job.fileExpiresAt || job.fileExpiresAt.getTime() <= Date.now()) {
    throw new ImportRequestError(410, "The uploaded file has expired (files are kept for 1 hour). Upload it again.");
  }
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of openGridFsDownload(job.fileId, IMPORTS_BUCKET)) chunks.push(chunk as Buffer);
  } catch {
    throw new ImportRequestError(410, "The uploaded file is no longer available. Upload it again.");
  }
  return Buffer.concat(chunks);
}

export async function readJobTable(job: IImportJob): Promise<ParsedTable> {
  return parseSpreadsheet(await readImportFile(job), job.fileName, { sheet: job.sheet, headerRow: job.headerRow });
}

/** Deletes raw files past their 1-hour lifetime (job-linked and orphaned). Idempotent. */
export async function purgeExpiredImportFiles(now: Date = new Date()): Promise<{ deleted: number }> {
  const db = mongoose.connection.db;
  if (!db) return { deleted: 0 };
  let deleted = 0;
  const jobs = await ImportJob.find({ fileId: { $type: "objectId" }, fileExpiresAt: { $lte: now } }).select("fileId").limit(500);
  for (const job of jobs) {
    await deleteFromGridFs(job.fileId!, IMPORTS_BUCKET);
    await ImportJob.updateOne({ _id: job._id }, { $set: { fileId: null } });
    deleted += 1;
  }
  const orphans = await db
    .collection(`${IMPORTS_BUCKET}.files`)
    .find({ "metadata.expiresAt": { $lte: now } })
    .project({ _id: 1 })
    .limit(500)
    .toArray();
  for (const f of orphans) {
    await deleteFromGridFs(f._id as mongoose.Types.ObjectId, IMPORTS_BUCKET);
    deleted += 1;
  }
  return { deleted };
}

let lastSweep = 0;
/** Opportunistic cleanup from import requests (at most once a minute per process). */
export function sweepImportFilesSoon(): void {
  if (Date.now() - lastSweep < 60_000) return;
  lastSweep = Date.now();
  void purgeExpiredImportFiles().catch((err) => console.error("[imports] file cleanup failed:", err));
}

// --- validation -------------------------------------------------------------

type AnyPlan = RowPlan<ProjectPlan> | RowPlan<TaskPlan>;

export interface ValidationOutcome {
  plans: AnyPlan[];
  table: ParsedTable;
  columns: Map<string, number>;
  options: ImportOptions;
  mapping: Record<string, string>;
}

/** Parses the stored file and validates every row with `mapping` / `options` (no writes). */
export async function validateJob(job: IImportJob, actor: IUser, rawMapping: unknown, rawOptions: unknown): Promise<ValidationOutcome> {
  const options = parseOptions(rawOptions);
  if (typeof options === "string") throw new ImportRequestError(400, options);
  const fields = fieldsFor(job.type);
  const table = await readJobTable(job);
  const columns = mappingColumns(rawMapping, fields.map((f) => f.key), table.headers.length);
  if (typeof columns === "string") throw new ImportRequestError(400, columns);
  const missing = fields.filter((f) => f.required === true && !columns.has(f.key)).map((f) => f.label);
  if (missing.length > 0) throw new ImportRequestError(400, `Map the required field${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
  if (table.rows.length === 0) throw new ImportRequestError(422, "No data rows found");
  const plans =
    job.type === "projects"
      ? await validateProjectRows(actor, options, table.rows, columns)
      : await validateTaskRows(actor, options, table.rows, columns);
  const mapping: Record<string, string> = {};
  for (const [field, col] of columns) mapping[String(col)] = field;
  return { plans, table, columns, options, mapping };
}

/** Row results for storage; error rows keep their original text (within a budget). */
function withValues(results: IImportRowResult[], table: ParsedTable): IImportRowResult[] {
  const byRow = new Map(table.rows.map((r) => [r.row, r]));
  let budget = VALUES_BUDGET;
  return results.map((r) => {
    const messages = r.messages.slice(0, 10).map((m) => m.slice(0, 500));
    if (r.status !== "error" || budget <= 0) return { ...r, messages };
    const values = (byRow.get(r.row)?.cells ?? []).map((c) => cellText(c).slice(0, VALUE_MAX));
    budget -= values.reduce((n, v) => n + v.length, 0);
    return { ...r, messages, values };
  });
}

export function validationTotals(plans: AnyPlan[]): IImportTotals {
  return {
    rows: plans.length,
    ready: plans.filter((p) => p.status === "ready").length,
    warnings: plans.filter((p) => p.status === "warning").length,
    errors: plans.filter((p) => p.status === "error").length,
    created: 0,
    updated: 0,
    skipped: plans.filter((p) => p.status !== "error" && p.action === "skip").length,
  };
}

/** POST /:jobId/validate — stores mapping/options and the validation results. */
export async function validateAndStore(job: IImportJob, actor: IUser, mapping: unknown, options: unknown): Promise<IImportJob> {
  const outcome = await validateJob(job, actor, mapping, options);
  job.mapping = outcome.mapping;
  job.options = outcome.options as unknown as Record<string, unknown>;
  job.totals = validationTotals(outcome.plans);
  job.rowsResult = withValues(
    outcome.plans.map((p) => ({ row: p.row, status: p.status, action: p.action, messages: p.messages })),
    outcome.table
  );
  job.resultsOf = "validate";
  job.markModified("mapping");
  job.markModified("options");
  await job.save();
  return job;
}

// --- run ----------------------------------------------------------------------

/**
 * Claims the job (previewed → running; a second run gets 409), then imports
 * inline (≤ 200 rows) or in the background. Returns the job after an inline
 * run, or right after claiming for a background one.
 */
export async function startRun(job: IImportJob, actor: IUser, ip: string | undefined, mapping: unknown, options: unknown): Promise<IImportJob> {
  const useMapping = mapping ?? (Object.keys(job.mapping ?? {}).length > 0 ? job.mapping : undefined);
  if (!useMapping) throw new ImportRequestError(400, "mapping is required (validate first or send it with run)");
  const useOptions = options ?? job.options;
  // Validate synchronously first so mapping/file problems are reported as 4xx.
  const outcome = await validateJob(job, actor, useMapping, useOptions);

  const now = new Date();
  const claimed = await ImportJob.findOneAndUpdate(
    { _id: job._id, status: "previewed" },
    {
      $set: {
        status: "running",
        startedAt: now,
        heartbeatAt: now,
        mapping: outcome.mapping,
        options: outcome.options,
        progress: { processed: 0, total: outcome.plans.length },
        createdIds: [],
      },
    },
    { returnDocument: "after" }
  );
  if (!claimed) throw new ImportRequestError(409, "This import is already running or has finished");

  if (outcome.plans.length <= IMPORT_LIMITS.inlineRows) {
    await executeRun(claimed, actor, ip, outcome);
    return (await ImportJob.findById(job._id))!;
  }
  void executeRun(claimed, actor, ip, outcome).catch(async (err) => {
    console.error("[imports] background run failed:", err);
    await ImportJob.updateOne(
      { _id: job._id, status: "running" },
      { $set: { status: "failed", finishedAt: new Date(), error: "The import failed unexpectedly" } }
    ).catch(() => undefined);
  });
  return claimed;
}

async function executeRun(job: IImportJob, actor: IUser, ip: string | undefined, outcome: ValidationOutcome): Promise<void> {
  const jobId = job._id.toString();
  const results: IImportRowResult[] = [];
  const created: IImportCreated[] = [];
  let lastPersist = Date.now();
  // Scope / team changed by "Update" rows: the approvers get one message for the run.
  const exceptions = new ExceptionBatch("import_update", actor);

  for (const [i, plan] of outcome.plans.entries()) {
    let result: RunRowResult;
    if (plan.status === "error" || !plan.plan) {
      result = { status: "error", messages: plan.messages };
    } else {
      try {
        result =
          job.type === "projects"
            ? await runProjectRow(actor, plan.plan as ProjectPlan, outcome.options, ip, jobId, exceptions)
            : await runTaskRow(actor, plan.plan as TaskPlan, outcome.options, ip, jobId);
        if (result.status !== "error") result.messages = [...plan.messages, ...result.messages];
      } catch (err) {
        console.error(`[imports] row ${plan.row} failed:`, err);
        result = { status: "error", messages: ["Unexpected error while importing this row"] };
      }
    }
    if (result.created) created.push(result.created);
    results.push({
      row: plan.row,
      status: result.status,
      action: plan.action,
      messages: result.messages,
      recordId: result.recordId ?? null,
      recordRef: result.recordRef ?? null,
    });
    const processed = i + 1;
    if (processed % PROGRESS_EVERY_ROWS === 0 || Date.now() - lastPersist > 1_000) {
      lastPersist = Date.now();
      await ImportJob.updateOne(
        { _id: job._id },
        { $set: { progress: { processed, total: outcome.plans.length }, heartbeatAt: new Date(), createdIds: created } }
      );
    }
  }

  await exceptions.flush();

  const totals: IImportTotals = {
    rows: results.length,
    ready: 0,
    warnings: results.filter((r) => r.status !== "error" && r.messages.length > 0).length,
    errors: results.filter((r) => r.status === "error").length,
    created: results.filter((r) => r.status === "created").length,
    updated: results.filter((r) => r.status === "updated").length,
    skipped: results.filter((r) => r.status === "skipped").length,
  };
  totals.ready = totals.created + totals.updated;
  const finishedAt = new Date();
  await ImportJob.updateOne(
    { _id: job._id },
    {
      $set: {
        status: "completed",
        finishedAt,
        heartbeatAt: finishedAt,
        progress: { processed: results.length, total: results.length },
        totals,
        rowsResult: withValues(results, outcome.table),
        resultsOf: "run",
        createdIds: created,
        undoUntil: created.length > 0 ? new Date(finishedAt.getTime() + IMPORT_LIMITS.undoWindowMs) : null,
      },
    }
  );
  logActivity({
    action: "import_completed",
    actor,
    targetType: "import",
    targetId: job._id as mongoose.Types.ObjectId,
    targetName: `${job.type} · ${job.fileName}`,
    details: { type: job.type, created: totals.created, updated: totals.updated, skipped: totals.skipped, errors: totals.errors },
    ip,
  });
}

/** Marks a "running" job whose heartbeat stopped (process restart) as failed. */
export async function failIfStale(job: IImportJob): Promise<IImportJob> {
  if (job.status !== "running" || !job.heartbeatAt || Date.now() - job.heartbeatAt.getTime() < STALE_RUN_MS) return job;
  const updated = await ImportJob.findOneAndUpdate(
    { _id: job._id, status: "running", heartbeatAt: job.heartbeatAt },
    {
      $set: {
        status: "failed",
        finishedAt: new Date(),
        error: "The import was interrupted (server restart). Records created so far can be undone.",
        undoUntil: job.createdIds.length > 0 ? new Date(Date.now() + IMPORT_LIMITS.undoWindowMs) : null,
      },
    },
    { returnDocument: "after" }
  );
  return updated ?? job;
}

// --- undo ---------------------------------------------------------------------

async function taskEdited(id: mongoose.Types.ObjectId): Promise<string | null> {
  const [history, comment, file, note, log] = await Promise.all([
    TaskHistory.exists({ task: id, action: { $nin: ["created", "created_from_meeting", "reminder_sent"] } }),
    TaskComment.exists({ task: id }),
    TaskFile.exists({ task: id }),
    TaskNote.exists({ task: id }),
    TimeLog.exists({ task: id }),
  ]);
  if (history) return "edited since the import";
  if (comment || file || note) return "has comments, notes or files";
  if (log) return "has logged time";
  return null;
}

async function projectEdited(id: mongoose.Types.ObjectId): Promise<string | null> {
  const [activity, task, log, file, note, milestone] = await Promise.all([
    ProjectActivity.exists({ project: id, action: { $ne: "created" } }),
    Task.exists({ project: id }),
    TimeLog.exists({ project: id }),
    ProjectFile.exists({ project: id }),
    ProjectNote.exists({ project: id }),
    Milestone.exists({ project: id }),
  ]);
  if (task) return "has tasks";
  if (activity) return "edited since the import";
  if (log || file || note || milestone) return "has time logs, files, notes or milestones";
  return null;
}

/** Deletes the records an import created that nobody has touched since. Idempotent. */
export async function undoImport(job: IImportJob, actor: IUser, ip: string | undefined): Promise<IImportJob> {
  if (job.status === "undone") return job;
  if (job.status !== "completed" && job.status !== "failed") throw new ImportRequestError(409, "Only finished imports can be undone");
  if (job.createdIds.length === 0) throw new ImportRequestError(409, "This import didn't create any records");
  if (!job.undoUntil || job.undoUntil.getTime() < Date.now()) throw new ImportRequestError(410, "Undo is only available for 24 hours after an import");

  const claimed = await ImportJob.findOneAndUpdate(
    { _id: job._id, status: job.status, undoneAt: null },
    { $set: { status: "undone", undoneAt: new Date(), undoneBy: actor._id } },
    { returnDocument: "after" }
  );
  if (!claimed) return (await ImportJob.findById(job._id)) ?? job;

  if (job.createdIds.length > IMPORT_LIMITS.inlineRows) {
    // Large imports are undone in the background; `undoResult` stays null until done.
    void performUndo(job, actor, ip).catch((err) => console.error("[imports] undo failed:", err));
    return claimed;
  }
  await performUndo(job, actor, ip);
  return (await ImportJob.findById(job._id))!;
}

async function performUndo(job: IImportJob, actor: IUser, ip: string | undefined): Promise<void> {
  let deleted = 0;
  const skipped: Array<{ id: string; ref: string | null; reason: string }> = [];
  const refOf = new Map(job.rowsResult.filter((r) => r.recordId).map((r) => [r.recordId!.toString(), r.recordRef ?? null]));
  const skip = (id: mongoose.Types.ObjectId, reason: string) => skipped.push({ id: id.toString(), ref: refOf.get(id.toString()) ?? null, reason });

  for (const item of job.createdIds.filter((c) => c.kind === "task")) {
    const task = await Task.findById(item.id);
    if (!task) {
      skip(item.id, "already deleted");
      continue;
    }
    const edited = await taskEdited(item.id);
    if (edited) {
      skip(item.id, edited);
      continue;
    }
    const failed = await applyTaskDelete(actor, task, ip, { keepTimeOnProject: true });
    if (failed) skip(item.id, failed.error);
    else deleted += 1;
  }
  for (const item of job.createdIds.filter((c) => c.kind === "project")) {
    const project = await Project.findById(item.id);
    if (!project) {
      skip(item.id, "already deleted");
      continue;
    }
    const edited = await projectEdited(item.id);
    if (edited) {
      skip(item.id, edited);
      continue;
    }
    const audience = { ...project.toObject(), _id: project._id } as unknown as typeof project;
    await Promise.all([
      Project.deleteOne({ _id: item.id }),
      ProjectActivity.deleteMany({ project: item.id }),
      Notification.deleteMany({ project: item.id }),
      User.updateMany({ pinnedProjects: item.id }, { $pull: { pinnedProjects: item.id } }),
    ]);
    pushProjectUpdate(audience, "deleted", { actorId: actor._id.toString() });
    deleted += 1;
  }

  const undoResult = { deleted, skipped };
  await ImportJob.updateOne({ _id: job._id }, { $set: { undoResult } });
  logActivity({
    action: "import_undone",
    actor,
    targetType: "import",
    targetId: job._id as mongoose.Types.ObjectId,
    targetName: `${job.type} · ${job.fileName}`,
    details: { type: job.type, deleted, skipped: skipped.length },
    ip,
  });
}

export { ImportFileError };
