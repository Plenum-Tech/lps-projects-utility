import mongoose, { Schema } from "mongoose";
import { deliveryInvalidateOnWrite } from "../lib/delivery/cache.js";

export interface ITaskComment extends mongoose.Document {
  task: mongoose.Types.ObjectId;
  author: mongoose.Types.ObjectId;
  /** Plain text; `@[Name](userId)` tokens mark mentions. */
  body: string;
  /** Users mentioned in the body (only those who can view the task). */
  mentions: mongoose.Types.ObjectId[];
  editedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const taskCommentSchema = new Schema<ITaskComment>(
  {
    task: { type: Schema.Types.ObjectId, ref: "Task", required: true, index: true },
    author: { type: Schema.Types.ObjectId, ref: "User", required: true },
    body: { type: String, required: true, trim: true, maxlength: 5000 },
    mentions: { type: [{ type: Schema.Types.ObjectId, ref: "User" }], default: [] },
    editedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Comments on a task — oldest first (chat order).
taskCommentSchema.index({ task: 1, createdAt: 1 });

// Never leak the internal version key in JSON responses.
taskCommentSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    return json;
  },
});

// Brief rules 1 and 7 read files, comments and notes.
deliveryInvalidateOnWrite(taskCommentSchema);

export const TaskComment = mongoose.model<ITaskComment>("TaskComment", taskCommentSchema);
