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

export const BRAND_LIMITS = { nameMax: 80, shortNameMax: 20, organisationMax: 80, maxScopeFiles: 10, noteMax: 300, maxNotes: 20, maxPlatforms: 12 } as const;

/** A brand scope row: a project scope row plus what it is and the file it came from. */
export interface IBrandScopeItem {
  unit: string;
  quantity: number;
  languages: number;
  languageList?: string[];
  sizes: number;
  /** "Engagement posts", "Native TikTok videos" … */
  what?: string;
  /** File (or "typed") the row was read from. */
  source?: string;
}

/** A file the brand's scope was read from (GridFS "taskFiles" bucket; copied onto its projects). */
export interface IBrandScopeFile {
  gridFsId: mongoose.Types.ObjectId;
  filename: string;
  mimeType: string;
  size: number;
}

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
  /** Client group shown as a label ("Ajmal" for Ajmal GCC / Ajmal 75 / Ajmal UK); "" = none. */
  organisation?: string;
  color: BrandColor;
  active: boolean;
  /** New brands wait for leadership: approved brands are usable; pending/rejected aren't. */
  status: "approved" | "pending" | "rejected";
  requestedBy?: mongoose.Types.ObjectId | null;
  decidedBy?: mongoose.Types.ObjectId | null;
  decidedAt?: Date | null;
  rejectReason?: string;
  /** Brand flow: a pitch (shows potential revenue) or a direct client. */
  isPitch?: boolean;
  /** Potential revenue in AED (pitches); null with revenueTbc = not known yet. */
  revenue?: number | null;
  revenueTbc?: boolean;
  /** Scope read from the brand's files; projects of the brand get it locked. Empty = no brand scope. */
  scopeItems?: IBrandScopeItem[];
  platforms?: string[];
  scopeNotes?: string[];
  scopeFiles?: IBrandScopeFile[];
  /** Lead(s) picked in the brand flow. */
  leads?: mongoose.Types.ObjectId[];
  /** Monthly retainer: on the 1st of each month the brand gets that month's project (lib/retainers.ts). */
  monthlyRetainer?: boolean;
  /** What the agreement says (rows read from it + its text): the base the scope is compared with. */
  scopeAgreement?: { rows: Array<Record<string, unknown>>; text: string; sources: string[]; at: Date } | null;
  /** How close the scope rows are to the agreement (lib/scopeMatch.ts) — advice only. */
  scopeMatch?: {
    score: number;
    missing: string[];
    extra: string[];
    changed: Array<{ unit: string; what: string; agreement: number; entered: number }>;
    source: "ai" | "rules";
    at: Date;
  } | null;
  /**
   * Brand flow run by someone who isn't leadership: the project, lead tasks and plan
   * line to create once the brand is approved (lib/brandFlow.ts). Cleared after.
   */
  pendingSetup?: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

const brandSchema = new Schema<IBrand>(
  {
    name: { type: String, required: true, trim: true, maxlength: BRAND_LIMITS.nameMax },
    nameKey: { type: String },
    shortName: { type: String, trim: true, maxlength: BRAND_LIMITS.shortNameMax, default: "" },
    organisation: { type: String, trim: true, maxlength: BRAND_LIMITS.organisationMax, default: "" },
    color: { type: String, enum: BRAND_COLORS, default: "chart-1" },
    active: { type: Boolean, default: true },
    status: { type: String, enum: ["approved", "pending", "rejected"], default: "approved", index: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decidedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decidedAt: { type: Date, default: null },
    rejectReason: { type: String, trim: true, maxlength: 500, default: "" },
    isPitch: { type: Boolean, default: false },
    revenue: { type: Number, default: null, min: 0 },
    revenueTbc: { type: Boolean, default: false },
    scopeItems: {
      type: [
        new Schema(
          {
            unit: { type: String, required: true, maxlength: 40 },
            quantity: { type: Number, required: true, min: 1 },
            languages: { type: Number, default: 1, min: 1 },
            languageList: { type: [String], default: undefined },
            sizes: { type: Number, default: 1, min: 1 },
            what: { type: String, trim: true, maxlength: 80, default: "" },
            source: { type: String, trim: true, maxlength: 255, default: "" },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    platforms: { type: [{ type: String, trim: true, maxlength: 40 }], default: [] },
    scopeNotes: { type: [{ type: String, trim: true, maxlength: BRAND_LIMITS.noteMax }], default: [] },
    scopeFiles: {
      type: [
        new Schema(
          {
            gridFsId: { type: Schema.Types.ObjectId, required: true },
            filename: { type: String, required: true, maxlength: 255 },
            mimeType: { type: String, default: "" },
            size: { type: Number, default: 0 },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    leads: { type: [{ type: Schema.Types.ObjectId, ref: "User" }], default: [] },
    monthlyRetainer: { type: Boolean, default: false },
    scopeAgreement: { type: Schema.Types.Mixed, default: null },
    scopeMatch: { type: Schema.Types.Mixed, default: null },
    pendingSetup: { type: Schema.Types.Mixed, default: null },
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
    // The setup is the server's to run on approval; clients see only that one is waiting.
    json.setupWaiting = Boolean(json.pendingSetup);
    delete json.pendingSetup;
    // The agreement's text can be long; clients get it from the scope-match / versions calls.
    delete json.scopeAgreement;
    return json;
  },
});

deliveryInvalidateOnWrite(brandSchema);

export const Brand = mongoose.model<IBrand>("Brand", brandSchema);
