import mongoose, { Schema } from "mongoose";
import { addLegacyRef } from "./legacy.js";

export interface ITaskCategory extends mongoose.Document {
  name: string;
}

const taskCategorySchema = new Schema<ITaskCategory>(
  {
    name: { type: String, required: true, unique: true, trim: true, maxlength: 60 },
  },
  { timestamps: true }
);

// Never leak the internal version key in JSON responses.
taskCategorySchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    return json;
  },
});

// Imported documents (bun run import:worksuite) carry `legacy` for idempotent re-runs.
addLegacyRef(taskCategorySchema);

export const TaskCategory = mongoose.model<ITaskCategory>("TaskCategory", taskCategorySchema);
