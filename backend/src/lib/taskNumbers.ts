import type mongoose from "mongoose";
import { isDuplicateKeyError } from "./errors.js";
import { Counter, TASK_NUMBER_COUNTER } from "../models/Counter.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";

/** Atomically claims the next `{CODE}-{n}` project short code (counter only, never re-coded). */
export async function nextShortCode(projectId: mongoose.Types.ObjectId): Promise<string | null> {
  const updated = await Project.findOneAndUpdate(
    { _id: projectId },
    { $inc: { taskCounter: 1 } },
    { returnDocument: "after" }
  ).select("code taskCounter");
  return updated ? `${updated.code}-${updated.taskCounter}` : null;
}

/**
 * Initial counter value when the `task` counter doesn't exist yet (fresh DB, or a
 * deploy that hasn't run `bun run migrate:tables`): the highest number in use
 * plus one slot per un-numbered task, so the migration can later backfill
 * 1..N in `createdAt` order without colliding with numbers handed out meanwhile.
 */
async function initialTaskSeq(): Promise<number> {
  const [highest, unnumbered] = await Promise.all([
    Task.findOne({ number: { $ne: null } }).sort({ number: -1 }).select("number").lean(),
    Task.countDocuments({ number: null }),
  ]);
  return (highest?.number ?? 0) + unnumbered;
}

/** Creates the `task` counter when missing (a concurrent creator may win — that's fine). */
export async function ensureTaskCounter(): Promise<void> {
  if (await Counter.exists({ _id: TASK_NUMBER_COUNTER })) return;
  try {
    await Counter.create({ _id: TASK_NUMBER_COUNTER, seq: await initialTaskSeq() });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
  }
}

/** Atomically claims the next global task number (used by EVERY task creation path). */
export async function nextTaskNumber(): Promise<number> {
  const claimed = await Counter.findOneAndUpdate(
    { _id: TASK_NUMBER_COUNTER },
    { $inc: { seq: 1 } },
    { returnDocument: "after" }
  ).lean();
  if (claimed) return claimed.seq;

  // First use: create the counter, then claim.
  await ensureTaskCounter();
  const next = await Counter.findOneAndUpdate(
    { _id: TASK_NUMBER_COUNTER },
    { $inc: { seq: 1 } },
    { returnDocument: "after" }
  ).lean();
  return next!.seq;
}
