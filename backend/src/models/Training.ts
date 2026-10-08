import mongoose, { Schema } from "mongoose";

export interface ITrainingSourceFile {
  fileId: mongoose.Types.ObjectId;
  filename: string;
  mimeType: string;
  size: number;
}

/**
 * HR training: a slide deck (stored as one PNG per slide in the
 * "trainingFiles" GridFS bucket) that assigned users must read in full.
 */
export interface ITraining extends mongoose.Document {
  title: string;
  description: string;
  /** GridFS ids of the rendered slides, in order. */
  slides: mongoose.Types.ObjectId[];
  /** The uploaded deck, kept for download. */
  sourceFile: ITrainingSourceFile;
  dueDate?: Date | null;
  /** Everyone (including people who join later). */
  assignAll: boolean;
  departments: mongoose.Types.ObjectId[];
  users: mongoose.Types.ObjectId[];
  /** Bumped when the deck is replaced; progress from older versions is reset or carried over. */
  version: number;
  archived: boolean;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const trainingSchema = new Schema<ITraining>(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: "", trim: true, maxlength: 2000 },
    slides: { type: [Schema.Types.ObjectId], default: [] },
    sourceFile: {
      fileId: { type: Schema.Types.ObjectId, required: true },
      filename: { type: String, required: true },
      mimeType: { type: String, required: true },
      size: { type: Number, required: true },
    },
    dueDate: { type: Date, default: null },
    assignAll: { type: Boolean, default: false },
    departments: {
      type: [{ type: Schema.Types.ObjectId, ref: "Department" }],
      default: [],
    },
    users: {
      type: [{ type: Schema.Types.ObjectId, ref: "User" }],
      default: [],
    },
    version: { type: Number, default: 1 },
    archived: { type: Boolean, default: false, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

trainingSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    return json;
  },
});

export const Training = mongoose.model<ITraining>("Training", trainingSchema);

/** One user's reading progress on one training. */
export interface ITrainingProgress extends mongoose.Document {
  training: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  /** Training version this progress belongs to. */
  version: number;
  /** 1-based slide numbers seen. */
  viewed: number[];
  startedAt?: Date | null;
  completedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const trainingProgressSchema = new Schema<ITrainingProgress>(
  {
    training: { type: Schema.Types.ObjectId, ref: "Training", required: true },
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    version: { type: Number, default: 1 },
    viewed: { type: [Number], default: [] },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

trainingProgressSchema.index({ training: 1, user: 1 }, { unique: true });

trainingProgressSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    return json;
  },
});

export const TrainingProgress = mongoose.model<ITrainingProgress>(
  "TrainingProgress",
  trainingProgressSchema,
);
