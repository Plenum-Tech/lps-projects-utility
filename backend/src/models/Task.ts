import mongoose, { Schema } from "mongoose";
import { deliveryInvalidateOnWrite } from "../lib/delivery/cache.js";
import { addLegacyRef, legacyRefSchema } from "./legacy.js";
import type { ILegacyRef } from "./legacy.js";

export const TASK_STATUSES = [
  "todo",
  "in_progress",
  "in_review",
  "completed",
  "rejected",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;

/** Iteration marker: first delivery of the work, or a rework of earlier work. */
export const TASK_ITERATIONS = ["new", "rework"] as const;
export type TaskIteration = (typeof TASK_ITERATIONS)[number];

/** Whose review asked for a rework: our own team's (internal) or the client's (external). */
export const REWORK_SOURCES = ["internal", "external"] as const;
export type ReworkSource = (typeof REWORK_SOURCES)[number];

/** Controlled task name: "<unit> <quantity> – <short name>" (brand + month come from the project). */
export interface ITaskTitleParts {
  unit: string;
  quantity: number;
  shortName: string;
}

export const TASK_TITLE_LIMITS = { unitMax: 40, shortNameMax: 80, quantityMax: 9999 } as const;

export function composeTaskTitle(parts: ITaskTitleParts): string {
  return `${parts.unit} ${parts.quantity} – ${parts.shortName}`;
}

export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const RECURRENCE_UNITS = ["day", "week", "month"] as const;

export type RecurrenceUnit = (typeof RECURRENCE_UNITS)[number];

/** Where a task's Actual start / Actual end came from (manual values are never overwritten automatically). */
export const ACTUAL_DATE_SOURCES = ["auto", "manual", "import"] as const;

export type ActualDateSource = (typeof ACTUAL_DATE_SOURCES)[number];

/** Hard limits shared by the model and the controllers. */
export const TASK_LIMITS = {
  maxAssignees: 20,
  maxLabels: 10,
  maxSubtasks: 50,
  /** Estimated time in minutes (0 – 100000). */
  maxEstimateMinutes: 100000,
  /** Task description length (raised for long Worksuite briefs). */
  maxDescription: 20000,
} as const;

/** Creation/assignment notifications held back until the form's file uploads finish. */
export const SUBTASK_PENDING_NOTIFY = ["created", "assigned"] as const;

export type SubtaskPendingNotify = (typeof SUBTASK_PENDING_NOTIFY)[number];

export interface ISubtask {
  _id: mongoose.Types.ObjectId;
  title: string;
  description?: string;
  done: boolean;
  /** What was done, written when the rework is ticked off. */
  completionNote?: string;
  assignee?: mongoose.Types.ObjectId | null;
  startDate?: Date | null;
  dueDate?: Date | null;
  completedAt?: Date | null;
  /** Actual start / end (see lib/actualDates.ts — subtask rules). */
  actualStartAt?: Date | null;
  actualEndAt?: Date | null;
  actualStartSource?: ActualDateSource | null;
  actualEndSource?: ActualDateSource | null;
  createdBy: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId | null;
  /** Set when the client deferred notifications (see POST .../subtasks/:subId/notify). */
  pendingNotify?: SubtaskPendingNotify | null;
  /** Set on subtasks imported from Worksuite. */
  legacy?: ILegacyRef;
}

export interface ITaskRecurrence {
  /** Repeat every N units (1-365). */
  every: number;
  unit: RecurrenceUnit;
  /** Total copies to generate; -1 = forever. */
  cycles: number;
  /** Copies generated so far. */
  generated: number;
  /** When the next copy is due to be generated. */
  nextRunAt: Date;
}

/** The meeting transcript line a task was created from (POST /api/meetings/:id/tasks). */
export interface ITaskSourceMeeting {
  meeting: mongoose.Types.ObjectId;
  segmentIdx: number | null;
}

export interface ITask extends mongoose.Document {
  title: string;
  description?: string;
  /** Employees the task is assigned to (1-20). */
  assignees: mongoose.Types.ObjectId[];
  /** Head/admin who created and assigned the task. */
  assignedBy: mongoose.Types.ObjectId;
  /** Department context — auto-populated from the first assignee. */
  department?: mongoose.Types.ObjectId | null;
  category?: mongoose.Types.ObjectId | null;
  /** Project this task belongs to (null = standalone task). */
  project?: mongoose.Types.ObjectId | null;
  milestone?: mongoose.Types.ObjectId | null;
  /** "{CODE}-{n}" assigned from Project.taskCounter on create; never re-coded. */
  shortCode?: string | null;
  /**
   * Global sequence ("#12" for tasks without a project), claimed atomically from
   * the `counters` collection (lib/taskNumbers.ts). Missing only on tasks created
   * before `bun run migrate:tables`.
   */
  number?: number | null;
  /** Estimated time in minutes (null = no estimate). */
  estimateMinutes?: number | null;
  labels: mongoose.Types.ObjectId[];
  status: TaskStatus;
  priority: TaskPriority;
  startDate?: Date | null;
  dueDate?: Date | null;
  /** Order within a kanban column (fractional index). */
  position: number;
  subtasks: mongoose.Types.DocumentArray<ISubtask>;
  recurrence?: ITaskRecurrence | null;
  /** The recurring task this copy was generated from. */
  recurringParent?: mongoose.Types.ObjectId | null;
  /** "YYYY-MM-DD:kind" — prevents duplicate reminder emails on the same day. */
  lastReminderSentOn?: string | null;
  /** When a manual reminder was last sent (rate limit: once per hour). */
  lastManualReminderAt?: Date | null;
  /** Employee's notes when submitting completed work. */
  submissionNotes?: string;
  /** Set when closing: the deliverable was generated on Pearity (the production engine) or off it. */
  parity?: "on" | "off";
  /** Rules-era tasks: new work or rework (required at creation). */
  iteration?: TaskIteration | null;
  /** Rework tasks: the original task this reworks (shown in its Rework tab as history). */
  reworkOf?: mongoose.Types.ObjectId | null;
  /** Rework tasks: whose review asked for the changes (null on older reworks and on new work). */
  reworkSource?: ReworkSource | null;
  /** Rules-era tasks: the parts the title is composed from. */
  titleParts?: ITaskTitleParts | null;
  /** <project tag>-<UNIT><QTY>, unique (lib/tags.ts); frozen once Pearity uses it. */
  tag?: string | null;
  /** The traffic manager a task was created with when only traffic managers were assigned (it waits to be routed). */
  trafficVia?: mongoose.Types.ObjectId | null;
  /** First moment someone other than a traffic manager was assigned (creation, or when routed on). */
  assignedAt?: Date | null;
  /** AI brief check (lib/briefCheck.ts): verdict on the description, refreshed when it changes. */
  briefCheck?: {
    verdict: "ok" | "weak" | "flagged";
    /** Brief quality 0–100 (English, clear, on-brand, links score higher). */
    score?: number;
    reason?: string;
    model?: string;
    checkedAt?: Date;
    hash?: string;
  } | null;
  /** Outcome readiness (lib/outcomeReadiness.ts): how well the outcome note answers the brief and scope. Advice only. */
  outcomeReadiness?: {
    score: number;
    verdict: "good" | "partial" | "weak";
    covered: string[];
    missing: string[];
    reply: string;
    source: "ai" | "rules";
    at: Date;
  } | null;
  /** Final deliverable recorded at completion: an uploaded file (TaskFile id) or a link. */
  finalFile?: { fileId?: mongoose.Types.ObjectId | null; url?: string | null; addedAt?: Date | null } | null;
  submittedAt?: Date | null;
  /** Reviewer's notes on approval/rejection. */
  reviewNotes?: string;
  reviewedAt?: Date | null;
  reviewedBy?: mongoose.Types.ObjectId | null;
  completedAt?: Date | null;
  /** When work actually started / finished (UTC instants; see lib/actualDates.ts). */
  actualStartAt?: Date | null;
  actualEndAt?: Date | null;
  actualStartSource?: ActualDateSource | null;
  actualEndSource?: ActualDateSource | null;
  /** Set when the task was created from a meeting action item; unset when the meeting is deleted. */
  sourceMeeting?: ITaskSourceMeeting | null;
  /** Created beyond its project's approved scope: blocked until an admin decides. */
  overScope?: {
    status: "pending" | "approved" | "rejected";
    unit: string;
    allowed: number;
    used: number;
    requested: number;
    decidedBy?: mongoose.Types.ObjectId | null;
    decidedAt?: Date | null;
    reason?: string;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

const subtaskSchema = new Schema<ISubtask>({
  title: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, trim: true, maxlength: 2000, default: "" },
  done: { type: Boolean, default: false },
  completionNote: { type: String, trim: true, maxlength: 2000, default: "" },
  assignee: { type: Schema.Types.ObjectId, ref: "User", default: null },
  startDate: { type: Date, default: null },
  dueDate: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  actualStartAt: { type: Date, default: null },
  actualEndAt: { type: Date, default: null },
  actualStartSource: { type: String, enum: [...ACTUAL_DATE_SOURCES, null], default: null },
  actualEndSource: { type: String, enum: [...ACTUAL_DATE_SOURCES, null], default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  pendingNotify: { type: String, enum: [...SUBTASK_PENDING_NOTIFY, null], default: null },
  /** Worksuite sub_tasks id for imported subtasks (see models/legacy.ts). */
  legacy: { type: legacyRefSchema, default: undefined },
});

const recurrenceSchema = new Schema<ITaskRecurrence>(
  {
    every: { type: Number, required: true, min: 1, max: 365 },
    unit: { type: String, required: true, enum: RECURRENCE_UNITS },
    cycles: { type: Number, required: true, min: -1 },
    generated: { type: Number, default: 0, min: 0 },
    nextRunAt: { type: Date, required: true },
  },
  { _id: false }
);

const sourceMeetingSchema = new Schema<ITaskSourceMeeting>(
  {
    meeting: { type: Schema.Types.ObjectId, ref: "Meeting", required: true },
    segmentIdx: { type: Number, default: null, min: 0 },
  },
  { _id: false }
);

const taskSchema = new Schema<ITask>(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: TASK_LIMITS.maxDescription },
    assignees: {
      type: [{ type: Schema.Types.ObjectId, ref: "User" }],
      validate: {
        validator: (v: unknown[]) => v.length >= 1 && v.length <= TASK_LIMITS.maxAssignees,
        message: `A task needs between 1 and ${TASK_LIMITS.maxAssignees} assignees`,
      },
    },
    assignedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    department: {
      type: Schema.Types.ObjectId,
      ref: "Department",
      default: null,
    },
    category: { type: Schema.Types.ObjectId, ref: "TaskCategory", default: null },
    project: { type: Schema.Types.ObjectId, ref: "Project", default: null },
    milestone: { type: Schema.Types.ObjectId, ref: "Milestone", default: null },
    shortCode: { type: String, trim: true, default: null },
    // No default: un-migrated tasks simply lack the field (see the partial unique index).
    number: { type: Number, min: 1 },
    estimateMinutes: { type: Number, default: null, min: 0, max: TASK_LIMITS.maxEstimateMinutes },
    labels: {
      type: [{ type: Schema.Types.ObjectId, ref: "TaskLabel" }],
      default: [],
      validate: {
        validator: (v: unknown[]) => v.length <= TASK_LIMITS.maxLabels,
        message: `A task can have at most ${TASK_LIMITS.maxLabels} labels`,
      },
    },
    status: {
      type: String,
      required: true,
      enum: TASK_STATUSES,
      default: "todo",
      index: true,
    },
    priority: {
      type: String,
      required: true,
      enum: TASK_PRIORITIES,
      default: "medium",
    },
    startDate: { type: Date, default: null },
    dueDate: { type: Date, default: null },
    position: { type: Number, default: () => Date.now() },
    subtasks: {
      type: [subtaskSchema],
      default: [],
      validate: {
        validator: (v: unknown[]) => v.length <= TASK_LIMITS.maxSubtasks,
        message: `A task can have at most ${TASK_LIMITS.maxSubtasks} subtasks`,
      },
    },
    recurrence: { type: recurrenceSchema, default: null },
    recurringParent: { type: Schema.Types.ObjectId, ref: "Task", default: null },
    lastReminderSentOn: { type: String, default: null },
    lastManualReminderAt: { type: Date, default: null },
    submissionNotes: { type: String, trim: true, maxlength: 2000 },
    parity: { type: String, enum: ["on", "off"] },
    iteration: { type: String, enum: [...TASK_ITERATIONS, null], default: null },
    reworkOf: { type: Schema.Types.ObjectId, ref: "Task", default: null, index: true },
    reworkSource: { type: String, enum: [...REWORK_SOURCES, null], default: null },
    tag: { type: String, default: undefined, trim: true, maxlength: 120 },
    trafficVia: { type: Schema.Types.ObjectId, ref: "User", default: null },
    assignedAt: { type: Date, default: null },
    titleParts: {
      type: new Schema(
        {
          unit: { type: String, trim: true, maxlength: TASK_TITLE_LIMITS.unitMax, required: true },
          quantity: { type: Number, min: 1, max: TASK_TITLE_LIMITS.quantityMax, required: true },
          shortName: { type: String, trim: true, maxlength: TASK_TITLE_LIMITS.shortNameMax, required: true },
        },
        { _id: false }
      ),
      default: undefined,
    },
    briefCheck: {
      type: new Schema(
        {
          verdict: { type: String, enum: ["ok", "weak", "flagged"], required: true },
          score: { type: Number, min: 0, max: 100 },
          reason: { type: String, trim: true, maxlength: 200 },
          model: { type: String, trim: true },
          checkedAt: { type: Date },
          hash: { type: String },
        },
        { _id: false }
      ),
      default: undefined,
    },
    outcomeReadiness: {
      type: new Schema(
        {
          score: { type: Number, min: 0, max: 100, required: true },
          verdict: { type: String, enum: ["good", "partial", "weak"], required: true },
          covered: { type: [{ type: String, maxlength: 300 }], default: [] },
          missing: { type: [{ type: String, maxlength: 300 }], default: [] },
          reply: { type: String, maxlength: 400, default: "" },
          source: { type: String, enum: ["ai", "rules"], required: true },
          at: { type: Date, required: true },
        },
        { _id: false }
      ),
      default: undefined,
    },
    finalFile: {
      type: new Schema(
        {
          fileId: { type: Schema.Types.ObjectId, ref: "TaskFile", default: null },
          url: { type: String, trim: true, maxlength: 2000, default: null },
          addedAt: { type: Date, default: null },
        },
        { _id: false }
      ),
      default: undefined,
    },
    submittedAt: { type: Date, default: null },
    reviewNotes: { type: String, trim: true, maxlength: 2000 },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    completedAt: { type: Date, default: null },
    actualStartAt: { type: Date, default: null },
    actualEndAt: { type: Date, default: null },
    actualStartSource: { type: String, enum: [...ACTUAL_DATE_SOURCES, null], default: null },
    actualEndSource: { type: String, enum: [...ACTUAL_DATE_SOURCES, null], default: null },
    sourceMeeting: { type: sourceMeetingSchema, default: null },
    overScope: {
      type: new Schema(
        {
          status: { type: String, enum: ["pending", "approved", "rejected"], required: true },
          unit: { type: String, required: true },
          allowed: { type: Number, required: true },
          used: { type: Number, required: true },
          requested: { type: Number, required: true },
          decidedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
          decidedAt: { type: Date, default: null },
          reason: { type: String, default: "", maxlength: 500 },
        },
        { _id: false }
      ),
      default: null,
    },
  },
  { timestamps: true }
);

// Employee's task list — newest first.
taskSchema.index({ assignees: 1, createdAt: -1 });
taskSchema.index({ tag: 1 }, { unique: true, partialFilterExpression: { tag: { $type: "string" } }, name: "tag_unique" });
// "My board" — assignee's tasks per column, in board order.
taskSchema.index({ assignees: 1, status: 1, position: 1 });
// Head's created tasks — newest first.
taskSchema.index({ assignedBy: 1, createdAt: -1 });
// Admin overview — filter by department + status.
taskSchema.index({ department: 1, status: 1, createdAt: -1 });
// Overdue tasks query + reminders job.
taskSchema.index({ status: 1, dueDate: 1 });
// Project board — project tasks per column, in board order.
taskSchema.index({ project: 1, status: 1, position: 1 });
// Recurring tasks job.
taskSchema.index({ "recurrence.nextRunAt": 1 });
// "My subtasks" — open subtasks assigned to a user.
taskSchema.index({ "subtasks.assignee": 1 });
// Global task number — unique once assigned (partial, so un-migrated tasks don't collide).
taskSchema.index(
  { number: 1 },
  { unique: true, partialFilterExpression: { number: { $type: "number" } }, name: "number_unique" }
);
// Calendar view (due-date range per status).
taskSchema.index({ dueDate: 1, status: 1 });
// Board column re-normalisation (status + position neighbours, see normalizeColumnIfNeeded).
taskSchema.index({ status: 1, position: 1 });
// Copies of a recurring task.
taskSchema.index({ recurringParent: 1 }, { sparse: true });
// Tasks created from a meeting (unset when the meeting is deleted).
taskSchema.index({ "sourceMeeting.meeting": 1 }, { sparse: true });

// Delivery Pulse: completed-in-period / created-in-period windows, per project.
taskSchema.index({ completedAt: 1 });
taskSchema.index({ createdAt: 1 });
taskSchema.index({ project: 1, createdAt: 1 });

// Never leak the internal version key in JSON responses.
taskSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    if (Array.isArray(json.subtasks)) {
      for (const sub of json.subtasks as Array<Record<string, unknown>>) delete sub.pendingNotify;
    }
    return json;
  },
});

deliveryInvalidateOnWrite(taskSchema);

// Imported documents (bun run import:worksuite) carry `legacy` for idempotent re-runs.
addLegacyRef(taskSchema);

export const Task = mongoose.model<ITask>("Task", taskSchema);
