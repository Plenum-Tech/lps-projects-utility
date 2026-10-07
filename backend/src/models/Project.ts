import mongoose, { Schema } from "mongoose";
import { cached, invalidateOnWrite } from "../lib/refCache.js";
import { deliveryInvalidateOnWrite } from "../lib/delivery/cache.js";

export const PROGRESS_MODES = ["manual", "task_completion", "total_time", "deadline"] as const;
export type ProgressMode = (typeof PROGRESS_MODES)[number];

export const PROJECT_LIMITS = {
  nameMax: 150,
  summaryMax: 5000,
  maxMembers: 200,
  maxDepartments: 20,
  maxHourlyRate: 100000,
} as const;

/** 2-10 uppercase letters/digits, e.g. "WEB". */
export const PROJECT_CODE_REGEX = /^[A-Z0-9]{2,10}$/;

export interface IProjectMember {
  user: mongoose.Types.ObjectId;
  hourlyRate: number;
  addedAt: Date;
}

export interface IProject extends mongoose.Document {
  name: string;
  code: string;
  summary?: string;
  category?: mongoose.Types.ObjectId | null;
  /** Brand (client); a task's brand is its project's brand. */
  brand?: mongoose.Types.ObjectId | null;
  departments: mongoose.Types.ObjectId[];
  /** Project manager (Worksuite project_admin). */
  manager?: mongoose.Types.ObjectId | null;
  members: mongoose.Types.DocumentArray<IProjectMember & mongoose.Types.Subdocument>;
  status: mongoose.Types.ObjectId;
  startDate: Date;
  deadline?: Date | null;
  progressMode: ProgressMode;
  progress: number;
  hoursAllocated?: number | null;
  budget?: number | null;
  isPublic: boolean;
  manualTimeLogs: boolean;
  requireTaskApproval: boolean;
  taskCounter: number;
  createdBy: mongoose.Types.ObjectId;
  archivedAt?: Date | null;
  /** "YYYY-MM-DD" idempotency key for the deadline reminder job. */
  lastDeadlineReminderOn?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const memberSchema = new Schema<IProjectMember>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    hourlyRate: { type: Number, default: 0, min: 0, max: PROJECT_LIMITS.maxHourlyRate },
    addedAt: { type: Date, default: () => new Date() },
  },
  { _id: false }
);

const projectSchema = new Schema<IProject>(
  {
    name: { type: String, required: true, trim: true, maxlength: PROJECT_LIMITS.nameMax },
    code: { type: String, required: true, trim: true, uppercase: true, match: PROJECT_CODE_REGEX },
    summary: { type: String, trim: true, maxlength: PROJECT_LIMITS.summaryMax },
    category: { type: Schema.Types.ObjectId, ref: "ProjectCategory", default: null },
    brand: { type: Schema.Types.ObjectId, ref: "Brand", default: null },
    departments: { type: [{ type: Schema.Types.ObjectId, ref: "Department" }], default: [] },
    manager: { type: Schema.Types.ObjectId, ref: "User", default: null },
    members: { type: [memberSchema], default: [] },
    status: { type: Schema.Types.ObjectId, ref: "ProjectStatus", required: true },
    startDate: { type: Date, required: true },
    deadline: { type: Date, default: null },
    progressMode: { type: String, enum: PROGRESS_MODES, default: "task_completion" },
    progress: { type: Number, default: 0, min: 0, max: 100 },
    hoursAllocated: { type: Number, default: null, min: 0 },
    budget: { type: Number, default: null, min: 0 },
    isPublic: { type: Boolean, default: false },
    manualTimeLogs: { type: Boolean, default: true },
    requireTaskApproval: { type: Boolean, default: true },
    taskCounter: { type: Number, default: 0, min: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    archivedAt: { type: Date, default: null },
    lastDeadlineReminderOn: { type: String, default: null },
  },
  { timestamps: true }
);

projectSchema.index({ code: 1 }, { unique: true });
projectSchema.index({ "members.user": 1, archivedAt: 1 });
projectSchema.index({ departments: 1 });
projectSchema.index({ deadline: 1, archivedAt: 1 });
// Brand filter / project counts per brand / Delivery Pulse brand joins.
projectSchema.index({ brand: 1 });

projectSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    delete json.lastDeadlineReminderOn;
    return json;
  },
});

invalidateOnWrite(projectSchema, "project:");
deliveryInvalidateOnWrite(projectSchema);

export const Project = mongoose.model<IProject>("Project", projectSchema);

/** Ids of archived projects (task lists/boards/dashboards hide their tasks). Cached 15 s; dropped on project writes. */
export async function archivedProjectIds(): Promise<mongoose.Types.ObjectId[]> {
  const ids = await cached("project:archived", 15_000, async () => {
    const rows = await Project.find({ archivedAt: { $ne: null } }).select("_id").lean();
    return rows.map((r) => r._id as mongoose.Types.ObjectId);
  });
  return [...ids];
}
