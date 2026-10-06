import { inngest } from "../client.js";

/**
 * Daily at 08:00 IST: due-soon / due-today reminders and overdue notices.
 * Idempotent per task per day (see runTaskReminders).
 */
export const taskRemindersFunction = inngest.createFunction(
  {
    id: "task-reminders",
    triggers: [{ cron: "TZ=Asia/Kolkata 0 8 * * *" }],
    retries: 2,
  },
  async ({ step }) => {
    return step.run("run-task-reminders", async () => {
      const { runTaskReminders } = await import("../../lib/taskJobs.js");
      return runTaskReminders(new Date());
    });
  }
);
