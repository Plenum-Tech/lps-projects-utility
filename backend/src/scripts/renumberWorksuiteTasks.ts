import "dotenv/config";
import type mongoose from "mongoose";
import { connectDB, disconnectDB } from "../db/index.js";
import { Counter, TASK_NUMBER_COUNTER } from "../models/Counter.js";
import { Task } from "../models/Task.js";

type Row = { _id: mongoose.Types.ObjectId; number?: number | null; legacy?: { id: number } };

const BATCH = 500;
/** Temporary offset that keeps numbers unique while they move (unique index on `number`). */
const TEMP_OFFSET = 10_000_000;

/**
 * `bun run renumber:worksuite [--dry-run]`
 *
 * Makes every imported task's number equal to its Worksuite task id, so the
 * numbers people already know (and Pearity's taskNo) match. Tasks created in
 * the app keep their relative order but move above the highest Worksuite id
 * when their number would collide. The `task` counter is raised to the highest
 * number in use, so new tasks keep auto-incrementing from there.
 *
 * Idempotent and safe to re-run; run it while nobody is creating tasks.
 */
async function run(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  await connectDB();

  const imported = await Task.find({ "legacy.table": "tasks" }).select("_id number legacy.id").lean<Row[]>();
  const appMade = await Task.find({ "legacy.table": { $ne: "tasks" } })
    .sort({ number: 1, createdAt: 1 })
    .select("_id number")
    .lean<Row[]>();
  const legacyIds = new Set(imported.map((t) => t.legacy!.id));
  const maxLegacy = Math.max(0, ...legacyIds);
  const toFix = imported.filter((t) => t.number !== t.legacy!.id);
  const collisions = appMade.filter((t) => typeof t.number === "number" && legacyIds.has(t.number));

  console.log(
    `tasks: ${imported.length} imported (${toFix.length} to renumber, Worksuite ids up to ${maxLegacy}), ` +
      `${appMade.length} app-created (${collisions.length} colliding)`
  );
  if (dryRun) {
    console.log("dry run — nothing written");
    return;
  }
  if (toFix.length === 0 && collisions.length === 0) {
    await raiseCounter();
    console.log("nothing to renumber");
    return;
  }

  // 1. App-created tasks that collide move above every Worksuite id (and above any
  //    app number already up there), keeping their order.
  const taken = new Set(appMade.map((t) => t.number).filter((n): n is number => typeof n === "number"));
  let next = Math.max(maxLegacy, ...taken) + 1;
  for (const t of collisions) {
    await Task.updateOne({ _id: t._id as mongoose.Types.ObjectId, number: t.number }, { $set: { number: next } });
    console.log(`  app task #${t.number} → #${next}`);
    next++;
  }

  // 2. Imported tasks: park on a temporary number, then land on the Worksuite id.
  for (let i = 0; i < toFix.length; i += BATCH) {
    const slice = toFix.slice(i, i + BATCH);
    await Task.bulkWrite(
      slice.map((t) => ({
        updateOne: { filter: { _id: t._id }, update: { $set: { number: TEMP_OFFSET + t.legacy!.id } } },
      })),
      { ordered: false }
    );
  }
  let landed = 0;
  for (let i = 0; i < toFix.length; i += BATCH) {
    const slice = toFix.slice(i, i + BATCH);
    const result = await Task.bulkWrite(
      slice.map((t) => ({
        updateOne: { filter: { _id: t._id }, update: { $set: { number: t.legacy!.id } } },
      })),
      { ordered: false }
    );
    landed += result.modifiedCount;
  }
  console.log(`✅ ${landed} imported task(s) now carry their Worksuite id as task number`);

  const parked = await Task.countDocuments({ number: { $gte: TEMP_OFFSET } });
  if (parked > 0) throw new Error(`${parked} task(s) still on a temporary number — re-run to finish`);

  await raiseCounter();
}

async function raiseCounter(): Promise<void> {
  const highest = await Task.findOne({ number: { $ne: null } }).sort({ number: -1 }).select("number").lean();
  if (highest?.number) {
    await Counter.updateOne({ _id: TASK_NUMBER_COUNTER }, { $max: { seq: highest.number } }, { upsert: true });
  }
  const counter = await Counter.findById(TASK_NUMBER_COUNTER).lean();
  console.log(`✅ counter "${TASK_NUMBER_COUNTER}": seq = ${counter?.seq ?? 0} (next new task gets #${(counter?.seq ?? 0) + 1})`);
}

run()
  .then(() => disconnectDB())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("❌ Renumbering failed:", error);
    await disconnectDB().catch(() => undefined);
    process.exit(1);
  });
