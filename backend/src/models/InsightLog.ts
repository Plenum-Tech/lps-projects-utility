import mongoose, { Schema } from "mongoose";

// ---------------------------------------------------------------------------
// Audit of Leadership Insights (POST /api/insights/ask): one document per
// question — who asked, the tools the model called (with their validated
// params), time and tokens. Answers themselves are not stored.
// ---------------------------------------------------------------------------

export interface IInsightToolCall {
  name: string;
  params: Record<string, unknown>;
  ok: boolean;
  ms: number;
}

export interface IInsightLog extends mongoose.Document {
  user: mongoose.Types.ObjectId;
  question: string;
  /** The board the question was asked on (null = unsaved), and how many board operations it made. */
  board: mongoose.Types.ObjectId | null;
  boardOps: number;
  tools: IInsightToolCall[];
  aiModel: string;
  status: "ok" | "error";
  error: string;
  ms: number;
  tokens: { prompt: number; completion: number; total: number };
  answerChars: number;
  /** Figures / table cells of the answer not found in the tool results (lib/insights/verify.ts). */
  unmatched: { unmatchedNumbers: string[]; unmatchedTexts: string[] };
  createdAt: Date;
}

const toolCallSchema = new Schema<IInsightToolCall>(
  {
    name: { type: String, required: true },
    params: { type: Schema.Types.Mixed, default: {} },
    ok: { type: Boolean, default: true },
    ms: { type: Number, default: 0 },
  },
  { _id: false }
);

const insightLogSchema = new Schema<IInsightLog>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    question: { type: String, required: true, maxlength: 1000 },
    board: { type: Schema.Types.ObjectId, ref: "InsightBoard", default: null },
    boardOps: { type: Number, default: 0 },
    tools: { type: [toolCallSchema], default: [] },
    aiModel: { type: String, default: "" },
    status: { type: String, enum: ["ok", "error"], default: "ok" },
    error: { type: String, default: "" },
    ms: { type: Number, default: 0 },
    tokens: {
      prompt: { type: Number, default: 0 },
      completion: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },
    answerChars: { type: Number, default: 0 },
    unmatched: {
      unmatchedNumbers: { type: [String], default: [] },
      unmatchedTexts: { type: [String], default: [] },
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

insightLogSchema.index({ createdAt: -1 });
insightLogSchema.index({ user: 1, createdAt: -1 });

export const InsightLog = mongoose.model<IInsightLog>("InsightLog", insightLogSchema);
