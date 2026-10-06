import mongoose from "mongoose";
import { Task } from "../models/Task.js";
import type { ITask, RecurrenceUnit } from "../models/Task.js";
import { getTaskSettings } from "../models/TaskSettings.js";
import { User } from "../models/User.js";
import { notifyTaskAsync } from "./notifications.js";
import { Milestone } from "../models/Milestone.js";
import { Project } from "../models/Project.js";
import type { IProject } from "../models/Project.js";
import { isProjectStatusCompleted } from "./projectAccess.js";
import { scheduleProgressRecalc } from "./projectProgress.js";
import { pushTaskUpdate, recordTaskHistory } from "./taskAccess.js";
import { nextShortCode, nextTaskNumber } from "./taskNumbers.js";
import { settingsTimeZone } from "./companySettings.js";

// ---------------------------------------------------------------------------
// Date-only helpers — due/start dates are stored as UTC midnight of a calendar
// date, so every comparison happens on "YYYY-MM-DD" keys in the app timezone
// (Worksuite's reminders broke by comparing DATETIME against DATE).
// ---------------------------------------------------------------------------

/** App timezone: Company Settings → APP_TIMEZONE env → Asia/Kolkata (cached, sync). */
export function appTimeZone(): string {
  return settingsTimeZone();
}

/** "YYYY-MM-DD" of `now` in the app timezone. */
export function appDateKey(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: appTimeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Today (app timezone) as a stored date-only value (UTC midnight). */
export function appToday(now: Date = new Date()): Date {
  return new Date(`${appDateKey(now)}T00:00:00.000Z`);
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/** Adds `every` units; months clamp to the last day (Jan 31 + 1 month → Feb 28/29). */
export function addInterval(date: Date, every: number, unit: RecurrenceUnit): Date {
  if (unit === "day") return addDays(date, every);
  if (unit === "week") return addDays(date, every * 7);
  const next = new Date(date.getTime());
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + every);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

/** First run strictly after `now`, starting from `from` and stepping by the interval. */
export function nextRunAfter(from: Date, every: number, unit: RecurrenceUnit, now: Date): Date {
  let next = addInterval(from, every, unit);
  // Guard against catch-up storms after downtime — skip missed runs.
  for (let i = 0; next.getTime() <= now.getTime() && i < 5000; i++) {
    next = addInterval(next, every, unit);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Due-date reminders
// ---------------------------------------------------------------------------

export interface ReminderRunResult {
  date: string;
  checked: number;
  reminded: number;
  overdue: number;
  skipped: number;
}

/**
 * Sends due-soon / due-today reminders and overdue notices for the current day.
 * Idempotent per task per day via `lastReminderSentOn = "YYYY-MM-DD:kind"`.
 */
export async function runTaskReminders(now: Date = new Date()): Promise<ReminderRunResult> {
  const settings = await getTaskSettings();
  const todayKey = appDateKey(now);
  const today = appToday(now);

  type Kind = "before" | "on" | "after";
  const targets = new Map<number, Kind>();
  if (settings.reminderBeforeDays > 0) {
    targets.set(addDays(today, settings.reminderBeforeDays).getTime(), "before");
  }
  if (settings.reminderOnDeadline) targets.set(today.getTime(), "on");
  if (settings.reminderAfterDays > 0) {
    targets.set(addDays(today, -settings.reminderAfterDays).getTime(), "after");
  }

  const result: ReminderRunResult = { date: todayKey, checked: 0, reminded: 0, overdue: 0, skipped: 0 };
  if (targets.size === 0) return result;

  const tasks = await Task.find({
    status: { $ne: "completed" },
    dueDate: { $in: [...targets.keys()].map((t) => new Date(t)) },
  }).select("title dueDate priority status assignees assignedBy department");
  result.checked = tasks.length;

  for (const task of tasks) {
    const kind = task.dueDate ? targets.get(task.dueDate.getTime()) : undefined;
    if (!kind) continue;
    const key = `${todayKey}:${kind}`;

    // Atomically claim today's reminder — a concurrent run (cron + local interval) sees null.
    const claimed = await Task.findOneAndUpdate(
      { _id: task._id, lastReminderSentOn: { $ne: key } },
      { $set: { lastReminderSentOn: key } }
    );
    if (!claimed) {
      result.skipped++;
      continue;
    }

    if (kind === "after") {
      await notifyTaskAsync({
        recipients: [...task.assignees, task.assignedBy],
        actor: null,
        type: "task_overdue",
        task,
        title: "Task overdue",
        message: `"${task.title}" is ${settings.reminderAfterDays} day(s) past its due date.`,
        email: {
          subject: `⏰ Overdue: ${task.title}`,
          heading: "Task Overdue",
          intro: `This task is ${settings.reminderAfterDays} day(s) past its due date and is not completed yet.`,
        },
      });
      result.overdue++;
    } else {
      const when =
        kind === "on" ? "today" : `in ${settings.reminderBeforeDays} day(s)`;
      await notifyTaskAsync({
        recipients: task.assignees,
        actor: null,
        type: "task_reminder",
        task,
        title: kind === "on" ? "Task due today" : "Task due soon",
        message: `"${task.title}" is due ${when}.`,
        email: {
          subject: `🔔 Due ${when}: ${task.title}`,
          heading: kind === "on" ? "Task Due Today" : "Task Due Soon",
          intro: `Reminder: this task is due ${when}.`,
        },
      });
      result.reminded++;
    }

    recordTaskHistory(task._id, null, "reminder_sent", { kind, auto: true });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Recurring tasks
// ---------------------------------------------------------------------------

export interface RecurringRunResult {
  checked: number;
  generated: number;
}

/** Clones one occurrence of a recurring parent task. */
async function generateOccurrence(parent: ITask, now: Date): Promise<ITask | null> {
  const today = appToday(now);

  // Keep the original start→due span (start defaults to the creation date).
  let dueDate: Date | null = null;
  if (parent.dueDate) {
    const origin = parent.startDate ?? new Date(`${appDateKey(parent.createdAt)}T00:00:00.000Z`);
    const spanDays = Math.max(0, Math.round((parent.dueDate.getTime() - origin.getTime()) / 86_400_000));
    dueDate = addDays(today, spanDays);
  }

  // Project tasks recur inside their project — unless it has since been
  // archived or finished, in which case this occurrence is skipped.
  let project: IProject | null = null;
  if (parent.project) {
    project = await Project.findById(parent.project);
    if (!project || project.archivedAt || (await isProjectStatusCompleted(project))) return null;
  }

  // Deleted users are dropped, and on a project only current members/the
  // manager stay (project task assignees must be members); with nobody left
  // there is nothing to generate.
  const existing = await User.find({ _id: { $in: parent.assignees } }).select("_id").lean();
  let assigneeIds = existing.map((u) => u._id);
  if (project) {
    const insiders = new Set([
      ...project.members.map((m) => m.user.toString()),
      ...(project.manager ? [project.manager.toString()] : []),
    ]);
    assigneeIds = assigneeIds.filter((id) => insiders.has(id.toString()));
  }
  if (assigneeIds.length === 0) return null;

  // Subtask assignees stand on their own (they needn't be task assignees);
  // keep the ones that still exist.
  const subAssigneeIds = parent.subtasks.flatMap((s) => (s.assignee ? [s.assignee] : []));
  const liveSubAssignees = new Set(
    (await User.find({ _id: { $in: subAssigneeIds } }).select("_id").lean()).map((u) => u._id.toString())
  );

  // Keep the milestone only while it is still open.
  const milestone =
    project && parent.milestone
      ? await Milestone.exists({ _id: parent.milestone, project: project._id, status: "incomplete" })
      : null;

  const copy = await Task.create({
    number: await nextTaskNumber(),
    project: project?._id ?? null,
    milestone: milestone ? parent.milestone : null,
    shortCode: project ? await nextShortCode(project._id as mongoose.Types.ObjectId) : null,
    title: parent.title,
    description: parent.description,
    assignees: assigneeIds,
    assignedBy: parent.assignedBy,
    department: parent.department ?? null,
    category: parent.category ?? null,
    labels: parent.labels,
    status: "todo",
    priority: parent.priority,
    startDate: today,
    dueDate,
    estimateMinutes: parent.estimateMinutes ?? null,
    position: Date.now(),
    subtasks: parent.subtasks.map((s) => ({
      title: s.title,
      description: s.description ?? "",
      done: false,
      assignee: s.assignee && liveSubAssignees.has(s.assignee.toString()) ? s.assignee : null,
      dueDate: null,
      completedAt: null,
      createdBy: s.createdBy,
    })),
    recurrence: null,
    recurringParent: parent._id,
  });

  recordTaskHistory(copy._id, null, "created", { recurringParent: parent._id.toString() });
  pushTaskUpdate(copy, "created");
  // A new open task changes task-completion progress.
  if (project) scheduleProgressRecalc(project._id as mongoose.Types.ObjectId);
  await notifyTaskAsync({
    recipients: copy.assignees,
    actor: null,
    type: "task_assigned",
    task: copy,
    title: "Recurring task assigned",
    message: `A new occurrence of "${copy.title}" has been assigned to you.`,
    email: {
      subject: `🔁 Recurring task: ${copy.title}`,
      heading: "Recurring Task Assigned",
      intro: "A new occurrence of a recurring task has been assigned to you.",
    },
  });

  return copy;
}

/**
 * Generates the next occurrence of every recurring task whose `nextRunAt` has
 * passed and whose cycles are not exhausted. Each parent is claimed atomically
 * (by its current `nextRunAt`) so overlapping runs never double-generate.
 */
export async function runRecurringTasks(now: Date = new Date()): Promise<RecurringRunResult> {
  const due = await Task.find({
    recurrence: { $ne: null },
    "recurrence.nextRunAt": { $lte: now },
    $or: [
      { "recurrence.cycles": -1 },
      { $expr: { $lt: ["$recurrence.generated", "$recurrence.cycles"] } },
    ],
  });

  const result: RecurringRunResult = { checked: due.length, generated: 0 };

  for (const parent of due) {
    const recurrence = parent.recurrence;
    if (!recurrence) continue;

    const nextRunAt = nextRunAfter(recurrence.nextRunAt, recurrence.every, recurrence.unit, now);
    const claimed = await Task.findOneAndUpdate(
      { _id: parent._id, "recurrence.nextRunAt": recurrence.nextRunAt },
      { $set: { "recurrence.nextRunAt": nextRunAt }, $inc: { "recurrence.generated": 1 } }
    );
    if (!claimed) continue;

    try {
      const copy = await generateOccurrence(parent, now);
      if (copy) result.generated++;
    } catch (err) {
      console.error("[jobs] Failed to generate recurring task", parent._id.toString(), err);
    }
  }

  return result;
}

/** True when the default mongoose connection is open (jobs skip silently otherwise). */
export function isDbReady(): boolean {
  return mongoose.connection.readyState === 1;
}
