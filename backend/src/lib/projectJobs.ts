import type mongoose from "mongoose";
import { Project } from "../models/Project.js";
import { getProjectSettings } from "../models/ProjectSettings.js";
import { completedStatusIds } from "../models/ProjectStatus.js";
import { User } from "../models/User.js";
import { addDays, appDateKey, appToday } from "./appTime.js";
import { formatDueDate, notifyUsersAsync } from "./notifications.js";
import { projectLink } from "./projectAccess.js";
import { recalcProjectProgress } from "./projectProgress.js";

// ---------------------------------------------------------------------------
// Project jobs (Inngest cron + `bun run jobs:projects` + dev interval).
// Date-only comparisons in APP_TIMEZONE; `lastDeadlineReminderOn` is the
// per-project idempotency key.
// ---------------------------------------------------------------------------

export interface DeadlineReminderResult {
  date: string;
  skipped?: string;
  checked: number;
  reminded: number;
}

/** Projects whose deadline is exactly today + N days get `project_deadline` (once per day). */
export async function runProjectDeadlineReminders(now: Date = new Date()): Promise<DeadlineReminderResult> {
  const settings = await getProjectSettings();
  const todayKey = appDateKey(now);
  const result: DeadlineReminderResult = { date: todayKey, checked: 0, reminded: 0 };
  const days = settings.deadlineReminderDays;
  if (!days || days <= 0) return { ...result, skipped: "deadlineReminderDays is 0" };
  if (settings.deadlineReminderTo.length === 0) return { ...result, skipped: "deadlineReminderTo is empty" };

  const target = addDays(appToday(now), days);
  const projects = await Project.find({
    archivedAt: null,
    deadline: target,
    status: { $nin: await completedStatusIds() },
  });
  result.checked = projects.length;
  const admins = settings.deadlineReminderTo.includes("admins")
    ? (await User.find({ role: "admin" }).select("_id").lean()).map((a) => a._id)
    : [];

  for (const project of projects) {
    const claimed = await Project.findOneAndUpdate(
      { _id: project._id, lastDeadlineReminderOn: { $ne: todayKey } },
      { $set: { lastDeadlineReminderOn: todayKey } }
    );
    if (!claimed) continue;

    const recipients: mongoose.Types.ObjectId[] = [...admins];
    if (settings.deadlineReminderTo.includes("manager") && project.manager) recipients.push(project.manager);
    if (settings.deadlineReminderTo.includes("members")) recipients.push(...project.members.map((m) => m.user));
    const projectId = project._id as mongoose.Types.ObjectId;
    const deadline = formatDueDate(project.deadline ?? null) ?? "";
    await notifyUsersAsync({
      recipients,
      actor: null,
      type: "project_deadline",
      title: "Project deadline approaching",
      message: `${project.code} · ${project.name} is due in ${days} day(s) (${deadline}).`,
      link: projectLink(projectId),
      project: projectId,
      email: {
        subject: `⏰ ${project.name} is due in ${days} day(s)`,
        heading: "Project Deadline Approaching",
        intro: `This project's deadline is ${days} day(s) away.`,
        cardTitle: `${project.code} · ${project.name}`,
        rows: [
          ["Deadline", deadline],
          ["Progress", `${project.progress}%`],
        ],
        buttonLabel: "Open Project",
      },
    });
    result.reminded++;
  }
  return result;
}

export interface ProgressRunResult {
  checked: number;
  updated: number;
}

/** Nightly: recalculates `deadline`-mode progress (it moves with the calendar). */
export async function runProjectProgressDeadlineMode(now: Date = new Date()): Promise<ProgressRunResult> {
  const projects = await Project.find({ progressMode: "deadline", archivedAt: null }).select("_id progress");
  const result: ProgressRunResult = { checked: projects.length, updated: 0 };
  for (const project of projects) {
    const next = await recalcProjectProgress(project._id as mongoose.Types.ObjectId, now);
    if (next !== null && next !== project.progress) result.updated++;
  }
  return result;
}
