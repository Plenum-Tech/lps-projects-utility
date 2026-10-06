import "dotenv/config";
import { connectDB, disconnectDB } from "../db/index.js";
import { Milestone } from "../models/Milestone.js";
import { Notification } from "../models/Notification.js";
import { Project } from "../models/Project.js";
import { ProjectActivity } from "../models/ProjectActivity.js";
import { ProjectCategory } from "../models/ProjectCategory.js";
import { ProjectFile } from "../models/ProjectFile.js";
import { ProjectNote } from "../models/ProjectNote.js";
import { getProjectSettings, ProjectSettings } from "../models/ProjectSettings.js";
import { ProjectStatus, seedProjectStatuses } from "../models/ProjectStatus.js";
import { Task } from "../models/Task.js";
import { TimeLog } from "../models/TimeLog.js";
import { User } from "../models/User.js";
import { WeeklyTimesheet } from "../models/WeeklyTimesheet.js";

/**
 * Idempotent migration (`bun run migrate:projects`):
 * - seeds the six project statuses and the settings singleton when missing
 * - sets `hourlyRate: 0` / `pinnedProjects: []` on users that lack them
 * - leaves existing tasks without a project (only builds the new indexes)
 */
async function migrate(): Promise<void> {
  await connectDB();

  const created = await seedProjectStatuses();
  console.log(`✅ statuses: ${created} created (${await ProjectStatus.countDocuments()} total)`);

  const hadSettings = await ProjectSettings.countDocuments();
  await getProjectSettings();
  console.log(`✅ settings: ${hadSettings === 0 ? "created" : "already present"}`);

  const rates = await User.updateMany({ hourlyRate: { $exists: false } }, { $set: { hourlyRate: 0 } });
  const pins = await User.updateMany({ pinnedProjects: { $exists: false } }, { $set: { pinnedProjects: [] } });
  console.log(`✅ users: hourlyRate on ${rates.modifiedCount}, pinnedProjects on ${pins.modifiedCount}`);

  for (const model of [Project, ProjectStatus, ProjectCategory, Milestone, ProjectNote, ProjectFile, ProjectActivity, TimeLog, WeeklyTimesheet, Task, Notification]) {
    await (model as unknown as { syncIndexes: () => Promise<unknown> }).syncIndexes();
  }
  console.log("✅ indexes synced");
}

migrate()
  .then(() => disconnectDB())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("❌ Migration failed:", error);
    await disconnectDB().catch(() => undefined);
    process.exit(1);
  });
