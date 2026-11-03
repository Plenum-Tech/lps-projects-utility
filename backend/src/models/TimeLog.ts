import mongoose, { Schema } from "mongoose";
import { addLegacyRef } from "./legacy.js";

export const TIMELOG_SOURCES = ["timer", "manual", "timesheet"] as const;
export type TimeLogSource = (typeof TIMELOG_SOURCES)[number];

export const TIMELOG_STATUSES = ["pending", "approved", "rejected"] as const;
export type TimeLogStatus = (typeof TIMELOG_STATUSES)[number];

export interface ITimeLogBreak {
  startTime: Date;
  endTime?: Date | null;
  reason?: string;
}

export interface ITimeLog extends mongoose.Document {
  user: mongoose.Types.ObjectId;
  project?: mongoose.Types.ObjectId | null;
  task?: mongoose.Types.ObjectId | null;
  /** The rework item (task subtask) this time was spent on, if any. */
  subtask?: mongoose.Types.ObjectId | null;
  /**
   * Time spent on a brand as a whole (weekly timesheet brand rows — Program, CM, leadership):
   * no project or task. Reports count it with the brand's project hours.
   */
  brand?: mongoose.Types.ObjectId | null;
  startTime: Date;
  /** null = timer running. */
  endTime?: Date | null;
  breaks: mongoose.Types.DocumentArray<ITimeLogBreak & mongoose.Types.Subdocument>;
  /** (end - start) - breaks, rounded to whole minutes. */
  durationMinutes: number;
  breakMinutes: number;
  memo: string;
  source: TimeLogSource;
  /** Snapshot of the rate used for earnings. */
  hourlyRate: number;
  earnings: number;
  status: TimeLogStatus;
  reviewedBy?: mongoose.Types.ObjectId | null;
  reviewedAt?: Date | null;
  rejectReason?: string;
  weeklyTimesheet?: mongoose.Types.ObjectId | null;
  addedBy: mongoose.Types.ObjectId;
  editedBy?: mongoose.Types.ObjectId | null;
  /** Set when the auto-stop job (or the hour limit) stopped the timer. */
  autoStopped?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const breakSchema = new Schema<ITimeLogBreak>({
  startTime: { type: Date, required: true },
  endTime: { type: Date, default: null },
  reason: { type: String, trim: true, maxlength: 200 },
});

const timeLogSchema = new Schema<ITimeLog>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    project: { type: Schema.Types.ObjectId, ref: "Project", default: null },
    task: { type: Schema.Types.ObjectId, ref: "Task", default: null },
    subtask: { type: Schema.Types.ObjectId, default: null },
    brand: { type: Schema.Types.ObjectId, ref: "Brand", default: null },
    startTime: { type: Date, required: true },
    // Always stored explicitly (null while running) — the partial unique index relies on it.
    endTime: { type: Date, default: null },
    breaks: { type: [breakSchema], default: [] },
    durationMinutes: { type: Number, default: 0, min: 0 },
    breakMinutes: { type: Number, default: 0, min: 0 },
    memo: { type: String, default: "", trim: true, maxlength: 500 },
    source: { type: String, enum: TIMELOG_SOURCES, required: true },
    hourlyRate: { type: Number, default: 0, min: 0 },
    earnings: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: TIMELOG_STATUSES, default: "pending" },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    rejectReason: { type: String, trim: true, maxlength: 1000 },
    weeklyTimesheet: { type: Schema.Types.ObjectId, ref: "WeeklyTimesheet", default: null },
    addedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    editedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    autoStopped: { type: Boolean, default: false },
  },
  { timestamps: true }
);

timeLogSchema.index({ user: 1, startTime: -1 });
timeLogSchema.index({ project: 1, startTime: -1 });
timeLogSchema.index({ task: 1 });
timeLogSchema.index({ brand: 1, startTime: -1 }, { sparse: true });
timeLogSchema.index({ status: 1 });
timeLogSchema.index({ weeklyTimesheet: 1 }, { sparse: true });
// One running timer per user.
timeLogSchema.index(
  { user: 1 },
  { unique: true, partialFilterExpression: { endTime: null }, name: "one_running_timer_per_user" }
);

timeLogSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    return json;
  },
});

// Imported documents (bun run import:worksuite) carry `legacy` for idempotent re-runs.
addLegacyRef(timeLogSchema);

// Keep the task's Actual start / end in step with its time logs.
function syncTaskActuals(doc: { task?: unknown } | null): void {
  const task = doc?.task;
  if (!task) return;
  void import("../lib/actualDates.js")
    .then((m) => m.syncActualDatesFromLogs(task as mongoose.Types.ObjectId))
    .catch(() => undefined);
}
timeLogSchema.post("save", (doc) => syncTaskActuals(doc));
timeLogSchema.post("findOneAndUpdate", (doc: { task?: unknown } | null) => syncTaskActuals(doc));
timeLogSchema.post("deleteOne", { document: true, query: false }, function (this: { task?: unknown }) {
  syncTaskActuals(this);
});

export const TimeLog = mongoose.model<ITimeLog>("TimeLog", timeLogSchema);
