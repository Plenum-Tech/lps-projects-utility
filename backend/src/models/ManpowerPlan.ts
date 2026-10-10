import mongoose, { Schema } from "mongoose";
import { deliveryInvalidateOnWrite } from "../lib/delivery/cache.js";
import { MANPOWER_LIMITS, MANPOWER_ROLE_KEYS } from "../lib/manpowerRoles.js";

// ---------------------------------------------------------------------------
// Manpower plan — one document per saved version of a month. Versions are
// never edited: every save (or import) writes the next version number, so the
// history can be browsed month → version.
// ---------------------------------------------------------------------------

export const MANPOWER_SECTIONS = ["active", "pitch"] as const;
export type ManpowerSection = (typeof MANPOWER_SECTIONS)[number];
export const MANPOWER_SOURCES = ["import", "edit", "copy"] as const;
export type ManpowerSource = (typeof MANPOWER_SOURCES)[number];

export interface IManpowerCell {
  role: string;
  users: mongoose.Types.ObjectId[];
  /** Unfilled or external slots as written in the plan ("New PM", "<Freelancer>", unmatched names). */
  placeholders: string[];
  /** "x" / "NA" in the sheet: this role isn't needed on the row. */
  notNeeded: boolean;
  note: string;
}

export interface IManpowerRow {
  /** Stable across versions (rows keep their key when a version is copied). */
  key: string;
  section: ManpowerSection;
  brand: mongoose.Types.ObjectId | null;
  /** Project type (Campaign / Program / Project …); null = any type. */
  type: string | null;
  /** Brand/project line as planned ("ENOC - Zoom", "Ajmal Social Retainer - GCC + Qatar"). */
  name: string;
  cells: IManpowerCell[];
}

export interface IManpowerPlan extends mongoose.Document {
  /** "YYYY-MM". */
  month: string;
  version: number;
  rows: IManpowerRow[];
  note: string;
  /** People on more rows than this are flagged as over-allocated. */
  maxProjectsPerPerson: number;
  source: ManpowerSource;
  createdBy: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const cellSchema = new Schema<IManpowerCell>(
  {
    role: { type: String, required: true, enum: MANPOWER_ROLE_KEYS as string[] },
    users: { type: [{ type: Schema.Types.ObjectId, ref: "User" }], default: [] },
    placeholders: { type: [{ type: String, trim: true, maxlength: MANPOWER_LIMITS.placeholderMax }], default: [] },
    notNeeded: { type: Boolean, default: false },
    note: { type: String, default: "", trim: true, maxlength: MANPOWER_LIMITS.noteMax },
  },
  { _id: false }
);

const rowSchema = new Schema<IManpowerRow>(
  {
    key: { type: String, required: true },
    section: { type: String, enum: MANPOWER_SECTIONS, default: "active" },
    brand: { type: Schema.Types.ObjectId, ref: "Brand", default: null },
    type: { type: String, default: null, trim: true, maxlength: 30 },
    name: { type: String, required: true, trim: true, maxlength: MANPOWER_LIMITS.nameMax },
    cells: { type: [cellSchema], default: [] },
  },
  { _id: false }
);

const manpowerPlanSchema = new Schema<IManpowerPlan>(
  {
    month: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    version: { type: Number, required: true, min: 1 },
    rows: { type: [rowSchema], default: [] },
    note: { type: String, default: "", trim: true, maxlength: MANPOWER_LIMITS.versionNoteMax },
    maxProjectsPerPerson: {
      type: Number,
      default: MANPOWER_LIMITS.defaultMaxProjectsPerPerson,
      min: 1,
      max: MANPOWER_LIMITS.maxProjectsPerPersonMax,
    },
    source: { type: String, enum: MANPOWER_SOURCES, default: "edit" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

manpowerPlanSchema.index({ month: 1, version: -1 }, { unique: true });
// Delivery Pulse reads the plan (on-map / off-map), so saves refresh its cache.
deliveryInvalidateOnWrite(manpowerPlanSchema);

export const ManpowerPlan = mongoose.model<IManpowerPlan>("ManpowerPlan", manpowerPlanSchema);

/** Latest version of a month, or null. */
export async function latestPlan(month: string): Promise<IManpowerPlan | null> {
  return ManpowerPlan.findOne({ month }).sort({ version: -1 });
}
