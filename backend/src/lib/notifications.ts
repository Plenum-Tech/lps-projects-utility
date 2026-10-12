import type { Response } from "express";
import type mongoose from "mongoose";
import {
  Notification,
  type INotification,
  type NotificationType,
} from "../models/Notification.js";
import type { EmailPreferences, IUser } from "../models/User.js";
import { Project } from "../models/Project.js";
import { User } from "../models/User.js";
import {
  sendEmail,
  sendBatchEmails,
  leaveApprovedTemplate,
  leaveRejectedTemplate,
  feedbackRespondedTemplate,
  announcementCreatedTemplate,
  reviewAssignedTemplate,
  taskEmailTemplate,
  genericEmailTemplate,
} from "./email.js";
import { pushToClient, createEvent, registerClient } from "./sse.js";

export interface NotifyParams {
  recipient: mongoose.Types.ObjectId;
  actor?: IUser | null;
  type: NotificationType;
  title: string;
  message: string;
  link?: string;
  /** Optional structured data for email templates. */
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// SSE connection manager — delegates to shared sse.ts
// ---------------------------------------------------------------------------

/** Register an SSE client for a user. Returns a cleanup function. */
export function registerSSEClient(
  userId: string,
  res: Response
): () => void {
  return registerClient(userId, res);
}

/** Push a notification to connected SSE clients for a given user. */
function pushToSSE(userId: string, notification: INotification): void {
  pushToClient(userId, createEvent("notification", notification.toJSON()));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** "Jane Doe" → "Jane" (falls back to "there"). */
export function firstNameOf(name: string | undefined | null): string {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first || "there";
}

/** Which email preference controls each notification type (types not listed always email). */
const EMAIL_PREF_BY_TYPE: Partial<Record<NotificationType, keyof EmailPreferences>> = {
  task_assigned: "taskAssigned",
  subtask_assigned: "taskAssigned",
  task_updated: "taskUpdates",
  task_status_changed: "taskUpdates",
  task_completed: "taskUpdates",
  task_approved: "taskUpdates",
  task_rejected: "taskUpdates",
  subtask_completed: "taskUpdates",
  subtask_created: "taskUpdates",
  task_comment: "taskComments",
  task_mention: "taskComments",
  task_note: "taskComments",
  task_note_mention: "taskComments",
  task_reminder: "taskReminders",
  task_overdue: "taskReminders",
  project_member_added: "projectUpdates",
  project_status_changed: "projectUpdates",
  project_deadline: "projectUpdates",
  project_note: "projectUpdates",
  project_file: "projectUpdates",
  timelog_pending: "timeLogs",
  timelog_approved: "timeLogs",
  timelog_rejected: "timeLogs",
  timesheet_submitted: "timeLogs",
  timesheet_approved: "timeLogs",
  timesheet_rejected: "timeLogs",
  time_tracker_reminder: "timeLogs",
  timer_auto_stopped: "timeLogs",
  user_joined: "teamUpdates",
  document_expiring: "hrReminders",
  hr_date_upcoming: "hrReminders",
  training_assigned: "hrReminders",
  training_reminder: "hrReminders",
  leave_requested: "leaveRequests",
};

/** True unless the user explicitly turned off email for this notification type. */
function wantsEmail(
  prefs: Partial<EmailPreferences> | undefined,
  type: NotificationType
): boolean {
  const key = EMAIL_PREF_BY_TYPE[type];
  if (!key) return true;
  return prefs?.[key] !== false;
}

/** Frontend route that opens a task's detail sheet. */
export function taskLink(taskId: mongoose.Types.ObjectId | string): string {
  return `/tasks?task=${taskId.toString()}`;
}

/** Date-only values are stored as UTC midnight — format them without a timezone shift. */
export function formatDueDate(date: Date | null | undefined): string | null {
  if (!date) return null;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// ---------------------------------------------------------------------------
// Email sending — fire-and-forget, errors are swallowed
// ---------------------------------------------------------------------------

/**
 * Looks up a user's name/email and sends a notification email rendered for them.
 * Failures are caught and logged — never throws.
 */
function sendNotificationEmail(
  recipientId: mongoose.Types.ObjectId,
  params: {
    subject: string;
    render: (firstName: string) => string;
  }
): void {
  void User.findById(recipientId)
    .select("name email")
    .lean()
    .then((user) => {
      if (!user || !user.email) return;
      return sendEmail({
        to: user.email,
        subject: params.subject,
        html: params.render(firstNameOf(user.name)),
      });
    })
    .catch((err) => {
      console.error("[email] Failed to look up recipient for email:", err);
    });
}

// ---------------------------------------------------------------------------
// Public helpers — fire-and-forget (mirrors the logActivity pattern)
// ---------------------------------------------------------------------------

/**
 * Creates a notification document and pushes it to any connected SSE clients.
 * Also sends an email notification when applicable.
 * Failures are swallowed — notifications must never break the primary request.
 */
export function notify(params: NotifyParams): void {
  const { recipient, actor, type, title, message, link } = params;

  void Notification.create({
    recipient,
    actor: actor ? actor._id : null,
    type,
    title,
    message,
    link,
  })
    .then((doc) => {
      pushToSSE(recipient.toString(), doc);
      sendEmailForNotification(params);
    })
    .catch(() => undefined);
}

/**
 * Batch-creates notifications for multiple recipients (used for department-wide
 * announcements). Pushes each to SSE and sends emails.
 * Failures are swallowed.
 */
export function notifyBatch(
  recipients: mongoose.Types.ObjectId[],
  params: Omit<NotifyParams, "recipient">
): void {
  const docs = recipients.map((recipient) => ({
    recipient,
    actor: params.actor ? params.actor._id : null,
    type: params.type,
    title: params.title,
    message: params.message,
    link: params.link,
  }));

  void Notification.insertMany(docs)
    .then((created) => {
      for (const doc of created) {
        pushToSSE(doc.recipient.toString(), doc as unknown as INotification);
      }
      sendBatchEmailsForNotifications(recipients, params);
    })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Task notifications — one helper for every task_* / subtask_* type
// ---------------------------------------------------------------------------

/** The task fields a task notification needs (a full ITask works too). */
export interface TaskNotificationTarget {
  _id: mongoose.Types.ObjectId;
  title: string;
  dueDate?: Date | null;
  startDate?: Date | null;
  priority?: string;
  status?: string;
  shortCode?: string | null;
  number?: number | null;
  /** Project id, or a populated project with a name. */
  project?: mongoose.Types.ObjectId | { _id?: unknown; name?: string } | null;
}

/** "In progress" from "in_progress". */
function statusLabel(status: string | undefined): string | null {
  if (!status) return null;
  const text = status.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Project name for an email: populated doc or a lookup by id. */
async function projectNameOf(project: TaskNotificationTarget["project"]): Promise<string | null> {
  if (!project) return null;
  if (typeof project === "object" && "name" in project && typeof project.name === "string") return project.name;
  const id = typeof (project as { toHexString?: unknown }).toHexString === "function" ? (project as mongoose.Types.ObjectId) : null;
  if (!id) return null;
  const doc = await Project.findById(id).select("name").lean();
  return doc?.name ?? null;
}

export interface TaskNotifyParams {
  /** Candidate recipients — deduplicated; the actor is always removed. */
  recipients: Array<mongoose.Types.ObjectId | string>;
  /** Null for system events (scheduled reminders, recurring copies). */
  actor?: IUser | null;
  type: NotificationType;
  task: TaskNotificationTarget;
  /** In-app notification title + message. */
  title: string;
  message: string;
  email: {
    subject: string;
    heading: string;
    intro: string;
    quote?: string | null;
    quoteAuthor?: string | null;
    buttonLabel?: string;
    /** Custom HTML per recipient (e.g. subtaskTemplate); replaces the task layout. */
    render?: (firstName: string) => string;
  };
  /** In-app link override (default `/tasks?task=<id>`). */
  link?: string;
  /** In-app only: no emails (bulk imports with "Send assignment emails" off). */
  skipEmail?: boolean;
}

/**
 * Creates in-app notifications (always) and sends emails (respecting each
 * recipient's `emailPreferences`). Deleted users are skipped. Resolves when the
 * emails have been handed to the transport — callers in requests should use
 * `notifyTask` (fire-and-forget); scheduled jobs await this to finish cleanly.
 */
export async function notifyTaskAsync(params: TaskNotifyParams): Promise<number> {
  const actorId = params.actor ? params.actor._id.toString() : null;
  const ids = [...new Set(params.recipients.map((id) => id.toString()))].filter(
    (id) => id !== actorId
  );
  if (ids.length === 0) return 0;

  const users = await User.find({ _id: { $in: ids } })
    .select("name email emailPreferences")
    .lean();
  if (users.length === 0) return 0;

  const link = params.link ?? taskLink(params.task._id);
  const created = await Notification.insertMany(
    users.map((user) => ({
      recipient: user._id,
      actor: params.actor ? params.actor._id : null,
      type: params.type,
      title: params.title,
      message: params.message,
      link,
      task: params.task._id,
    }))
  );
  for (const doc of created) {
    pushToSSE(doc.recipient.toString(), doc as unknown as INotification);
  }

  if (params.skipEmail) return users.length;
  const dueDate = formatDueDate(params.task.dueDate);
  const startDate = formatDueDate(params.task.startDate);
  const taskCode = params.task.shortCode ?? (params.task.number ? `#${params.task.number}` : null);
  const projectName = await projectNameOf(params.task.project);
  const emails = users
    .filter((user) => user.email && wantsEmail(user.emailPreferences, params.type))
    .map((user) => ({
      to: user.email,
      subject: taskCode && !params.email.subject.includes(taskCode) ? `${params.email.subject} · ${taskCode}` : params.email.subject,
      html: params.email.render ? params.email.render(firstNameOf(user.name)) : taskEmailTemplate({
        firstName: user.name,
        heading: params.email.heading,
        intro: params.email.intro,
        taskId: params.task._id.toString(),
        taskTitle: params.task.title,
        taskCode,
        projectName,
        startDate,
        dueDate,
        status: statusLabel(params.task.status),
        priority: params.task.priority ?? null,
        quote: params.email.quote ?? null,
        quoteAuthor: params.email.quoteAuthor ?? null,
        buttonLabel: params.email.buttonLabel,
      }),
    }));
  await sendBatchEmails(emails);

  return users.length;
}

/** Fire-and-forget wrapper around `notifyTaskAsync`. */
export function notifyTask(params: TaskNotifyParams): void {
  void notifyTaskAsync(params).catch((err) => {
    console.error("[notifications] Task notification failed:", err);
  });
}

// ---------------------------------------------------------------------------
// Project / time-tracking notifications (one generic helper)
// ---------------------------------------------------------------------------

export interface UsersNotifyParams {
  /** Candidate recipients, deduplicated; the actor is removed unless `includeActor`. */
  recipients: Array<mongoose.Types.ObjectId | string>;
  actor?: IUser | null;
  includeActor?: boolean;
  type: NotificationType;
  title: string;
  message: string;
  /** Frontend route, e.g. "/projects/<id>". */
  link: string;
  /** Related project (cleanup on project delete). */
  project?: mongoose.Types.ObjectId | null;
  /** In-app only: no emails (bulk imports with "Send assignment emails" off). */
  skipEmail?: boolean;
  /**
   * Email only these people (everyone in `recipients` still gets the in-app
   * notification). Keeps project-wide events from emailing every member.
   */
  emailOnly?: Array<mongoose.Types.ObjectId | string>;
  email: {
    subject: string;
    heading: string;
    intro: string;
    cardTitle?: string | null;
    rows?: Array<[string, string]>;
    quote?: string | null;
    quoteAuthor?: string | null;
    buttonLabel?: string;
    /** Custom HTML per recipient (replaces the generic layout). */
    render?: (firstName: string, recipientId: string) => string;
  };
}

/**
 * Creates in-app notifications (always) and emails (gated by the recipient's
 * `emailPreferences` via EMAIL_PREF_BY_TYPE). Resolves once emails are handed
 * to the transport: jobs await it, requests use the fire-and-forget wrapper.
 */
export async function notifyUsersAsync(params: UsersNotifyParams): Promise<number> {
  const actorId = params.actor && !params.includeActor ? params.actor._id.toString() : null;
  const ids = [...new Set(params.recipients.map((id) => id.toString()))].filter((id) => id !== actorId);
  if (ids.length === 0) return 0;

  const users = await User.find({ _id: { $in: ids } }).select("name email emailPreferences").lean();
  if (users.length === 0) return 0;

  const created = await Notification.insertMany(
    users.map((user) => ({
      recipient: user._id,
      actor: params.actor ? params.actor._id : null,
      type: params.type,
      title: params.title,
      message: params.message,
      link: params.link,
      project: params.project ?? null,
    }))
  );
  for (const doc of created) {
    pushToSSE(doc.recipient.toString(), doc as unknown as INotification);
  }
  if (params.skipEmail) return users.length;

  const emailOnly = params.emailOnly ? new Set(params.emailOnly.map((id) => id.toString())) : null;
  const emails = users
    .filter((user) => !emailOnly || emailOnly.has(user._id.toString()))
    .filter((user) => user.email && wantsEmail(user.emailPreferences, params.type))
    .map((user) => ({
      to: user.email,
      subject: params.email.subject,
      html: params.email.render ? params.email.render(firstNameOf(user.name), user._id.toString()) : genericEmailTemplate({
        firstName: firstNameOf(user.name),
        heading: params.email.heading,
        intro: params.email.intro,
        cardTitle: params.email.cardTitle ?? null,
        rows: params.email.rows,
        quote: params.email.quote ?? null,
        quoteAuthor: params.email.quoteAuthor ?? null,
        path: params.link,
        buttonLabel: params.email.buttonLabel,
      }),
    }));
  await sendBatchEmails(emails);
  return users.length;
}

/** Fire-and-forget wrapper around `notifyUsersAsync`. */
export function notifyUsers(params: UsersNotifyParams): void {
  void notifyUsersAsync(params).catch((err) => {
    console.error("[notifications] Notification failed:", err);
  });
}

// ---------------------------------------------------------------------------
// Email dispatch logic per (non-task) notification type
// ---------------------------------------------------------------------------

/** Send an email for a single notification based on its type. */
function sendEmailForNotification(params: NotifyParams): void {
  const { recipient, type, message, data } = params;

  switch (type) {
    case "leave_approved":
    case "leave_rejected": {
      const isApproved = type === "leave_approved";
      const leaveType = (data?.leaveType as string) || "leave";
      const startDate = (data?.startDate as string) || "";
      const endDate = (data?.endDate as string) || "";
      const days = (data?.days as number) || 0;
      const note = (data?.note as string) || undefined;
      const decidedBy = (data?.decidedBy as string) || params.actor?.name || undefined;

      // Fallback: parse from message if data is not provided
      const match = message.match(/^Your (\w+) leave request for (\d+) day\(s\)/);
      const finalLeaveType = leaveType !== "leave" ? leaveType : (match?.[1] || "leave");
      const finalDays = days || (match ? parseInt(match[2] ?? "0", 10) : 0);

      sendNotificationEmail(recipient, {
        subject: isApproved ? "Leave Approved ✅" : "Leave Rejected ❌",
        render: (firstName) => {
          const templateParams = {
            employeeName: firstName,
            leaveType: finalLeaveType,
            startDate,
            endDate,
            days: finalDays,
            note,
            decidedBy,
          };
          return isApproved
            ? leaveApprovedTemplate(templateParams)
            : leaveRejectedTemplate(templateParams);
        },
      });
      break;
    }

    case "feedback_responded": {
      const category = (data?.category as string) || "feedback";
      const responseBody = (data?.responseBody as string) || message;
      sendNotificationEmail(recipient, {
        subject: "Admin Responded to Your Feedback",
        render: (firstName) =>
          feedbackRespondedTemplate({
            employeeName: firstName,
            category,
            responseBody,
            respondedBy: params.actor?.name || "An admin",
          }),
      });
      break;
    }

    case "announcement_created": {
      // For announcements, we send batch emails (handled by sendBatchEmailsForNotifications)
      break;
    }

    case "review_assigned": {
      const period = (data?.period as string) || "";
      const reviewerName = (data?.reviewerName as string) || params.actor?.name || "An admin";
      sendNotificationEmail(recipient, {
        subject: "Performance Review Assigned 📋",
        render: (firstName) =>
          reviewAssignedTemplate({ employeeName: firstName, period, reviewerName }),
      });
      break;
    }

    case "review_acknowledged": {
      // The reviewer gets notified — we don't send an email for acknowledgment,
      // it's mainly an in-app notification.
      break;
    }

    default:
      // Task notifications go through notifyTask(), which handles their emails.
      break;
  }
}

/** Send batch emails for announcement notifications. */
function sendBatchEmailsForNotifications(
  recipients: mongoose.Types.ObjectId[],
  params: Omit<NotifyParams, "recipient">
): void {
  if (params.type !== "announcement_created") return;

  const data = params.data || {};
  const announcementTitle = (data.announcementTitle as string) || params.title;
  const announcementBody = (data.announcementBody as string) || params.message;
  const departmentName = (data.departmentName as string) || "your department";

  void User.find({ _id: { $in: recipients } })
    .select("name email")
    .lean()
    .then((users) =>
      sendBatchEmails(
        users
          .filter((user) => user.email)
          .map((user) => ({
            to: user.email,
            subject: `📢 ${announcementTitle}`,
            html: announcementCreatedTemplate({
              recipientName: firstNameOf(user.name),
              announcementTitle,
              announcementBody,
              departmentName,
              authorName: params.actor?.name || "A team member",
            }),
          }))
      )
    )
    .catch((err) => {
      console.error("[email] Failed to look up recipients for batch email:", err);
    });
}
