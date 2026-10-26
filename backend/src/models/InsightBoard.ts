import mongoose, { Schema } from "mongoose";

// ---------------------------------------------------------------------------
// A saved Leadership Insights session: its Board blocks (tool + params + view,
// never the numbers — they are re-fetched when the board opens) and the
// conversation that built it. Each leader sees only their own boards.
// ---------------------------------------------------------------------------

export const BOARD_LIMITS = { titleMax: 120, maxMessages: 40, messageMax: 12_000, maxBoardsPerUser: 200 } as const;

export const INSIGHT_SCHEDULES = ["off", "1h", "2h", "4h", "daily9", "weeklyMon9"] as const;
export type InsightSchedule = (typeof INSIGHT_SCHEDULES)[number];

export interface IInsightBlock {
  id: string;
  title: string;
  tool: string;
  params: Record<string, unknown>;
  view?: string;
  list?: string;
  only?: string[];
  sortBy?: string;
  sortDir?: string;
}

export interface IInsightMessage {
  role: "user" | "assistant";
  /** User: the question. Assistant: the OpenUI Lang answer. */
  text: string;
  at: Date;
}

export interface IInsightBoard extends mongoose.Document {
  user: mongoose.Types.ObjectId;
  title: string;
  blocks: IInsightBlock[];
  messages: IInsightMessage[];
  /** While the board is open it re-fetches its blocks on this schedule (no AI call). */
  refresh: InsightSchedule;
  /** Scheduled email + in-app report of the board (leadership recipients only). */
  report: {
    schedule: InsightSchedule;
    recipients: mongoose.Types.ObjectId[];
    sendUnchanged: boolean;
    nextRunAt: Date | null;
    lastSentAt: Date | null;
    /** Fingerprint and headline numbers of the last report sent (change detection). */
    lastHash: string;
    lastKpis: Record<string, Record<string, string | number | null>>;
  };
  createdAt: Date;
  updatedAt: Date;
}

const blockSchema = new Schema<IInsightBlock>(
  {
    id: { type: String, required: true },
    title: { type: String, required: true, maxlength: 100 },
    tool: { type: String, required: true },
    params: { type: Schema.Types.Mixed, default: {} },
    view: { type: String, default: undefined },
    list: { type: String, default: undefined },
    only: { type: [String], default: undefined },
    sortBy: { type: String, default: undefined },
    sortDir: { type: String, default: undefined },
  },
  { _id: false, minimize: false }
);

const messageSchema = new Schema<IInsightMessage>(
  {
    role: { type: String, enum: ["user", "assistant"], required: true },
    text: { type: String, required: true, maxlength: BOARD_LIMITS.messageMax },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const insightBoardSchema = new Schema<IInsightBoard>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true, trim: true, maxlength: BOARD_LIMITS.titleMax },
    blocks: { type: [blockSchema], default: [] },
    messages: { type: [messageSchema], default: [] },
    refresh: { type: String, enum: INSIGHT_SCHEDULES, default: "off" },
    report: {
      schedule: { type: String, enum: INSIGHT_SCHEDULES, default: "off" },
      // Leadership only for now (validated in controllers/insights.ts). Sharing a board with
      // other staff would add read-only viewers here and a viewer route.
      recipients: { type: [{ type: Schema.Types.ObjectId, ref: "User" }], default: [] },
      sendUnchanged: { type: Boolean, default: false },
      nextRunAt: { type: Date, default: null },
      lastSentAt: { type: Date, default: null },
      lastHash: { type: String, default: "" },
      lastKpis: { type: Schema.Types.Mixed, default: {} },
    },
  },
  { timestamps: true }
);

insightBoardSchema.index({ user: 1, updatedAt: -1 });
insightBoardSchema.index({ "report.nextRunAt": 1 });

export const InsightBoard = mongoose.model<IInsightBoard>("InsightBoard", insightBoardSchema);
