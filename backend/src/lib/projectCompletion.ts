import mongoose from "mongoose";
import { Project } from "../models/Project.js";
import { ProjectActivity } from "../models/ProjectActivity.js";
import { completedStatusIds } from "../models/ProjectStatus.js";

type ObjectId = mongoose.Types.ObjectId;

/** A half-open range of UTC instants: start (inclusive) … end (exclusive). */
export interface InstantRange {
  start: Date;
  end: Date;
}

/**
 * When each project was completed: its last `status_changed` activity (= the
 * move into its completed status); projects that never changed status fall
 * back to `updatedAt`. Shared by My dashboard (completed-projects tile) and
 * GET /api/projects?completed=true&completedFrom/To so their counts match.
 */
export async function projectCompletionDates(
  projects: ReadonlyArray<{ _id: unknown; updatedAt: Date }>
): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (projects.length === 0) return out;
  const rows = await ProjectActivity.aggregate<{ _id: ObjectId; at: Date }>([
    { $match: { project: { $in: projects.map((p) => p._id as ObjectId) }, action: "status_changed" } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: "$project", at: { $first: "$createdAt" } } },
  ]);
  const last = new Map(rows.map((r) => [String(r._id), r.at]));
  for (const p of projects) out.set(String(p._id), last.get(String(p._id)) ?? p.updatedAt);
  return out;
}

/** `at` inside the range (either bound may be open). */
export function completedWithin(at: Date, range: Partial<InstantRange>): boolean {
  if (range.start && at.getTime() < range.start.getTime()) return false;
  if (range.end && at.getTime() >= range.end.getTime()) return false;
  return true;
}

/**
 * Ids of the projects matching `filter` that are in a completed status and
 * whose completion moment (see projectCompletionDates) falls in `range`.
 */
export async function projectIdsCompletedWithin(
  filter: Record<string, unknown>,
  range: Partial<InstantRange>
): Promise<ObjectId[]> {
  const projects = await Project.find({ $and: [filter, { status: { $in: await completedStatusIds() } }] })
    .select("_id updatedAt")
    .lean<Array<{ _id: ObjectId; updatedAt: Date }>>();
  const dates = await projectCompletionDates(projects);
  return projects.filter((p) => completedWithin(dates.get(String(p._id))!, range)).map((p) => p._id);
}
