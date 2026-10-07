import mongoose, { Schema } from "mongoose";

// ---------------------------------------------------------------------------
// One spreadsheet import (Projects or Tasks): the uploaded file (GridFS, kept
// for at most an hour), the column mapping and options, per-row results, the
// records it created (for Undo) and the progress of a background run.
// ---------------------------------------------------------------------------

export const IMPORT_TYPES = ["projects", "tasks"] as const;
export type ImportType = (typeof IMPORT_TYPES)[number];

export const IMPORT_STATUSES = ["previewed", "running", "completed", "failed", "undone"] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/** Validate: ready | warning | error. Run: created | updated | skipped | error. */
export const IMPORT_ROW_STATUSES = ["ready", "warning", "error", "created", "updated", "skipped"] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];

/** What a valid row will do (projects: create / update / skip an existing code). */
export const IMPORT_ROW_ACTIONS = ["create", "update", "skip"] as const;
export type ImportRowAction = (typeof IMPORT_ROW_ACTIONS)[number];

export interface IImportRowResult {
  /** Spreadsheet row number (1-based, as shown in Excel). */
  row: number;
  status: ImportRowStatus;
  action?: ImportRowAction | null;
  messages: string[];
  recordId?: mongoose.Types.ObjectId | null;
  /** Project code / task short code ("WEB-12") or "#123" of the record. */
  recordRef?: string | null;
  /** Original cell text of failing rows (for the error report once the file is gone). */
  values?: string[];
}

export interface IImportCreated {
  kind: "project" | "task";
  id: mongoose.Types.ObjectId;
}

export interface IImportTotals {
  rows: number;
  ready: number;
  warnings: number;
  errors: number;
  created: number;
  updated: number;
  skipped: number;
}

export interface IImportJob extends mongoose.Document {
  type: ImportType;
  createdBy: mongoose.Types.ObjectId;
  status: ImportStatus;
  fileName: string;
  fileSize: number;
  /** GridFS id in the "imports" bucket; null once the raw file was deleted (≤ 1 h). */
  fileId?: mongoose.Types.ObjectId | null;
  fileExpiresAt?: Date | null;
  sheets: string[];
  sheet?: string | null;
  headerRow: boolean;
  columns: Array<{ index: number; header: string }>;
  /** Non-empty data rows in the chosen sheet. */
  rowCount: number;
  /** `{ "<column index>": "<field key>" }`. */
  mapping: Record<string, string>;
  options: Record<string, unknown>;
  /** "validate" results until the import runs, then the run results. */
  resultsOf: "validate" | "run" | null;
  totals: IImportTotals;
  rowsResult: IImportRowResult[];
  createdIds: IImportCreated[];
  progress: { processed: number; total: number };
  startedAt?: Date | null;
  finishedAt?: Date | null;
  /** Bumped while a background run is alive; a stale one is marked failed. */
  heartbeatAt?: Date | null;
  undoUntil?: Date | null;
  undoneAt?: Date | null;
  undoneBy?: mongoose.Types.ObjectId | null;
  undoResult?: { deleted: number; skipped: Array<{ id: string; ref: string | null; reason: string }> } | null;
  error?: string | null;
  /** The job document itself is removed after 30 days (TTL index). */
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const IMPORT_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxRows: 2000,
  maxColumns: 50,
  maxCellChars: 5000,
  /** Zip-bomb guard: total unpacked size of an .xlsx. */
  maxUnzippedBytes: 50 * 1024 * 1024,
  maxZipEntries: 5000,
  /** Rows processed inside the request; larger files run in the background. */
  inlineRows: 200,
  fileTtlMs: 60 * 60 * 1000,
  undoWindowMs: 24 * 60 * 60 * 1000,
  jobTtlMs: 30 * 24 * 60 * 60 * 1000,
  sampleRows: 20,
} as const;

const rowResultSchema = new Schema<IImportRowResult>(
  {
    row: { type: Number, required: true },
    status: { type: String, enum: IMPORT_ROW_STATUSES, required: true },
    action: { type: String, enum: [...IMPORT_ROW_ACTIONS, null], default: null },
    messages: { type: [String], default: [] },
    recordId: { type: Schema.Types.ObjectId, default: null },
    recordRef: { type: String, default: null },
    values: { type: [String], default: undefined },
  },
  { _id: false }
);

const importJobSchema = new Schema<IImportJob>(
  {
    type: { type: String, enum: IMPORT_TYPES, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: IMPORT_STATUSES, default: "previewed" },
    fileName: { type: String, required: true, trim: true, maxlength: 255 },
    fileSize: { type: Number, default: 0 },
    fileId: { type: Schema.Types.ObjectId, default: null },
    fileExpiresAt: { type: Date, default: null },
    sheets: { type: [String], default: [] },
    sheet: { type: String, default: null },
    headerRow: { type: Boolean, default: true },
    columns: {
      type: [new Schema({ index: Number, header: String }, { _id: false })],
      default: [],
    },
    rowCount: { type: Number, default: 0 },
    mapping: { type: Schema.Types.Mixed, default: {} },
    options: { type: Schema.Types.Mixed, default: {} },
    resultsOf: { type: String, enum: ["validate", "run", null], default: null },
    totals: {
      rows: { type: Number, default: 0 },
      ready: { type: Number, default: 0 },
      warnings: { type: Number, default: 0 },
      errors: { type: Number, default: 0 },
      created: { type: Number, default: 0 },
      updated: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
    },
    rowsResult: { type: [rowResultSchema], default: [] },
    createdIds: {
      type: [
        new Schema(
          { kind: { type: String, enum: ["project", "task"] }, id: Schema.Types.ObjectId },
          { _id: false }
        ),
      ],
      default: [],
    },
    progress: {
      processed: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    heartbeatAt: { type: Date, default: null },
    undoUntil: { type: Date, default: null },
    undoneAt: { type: Date, default: null },
    undoneBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    undoResult: { type: Schema.Types.Mixed, default: null },
    error: { type: String, default: null },
    expiresAt: { type: Date, default: () => new Date(Date.now() + IMPORT_LIMITS.jobTtlMs) },
  },
  { timestamps: true, minimize: false }
);

importJobSchema.index({ createdBy: 1, createdAt: -1 });
importJobSchema.index({ createdAt: -1 });
importJobSchema.index({ fileExpiresAt: 1 }, { partialFilterExpression: { fileId: { $type: "objectId" } } });
importJobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ImportJob = mongoose.model<IImportJob>("ImportJob", importJobSchema);
