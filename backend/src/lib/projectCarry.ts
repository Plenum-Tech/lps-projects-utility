import mongoose from "mongoose";
import { Project, type IProject } from "../models/Project.js";
import { Task } from "../models/Task.js";
import type { IUser } from "../models/User.js";
import { recordProjectActivity } from "./projectAccess.js";
import { projectMonth } from "./projectExpiry.js";

// ---------------------------------------------------------------------------
// Continuous projects (Nov 2026): a project that still has open tasks at the end of its
// month carries on into the next one — the same project, same name, its closed and open
// tasks together, and new tasks can be added. A project whose tasks are all done stays in
// its month (it closes as before). `Project.activeThrough` is the last month it runs in.
// Carried: on the 1st (lib/retainers.ts), by "Migrate to next month" (lib/monthMigration.ts),
// or by hand on the project ("Continue into <month>").
// ---------------------------------------------------------------------------

type Id = mongoose.Types.ObjectId;

/** "2026-11" → the last day of the month at UTC midnight. */
function monthEnd(month: string): Date {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0));
}

/** Last month the project runs in: activeThrough, else its own month. */
export function throughMonth(project: Pick<IProject, "naming" | "deadline"> & { name?: string; activeThrough?: string | null }): string | null {
  return project.activeThrough ?? projectMonth(project);
}

/** Open tasks (not completed, not rejected) per project. */
export async function openTaskCounts(projectIds: Id[]): Promise<Map<string, number>> {
  if (projectIds.length === 0) return new Map();
  const rows = await Task.aggregate<{ _id: Id; n: number }>([
    { $match: { project: { $in: projectIds }, status: { $nin: ["completed", "rejected"] } } },
    { $group: { _id: "$project", n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

/**
 * Runs the project through `month`: activeThrough moves on, and a deadline that was the end of
 * its last month moves to the end of `month`. No-op when it already runs through `month`.
 */
export async function carryProject(project: IProject, month: string, actor: IUser | null, via: string): Promise<boolean> {
  const through = throughMonth(project);
  if (through && through >= month) return false;
  const set: Record<string, unknown> = { activeThrough: month };
  const wasEnd = through ? monthEnd(through).toISOString().slice(0, 10) : null;
  if (project.deadline && project.deadline.toISOString().slice(0, 10) === wasEnd) {
    set.deadline = monthEnd(month);
    set.lastDeadlineReminderOn = null;
  }
  await Project.updateOne({ _id: project._id }, { $set: set });
  recordProjectActivity(project._id as Id, actor, "updated", { fields: ["activeThrough"], activeThrough: month, via });
  return true;
}

/**
 * The 1st of the month: every project that ran through last month, isn't archived and still has
 * open tasks carries into `month` (pitches excepted). Projects already copied into the month by an earlier
 * migration (a project with `migratedFrom` = it) are left alone.
 */
export async function carryOpenProjects(month: string, actor: IUser | null): Promise<{ carried: string[]; stayed: number }> {
  const [y, m] = month.split("-").map(Number);
  const prev = new Date(Date.UTC(y!, m! - 2, 1)).toISOString().slice(0, 7);
  const candidates = (
    await Project.find({
      archivedAt: null,
      // Pitches run on their own dates (never carried, as with the month migration).
      "naming.type": { $not: /^pitch$/i },
      $or: [{ activeThrough: prev }, { activeThrough: null, "naming.month": prev }, { activeThrough: null, naming: null }],
    })
  ).filter((p) => throughMonth(p) === prev);
  const open = await openTaskCounts(candidates.map((p) => p._id as Id));
  const copied = new Set(
    (await Project.find({ migratedFrom: { $in: candidates.map((p) => p._id) } }).select("migratedFrom").lean()).map((p) => String(p.migratedFrom))
  );
  const carried: string[] = [];
  let stayed = 0;
  for (const p of candidates) {
    if (!open.get(String(p._id)) || copied.has(String(p._id))) {
      stayed++;
      continue;
    }
    if (await carryProject(p, month, actor, "month_start")) carried.push(p.name);
  }
  return { carried, stayed };
}
