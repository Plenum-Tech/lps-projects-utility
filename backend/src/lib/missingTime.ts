import mongoose from "mongoose";
import { Task } from "../models/Task.js";

// ---------------------------------------------------------------------------
// Completed tasks with no time logged: their assignees are asked to add the
// actual start and the time taken (task page prompt + My dashboard card).
// Only tasks completed since MISSING_TIME_FROM (the move to Utility) count;
// the imported Worksuite history is left alone.
// ---------------------------------------------------------------------------

export const MISSING_TIME_FROM = new Date(`${process.env.MISSING_TIME_FROM ?? "2026-10-01"}T00:00:00.000Z`);

export interface MissingTimeTask {
  _id: string;
  title: string;
  shortCode: string | null;
  project: { _id: string; name: string } | null;
  completedAt: string | null;
}

/** True when `task` (completed, no logged minutes) asks `userId` for its time. */
export function needsTimeEntry(
  task: { status: string; completedAt?: Date | null; assignees: mongoose.Types.ObjectId[] },
  loggedMinutes: number,
  userId: mongoose.Types.ObjectId
): boolean {
  return (
    task.status === "completed" &&
    loggedMinutes === 0 &&
    Boolean(task.completedAt && task.completedAt >= MISSING_TIME_FROM) &&
    task.assignees.some((a) => a.equals(userId))
  );
}

/** The user's completed tasks (since MISSING_TIME_FROM) with no time entry, newest first. */
export async function missingTimeTasks(userId: mongoose.Types.ObjectId, limit = 50): Promise<{ total: number; tasks: MissingTimeTask[] }> {
  const rows = await Task.aggregate<{
    _id: mongoose.Types.ObjectId;
    title: string;
    shortCode?: string | null;
    completedAt?: Date | null;
    project?: Array<{ _id: mongoose.Types.ObjectId; name: string; archivedAt?: Date | null }>;
  }>([
    { $match: { status: "completed", assignees: userId, completedAt: { $gte: MISSING_TIME_FROM } } },
    { $lookup: { from: "timelogs", let: { id: "$_id" }, pipeline: [{ $match: { $expr: { $eq: ["$task", "$$id"] } } }, { $limit: 1 }, { $project: { _id: 1 } }], as: "logs" } },
    { $match: { logs: { $size: 0 } } },
    { $lookup: { from: "projects", localField: "project", foreignField: "_id", as: "project", pipeline: [{ $project: { name: 1, archivedAt: 1 } }] } },
    { $sort: { completedAt: -1 } },
    { $project: { title: 1, shortCode: 1, completedAt: 1, project: 1 } },
  ]);
  // Archived projects are read-only: no time can be added there.
  const open = rows.filter((r) => !r.project?.[0]?.archivedAt);
  return {
    total: open.length,
    tasks: open.slice(0, limit).map((r) => ({
      _id: String(r._id),
      title: r.title,
      shortCode: r.shortCode ?? null,
      project: r.project?.[0] ? { _id: String(r.project[0]._id), name: r.project[0].name } : null,
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    })),
  };
}
