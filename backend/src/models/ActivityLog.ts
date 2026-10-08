import mongoose, { Schema } from "mongoose";

/** Every action the activity log records. Keep in sync with the frontend `ActivityAction` type. */
export const ACTIVITY_ACTIONS = [
  "login",
  "login_failed",
  "logout",
  "user_created",
  "user_updated",
  "user_deleted",
  "profile_updated",
  "department_created",
  "department_updated",
  "department_deleted",
  "department_members_updated",
  "leave_created",
  "leave_cancelled",
  "leave_approved",
  "leave_rejected",
  "leave_balance_adjusted",
  "leave_policy_updated",
  "announcement_created",
  "announcement_updated",
  "announcement_deleted",
  "feedback_created",
  "feedback_responded",
  "feedback_resolved",
  "feedback_reopened",
  "attendance_marked",
  "attendance_bulk_marked",
  "review_created",
  "review_generated",
  "review_acknowledged",
  "review_completed",
  "review_deleted",
  "goal_updated",
  "task_created",
  "task_status_updated",
  "task_submitted",
  "task_reviewed",
  "task_updated",
  "task_deleted",
  "task_settings_updated",
  "project_created",
  "project_updated",
  "project_archived",
  "project_deleted",
  "timelog_reviewed",
  "timesheet_reviewed",
  "project_settings_updated",
  "ai_insight_deleted",
  "user_invited",
  "invitation_resent",
  "invitation_revoked",
  "invitation_accepted",
  "document_created",
  "document_updated",
  "document_deleted",
  "meeting_created",
  "meeting_deleted",
  "meeting_tasks_created",
  "settings_updated",
  "import_completed",
  "import_undone",
  "password_reset",
] as const;

export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

export interface IActivityLog extends mongoose.Document {
  action: ActivityAction;
  /** The user who performed the action — null for failed logins (no matching user). */
  actor?: mongoose.Types.ObjectId | null;
  /** Snapshots so entries stay readable even after the actor/target is deleted. */
  actorName?: string;
  actorEmail?: string;
  actorRole?: "admin" | "employee" | "head";
  targetType?: string;
  targetId?: mongoose.Types.ObjectId | null;
  targetName?: string;
  details?: unknown;
  ip?: string;
}

const activityLogSchema = new Schema<IActivityLog>(
  {
    action: { type: String, required: true, enum: ACTIVITY_ACTIONS, index: true },
    actor: { type: Schema.Types.ObjectId, ref: "User", default: null },
    actorName: { type: String, trim: true },
    actorEmail: { type: String, trim: true },
    actorRole: { type: String, enum: ["admin", "employee", "head"] },
    targetType: { type: String, trim: true },
    targetId: { type: Schema.Types.ObjectId, default: null },
    targetName: { type: String, trim: true },
    details: { type: Schema.Types.Mixed },
    ip: { type: String, trim: true },
  },
  { timestamps: true }
);

// Newest-first listing is the only access pattern — index createdAt desc.
activityLogSchema.index({ createdAt: -1 });

// Never leak the internal version key in JSON responses
activityLogSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    return json;
  },
});

export const ActivityLog = mongoose.model<IActivityLog>("ActivityLog", activityLogSchema);
