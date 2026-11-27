import mongoose from "mongoose";
import { Task } from "../models/Task.js";

// ---------------------------------------------------------------------------
// Scope deliverables: a scope row "15 Video" is 15 deliverables — Video 1 of 15 …
// Video 15 of 15. A task names the deliverable it works on with its title parts
// (unit "Video", number 3 → "Video 3 – Copy"), and any number of tasks (copy,
// design, review …) can work on the same deliverable. Scope used = how many
// different deliverables have tasks, not how many tasks there are.
// New work only: reworks and rejected over-scope tasks don't count.
// ---------------------------------------------------------------------------

export interface DeliverableUse {
  project: mongoose.Types.ObjectId;
  /** Lower-cased unit. */
  unit: string;
  /** The deliverable number (title parts quantity). */
  n: number;
  tasks: number;
  /** Short names of the tasks on it (first few), e.g. ["Copy", "Design"]. */
  names: string[];
}

const COUNTED = {
  iteration: { $ne: "rework" },
  "overScope.status": { $ne: "rejected" },
  "titleParts.unit": { $type: "string" },
  "titleParts.quantity": { $type: "number" },
};

/**
 * Aggregation stages that turn a task into one row per deliverable it covers, in `$__d`
 * ({ unit, n }): a task for Video 1, 4 and Static 2 gives three rows, a task on one deliverable one.
 */
export const EXPAND_DELIVERABLES = [
  {
    $addFields: {
      __d: {
        $cond: [
          { $gt: [{ $size: { $ifNull: ["$titleParts.items", []] } }, 0] },
          "$titleParts.items",
          [{ unit: "$titleParts.unit", n: "$titleParts.quantity" }],
        ],
      },
    },
  },
  { $unwind: "$__d" },
  // "Others" is never counted against the scope.
  { $match: { "__d.unit": { $not: /^\s*others?\s*$/i } } },
];
/** `$group` key part (the lower-cased unit) for a row of EXPAND_DELIVERABLES. */
export const DELIVERABLE_UNIT_KEY = { $toLower: { $trim: { input: "$__d.unit" } } };

const unitRx = (unit: string) => ({ $regex: `^${unit.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" });

/** Every deliverable in use on these projects, with its tasks. */
export async function deliverableUsage(projectIds: mongoose.Types.ObjectId[], unit?: string): Promise<DeliverableUse[]> {
  if (projectIds.length === 0) return [];
  const rows = await Task.aggregate<{ _id: { project: mongoose.Types.ObjectId; unit: string; n: number }; tasks: number; names: string[] }>([
    {
      $match: {
        project: { $in: projectIds },
        ...COUNTED,
      },
    },
    { $sort: { createdAt: 1 } },
    ...EXPAND_DELIVERABLES,
    ...(unit ? [{ $match: { "__d.unit": unitRx(unit) } }] : []),
    {
      $group: {
        _id: { project: "$project", unit: DELIVERABLE_UNIT_KEY, n: "$__d.n" },
        tasks: { $sum: 1 },
        names: { $push: "$titleParts.shortName" },
      },
    },
  ]);
  return rows.map((r) => ({ project: r._id.project, unit: r._id.unit, n: r._id.n, tasks: r.tasks, names: r.names.filter(Boolean).slice(0, 5) }));
}

/** Deliverables used per "project|unit" key (distinct numbers). */
export function usedByUnit(rows: DeliverableUse[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const key = `${String(r.project)}|${r.unit}`;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/** True when a deliverable number beyond the scope already has an approved (or unflagged) task — more tasks on it need no new approval. */
export async function extraDeliverableApproved(
  projectId: mongoose.Types.ObjectId,
  unit: string,
  n: number,
  /** The task being checked (its own flag doesn't clear it). */
  except?: mongoose.Types.ObjectId
): Promise<boolean> {
  return Boolean(
    await Task.exists({
      ...(except ? { _id: { $ne: except } } : {}),
      project: projectId,
      iteration: { $ne: "rework" },
      // On this deliverable: the task's own one, or one of the several it covers.
      $or: [
        { "titleParts.unit": unitRx(unit), "titleParts.quantity": n, "titleParts.items": { $in: [null, []] } },
        { "titleParts.items": { $elemMatch: { unit: unitRx(unit), n } } },
      ],
      // Only an approval clears the deliverable (an older task on it without a decision doesn't).
      "overScope.status": "approved",
    })
  );
}
