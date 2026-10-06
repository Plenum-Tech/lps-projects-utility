import "dotenv/config";
import type mongoose from "mongoose";
import { connectDB, disconnectDB } from "../db/index.js";
import { employeeIdNumber, ensureEmployeeCounter, formatEmployeeId } from "../lib/employeeIds.js";
import { Counter, EMPLOYEE_ID_COUNTER } from "../models/Counter.js";
import { EmployeeDocument } from "../models/EmployeeDocument.js";
import { User } from "../models/User.js";

const BATCH = 500;

/**
 * Idempotent migration for HR profile fields (`bun run migrate:hr`):
 * - creates the `counters.employee` sequence (reserving one slot per user without an ID)
 * - backfills `employeeId` ("EMP-0001"...) in `createdAt` order, skipping IDs in use
 *   and never touching a user who already has one
 * - raises the counter to the highest EMP-number in use
 * - defaults: designation "", HR dates null, lastHrReminderKeys [], emailPreferences.hrReminders true
 * - builds the new indexes (createIndexes — never drops existing ones)
 * Safe to re-run, and safe while the API is running.
 */
async function migrate(): Promise<void> {
  await connectDB();

  // 1. Counter first, so users created meanwhile get IDs above the backfill range.
  const counterExisted = Boolean(await Counter.exists({ _id: EMPLOYEE_ID_COUNTER }));
  await ensureEmployeeCounter();
  const reservedSeq = (await Counter.findById(EMPLOYEE_ID_COUNTER).lean())?.seq ?? 0;

  // 2. Backfill in createdAt order.
  const missingFilter = { $or: [{ employeeId: { $exists: false } }, { employeeId: null }, { employeeId: "" }] };
  const used = new Set<number>();
  const usedIds = new Set<string>();
  for (const u of await User.find({ employeeId: { $type: "string", $ne: "" } }).select("employeeId").lean()) {
    usedIds.add(u.employeeId as string);
    const n = employeeIdNumber(u.employeeId);
    if (n !== null) used.add(n);
  }
  const pending = await User.find(missingFilter).sort({ createdAt: 1, _id: 1 }).select("_id").lean();
  let next = 1;
  let assigned = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const ops = pending.slice(i, i + BATCH).map((u) => {
      while (used.has(next) || usedIds.has(formatEmployeeId(next))) next++;
      const value = next++;
      used.add(value);
      return {
        updateOne: {
          // Guard: only users still without an ID (concurrent runs / creations).
          filter: { _id: u._id as mongoose.Types.ObjectId, ...missingFilter },
          update: { $set: { employeeId: formatEmployeeId(value) } },
        },
      };
    });
    const result = await User.bulkWrite(ops, { ordered: false });
    assigned += result.modifiedCount;
  }
  console.log(`✅ employee IDs: ${assigned} backfilled (${pending.length} were missing)`);

  // 3. Counter >= highest EMP-number in use.
  const highest = (await User.find({ employeeId: { $regex: /^EMP-\d+$/ } }).select("employeeId").lean()).reduce(
    (max, u) => Math.max(max, employeeIdNumber(u.employeeId) ?? 0),
    0
  );
  if (highest > 0) {
    await Counter.updateOne({ _id: EMPLOYEE_ID_COUNTER }, { $max: { seq: highest } }, { upsert: true });
    // Counter created by this run and untouched since: drop the unused reserved slots
    // (conditional on `seq`, so an ID claimed meanwhile is never handed out twice).
    if (!counterExisted && highest < reservedSeq) {
      await Counter.updateOne({ _id: EMPLOYEE_ID_COUNTER, seq: reservedSeq }, { $set: { seq: highest } });
    }
  }
  const counter = await Counter.findById(EMPLOYEE_ID_COUNTER).lean();
  console.log(`✅ counter "${EMPLOYEE_ID_COUNTER}": seq = ${counter?.seq ?? 0}`);

  // 4. Defaults for the new fields (only where missing).
  let defaults = 0;
  const setters: Array<[string, unknown]> = [
    ["designation", ""],
    ["dateOfBirth", null],
    ["joiningDate", null],
    ["probationEndDate", null],
    ["internshipEndDate", null],
    ["noticePeriodStart", null],
    ["noticePeriodEnd", null],
    ["lastHrReminderKeys", []],
    ["emailPreferences.hrReminders", true],
  ];
  for (const [field, value] of setters) {
    const r = await User.updateMany({ [field]: { $exists: false } }, { $set: { [field]: value } });
    defaults += r.modifiedCount;
  }
  console.log(`✅ users: ${defaults} default field values set`);

  // 5. Indexes (unique employeeId, HR date lookups, documents). Never drops anything.
  await Promise.all([User.createIndexes(), EmployeeDocument.createIndexes(), Counter.createIndexes()]);
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
