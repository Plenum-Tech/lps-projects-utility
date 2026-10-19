import { inngest } from "../client.js";

/** Daily at 08:00 IST: `project_deadline` reminders (idempotent per project per day). */
export const projectDeadlineRemindersFunction = inngest.createFunction(
  {
    id: "project-deadline-reminders",
    triggers: [{ cron: "TZ=Asia/Kolkata 0 8 * * *" }],
    retries: 2,
  },
  async ({ step }) => {
    return step.run("run-project-deadline-reminders", async () => {
      const { runProjectDeadlineReminders } = await import("../../lib/projectJobs.js");
      return runProjectDeadlineReminders(new Date());
    });
  }
);

/** Hourly: pitch steps past their due date and not done (one email per step per due date). */
export const pitchMissedDatesFunction = inngest.createFunction(
  {
    id: "pitch-missed-dates",
    triggers: [{ cron: "TZ=Asia/Dubai 5 * * * *" }],
    retries: 2,
  },
  async ({ step }) => {
    return step.run("run-pitch-missed-dates", async () => {
      const { runPitchMissedReminders } = await import("../../lib/pitches.js");
      return runPitchMissedReminders(new Date());
    });
  }
);

/** Daily at 00:15 IST: recalculates `deadline`-mode project progress. */
export const projectProgressDeadlineModeFunction = inngest.createFunction(
  {
    id: "project-progress-deadline-mode",
    triggers: [{ cron: "TZ=Asia/Kolkata 15 0 * * *" }],
    retries: 2,
  },
  async ({ step }) => {
    return step.run("run-project-progress-deadline-mode", async () => {
      const { runProjectProgressDeadlineMode } = await import("../../lib/projectJobs.js");
      return runProjectProgressDeadlineMode(new Date());
    });
  }
);
