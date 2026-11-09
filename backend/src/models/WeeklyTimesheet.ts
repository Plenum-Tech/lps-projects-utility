import mongoose, { Schema } from "mongoose";

export const TIMESHEET_STATUSES = ["draft", "submitted", "approved", "rejected"] as const;
export type TimesheetStatus = (typeof TIMESHEET_STATUSES)[number];

/** A row's day: time on a task, or (Program / CM / leadership) on a brand as a whole. */
export interface ITimesheetEntry {
  task?: mongoose.Types.ObjectId | null;
  brand?: mongoose.Types.ObjectId | null;
  /** Brand rows: the brand's project (of the month) the time was on; null = the brand as a whole. */
  project?: mongoose.Types.ObjectId | null;
  /** Brand rows: what the time was for (optional). */
  note?: string;
  /** Date-only (UTC midnight), within the week. */
  date: Date;
  minutes: number;
}

export interface IWeeklyTimesheet extends mongoose.Document {
  user: mongoose.Types.ObjectId;
  /** Monday, date-only (UTC midnight). */
  weekStart: Date;
  status: TimesheetStatus;
  entries: mongoose.Types.DocumentArray<ITimesheetEntry & mongoose.Types.Subdocument>;
  submittedAt?: Date | null;
  reviewedBy?: mongoose.Types.ObjectId | null;
  reviewedAt?: Date | null;
  rejectReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const entrySchema = new Schema<ITimesheetEntry>(
  {
    task: { type: Schema.Types.ObjectId, ref: "Task", default: null },
    brand: { type: Schema.Types.ObjectId, ref: "Brand", default: null },
    project: { type: Schema.Types.ObjectId, ref: "Project", default: null },
    note: { type: String, default: "", trim: true, maxlength: 300 },
    date: { type: Date, required: true },
    minutes: { type: Number, required: true, min: 1, max: 1440 },
  },
  { _id: false }
);

const weeklyTimesheetSchema = new Schema<IWeeklyTimesheet>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    weekStart: { type: Date, required: true },
    status: { type: String, enum: TIMESHEET_STATUSES, default: "draft" },
    entries: { type: [entrySchema], default: [] },
    submittedAt: { type: Date, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    rejectReason: { type: String, trim: true, maxlength: 1000 },
  },
  { timestamps: true }
);

weeklyTimesheetSchema.index({ user: 1, weekStart: 1 }, { unique: true });
weeklyTimesheetSchema.index({ status: 1, weekStart: -1 });

weeklyTimesheetSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    return json;
  },
});

export const WeeklyTimesheet = mongoose.model<IWeeklyTimesheet>("WeeklyTimesheet", weeklyTimesheetSchema);
