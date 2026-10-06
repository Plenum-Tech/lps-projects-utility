import type mongoose from "mongoose";
import { Department } from "../models/Department.js";
import { Leave } from "../models/Leave.js";
import { Project } from "../models/Project.js";
import { getProjectSettings, ProjectSettings } from "../models/ProjectSettings.js";
import { TimeLog } from "../models/TimeLog.js";
import { User } from "../models/User.js";
import {
  addDays,
  appDateKey,
  appDayStart,
  appMinutesOfDay,
  appTimeOn,
  appToday,
  isAppWeekend,
  parseHhmm,
} from "./appTime.js";
import { sendBatchEmails, tableEmailTemplate } from "./email.js";
import { firstNameOf, notifyUsersAsync } from "./notifications.js";
import { computeDurations, formatMinutes, remainingProjectMinutes, stopTimer, TIMELOGS_LINK } from "./timeLogs.js";

// ---------------------------------------------------------------------------
// Time-tracking jobs (Inngest cron + `bun run jobs:time` + dev interval).
// Every job is idempotent: stopping is atomic on `endTime: null`, reminders
// claim a per-user / per-settings "YYYY-MM-DD" key before sending.
// ---------------------------------------------------------------------------

/** First occurrence of "HH:mm" (app timezone) strictly after `start`. */
function nextCutoffAfter(start: Date, hhmm: string): Date {
  const startKey = appDateKey(start);
  let cutoff = appTimeOn(startKey, hhmm);
  if (cutoff.getTime() <= start.getTime()) {
    const next = addDays(new Date(`${startKey}T00:00:00.000Z`), 1).toISOString().slice(0, 10);
    cutoff = appTimeOn(next, hhmm);
  }
  return cutoff;
}

export interface AutoStopResult {
  checked: number;
  stopped: number;
  limitStopped: number;
}

/**
 * Stops timers still running past `autoStopTimerAt` (end = the configured time,
 * not now) and timers that reached their project's hour limit in `total_time`
 * mode (end = the moment the limit was reached).
 */
export async function runAutoStopTimers(now: Date = new Date()): Promise<AutoStopResult> {
  const settings = await getProjectSettings();
  const running = await TimeLog.find({ endTime: null });
  const result: AutoStopResult = { checked: running.length, stopped: 0, limitStopped: 0 };

  for (const log of running) {
    let end: Date | null = null;
    let byLimit = false;

    if (settings.autoStopTimerAt) {
      const cutoff = nextCutoffAfter(log.startTime, settings.autoStopTimerAt);
      if (cutoff.getTime() <= now.getTime()) end = cutoff;
    }

    if (log.project) {
      const project = await Project.findById(log.project);
      const remaining = await remainingProjectMinutes(project);
      if (remaining !== null) {
        const worked = computeDurations(log.startTime, now, log.breaks).durationMinutes;
        if (worked >= remaining) {
          const limitEnd = new Date(now.getTime() - (worked - remaining) * 60_000);
          if (!end || limitEnd.getTime() < end.getTime()) {
            end = limitEnd;
            byLimit = true;
          }
        }
      }
    }

    if (!end) continue;
    const stopped = await stopTimer(log, end, { autoStopped: true });
    if (!stopped) continue;
    if (byLimit) result.limitStopped++;
    else result.stopped++;

    const project = stopped.project ? await Project.findById(stopped.project).select("name code").lean() : null;
    const what = project ? `${project.code} · ${project.name}` : "your task";
    const reason = byLimit
      ? "the project's allocated hours were reached"
      : `it was still running at ${settings.autoStopTimerAt}`;
    await notifyUsersAsync({
      recipients: [stopped.user],
      actor: null,
      type: "timer_auto_stopped",
      title: "Timer stopped automatically",
      message: `Your timer on ${what} was stopped because ${reason}. Logged ${formatMinutes(stopped.durationMinutes)}.`,
      link: TIMELOGS_LINK,
      project: stopped.project ?? null,
      email: {
        subject: "⏹️ Your timer was stopped automatically",
        heading: "Timer Stopped Automatically",
        intro: `Your timer was stopped because ${reason}. Please review the entry.`,
        cardTitle: what,
        rows: [["Logged", formatMinutes(stopped.durationMinutes)]],
        buttonLabel: "Review Time Logs",
      },
    });
  }
  return result;
}

export interface TrackerReminderResult {
  date: string;
  skipped?: string;
  candidates: number;
  reminded: number;
}

/**
 * Once per day per user after `trackerReminderAt`: reminds employees and heads
 * with no time log today. Skips weekends and users on approved leave.
 */
export async function runTimeTrackerReminder(now: Date = new Date()): Promise<TrackerReminderResult> {
  const settings = await getProjectSettings();
  const todayKey = appDateKey(now);
  const result: TrackerReminderResult = { date: todayKey, candidates: 0, reminded: 0 };
  const at = parseHhmm(settings.trackerReminderAt);
  if (at === null) return { ...result, skipped: "trackerReminderAt is not set" };
  if (appMinutesOfDay(now) < at) return { ...result, skipped: `before ${settings.trackerReminderAt}` };
  if (isAppWeekend(now)) return { ...result, skipped: "weekend" };

  const today = appToday(now);
  const dayStart = appDayStart(todayKey);
  const dayEnd = appDayStart(addDays(today, 1));
  const [onLeave, withLogs] = await Promise.all([
    Leave.distinct("user", { status: "approved", startDate: { $lte: today }, endDate: { $gte: today } }),
    TimeLog.distinct("user", { $or: [{ startTime: { $gte: dayStart, $lt: dayEnd } }, { endTime: null }] }),
  ]);
  const exclude = [...onLeave, ...withLogs] as mongoose.Types.ObjectId[];
  const candidates = await User.find({
    role: { $in: ["employee", "head"] },
    _id: { $nin: exclude },
    lastTrackerReminderOn: { $ne: todayKey },
  }).select("_id");
  result.candidates = candidates.length;

  for (const candidate of candidates) {
    const claimed = await User.findOneAndUpdate(
      { _id: candidate._id, lastTrackerReminderOn: { $ne: todayKey } },
      { $set: { lastTrackerReminderOn: todayKey } }
    );
    if (!claimed) continue;
    await notifyUsersAsync({
      recipients: [candidate._id],
      actor: null,
      type: "time_tracker_reminder",
      title: "No time logged today",
      message: "You haven't logged any time today. Start a timer or add a manual entry.",
      link: TIMELOGS_LINK,
      email: {
        subject: "⏱️ Reminder: log your time for today",
        heading: "Log Your Time",
        intro: "You haven't logged any time today. Start a timer or add a manual entry before you finish.",
        buttonLabel: "Log Time",
      },
    });
    result.reminded++;
  }
  return result;
}

export interface DailyReportResult {
  date: string;
  skipped?: string;
  departments: number;
  emails: number;
}

/**
 * Email-only daily summary (per department) to its heads and every admin.
 * Idempotent via `ProjectSettings.lastDailyReportOn`.
 */
export async function runDailyTimeLogReport(now: Date = new Date()): Promise<DailyReportResult> {
  const settings = await getProjectSettings();
  const todayKey = appDateKey(now);
  const result: DailyReportResult = { date: todayKey, departments: 0, emails: 0 };
  if (!settings.dailyTimeLogReport) return { ...result, skipped: "dailyTimeLogReport is off" };

  const claimed = await ProjectSettings.findOneAndUpdate(
    { _id: settings._id, lastDailyReportOn: { $ne: todayKey } },
    { $set: { lastDailyReportOn: todayKey } }
  );
  if (!claimed) return { ...result, skipped: "already sent today" };

  const dayStart = appDayStart(todayKey);
  const dayEnd = appDayStart(addDays(appToday(now), 1));
  const rows = await TimeLog.aggregate<{ _id: mongoose.Types.ObjectId; minutes: number; count: number; pending: number }>([
    { $match: { startTime: { $gte: dayStart, $lt: dayEnd }, endTime: { $ne: null }, status: { $in: ["pending", "approved"] } } },
    {
      $group: {
        _id: "$user",
        minutes: { $sum: "$durationMinutes" },
        count: { $sum: 1 },
        pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
      },
    },
  ]);
  const byUser = new Map(rows.map((r) => [r._id.toString(), r]));
  const [departments, people, admins] = await Promise.all([
    Department.find().select("name").lean(),
    User.find({ role: { $in: ["employee", "head"] } }).select("name department").sort({ name: 1 }).lean(),
    User.find({ role: "admin" }).select("name email emailPreferences").lean(),
  ]);

  const groups = new Map<string, { name: string; departmentId: mongoose.Types.ObjectId | null; members: typeof people }>();
  for (const d of departments) groups.set(d._id.toString(), { name: d.name, departmentId: d._id, members: [] });
  for (const p of people) {
    const key = p.department ? p.department.toString() : "none";
    if (!groups.has(key)) groups.set(key, { name: "No department", departmentId: null, members: [] });
    groups.get(key)!.members.push(p);
  }

  const emails = [];
  for (const group of groups.values()) {
    if (group.members.length === 0) continue;
    result.departments++;
    const tableRows = group.members.map((m) => {
      const r = byUser.get(m._id.toString());
      return [m.name, formatMinutes(r?.minutes ?? 0), String(r?.count ?? 0), String(r?.pending ?? 0)];
    });
    const total = group.members.reduce((sum, m) => sum + (byUser.get(m._id.toString())?.minutes ?? 0), 0);
    const heads = group.departmentId
      ? await User.find({ role: "head", department: group.departmentId }).select("name email emailPreferences").lean()
      : [];
    for (const recipient of [...heads, ...admins]) {
      if (!recipient.email || recipient.emailPreferences?.timeLogs === false) continue;
      emails.push({
        to: recipient.email,
        subject: `📊 Daily time report: ${group.name} (${todayKey})`,
        html: tableEmailTemplate({
          firstName: firstNameOf(recipient.name),
          heading: `Daily Time Report: ${group.name}`,
          intro: `Time logged on ${todayKey}: ${formatMinutes(total)} in total.`,
          columns: ["Employee", "Logged", "Entries", "Pending"],
          rows: tableRows,
          path: "/reports/time",
          buttonLabel: "Open Time Log Report",
        }),
      });
    }
  }
  result.emails = emails.length;
  await sendBatchEmails(emails);
  return result;
}
