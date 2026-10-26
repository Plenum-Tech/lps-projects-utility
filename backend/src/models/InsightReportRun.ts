import mongoose, { Schema } from "mongoose";

// ---------------------------------------------------------------------------
// Audit of scheduled / manual Leadership Insights board reports: one document
// per run — the board, who it went to, rows and time, and whether it was sent
// (skipped when nothing changed since the last report).
// ---------------------------------------------------------------------------

export interface IInsightReportRun extends mongoose.Document {
  board: mongoose.Types.ObjectId;
  owner: mongoose.Types.ObjectId;
  trigger: "schedule" | "manual";
  recipients: mongoose.Types.ObjectId[];
  sent: boolean;
  reason: string;
  blocks: number;
  rows: number;
  ms: number;
  createdAt: Date;
}

const insightReportRunSchema = new Schema<IInsightReportRun>(
  {
    board: { type: Schema.Types.ObjectId, ref: "InsightBoard", required: true },
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    trigger: { type: String, enum: ["schedule", "manual"], required: true },
    recipients: { type: [{ type: Schema.Types.ObjectId, ref: "User" }], default: [] },
    sent: { type: Boolean, default: false },
    reason: { type: String, default: "" },
    blocks: { type: Number, default: 0 },
    rows: { type: Number, default: 0 },
    ms: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

insightReportRunSchema.index({ board: 1, createdAt: -1 });

export const InsightReportRun = mongoose.model<IInsightReportRun>("InsightReportRun", insightReportRunSchema);
