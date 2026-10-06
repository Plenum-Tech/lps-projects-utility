import mongoose, { Schema } from "mongoose";
import { TASK_PRIORITIES } from "./Task.js";
import type { TaskPriority } from "./Task.js";

/** Where the transcript came from. "teams" is reserved for a future Graph import. */
export const MEETING_SOURCES = ["upload", "paste"] as const;
export type MeetingSource = (typeof MEETING_SOURCES)[number];

export const ACTION_ITEM_ORIGINS = ["hint", "ai", "manual"] as const;
export type ActionItemOrigin = (typeof ACTION_ITEM_ORIGINS)[number];

export const ACTION_ITEM_STATUSES = ["suggested", "task_created", "dismissed"] as const;
export type ActionItemStatus = (typeof ACTION_ITEM_STATUSES)[number];

/** Hard limits shared by the parsers, the model and the controllers. */
export const MEETING_LIMITS = {
  titleMax: 200,
  notesMax: 20000,
  /** Original upload size (bytes). */
  maxFileBytes: 5 * 1024 * 1024,
  /** Extracted transcript text (characters). */
  maxChars: 300_000,
  maxSegments: 5000,
  segmentTextMax: 5000,
  maxSpeakers: 200,
  speakerNameMax: 120,
  maxActionItems: 300,
  itemTitleMax: 200,
  quoteMax: 2000,
  maxSegmentsPerItem: 50,
  /** Items per POST /:id/tasks call. */
  maxTasksPerRequest: 50,
} as const;

/** GridFS bucket holding original transcript uploads. */
export const MEETING_FILES_BUCKET = "meetingFiles";

export interface IMeetingSegment {
  idx: number;
  /** Seconds from the start of the meeting. */
  start?: number | null;
  end?: number | null;
  speaker?: string | null;
  text: string;
}

export interface IMeetingSpeaker {
  name: string;
  user?: mongoose.Types.ObjectId | null;
}

export interface IMeetingFile {
  filename: string;
  mimeType: string;
  size: number;
  gridFsId: mongoose.Types.ObjectId;
}

export interface IActionItem {
  _id: mongoose.Types.ObjectId;
  segmentIdxs: number[];
  quote: string;
  title: string;
  assignee?: mongoose.Types.ObjectId | null;
  /** Transcript name of the owner (kept even when it doesn't map to an LPS user). */
  assigneeName?: string | null;
  dueDate?: Date | null;
  priority: TaskPriority;
  origin: ActionItemOrigin;
  status: ActionItemStatus;
  task?: mongoose.Types.ObjectId | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IMeeting extends mongoose.Document {
  title: string;
  /** Date-only (UTC midnight of the calendar date in APP_TIMEZONE). */
  meetingDate: Date;
  project?: mongoose.Types.ObjectId | null;
  source: MeetingSource;
  file?: IMeetingFile | null;
  segments: IMeetingSegment[];
  speakers: mongoose.Types.DocumentArray<IMeetingSpeaker & mongoose.Types.Subdocument>;
  notes?: string;
  actionItems: mongoose.Types.DocumentArray<IActionItem & mongoose.Types.Subdocument>;
  aiExtractedAt?: Date | null;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const segmentSchema = new Schema<IMeetingSegment>(
  {
    idx: { type: Number, required: true, min: 0 },
    start: { type: Number, default: null, min: 0 },
    end: { type: Number, default: null, min: 0 },
    speaker: { type: String, default: null, maxlength: MEETING_LIMITS.speakerNameMax },
    text: { type: String, required: true, maxlength: MEETING_LIMITS.segmentTextMax },
  },
  { _id: false }
);

const speakerSchema = new Schema<IMeetingSpeaker>(
  {
    name: { type: String, required: true, trim: true, maxlength: MEETING_LIMITS.speakerNameMax },
    user: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { _id: false }
);

const fileSchema = new Schema<IMeetingFile>(
  {
    filename: { type: String, required: true, trim: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true, min: 0 },
    gridFsId: { type: Schema.Types.ObjectId, required: true },
  },
  { _id: false }
);

const actionItemSchema = new Schema<IActionItem>(
  {
    segmentIdxs: { type: [Number], default: [] },
    quote: { type: String, default: "", maxlength: MEETING_LIMITS.quoteMax },
    title: { type: String, required: true, trim: true, maxlength: MEETING_LIMITS.itemTitleMax },
    assignee: { type: Schema.Types.ObjectId, ref: "User", default: null },
    assigneeName: { type: String, default: null, maxlength: MEETING_LIMITS.speakerNameMax },
    dueDate: { type: Date, default: null },
    priority: { type: String, enum: TASK_PRIORITIES, default: "medium" },
    origin: { type: String, enum: ACTION_ITEM_ORIGINS, required: true },
    status: { type: String, enum: ACTION_ITEM_STATUSES, default: "suggested" },
    task: { type: Schema.Types.ObjectId, ref: "Task", default: null },
  },
  { timestamps: true }
);

const meetingSchema = new Schema<IMeeting>(
  {
    title: { type: String, required: true, trim: true, maxlength: MEETING_LIMITS.titleMax },
    meetingDate: { type: Date, required: true },
    project: { type: Schema.Types.ObjectId, ref: "Project", default: null },
    source: { type: String, enum: MEETING_SOURCES, required: true },
    file: { type: fileSchema, default: null },
    segments: {
      type: [segmentSchema],
      default: [],
      validate: {
        validator: (v: unknown[]) => v.length <= MEETING_LIMITS.maxSegments,
        message: `A transcript can have at most ${MEETING_LIMITS.maxSegments} segments`,
      },
    },
    speakers: { type: [speakerSchema], default: [] },
    notes: { type: String, default: "", maxlength: MEETING_LIMITS.notesMax },
    actionItems: {
      type: [actionItemSchema],
      default: [],
      validate: {
        validator: (v: unknown[]) => v.length <= MEETING_LIMITS.maxActionItems,
        message: `A meeting can have at most ${MEETING_LIMITS.maxActionItems} action items`,
      },
    },
    aiExtractedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

// Project "Meetings" tab — newest first.
meetingSchema.index({ project: 1, meetingDate: -1 });
// "My meetings" — newest first.
meetingSchema.index({ createdBy: 1, meetingDate: -1 });
// Visibility for mapped speakers.
meetingSchema.index({ "speakers.user": 1 });

meetingSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    return json;
  },
});

export const Meeting = mongoose.model<IMeeting>("Meeting", meetingSchema);
