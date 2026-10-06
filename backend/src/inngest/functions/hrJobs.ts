import { inngest } from "../client.js";

/** Daily at 08:00 IST: document expiry + probation/notice/internship reminders (idempotent keys). */
export const hrRemindersFunction = inngest.createFunction(
  {
    id: "hr-reminders",
    triggers: [{ cron: "TZ=Asia/Kolkata 0 8 * * *" }],
    retries: 2,
  },
  async ({ step }) => {
    return step.run("run-hr-reminders", async () => {
      const { runHrReminders } = await import("../../lib/hrJobs.js");
      return runHrReminders(new Date());
    });
  }
);
