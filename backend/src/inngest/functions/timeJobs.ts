import { inngest } from "../client.js";

/** Every 15 minutes: auto-stop timers past `autoStopTimerAt` or at the project hour limit. */
export const autoStopTimersFunction = inngest.createFunction(
  {
    id: "auto-stop-timers",
    triggers: [{ cron: "TZ=Asia/Kolkata */15 * * * *" }],
    retries: 2,
  },
  async ({ step }) => {
    return step.run("run-auto-stop-timers", async () => {
      const { runAutoStopTimers } = await import("../../lib/timeJobs.js");
      return runAutoStopTimers(new Date());
    });
  }
);

/** Every 15 minutes: once-a-day "no time logged today" reminder after `trackerReminderAt`. */
export const timeTrackerReminderFunction = inngest.createFunction(
  {
    id: "time-tracker-reminder",
    triggers: [{ cron: "TZ=Asia/Kolkata */15 * * * *" }],
    retries: 2,
  },
  async ({ step }) => {
    return step.run("run-time-tracker-reminder", async () => {
      const { runTimeTrackerReminder } = await import("../../lib/timeJobs.js");
      return runTimeTrackerReminder(new Date());
    });
  }
);

/** Daily at 19:30 IST: per-department time-log summary email to heads and admins. */
export const dailyTimeLogReportFunction = inngest.createFunction(
  {
    id: "daily-time-log-report",
    triggers: [{ cron: "TZ=Asia/Kolkata 30 19 * * *" }],
    retries: 2,
  },
  async ({ step }) => {
    return step.run("run-daily-time-log-report", async () => {
      const { runDailyTimeLogReport } = await import("../../lib/timeJobs.js");
      return runDailyTimeLogReport(new Date());
    });
  }
);
