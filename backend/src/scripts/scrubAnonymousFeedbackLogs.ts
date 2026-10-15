import "dotenv/config";
import mongoose from "mongoose";
import { connectDB, disconnectDB } from "../db/index.js";
import { ActivityLog } from "../models/ActivityLog.js";
import { Feedback } from "../models/Feedback.js";

/**
 * Removes the author's identity from existing "feedback_created" activity-log
 * entries of anonymous feedback (they were logged with the author's id, name,
 * email, role, IP and the feedback id).
 *
 *   bun run scrub:anonymous-feedback-logs -- --dry-run   # counts only, nothing written
 *   bun run scrub:anonymous-feedback-logs -- --confirm   # writes
 *
 * - An entry is anonymous when its details say so, or its feedback id belongs
 *   to anonymous feedback.
 * - Each one ends up like the entries logged now: actorName "Anonymous", no
 *   actor or feedback id, and no email, role or IP. Category and the anonymous
 *   flag in the details stay, so the log still shows the submission.
 * - Idempotent: only entries still carrying an identifying field are matched,
 *   so a re-run writes nothing.
 * - Prints the target database first; writing requires --confirm.
 */

interface Args {
  dryRun: boolean;
  confirm: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, confirm: false };
  for (const a of argv) {
    if (a === "--") continue;
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--confirm") args.confirm = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dryRun && !args.confirm) {
    console.error("Refusing to write without --confirm (use --dry-run to preview the counts).");
    process.exitCode = 2;
    return;
  }
  await connectDB();
  const conn = mongoose.connection;
  console.log(`Target database: "${conn.name}" on ${conn.host}:${conn.port}${args.dryRun ? " (DRY RUN — nothing is written)" : ""}`);

  const anonymousFeedbackIds = await Feedback.find({ isAnonymous: true }).distinct("_id");
  const anonymousEntries: Record<string, unknown> = {
    action: "feedback_created",
    $or: [{ "details.isAnonymous": true }, { targetId: { $in: anonymousFeedbackIds } }],
  };
  const stillIdentifying: Record<string, unknown> = {
    $or: [
      { actor: { $ne: null } },
      { targetId: { $ne: null } },
      { actorEmail: { $exists: true } },
      { actorRole: { $exists: true } },
      { ip: { $exists: true } },
      { actorName: { $ne: "Anonymous" } },
    ],
  };
  const filter = { $and: [anonymousEntries, stillIdentifying] };

  const [created, anonymous, toScrub] = await Promise.all([
    ActivityLog.countDocuments({ action: "feedback_created" }),
    ActivityLog.countDocuments(anonymousEntries),
    ActivityLog.countDocuments(filter),
  ]);

  let modified = 0;
  if (!args.dryRun && toScrub > 0) {
    const result = await ActivityLog.updateMany(filter, {
      $set: { actor: null, targetId: null, actorName: "Anonymous" },
      $unset: { actorEmail: "", actorRole: "", ip: "" },
    });
    modified = result.modifiedCount;
  }

  console.log("");
  console.log(`Anonymous feedback in database:          ${anonymousFeedbackIds.length}`);
  console.log(`"Submitted feedback" log entries:        ${created}`);
  console.log(`  of anonymous feedback:                 ${anonymous}`);
  console.log(`  still identifying the author:          ${toScrub}`);
  console.log(args.dryRun ? `Entries to scrub:                        ${toScrub}` : `Entries scrubbed:                        ${modified}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) await disconnectDB();
  });
