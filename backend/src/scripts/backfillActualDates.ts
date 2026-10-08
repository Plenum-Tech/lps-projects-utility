import "dotenv/config";
import mongoose from "mongoose";
import { connectDB, disconnectDB } from "../db/index.js";
import { IN_PROGRESS_HISTORY } from "../lib/actualDates.js";
import { chunks } from "../lib/worksuite/writer.js";
import { Task } from "../models/Task.js";
import { TaskHistory } from "../models/TaskHistory.js";
import { TimeLog } from "../models/TimeLog.js";

/**
 * Fills Task.actualStartAt / actualEndAt for existing tasks (prompts/task-actual-dates.md).
 *
 *   bun run backfill:actual-dates -- --dry-run          # counts only, nothing written
 *   bun run backfill:actual-dates -- --confirm          # writes
 *
 * - Actual end = completedAt of completed tasks.
 * - Actual start = the first move to in_progress (task history) or the first time
 *   log, whichever came first; Worksuite-imported tasks prefer the history (the
 *   import rule: first move to Doing / In Process, else the earliest time log).
 * - Source "import" for Worksuite tasks, "auto" otherwise.
 * - Idempotent: only empty fields are filled (filters re-check emptiness at write
 *   time), so manual / import / auto values are never changed and a re-run writes nothing.
 * - Prints the target database first; writing requires --confirm.
 */

type Id = mongoose.Types.ObjectId;

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

async function firstByTask(model: mongoose.Model<any>, match: Record<string, unknown>, field: string): Promise<Map<string, Date>> {
  const rows = await model.aggregate<{ _id: Id; first: Date }>([
    { $match: match },
    { $group: { _id: "$task", first: { $min: `$${field}` } } },
  ]);
  return new Map(rows.filter((r) => r._id && r.first).map((r) => [String(r._id), r.first]));
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

  const [totalTasks, candidates, historyStarts, logStarts] = await Promise.all([
    Task.countDocuments({}),
    Task.collection
      .find(
        { $or: [{ actualStartAt: null }, { status: "completed", actualEndAt: null }] },
        { projection: { status: 1, completedAt: 1, actualStartAt: 1, actualEndAt: 1, "legacy.source": 1 } }
      )
      .toArray(),
    firstByTask(TaskHistory, IN_PROGRESS_HISTORY, "createdAt"),
    firstByTask(TimeLog, { task: { $ne: null } }, "startTime"),
  ]);

  const counts = {
    totalTasks,
    candidates: candidates.length,
    startFromHistory: 0,
    startFromTimeLog: 0,
    endFromCompletedAt: 0,
    completedWithoutCompletedAt: 0,
    stillWithoutStart: 0,
  };
  const ops: Array<{ updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> } }> = [];
  for (const t of candidates) {
    const id = String(t._id);
    const source = (t.legacy as { source?: string } | undefined)?.source === "worksuite" ? "import" : "auto";
    let end: Date | null = (t.actualEndAt as Date | null | undefined) ?? null;
    if (t.status === "completed" && !end) {
      const completedAt = (t.completedAt as Date | null | undefined) ?? null;
      if (completedAt) {
        end = completedAt;
        counts.endFromCompletedAt++;
        ops.push({
          updateOne: {
            filter: { _id: t._id, status: "completed", actualEndAt: null },
            update: { $set: { actualEndAt: completedAt, actualEndSource: source } },
          },
        });
      } else {
        counts.completedWithoutCompletedAt++;
      }
    }
    if (t.actualStartAt) continue;
    const fromHistory = historyStarts.get(id) ?? null;
    const fromLog = logStarts.get(id) ?? null;
    let start: Date | null;
    if (source === "import") start = fromHistory ?? fromLog;
    else start = fromHistory && fromLog ? (fromHistory <= fromLog ? fromHistory : fromLog) : (fromHistory ?? fromLog);
    // Never a start after the end (bad legacy data): leave it empty.
    if (start && end && start.getTime() > end.getTime()) start = fromLog && fromLog.getTime() <= end.getTime() ? fromLog : null;
    if (!start) {
      counts.stillWithoutStart++;
      continue;
    }
    if (start === fromHistory) counts.startFromHistory++;
    else counts.startFromTimeLog++;
    ops.push({
      updateOne: {
        filter: { _id: t._id, actualStartAt: null },
        update: { $set: { actualStartAt: start, actualStartSource: source } },
      },
    });
  }

  let modified = 0;
  if (!args.dryRun) {
    for (const batch of chunks(ops)) {
      const result = await Task.collection.bulkWrite(batch as any, { ordered: false });
      modified += result.modifiedCount;
    }
  }

  console.log("");
  console.log(`Tasks in database:                  ${counts.totalTasks}`);
  console.log(`Tasks missing a start or an end:    ${counts.candidates}`);
  console.log(`Actual start from history:          ${counts.startFromHistory}`);
  console.log(`Actual start from first time log:   ${counts.startFromTimeLog}`);
  console.log(`Actual end from completedAt:        ${counts.endFromCompletedAt}`);
  console.log(`Completed without completedAt:      ${counts.completedWithoutCompletedAt}`);
  console.log(`Left without an actual start:       ${counts.stillWithoutStart}`);
  console.log(args.dryRun ? `Writes planned:                     ${ops.length}` : `Fields written:                     ${modified}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) await disconnectDB();
  });
