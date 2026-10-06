import mongoose, { Schema } from "mongoose";

/** Singleton document — schedule for the due-date reminders job. */
export interface ITaskSettings extends mongoose.Document {
  /** Remind assignees N days before the due date (0 = off). */
  reminderBeforeDays: number;
  /** Remind assignees on the due date. */
  reminderOnDeadline: boolean;
  /** Send an overdue notice N days after the due date (0 = off). */
  reminderAfterDays: number;
}

const taskSettingsSchema = new Schema<ITaskSettings>(
  {
    reminderBeforeDays: { type: Number, default: 1, min: 0, max: 30 },
    reminderOnDeadline: { type: Boolean, default: true },
    reminderAfterDays: { type: Number, default: 1, min: 0, max: 30 },
  },
  { timestamps: true }
);

// Never leak the internal version key in JSON responses.
taskSettingsSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    return json;
  },
});

export const TaskSettings = mongoose.model<ITaskSettings>("TaskSettings", taskSettingsSchema);

/** Returns the singleton settings document, creating it with defaults on first use. */
export async function getTaskSettings(): Promise<ITaskSettings> {
  const existing = await TaskSettings.findOne();
  if (existing) return existing;
  const created = await TaskSettings.findOneAndUpdate(
    {},
    { $setOnInsert: { reminderBeforeDays: 1, reminderOnDeadline: true, reminderAfterDays: 1 } },
    { upsert: true, returnDocument: "after" }
  );
  return created!;
}
