import { inngest } from "../client.js";

/**
 * Daily at 00:30 IST: generates the next occurrence of due recurring tasks.
 * Each parent is claimed atomically, so retries never double-generate.
 */
export const recurringTasksFunction = inngest.createFunction(
  {
    id: "recurring-tasks",
    triggers: [{ cron: "TZ=Asia/Kolkata 30 0 * * *" }],
    retries: 2,
  },
  async ({ step }) => {
    return step.run("run-recurring-tasks", async () => {
      const { runRecurringTasks } = await import("../../lib/taskJobs.js");
      return runRecurringTasks(new Date());
    });
  }
);
