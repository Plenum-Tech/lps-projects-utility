import mongoose, { Schema } from "mongoose";

// ---------------------------------------------------------------------------
// A change waiting for leadership approval (Settings → Projects approvers:
// Aasim, Rania and the leadership admins):
//  - project_change: a project's scope (summary) and / or team
//  - brand_edit:     a brand's name, short name, colour or active flag
//  - manpower_plan:  a saved manpower plan version (all its changes at once)
// Leadership's own changes apply straight away and never create one.
// A newer request for the same target replaces the pending one ("superseded").
// ---------------------------------------------------------------------------

export const CHANGE_KINDS = ["project_change", "brand_edit", "manpower_plan"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
export const CHANGE_STATUSES = ["pending", "approved", "rejected", "superseded"] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];

export interface IChangeLine {
  label: string;
  before: string;
  after: string;
}

export interface IChangeRequest extends mongoose.Document {
  kind: ChangeKind;
  status: ChangeStatus;
  /** What it is about, for the list and the email ("Wasl_Campaign_Nov2026_Run — scope and team"). */
  title: string;
  brand: mongoose.Types.ObjectId | null;
  project: mongoose.Types.ObjectId | null;
  /** manpower_plan: the month and the pending version. */
  month: string | null;
  version: number | null;
  /** Human-readable changes (shown in the list and the email). */
  changes: IChangeLine[];
  /** What is applied on approval (kind-specific). */
  payload: Record<string, unknown>;
  requestedBy: mongoose.Types.ObjectId;
  decidedBy: mongoose.Types.ObjectId | null;
  decidedAt: Date | null;
  reason: string;
  createdAt: Date;
  updatedAt: Date;
}

const changeLineSchema = new Schema<IChangeLine>(
  {
    label: { type: String, required: true, maxlength: 200 },
    before: { type: String, default: "", maxlength: 5000 },
    after: { type: String, default: "", maxlength: 5000 },
  },
  { _id: false }
);

const changeRequestSchema = new Schema<IChangeRequest>(
  {
    kind: { type: String, enum: CHANGE_KINDS, required: true },
    status: { type: String, enum: CHANGE_STATUSES, default: "pending", index: true },
    title: { type: String, required: true, maxlength: 300 },
    brand: { type: Schema.Types.ObjectId, ref: "Brand", default: null },
    project: { type: Schema.Types.ObjectId, ref: "Project", default: null },
    month: { type: String, default: null },
    version: { type: Number, default: null },
    changes: { type: [changeLineSchema], default: [] },
    payload: { type: Schema.Types.Mixed, default: {} },
    requestedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    decidedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decidedAt: { type: Date, default: null },
    reason: { type: String, default: "", maxlength: 500 },
  },
  { timestamps: true }
);

changeRequestSchema.index({ kind: 1, status: 1, project: 1, brand: 1, month: 1 });

changeRequestSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    delete json.payload;
    return json;
  },
});

export const ChangeRequest = mongoose.model<IChangeRequest>("ChangeRequest", changeRequestSchema);
