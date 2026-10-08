import mongoose from "mongoose";
import { addDays, appDayStart } from "./appTime.js";
import { Task } from "../models/Task.js";

type ObjectId = mongoose.Types.ObjectId;

// ---------------------------------------------------------------------------
// "My projects" as Worksuite's employee dashboard counts them, shared by
// GET /api/dashboard/me and GET /api/projects (memberOnly / active / activeFrom…)
// so every dashboard tile equals the total of the list it links to.
// ---------------------------------------------------------------------------

/** Projects the user is a member of (members[].user — a manager-only project does not count), not archived. */
export function memberProjectFilter(userId: ObjectId): Record<string, unknown> {
  return { "members.user": userId, archivedAt: null };
}

/** Worksuite "in progress": progress below 100 %. */
export const PROGRESS_NOT_DONE = { progress: { $ne: 100 } } as const;

/**
 * Projects active in the inclusive date-only range `from`…`to` for `userId`:
 * start → deadline overlaps the range (no deadline = open-ended), or a task
 * assigned to the user was updated in it (app-timezone days).
 */
export async function activeInRangeFilter(
  userId: ObjectId,
  from: Date,
  to: Date
): Promise<Record<string, unknown>> {
  const touched = (
    await Task.distinct("project", {
      assignees: userId,
      updatedAt: { $gte: appDayStart(from), $lt: appDayStart(addDays(to, 1)) },
    })
  ).filter(Boolean);
  return {
    $or: [
      { _id: { $in: touched } },
      { startDate: { $lte: to }, $or: [{ deadline: null }, { deadline: { $gte: from } }] },
    ],
  };
}
