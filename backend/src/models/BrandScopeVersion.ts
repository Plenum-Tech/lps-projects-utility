import mongoose, { Schema } from "mongoose";
import type { IBrandScopeItem } from "./Brand.js";

// ---------------------------------------------------------------------------
// A brand's scope history: one version per change of its scope rows (brand
// flow create, a scope upload, a direct edit, an approved change request).
// Version 1 of an older brand is written lazily from its scope (lib/scopeVersions.ts).
// ---------------------------------------------------------------------------

export const SCOPE_VERSION_SOURCES = ["create", "upload", "edit", "approval"] as const;
export type ScopeVersionSource = (typeof SCOPE_VERSION_SOURCES)[number];

export interface IBrandScopeVersion extends mongoose.Document {
  brand: mongoose.Types.ObjectId;
  version: number;
  items: IBrandScopeItem[];
  files: Array<{ filename: string; gridFsId?: mongoose.Types.ObjectId | null }>;
  platforms: string[];
  notes: string[];
  /** The brand's "other scope" text at the time. */
  scopeText: string;
  source: ScopeVersionSource;
  /** Who made the change (the requester for an approved change request). */
  by: mongoose.Types.ObjectId | null;
  approvedBy: mongoose.Types.ObjectId | null;
  /** Agreement match at the time (advice only). */
  scopeMatch: { score: number } | null;
  at: Date;
}

const scopeVersionSchema = new Schema<IBrandScopeVersion>({
  brand: { type: Schema.Types.ObjectId, ref: "Brand", required: true },
  version: { type: Number, required: true, min: 1 },
  items: {
    type: [
      new Schema(
        {
          unit: { type: String, required: true },
          quantity: { type: Number, required: true },
          languages: { type: Number, default: 1 },
          languageList: { type: [String], default: undefined },
          sizes: { type: Number, default: 1 },
          what: { type: String, default: "" },
          source: { type: String, default: "" },
        },
        { _id: false }
      ),
    ],
    default: [],
  },
  files: {
    type: [new Schema({ filename: { type: String, required: true }, gridFsId: { type: Schema.Types.ObjectId, default: null } }, { _id: false })],
    default: [],
  },
  platforms: { type: [String], default: [] },
  notes: { type: [String], default: [] },
  scopeText: { type: String, default: "" },
  source: { type: String, enum: SCOPE_VERSION_SOURCES, required: true },
  by: { type: Schema.Types.ObjectId, ref: "User", default: null },
  approvedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  scopeMatch: { type: Schema.Types.Mixed, default: null },
  at: { type: Date, default: () => new Date() },
});

scopeVersionSchema.index({ brand: 1, version: -1 }, { unique: true });

scopeVersionSchema.set("toJSON", {
  transform: (_doc, ret) => {
    delete (ret as unknown as Record<string, unknown>).__v;
    return ret;
  },
});

export const BrandScopeVersion = mongoose.model<IBrandScopeVersion>("BrandScopeVersion", scopeVersionSchema);
