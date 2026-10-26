import mongoose, { Schema } from "mongoose";

// ---------------------------------------------------------------------------
// Scope units — singleton (`key: "scopeUnits"`), written by PUT
// /api/settings/scope-units. Until it exists (or while its list is empty) the
// defaults in lib/scopeUnits.ts apply: no migration needed.
// ---------------------------------------------------------------------------

export interface IScopeUnitEntry {
  key: string;
  name: string;
  aliases: string[];
  roles: string[];
  countsTowardTotal: boolean;
  hidden: boolean;
}

export interface IScopeUnitSettings extends mongoose.Document {
  key: "scopeUnits";
  units: IScopeUnitEntry[];
  updatedBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const unitSchema = new Schema<IScopeUnitEntry>(
  {
    key: { type: String, required: true, maxlength: 40 },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    aliases: { type: [{ type: String, trim: true, maxlength: 40 }], default: [] },
    roles: { type: [String], default: [] },
    countsTowardTotal: { type: Boolean, default: true },
    hidden: { type: Boolean, default: false },
  },
  { _id: false }
);

const scopeUnitSettingsSchema = new Schema<IScopeUnitSettings>(
  {
    key: { type: String, enum: ["scopeUnits"], default: "scopeUnits", required: true, unique: true },
    units: { type: [unitSchema], default: [] },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

export const ScopeUnitSettings = mongoose.model<IScopeUnitSettings>("ScopeUnitSettings", scopeUnitSettingsSchema);
