import mongoose, { Schema } from "mongoose";
import { addLegacyRef } from "./legacy.js";

/** Same per-file limit as task files; 50 files per project. */
export const PROJECT_FILE_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxFilesPerProject: 50,
} as const;

export interface IProjectFile extends mongoose.Document {
  project: mongoose.Types.ObjectId;
  uploadedBy: mongoose.Types.ObjectId;
  filename: string;
  mimeType: string;
  size: number;
  /** Id of the file in the shared GridFS bucket. */
  gridFsId: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const projectFileSchema = new Schema<IProjectFile>(
  {
    project: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    filename: { type: String, required: true, trim: true, maxlength: 255 },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true, min: 0 },
    gridFsId: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: true }
);

projectFileSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    delete json.gridFsId;
    return json;
  },
});

// Imported documents (bun run import:worksuite) carry `legacy` for idempotent re-runs.
addLegacyRef(projectFileSchema);

export const ProjectFile = mongoose.model<IProjectFile>("ProjectFile", projectFileSchema);
