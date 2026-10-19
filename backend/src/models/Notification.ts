import mongoose, { Schema } from "mongoose";

/** Fixed notification types — keeps backend and frontend in sync. */
export const NOTIFICATION_TYPES = [
  "leave_approved",
  "leave_rejected",
  "leave_requested",
  "feedback_responded",
  "announcement_created",
  "review_assigned",
  "review_acknowledged",
  "task_assigned",
  "task_completed",
  "task_approved",
  "task_rejected",
  "task_updated",
  "task_status_changed",
  "task_comment",
  "task_mention",
  "subtask_created",
  "subtask_assigned",
  "subtask_completed",
  "task_note",
  "task_note_mention",
  "task_reminder",
  "task_overdue",
  "project_member_added",
  "project_approval_requested",
  "brand_approval_requested",
  "change_approval_requested",
  "change_decided",
  "change_exception",
  "retainer_projects_created",
  "task_over_scope",
  "brand_approved",
  "brand_rejected",
  "project_approved",
  "project_rejected",
  "project_status_changed",
  "project_deadline",
  "pitch_milestone_missed",
  "project_note",
  "project_file",
  "timelog_pending",
  "timelog_approved",
  "timelog_rejected",
  "timesheet_submitted",
  "timesheet_approved",
  "timesheet_rejected",
  "time_tracker_reminder",
  "timer_auto_stopped",
  "user_joined",
  "document_expiring",
  "hr_date_upcoming",
  "training_assigned",
  "training_reminder",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface INotification extends mongoose.Document {
  /** User who receives the notification. */
  recipient: mongoose.Types.ObjectId;
  /** User who triggered the event (null for system-generated notifications). */
  actor?: mongoose.Types.ObjectId | null;
  type: NotificationType;
  /** Short human-readable title. */
  title: string;
  /** Longer description of the event. */
  message: string;
  read: boolean;
  /** Optional frontend route to navigate to when the notification is clicked. */
  link?: string;
  /** Related task (task notifications only) — lets a task delete clean up its notifications. */
  task?: mongoose.Types.ObjectId | null;
  /** Related project — lets a project delete clean up its notifications. */
  project?: mongoose.Types.ObjectId | null;
}

const notificationSchema = new Schema<INotification>(
  {
    recipient: { type: Schema.Types.ObjectId, ref: "User", required: true },
    actor: { type: Schema.Types.ObjectId, ref: "User", default: null },
    type: { type: String, required: true, enum: NOTIFICATION_TYPES },
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    read: { type: Boolean, default: false },
    link: { type: String, trim: true },
    task: { type: Schema.Types.ObjectId, ref: "Task", default: null },
    project: { type: Schema.Types.ObjectId, ref: "Project", default: null },
  },
  { timestamps: true }
);

// Primary access pattern: user's notifications, newest first.
notificationSchema.index({ recipient: 1, createdAt: -1 });
// Unread count query.
notificationSchema.index({ recipient: 1, read: 1 });
// Task delete cleanup.
notificationSchema.index({ task: 1 }, { sparse: true });
// Project delete cleanup.
notificationSchema.index({ project: 1 }, { sparse: true });

// Never leak the internal version key in JSON responses.
notificationSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    return json;
  },
});

export const Notification = mongoose.model<INotification>(
  "Notification",
  notificationSchema
);
