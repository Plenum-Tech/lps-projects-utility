import mongoose, { Schema } from "mongoose";
import { deliveryInvalidateOnWrite } from "../lib/delivery/cache.js";

// ---------------------------------------------------------------------------
// Delivery Pulse settings — singleton (`key: "delivery"`), created lazily by
// GET/PATCH /api/settings/delivery. Until it exists the analytics use the
// defaults in lib/delivery/settings.ts.
// ---------------------------------------------------------------------------

export const DELIVERY_DEFAULTS = {
  reworkKeywords: ["amend", "amends", "revision", "revisions", "feedback", "change", "changes"],
  reworkCategoryNames: ["Amends"],
  /** 0 = Sunday … 6 = Saturday. */
  briefingWeekday: 1,
  minLeadDays: 2,
  finalAssetDomains: ["frame.io", "onedrive.live.com", "1drv.ms", "sharepoint.com"],
  briefMinLength: 80,
  minCompletedToRank: 5,
  staleDays: 30,
} as const;

export const DELIVERY_LIMITS = {
  maxTrafficManagers: 50,
  maxTeams: 50,
  maxKeywords: 50,
  keywordMax: 40,
  maxCategories: 50,
  maxSameDayBrands: 200,
  maxDomains: 50,
  domainMax: 120,
  maxMapBrands: 500,
  maxMapUsersPerBrand: 200,
  minLeadDaysMax: 60,
  briefMinLengthMax: 2000,
  minCompletedMax: 1000,
  staleDaysMax: 3650,
} as const;

export interface IBrandTeamMapEntry {
  brand: mongoose.Types.ObjectId;
  users: mongoose.Types.ObjectId[];
}

export interface IDeliverySettings extends mongoose.Document {
  key: "delivery";
  trafficManagers: mongoose.Types.ObjectId[];
  /** Departments shown as dashboard teams; null = every department. */
  dashboardTeams: mongoose.Types.ObjectId[] | null;
  reworkKeywords: string[];
  reworkCategories: mongoose.Types.ObjectId[];
  briefingWeekday: number;
  minLeadDays: number;
  sameDayBrands: mongoose.Types.ObjectId[];
  finalAssetDomains: string[];
  briefMinLength: number;
  minCompletedToRank: number;
  staleDays: number;
  brandTeamMap: IBrandTeamMapEntry[];
  /** Date-only (UTC midnight of the app calendar date). */
  teamMapStartDate: Date;
  updatedBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const mapEntrySchema = new Schema<IBrandTeamMapEntry>(
  {
    brand: { type: Schema.Types.ObjectId, ref: "Brand", required: true },
    users: { type: [{ type: Schema.Types.ObjectId, ref: "User" }], default: [] },
  },
  { _id: false }
);

const deliverySettingsSchema = new Schema<IDeliverySettings>(
  {
    key: { type: String, enum: ["delivery"], default: "delivery", required: true, unique: true },
    trafficManagers: { type: [{ type: Schema.Types.ObjectId, ref: "User" }], default: [] },
    dashboardTeams: { type: [{ type: Schema.Types.ObjectId, ref: "Department" }], default: null },
    reworkKeywords: { type: [String], default: () => [...DELIVERY_DEFAULTS.reworkKeywords] },
    reworkCategories: { type: [{ type: Schema.Types.ObjectId, ref: "TaskCategory" }], default: [] },
    briefingWeekday: { type: Number, min: 0, max: 6, default: DELIVERY_DEFAULTS.briefingWeekday },
    minLeadDays: { type: Number, min: 0, max: DELIVERY_LIMITS.minLeadDaysMax, default: DELIVERY_DEFAULTS.minLeadDays },
    sameDayBrands: { type: [{ type: Schema.Types.ObjectId, ref: "Brand" }], default: [] },
    finalAssetDomains: { type: [String], default: () => [...DELIVERY_DEFAULTS.finalAssetDomains] },
    briefMinLength: { type: Number, min: 0, max: DELIVERY_LIMITS.briefMinLengthMax, default: DELIVERY_DEFAULTS.briefMinLength },
    minCompletedToRank: { type: Number, min: 0, max: DELIVERY_LIMITS.minCompletedMax, default: DELIVERY_DEFAULTS.minCompletedToRank },
    staleDays: { type: Number, min: 1, max: DELIVERY_LIMITS.staleDaysMax, default: DELIVERY_DEFAULTS.staleDays },
    brandTeamMap: { type: [mapEntrySchema], default: [] },
    teamMapStartDate: { type: Date, required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

deliverySettingsSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    delete json.key;
    return json;
  },
});

deliveryInvalidateOnWrite(deliverySettingsSchema);

export const DeliverySettings = mongoose.model<IDeliverySettings>("DeliverySettings", deliverySettingsSchema);
