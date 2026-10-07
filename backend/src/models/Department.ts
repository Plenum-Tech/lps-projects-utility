import mongoose, { Schema } from "mongoose";
import { addLegacyRef } from "./legacy.js";

export interface IDepartment extends mongoose.Document {
  name: string;
  description?: string;
}

const departmentSchema = new Schema<IDepartment>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, trim: true },
  },
  { timestamps: true }
);

// Never leak the internal version key in JSON responses
departmentSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    return json;
  },
});

// Imported documents (bun run import:worksuite) carry `legacy` for idempotent re-runs.
addLegacyRef(departmentSchema);

export const Department = mongoose.model<IDepartment>("Department", departmentSchema);
