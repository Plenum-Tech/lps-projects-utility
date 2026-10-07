import mongoose, { Schema } from "mongoose";
import { deliveryInvalidateOnWrite } from "../lib/delivery/cache.js";
import { TASK_LABEL_COLORS } from "./TaskLabel.js";

// ---------------------------------------------------------------------------
// Brand (client). A project belongs to at most one brand (Project.brand); a
// task's brand is its project's brand. Brands in use can't be deleted, only
// deactivated (see controllers/brands.ts).
// ---------------------------------------------------------------------------

/** Theme colour tokens a brand can use (same set as task labels / project statuses). */
export const BRAND_COLORS = TASK_LABEL_COLORS;
export type BrandColor = (typeof BRAND_COLORS)[number];

export const BRAND_LIMITS = { nameMax: 80, shortNameMax: 20 } as const;

export interface IBrand extends mongoose.Document {
  name: string;
  shortName?: string;
  color: BrandColor;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const brandSchema = new Schema<IBrand>(
  {
    name: { type: String, required: true, trim: true, maxlength: BRAND_LIMITS.nameMax },
    shortName: { type: String, trim: true, maxlength: BRAND_LIMITS.shortNameMax, default: "" },
    color: { type: String, enum: BRAND_COLORS, default: "chart-1" },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Names are unique case-insensitively ("Ajmal" == "ajmal").
brandSchema.index({ name: 1 }, { unique: true, collation: { locale: "en", strength: 2 }, name: "name_unique_ci" });

brandSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    return json;
  },
});

deliveryInvalidateOnWrite(brandSchema);

export const Brand = mongoose.model<IBrand>("Brand", brandSchema);
