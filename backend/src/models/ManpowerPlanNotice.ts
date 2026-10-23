import mongoose, { Schema } from "mongoose";

// ---------------------------------------------------------------------------
// One per month: up to which approved plan version people were emailed about
// the plan's changes. Leadership's saves go live quietly; "Send email" on the
// plan tells the approvers and the people affected about every change since
// `baseVersion` at once, then moves `baseVersion` to the version emailed.
// ---------------------------------------------------------------------------

export interface IManpowerPlanNotice extends mongoose.Document {
  month: string;
  /** The approved version the changes not emailed yet are counted from. */
  baseVersion: number | null;
  /** The last "Send email" (null: never sent for this month). */
  emailedAt: Date | null;
  emailedBy: mongoose.Types.ObjectId | null;
  /** The approved version that email covered (= baseVersion right after sending). */
  emailedVersion: number | null;
  createdAt: Date;
  updatedAt: Date;
}

const noticeSchema = new Schema<IManpowerPlanNotice>(
  {
    month: { type: String, required: true, unique: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    baseVersion: { type: Number, default: null },
    emailedAt: { type: Date, default: null },
    emailedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    emailedVersion: { type: Number, default: null },
  },
  { timestamps: true }
);

export const ManpowerPlanNotice = mongoose.model<IManpowerPlanNotice>("ManpowerPlanNotice", noticeSchema);
