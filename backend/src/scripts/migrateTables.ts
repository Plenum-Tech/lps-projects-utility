import "dotenv/config";
import type mongoose from "mongoose";
import { connectDB, disconnectDB } from "../db/index.js";
import { ensureTaskCounter } from "../lib/taskNumbers.js";
import { Counter, TASK_NUMBER_COUNTER } from "../models/Counter.js";
import { Task } from "../models/Task.js";
import { User } from "../models/User.js";

const BATCH = 500;

/**
 * Idempotent migration for the Worksuite-style tables (`bun run migrate:tables`):
 * - creates the `counters.task` sequence (reserving one slot per un-numbered task)
 * - backfills `Task.number` 1..N in `createdAt` order, skipping numbers already
 *   handed out, and never touching a task that already has a number
 * - raises the counter to the highest number in use
 * - `pinnedTasks: []` / `estimateMinutes: null` where missing
 * - builds the new indexes (createIndexes — never drops existing ones)
 * Safe to re-run, and safe while the API is running (new tasks always claim
 * numbers above the reserved range).
 */
async function migrate(): Promise<void> {
  await connectDB();

  // 1. Counter first, so tasks created meanwhile get numbers above the backfill range.
  const counterExisted = Boolean(await Counter.exists({ _id: TASK_NUMBER_COUNTER }));
  await ensureTaskCounter();
  const reservedSeq = (await Counter.findById(TASK_NUMBER_COUNTER).lean())?.seq ?? 0;

  // 2. Backfill numbers in createdAt order.
  const used = new Set<number>(
    (await Task.find({ number: { $ne: null } }).select("number").lean()).map((t) => t.number as number)
  );
  const pending = await Task.find({ number: null }).sort({ createdAt: 1, _id: 1 }).select("_id").lean();
  let next = 1;
  let assigned = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const ops = pending.slice(i, i + BATCH).map((t) => {
      while (used.has(next)) next++;
      const value = next++;
      used.add(value);
      return {
        updateOne: {
          // Guard: only tasks still without a number (concurrent runs / creations).
          filter: { _id: t._id as mongoose.Types.ObjectId, number: null },
          update: { $set: { number: value } },
        },
      };
    });
    const result = await Task.bulkWrite(ops, { ordered: false });
    assigned += result.modifiedCount;
  }
  console.log(`✅ task numbers: ${assigned} backfilled (${pending.length} were missing)`);

  // 3. Counter ≥ highest number in use.
  const highest = await Task.findOne({ number: { $ne: null } }).sort({ number: -1 }).select("number").lean();
  if (highest?.number) {
    await Counter.updateOne({ _id: TASK_NUMBER_COUNTER }, { $max: { seq: highest.number } }, { upsert: true });
    // Counter created by this run and untouched since: drop the unused reserved slots
    // (conditional on `seq`, so a number claimed meanwhile is never handed out twice).
    if (!counterExisted && highest.number < reservedSeq) {
      await Counter.updateOne({ _id: TASK_NUMBER_COUNTER, seq: reservedSeq }, { $set: { seq: highest.number } });
    }
  }
  const counter = await Counter.findById(TASK_NUMBER_COUNTER).lean();
  console.log(`✅ counter "${TASK_NUMBER_COUNTER}": seq = ${counter?.seq ?? 0}`);

  // 4. Defaults for the new fields.
  const pins = await User.updateMany({ pinnedTasks: { $exists: false } }, { $set: { pinnedTasks: [] } });
  const estimates = await Task.updateMany({ estimateMinutes: { $exists: false } }, { $set: { estimateMinutes: null } });
  console.log(`✅ users: pinnedTasks on ${pins.modifiedCount}; tasks: estimateMinutes on ${estimates.modifiedCount}`);

  // 5. Indexes (unique number index, calendar, recurring copies). Never drops anything.
  await Promise.all([Task.createIndexes(), User.createIndexes(), Counter.createIndexes()]);
  console.log("✅ indexes ensured");
}

migrate()
  .then(() => disconnectDB())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("❌ Migration failed:", error);
    await disconnectDB().catch(() => undefined);
    process.exit(1);
  });
