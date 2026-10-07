import mongoose, { Schema } from "mongoose";
import { addLegacyRef } from "./legacy.js";

export interface IProjectCategory extends mongoose.Document {
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

const projectCategorySchema = new Schema<IProjectCategory>(
  {
    name: { type: String, required: true, trim: true, maxlength: 60, unique: true },
  },
  { timestamps: true }
);

projectCategorySchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    return json;
  },
});

// Imported documents (bun run import:worksuite) carry `legacy` for idempotent re-runs.
addLegacyRef(projectCategorySchema);

export const ProjectCategory = mongoose.model<IProjectCategory>("ProjectCategory", projectCategorySchema);
