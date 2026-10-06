import mongoose, { Schema } from "mongoose";

export const PROJECT_ACTIVITY_ACTIONS = [
  "created",
  "updated",
  "status_changed",
  "member_added",
  "member_removed",
  "member_rate_changed",
  "manager_changed",
  "milestone_created",
  "milestone_updated",
  "milestone_completed",
  "milestone_reopened",
  "milestone_deleted",
  "file_added",
  "file_removed",
  "note_added",
  "note_updated",
  "note_deleted",
  "archived",
  "restored",
  "duplicated",
] as const;

export type ProjectActivityAction = (typeof PROJECT_ACTIVITY_ACTIONS)[number];

export interface IProjectActivity extends mongoose.Document {
  project: mongoose.Types.ObjectId;
  actor?: mongoose.Types.ObjectId | null;
  action: ProjectActivityAction;
  details?: unknown;
  createdAt: Date;
}

const projectActivitySchema = new Schema<IProjectActivity>(
  {
    project: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    actor: { type: Schema.Types.ObjectId, ref: "User", default: null },
    action: { type: String, required: true, enum: PROJECT_ACTIVITY_ACTIONS },
    details: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

projectActivitySchema.index({ project: 1, createdAt: -1 });

projectActivitySchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    return json;
  },
});

export const ProjectActivity = mongoose.model<IProjectActivity>("ProjectActivity", projectActivitySchema);
