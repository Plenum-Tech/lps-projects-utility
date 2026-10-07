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

/**
 * Case-insensitive identity of a brand name: trimmed, inner whitespace collapsed,
 * lowercased. Stored as `nameKey` (unique) instead of an ICU case-insensitive index, which
 * Azure Cosmos DB for MongoDB vCore doesn't support.
 */
export function brandNameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export interface IBrand extends mongoose.Document {
  name: string;
  /** brandNameKey(name) — maintained on validate; set it explicitly in raw updates. */
  nameKey: string;
  shortName?: string;
  color: BrandColor;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const brandSchema = new Schema<IBrand>(
  {
    name: { type: String, required: true, trim: true, maxlength: BRAND_LIMITS.nameMax },
    nameKey: { type: String },
    shortName: { type: String, trim: true, maxlength: BRAND_LIMITS.shortNameMax, default: "" },
    color: { type: String, enum: BRAND_COLORS, default: "chart-1" },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

brandSchema.pre("validate", function () {
  if (typeof this.name === "string") this.nameKey = brandNameKey(this.name);
});

/** Keeps nameKey in step when a query update sets `name` without it. */
function syncNameKeyOnUpdate(this: mongoose.Query<unknown, IBrand>) {
  const update = this.getUpdate() as Record<string, unknown> | null;
  if (!update || Array.isArray(update)) return;
  const set = (update.$set ?? {}) as Record<string, unknown>;
  const name = typeof set.name === "string" ? set.name : typeof update.name === "string" ? update.name : undefined;
  if (name === undefined || set.nameKey !== undefined || update.nameKey !== undefined) return;
  this.set("nameKey", brandNameKey(name));
}
brandSchema.pre(["findOneAndUpdate", "updateOne", "updateMany"], syncNameKeyOnUpdate);

// Names are unique case-insensitively ("Ajmal" == "ajmal") via the normalized key.
// (Replaces the legacy ICU index "name_unique_ci" — dropped on startup by
// lib/dbMaintenance.ts.) Partial so docs not yet backfilled don't collide on null.
brandSchema.index(
  { nameKey: 1 },
  { unique: true, partialFilterExpression: { nameKey: { $type: "string" } }, name: "nameKey_unique" }
);

brandSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    return json;
  },
});

deliveryInvalidateOnWrite(brandSchema);

export const Brand = mongoose.model<IBrand>("Brand", brandSchema);
