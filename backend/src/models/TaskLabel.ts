import mongoose, { Schema } from "mongoose";

/** Theme token names a label may use — the frontend maps them to CSS variables. */
export const TASK_LABEL_COLORS = [
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "primary",
  "secondary",
  "accent",
  "muted",
  "destructive",
] as const;

export type TaskLabelColor = (typeof TASK_LABEL_COLORS)[number];

export interface ITaskLabel extends mongoose.Document {
  name: string;
  color: TaskLabelColor;
  description?: string;
}

const taskLabelSchema = new Schema<ITaskLabel>(
  {
    name: { type: String, required: true, unique: true, trim: true, maxlength: 40 },
    color: { type: String, required: true, enum: TASK_LABEL_COLORS, default: "primary" },
    description: { type: String, trim: true, maxlength: 200 },
  },
  { timestamps: true }
);

// Never leak the internal version key in JSON responses.
taskLabelSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    return json;
  },
});

export const TaskLabel = mongoose.model<ITaskLabel>("TaskLabel", taskLabelSchema);
