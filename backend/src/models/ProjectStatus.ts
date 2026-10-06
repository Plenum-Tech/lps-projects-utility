import mongoose, { Schema } from "mongoose";
import { TASK_LABEL_COLORS } from "./TaskLabel.js";
import type { TaskLabelColor } from "./TaskLabel.js";

/** Same theme tokens as task labels — the frontend maps them to CSS variables. */
export const PROJECT_STATUS_COLORS = TASK_LABEL_COLORS;
export type ProjectStatusColor = TaskLabelColor;

export interface IProjectStatus extends mongoose.Document {
  name: string;
  color: ProjectStatusColor;
  /** Exactly one status is the default for new projects. */
  isDefault: boolean;
  /** Counts as finished (progress = 100, excluded from pickers/reminders). */
  isCompleted: boolean;
  order: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const projectStatusSchema = new Schema<IProjectStatus>(
  {
    name: { type: String, required: true, trim: true, maxlength: 40, unique: true },
    color: { type: String, enum: PROJECT_STATUS_COLORS, default: "primary" },
    isDefault: { type: Boolean, default: false },
    isCompleted: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

projectStatusSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    return json;
  },
});

export const ProjectStatus = mongoose.model<IProjectStatus>("ProjectStatus", projectStatusSchema);

/** The six statuses seeded by the migration (and lazily on first use). */
export const DEFAULT_PROJECT_STATUSES: Array<{
  name: string;
  color: ProjectStatusColor;
  isDefault: boolean;
  isCompleted: boolean;
}> = [
  { name: "Not started", color: "muted", isDefault: false, isCompleted: false },
  { name: "In progress", color: "primary", isDefault: true, isCompleted: false },
  { name: "On hold", color: "chart-4", isDefault: false, isCompleted: false },
  { name: "Under review", color: "chart-2", isDefault: false, isCompleted: false },
  { name: "Cancelled", color: "destructive", isDefault: false, isCompleted: false },
  { name: "Finished", color: "chart-1", isDefault: false, isCompleted: true },
];

/** Inserts any missing default statuses (by name). Returns how many were created. */
export async function seedProjectStatuses(): Promise<number> {
  const anyExisting = await ProjectStatus.countDocuments();
  let created = 0;
  for (const [order, status] of DEFAULT_PROJECT_STATUSES.entries()) {
    const result = await ProjectStatus.updateOne(
      { name: status.name },
      // Only the very first seed may set a default — admins may have changed it since.
      { $setOnInsert: { ...status, isDefault: anyExisting === 0 && status.isDefault, order, active: true } },
      { upsert: true }
    );
    created += result.upsertedCount;
  }
  // Guarantee exactly one default.
  const defaults = await ProjectStatus.countDocuments({ isDefault: true });
  if (defaults === 0) {
    const first =
      (await ProjectStatus.findOne({ name: "In progress" })) ?? (await ProjectStatus.findOne().sort({ order: 1 }));
    if (first) await ProjectStatus.updateOne({ _id: first._id }, { $set: { isDefault: true } });
  }
  return created;
}

/** The default status, seeding the defaults on first use. */
export async function getDefaultProjectStatus(): Promise<IProjectStatus> {
  let status = await ProjectStatus.findOne({ isDefault: true });
  if (status) return status;
  await seedProjectStatuses();
  status = await ProjectStatus.findOne({ isDefault: true });
  return status!;
}

/** Ids of statuses flagged `isCompleted`. */
export async function completedStatusIds(): Promise<mongoose.Types.ObjectId[]> {
  const rows = await ProjectStatus.find({ isCompleted: true }).select("_id").lean();
  return rows.map((r) => r._id);
}
