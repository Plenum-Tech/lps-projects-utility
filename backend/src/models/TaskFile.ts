import mongoose, { Schema } from "mongoose";
import { deliveryInvalidateOnWrite } from "../lib/delivery/cache.js";
import { addLegacyRef } from "./legacy.js";

/** Upload limits for task attachments. */
export const TASK_FILE_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxFilesPerTask: 20,
} as const;

/** Allowed MIME types: images, pdf, office docs, txt, csv, zip. */
export const TASK_FILE_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/zip",
  "application/x-zip-compressed",
];

export interface ITaskFile extends mongoose.Document {
  task: mongoose.Types.ObjectId;
  /** Subtask (embedded in the task) this file is attached to; null = task file. */
  subtask?: mongoose.Types.ObjectId | null;
  uploadedBy: mongoose.Types.ObjectId;
  filename: string;
  mimeType: string;
  size: number;
  /** Id of the file in the `taskFiles` GridFS bucket. */
  gridFsId: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const taskFileSchema = new Schema<ITaskFile>(
  {
    task: { type: Schema.Types.ObjectId, ref: "Task", required: true, index: true },
    subtask: { type: Schema.Types.ObjectId, default: null },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    filename: { type: String, required: true, trim: true, maxlength: 255 },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true, min: 0 },
    gridFsId: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: true }
);

// A subtask's attachments.
taskFileSchema.index({ task: 1, subtask: 1 });

// Never leak the internal version key (or the storage id) in JSON responses.
taskFileSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    delete json.gridFsId;
    return json;
  },
});

// Brief rules 1 and 7 read files, comments and notes.
deliveryInvalidateOnWrite(taskFileSchema);

// Imported documents (bun run import:worksuite) carry `legacy` for idempotent re-runs.
addLegacyRef(taskFileSchema);

export const TaskFile = mongoose.model<ITaskFile>("TaskFile", taskFileSchema);
