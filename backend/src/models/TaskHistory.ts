import mongoose, { Schema } from "mongoose";
import { addLegacyRef } from "./legacy.js";

/** Every action recorded in a task's history timeline. Keep in sync with the frontend. */
export const TASK_HISTORY_ACTIONS = [
  "created",
  "created_from_meeting",
  "updated",
  "status_changed",
  "assignees_changed",
  "subtask_added",
  "subtask_updated",
  "subtask_completed",
  "subtask_reopened",
  "subtask_removed",
  "comment_added",
  "file_added",
  "file_removed",
  "note_added",
  "note_updated",
  "note_removed",
  "submitted",
  "reviewed",
  "reminder_sent",
  "actual_dates_updated",
  "subtask_actual_dates_updated",
  "pearity_generated",
  "rework_added",
] as const;

export type TaskHistoryAction = (typeof TASK_HISTORY_ACTIONS)[number];

export interface ITaskHistory extends mongoose.Document {
  task: mongoose.Types.ObjectId;
  /** Null for system events (scheduled reminders). */
  actor?: mongoose.Types.ObjectId | null;
  action: TaskHistoryAction;
  details?: unknown;
  createdAt: Date;
}

const taskHistorySchema = new Schema<ITaskHistory>(
  {
    task: { type: Schema.Types.ObjectId, ref: "Task", required: true },
    actor: { type: Schema.Types.ObjectId, ref: "User", default: null },
    action: { type: String, required: true, enum: TASK_HISTORY_ACTIONS },
    details: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Task timeline — newest first.
taskHistorySchema.index({ task: 1, createdAt: -1 });

// Never leak the internal version key in JSON responses.
taskHistorySchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    return json;
  },
});

// Imported documents (bun run import:worksuite) carry `legacy` for idempotent re-runs.
addLegacyRef(taskHistorySchema);

export const TaskHistory = mongoose.model<ITaskHistory>("TaskHistory", taskHistorySchema);
