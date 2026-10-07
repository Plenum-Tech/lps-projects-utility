import mongoose, { Schema } from "mongoose";
import { addLegacyRef } from "./legacy.js";

export const NOTE_VISIBILITIES = ["members", "private"] as const;
export type NoteVisibility = (typeof NOTE_VISIBILITIES)[number];

export interface IProjectNote extends mongoose.Document {
  project: mongoose.Types.ObjectId;
  author: mongoose.Types.ObjectId;
  title: string;
  body: string;
  /** members = everyone who can view the project; private = author + sharedWith + admins. */
  visibility: NoteVisibility;
  sharedWith: mongoose.Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const projectNoteSchema = new Schema<IProjectNote>(
  {
    project: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    author: { type: Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true, trim: true, maxlength: 150 },
    body: { type: String, default: "", maxlength: 10000 },
    visibility: { type: String, enum: NOTE_VISIBILITIES, default: "members" },
    sharedWith: { type: [{ type: Schema.Types.ObjectId, ref: "User" }], default: [] },
  },
  { timestamps: true }
);

projectNoteSchema.index({ project: 1, createdAt: -1 });

projectNoteSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    return json;
  },
});

// Imported documents (bun run import:worksuite) carry `legacy` for idempotent re-runs.
addLegacyRef(projectNoteSchema);

export const ProjectNote = mongoose.model<IProjectNote>("ProjectNote", projectNoteSchema);
