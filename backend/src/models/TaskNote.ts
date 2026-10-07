import mongoose, { Schema } from "mongoose";
import { deliveryInvalidateOnWrite } from "../lib/delivery/cache.js";

export const TASK_NOTE_VISIBILITIES = ["task", "private"] as const;

export type TaskNoteVisibility = (typeof TASK_NOTE_VISIBILITIES)[number];

export const TASK_NOTE_LIMITS = {
  maxTitle: 150,
  maxBody: 10000,
} as const;

/**
 * Longer-lived reference text on a task (specs, decisions, links) — the
 * conversation lives in TaskComment. `private` notes are visible to the author
 * and admins only.
 */
export interface ITaskNote extends mongoose.Document {
  task: mongoose.Types.ObjectId;
  author: mongoose.Types.ObjectId;
  title?: string;
  /** Plain text with line breaks; `@[Name](userId)` tokens mark mentions. */
  body: string;
  visibility: TaskNoteVisibility;
  /** Users mentioned in the body (only those who can view the task; empty for private notes). */
  mentions: mongoose.Types.ObjectId[];
  pinned: boolean;
  editedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const taskNoteSchema = new Schema<ITaskNote>(
  {
    task: { type: Schema.Types.ObjectId, ref: "Task", required: true, index: true },
    author: { type: Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, trim: true, maxlength: TASK_NOTE_LIMITS.maxTitle, default: "" },
    body: { type: String, required: true, trim: true, maxlength: TASK_NOTE_LIMITS.maxBody },
    visibility: { type: String, enum: TASK_NOTE_VISIBILITIES, default: "task" },
    mentions: { type: [{ type: Schema.Types.ObjectId, ref: "User" }], default: [] },
    pinned: { type: Boolean, default: false },
    editedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Notes on a task — pinned first, then newest.
taskNoteSchema.index({ task: 1, pinned: -1, createdAt: -1 });

// Never leak the internal version key in JSON responses.
taskNoteSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    return json;
  },
});

// Brief rules 1 and 7 read files, comments and notes.
deliveryInvalidateOnWrite(taskNoteSchema);

export const TaskNote = mongoose.model<ITaskNote>("TaskNote", taskNoteSchema);
