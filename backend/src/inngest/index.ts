import { inngest } from "./client.js";
import { generateInsightFunction } from "./functions/generateInsight.js";
import { generateReviewFunction } from "./functions/generateReview.js";
import { hrRemindersFunction } from "./functions/hrJobs.js";
import {
  pitchMissedDatesFunction,
  projectDeadlineRemindersFunction,
  projectProgressDeadlineModeFunction,
} from "./functions/projectJobs.js";
import { recurringTasksFunction } from "./functions/recurringTasks.js";
import { taskRemindersFunction } from "./functions/taskReminders.js";
import {
  autoStopTimersFunction,
  dailyTimeLogReportFunction,
  timeTrackerReminderFunction,
} from "./functions/timeJobs.js";

// Re-export the client for use elsewhere (e.g. controllers)
export { inngest };

// All Inngest functions
export const functions = [
  generateReviewFunction,
  generateInsightFunction,
  taskRemindersFunction,
  recurringTasksFunction,
  projectDeadlineRemindersFunction,
  projectProgressDeadlineModeFunction,
  pitchMissedDatesFunction,
  autoStopTimersFunction,
  timeTrackerReminderFunction,
  dailyTimeLogReportFunction,
  hrRemindersFunction,
];
