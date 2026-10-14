import mongoose, { Schema } from "mongoose";

// ---------------------------------------------------------------------------
// A campaign of a brand (account). Projects pick one of their brand's approved
// campaigns; a new campaign is added at brand level first and, unless
// leadership added it, waits for leadership approval.
// ---------------------------------------------------------------------------

export const CAMPAIGN_LIMITS = { nameMax: 60 } as const;
export const CAMPAIGN_STATUSES = ["pending", "approved", "rejected"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export interface ICampaign extends mongoose.Document {
  brand: mongoose.Types.ObjectId;
  name: string;
  /** "YYYY-MM" range (optional). */
  startMonth: string | null;
  endMonth: string | null;
  status: CampaignStatus;
  active: boolean;
  requestedBy: mongoose.Types.ObjectId | null;
  decidedBy: mongoose.Types.ObjectId | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const campaignSchema = new Schema<ICampaign>(
  {
    brand: { type: Schema.Types.ObjectId, ref: "Brand", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: CAMPAIGN_LIMITS.nameMax },
    startMonth: { type: String, default: null, match: MONTH },
    endMonth: { type: String, default: null, match: MONTH },
    status: { type: String, enum: CAMPAIGN_STATUSES, default: "approved" },
    active: { type: Boolean, default: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decidedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

campaignSchema.index({ brand: 1, name: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });

campaignSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    return json;
  },
});

export const Campaign = mongoose.model<ICampaign>("Campaign", campaignSchema);
