import "dotenv/config";
import { connectDB, disconnectDB } from "../db/index.js";
import { runHrReminders } from "../lib/hrJobs.js";
import { flushProgressRecalcs } from "../lib/projectProgress.js";
import mongoose from "mongoose";
import { runPitchMissedReminders } from "../lib/pitches.js";
import { runMonthlyRetainers } from "../lib/retainers.js";
import { runProjectDeadlineReminders, runProjectProgressDeadlineMode } from "../lib/projectJobs.js";
import { runRecurringTasks, runTaskReminders } from "../lib/taskJobs.js";
import { runAutoStopTimers, runDailyTimeLogReport, runTimeTrackerReminder } from "../lib/timeJobs.js";

/**
 * Runs scheduled jobs once, without the Inngest dev server:
 *   bun run jobs:reminders      → task due/overdue reminders
 *   bun run jobs:recurring      → next occurrences of recurring tasks
 *   bun run jobs:time           → auto-stop timers + time-tracker reminder
 *   bun run jobs:projects       → project deadline reminders + deadline-mode progress
 *   bun run jobs:hr             → document expiry + probation/notice/internship reminders
 *   bun src/scripts/runJobs.ts pitches [projectId …] → pitch missed-date emails (optionally only these projects)
 *   bun src/scripts/runJobs.ts daily-report → daily time-log report email
 *   bun src/scripts/runJobs.ts retainers [YYYY-MM] → monthly retainers (plan copy + projects); a month forces that month
 */
const JOBS: Record<string, () => Promise<Record<string, unknown>>> = {
  reminders: async () => ({ reminders: await runTaskReminders(new Date()) }),
  recurring: async () => ({ recurring: await runRecurringTasks(new Date()) }),
  time: async () => ({
    autoStop: await runAutoStopTimers(new Date()),
    trackerReminder: await runTimeTrackerReminder(new Date()),
  }),
  projects: async () => ({
    deadlineReminders: await runProjectDeadlineReminders(new Date()),
    deadlineProgress: await runProjectProgressDeadlineMode(new Date()),
  }),
  "daily-report": async () => ({ dailyReport: await runDailyTimeLogReport(new Date()) }),
  hr: async () => ({ hrReminders: await runHrReminders(new Date()) }),
  retainers: async () => {
    const month = process.argv[3];
    return { retainers: await runMonthlyRetainers(new Date(), month && /^\d{4}-\d{2}$/.test(month) ? { month } : {}) };
  },
  pitches: async () => {
    const ids = process.argv.slice(3).filter((id) => mongoose.isValidObjectId(id));
    const projectIds = ids.length ? ids.map((id) => new mongoose.Types.ObjectId(id)) : undefined;
    return { pitchMissed: await runPitchMissedReminders(new Date(), { projectIds }) };
  },
};

async function main(): Promise<void> {
  const job = process.argv[2] ?? "";
  const run = JOBS[job];
  if (!run) {
    console.error(`Usage: bun src/scripts/runJobs.ts <${Object.keys(JOBS).join("|")}>`);
    process.exit(1);
  }

  await connectDB();
  const result = await run();
  console.log(`✅ ${job}:`, JSON.stringify(result));
  // Let fire-and-forget side effects (SSE/notifications) settle before disconnecting.
  await new Promise((resolve) => setTimeout(resolve, 500));
  await flushProgressRecalcs();
}

main()
  .then(() => disconnectDB())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("❌ Job failed:", error);
    await disconnectDB().catch(() => undefined);
    process.exit(1);
  });
