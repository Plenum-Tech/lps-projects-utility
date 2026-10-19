import "dotenv/config";
import { connectDB, disconnectDB } from "../db/index.js";
import { internalMeetingLabelId, PITCH_STEPS } from "../lib/pitches.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";

/**
 * One-off (Oct 2026): the pitch tasks "Milestone 1" / "Milestone 2" become
 * "Milestone 1 meeting" / "Milestone 2 meeting" and carry the "Internal meeting"
 * label. Only tasks of Pitch projects; idempotent (safe to re-run).
 *
 *   bun src/scripts/renamePitchTasks.ts            → dry run (counts only)
 *   bun src/scripts/renamePitchTasks.ts --apply    → rename + label
 *
 * Uses MONGO_URI — check which database it points at before --apply.
 */
async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  await connectDB();
  const pitchIds = (await Project.find({ "naming.type": /^pitch$/i }).select("_id").lean()).map((p) => p._id);
  console.log(`Pitch projects: ${pitchIds.length}${apply ? "" : " (dry run — pass --apply to change)"}`);

  const label = apply ? await internalMeetingLabelId() : null;
  for (const step of PITCH_STEPS.filter((s) => s.internal)) {
    const old = { project: { $in: pitchIds }, title: { $in: [...step.aliases] } };
    const toRename = await Task.countDocuments(old);
    const unlabelled = await Task.countDocuments({ project: { $in: pitchIds }, title: { $in: [step.title, ...step.aliases] }, ...(label ? { labels: { $ne: label } } : {}) });
    console.log(`${step.aliases.join(" / ")} → ${step.title}: ${toRename} to rename; ${unlabelled} to label`);
    if (!apply || !label) continue;
    const renamed = await Task.updateMany(old, { $set: { title: step.title } });
    const labelled = await Task.updateMany(
      { project: { $in: pitchIds }, title: step.title, labels: { $ne: label } },
      { $addToSet: { labels: label } }
    );
    console.log(`  renamed ${renamed.modifiedCount}, labelled ${labelled.modifiedCount}`);
  }
}

main()
  .then(() => disconnectDB())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("❌ renamePitchTasks failed:", error);
    await disconnectDB().catch(() => undefined);
    process.exit(1);
  });
