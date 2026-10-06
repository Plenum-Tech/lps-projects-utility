import mongoose, { Schema } from "mongoose";

export const LOG_TIME_FOR = ["project", "task"] as const;
export type LogTimeFor = (typeof LOG_TIME_FOR)[number];

export const DEADLINE_REMINDER_TARGETS = ["manager", "members", "admins"] as const;
export type DeadlineReminderTarget = (typeof DEADLINE_REMINDER_TARGETS)[number];

/** Singleton: project + time-tracking settings. */
export interface IProjectSettings extends mongoose.Document {
  logTimeFor: LogTimeFor;
  approvalRequired: boolean;
  /** "HH:mm" (app timezone): running timers are stopped at this time daily. */
  autoStopTimerAt?: string | null;
  /** "HH:mm" (app timezone): remind employees with no log today. */
  trackerReminderAt?: string | null;
  /** Remind N days before a project deadline (0 = off). */
  deadlineReminderDays: number;
  deadlineReminderTo: DeadlineReminderTarget[];
  dailyTimeLogReport: boolean;
  /** "YYYY-MM-DD" idempotency key for the daily report job. */
  lastDailyReportOn?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const projectSettingsSchema = new Schema<IProjectSettings>(
  {
    logTimeFor: { type: String, enum: LOG_TIME_FOR, default: "project" },
    approvalRequired: { type: Boolean, default: true },
    autoStopTimerAt: { type: String, default: null, match: HHMM },
    trackerReminderAt: { type: String, default: null, match: HHMM },
    deadlineReminderDays: { type: Number, default: 3, min: 0, max: 60 },
    deadlineReminderTo: {
      type: [{ type: String, enum: DEADLINE_REMINDER_TARGETS }],
      default: ["manager", "members"],
    },
    dailyTimeLogReport: { type: Boolean, default: false },
    lastDailyReportOn: { type: String, default: null },
  },
  { timestamps: true }
);

projectSettingsSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    delete json.lastDailyReportOn;
    return json;
  },
});

export const ProjectSettings = mongoose.model<IProjectSettings>("ProjectSettings", projectSettingsSchema);

/** Returns the singleton settings document, creating it with defaults on first use. */
export async function getProjectSettings(): Promise<IProjectSettings> {
  const existing = await ProjectSettings.findOne();
  if (existing) return existing;
  const created = await ProjectSettings.findOneAndUpdate(
    {},
    {
      $setOnInsert: {
        logTimeFor: "project",
        approvalRequired: true,
        autoStopTimerAt: null,
        trackerReminderAt: null,
        deadlineReminderDays: 3,
        deadlineReminderTo: ["manager", "members"],
        dailyTimeLogReport: false,
      },
    },
    { upsert: true, returnDocument: "after" }
  );
  return created!;
}
