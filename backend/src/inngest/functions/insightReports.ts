import { inngest } from "../client.js";

/** Every 15 minutes: Leadership Insights board reports whose schedule is due. */
export const insightReportsFunction = inngest.createFunction(
  {
    id: "insight-reports",
    triggers: [{ cron: "TZ=Asia/Dubai */15 * * * *" }],
    retries: 2,
  },
  async ({ step }) => {
    return step.run("run-insight-reports", async () => {
      const { runDueInsightReports } = await import("../../lib/insights/reports.js");
      return runDueInsightReports(new Date());
    });
  }
);
