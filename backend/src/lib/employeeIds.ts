import mongoose from "mongoose";
import { isDuplicateKeyError } from "./errors.js";
import { Counter, EMPLOYEE_ID_COUNTER } from "../models/Counter.js";

// ---------------------------------------------------------------------------
// Employee IDs: "EMP-0001", claimed atomically from `counters.employee`.
// The User model's pre-save hook assigns one to every new user created without
// an ID; `bun run migrate:hr` backfills existing users in `createdAt` order.
// Uses the raw `users` collection to avoid a circular import with User.ts.
// ---------------------------------------------------------------------------

export const EMPLOYEE_ID_PREFIX = "EMP-";
const EMPLOYEE_ID_PATTERN = /^EMP-(\d{1,9})$/;

/** 7 → "EMP-0007". */
export function formatEmployeeId(seq: number): string {
  return `${EMPLOYEE_ID_PREFIX}${String(seq).padStart(4, "0")}`;
}

/** "EMP-0007" → 7 (null for custom IDs). */
export function employeeIdNumber(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = EMPLOYEE_ID_PATTERN.exec(value);
  return match ? Number(match[1]) : null;
}

function usersCollection(): mongoose.mongo.Collection {
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB is not connected");
  return db.collection("users");
}

/**
 * Initial counter when missing: highest EMP-number in use plus one slot per user
 * without an ID, so `migrate:hr` can later backfill 1..N without collisions.
 */
async function initialEmployeeSeq(): Promise<number> {
  const users = usersCollection();
  const [withIds, missing] = await Promise.all([
    users.find({ employeeId: { $regex: EMPLOYEE_ID_PATTERN } }, { projection: { employeeId: 1 } }).toArray(),
    users.countDocuments({ $or: [{ employeeId: { $exists: false } }, { employeeId: null }, { employeeId: "" }] }),
  ]);
  const highest = withIds.reduce((max, u) => Math.max(max, employeeIdNumber(u.employeeId) ?? 0), 0);
  return highest + missing;
}

/** Creates the `employee` counter when missing (a concurrent creator may win — that's fine). */
export async function ensureEmployeeCounter(): Promise<void> {
  if (await Counter.exists({ _id: EMPLOYEE_ID_COUNTER })) return;
  try {
    await Counter.create({ _id: EMPLOYEE_ID_COUNTER, seq: await initialEmployeeSeq() });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
  }
}

async function claimSeq(): Promise<number> {
  const claimed = await Counter.findOneAndUpdate(
    { _id: EMPLOYEE_ID_COUNTER },
    { $inc: { seq: 1 } },
    { returnDocument: "after" }
  ).lean();
  if (claimed) return claimed.seq;
  await ensureEmployeeCounter();
  const next = await Counter.findOneAndUpdate(
    { _id: EMPLOYEE_ID_COUNTER },
    { $inc: { seq: 1 } },
    { returnDocument: "after" }
  ).lean();
  return next!.seq;
}

/**
 * Claims the next free "EMP-xxxx" (skips IDs an admin already typed by hand).
 * The unique index on `employeeId` is the final guard.
 */
export async function nextEmployeeId(): Promise<string> {
  const users = usersCollection();
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = formatEmployeeId(await claimSeq());
    if (!(await users.findOne({ employeeId: candidate }, { projection: { _id: 1 } }))) return candidate;
  }
  throw new Error("Could not allocate an employee ID");
}
