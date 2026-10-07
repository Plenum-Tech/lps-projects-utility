import mongoose, { Schema } from "mongoose";
import { addLegacyRef } from "./legacy.js";

export const MILESTONE_STATUSES = ["incomplete", "complete"] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export interface IMilestone extends mongoose.Document {
  project: mongoose.Types.ObjectId;
  title: string;
  summary?: string;
  startDate?: Date | null;
  endDate?: Date | null;
  status: MilestoneStatus;
  completedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const milestoneSchema = new Schema<IMilestone>(
  {
    project: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 150 },
    summary: { type: String, trim: true, maxlength: 2000 },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    status: { type: String, enum: MILESTONE_STATUSES, default: "incomplete" },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

milestoneSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    return json;
  },
});

// Imported documents (bun run import:worksuite) carry `legacy` for idempotent re-runs.
addLegacyRef(milestoneSchema);

export const Milestone = mongoose.model<IMilestone>("Milestone", milestoneSchema);
