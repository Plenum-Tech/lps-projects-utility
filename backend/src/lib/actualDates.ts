import mongoose from "mongoose";
import { Task } from "../models/Task.js";
import type { ActualDateSource, ITask, TaskStatus } from "../models/Task.js";
import { TaskHistory } from "../models/TaskHistory.js";
import { TimeLog } from "../models/TimeLog.js";
import { dayFromKey } from "./delivery/days.js";
import { appDateKey } from "./taskJobs.js";

// ---------------------------------------------------------------------------
// Task Actual start / Actual end (prompts/task-actual-dates.md).
//
// The automatic rules live here and every path that changes a task's status
// (status endpoint, board move, bulk, submit, review, create with an initial
// status, recurring copies, imports) calls `applyAutoActualDates`. Time logs
// call `markActualStartFromLogs`. A value with source "manual" is never
// changed by these rules — only a manual edit (or clearing it) does.
// ---------------------------------------------------------------------------

/** Manual values may be at most this far in the future (clock skew). */
export const ACTUAL_FUTURE_GRACE_MS = 2 * 60_000;

type Id = mongoose.Types.ObjectId;

/** The fields the rules read and write (a hydrated task or a plain create payload). */
export interface ActualDateFields {
  _id?: Id | unknown;
  actualStartAt?: Date | null;
  actualEndAt?: Date | null;
  actualStartSource?: ActualDateSource | null;
  actualEndSource?: ActualDateSource | null;
}

/** Earliest time-log start of a task (any review status), null without logs. */
export async function earliestLogStart(taskId: Id): Promise<Date | null> {
  const row = await TimeLog.findOne({ task: taskId }).sort({ startTime: 1 }).select("startTime").lean();
  return row?.startTime ?? null;
}

/**
 * Applies the automatic rules for a status change `from` → `to` at `at` (the
 * moment written to completedAt for completions). Mutates `task` in memory;
 * the caller saves it. `from` = null for a task being created.
 * - start: set on the first move to in_progress while empty;
 * - end: set on completion (a manual end is kept); a non-manual end is cleared
 *   when the task leaves completed;
 * - consistency: an end without a start takes the earliest time log's start.
 */
export async function applyAutoActualDates(
  task: ActualDateFields,
  from: TaskStatus | null,
  to: TaskStatus,
  at: Date
): Promise<void> {
  if (from === to) return;
  if (to === "in_progress" && !task.actualStartAt) {
    task.actualStartAt = at;
    task.actualStartSource = "auto";
  }
  if (to === "completed") {
    if (!task.actualEndAt || task.actualEndSource !== "manual") {
      task.actualEndAt = at;
      task.actualEndSource = "auto";
    }
  } else if (from === "completed" && task.actualEndAt && task.actualEndSource !== "manual") {
    task.actualEndAt = null;
    task.actualEndSource = null;
  }
  if (task.actualEndAt && !task.actualStartAt && task._id instanceof mongoose.Types.ObjectId) {
    const first = await earliestLogStart(task._id);
    if (first && first.getTime() <= task.actualEndAt.getTime()) {
      task.actualStartAt = first;
      task.actualStartSource = "auto";
    }
  }
}

/** Actual dates for a task created with `status` (create, imports, recurring copies). */
export function initialActualDates(status: TaskStatus, at: Date): Required<Omit<ActualDateFields, "_id">> {
  return {
    actualStartAt: status === "in_progress" ? at : null,
    actualStartSource: status === "in_progress" ? "auto" : null,
    actualEndAt: status === "completed" ? at : null,
    actualEndSource: status === "completed" ? "auto" : null,
  };
}

/**
 * A timer was started / time was logged: fills an empty Actual start with the
 * log's start (atomic — never overwrites a set value). `starts` = task → start.
 */
export async function markActualStartFromLogs(starts: Array<{ task: Id | null | undefined; start: Date }>): Promise<number> {
  const earliest = new Map<string, { task: Id; start: Date }>();
  for (const { task, start } of starts) {
    if (!task) continue;
    const key = String(task);
    const known = earliest.get(key);
    if (!known || start.getTime() < known.start.getTime()) earliest.set(key, { task, start });
  }
  if (earliest.size === 0) return 0;
  const result = await Task.bulkWrite(
    [...earliest.values()].map(({ task, start }) => ({
      updateOne: {
        filter: { _id: task, actualStartAt: null },
        update: { $set: { actualStartAt: start, actualStartSource: "auto" as const } },
      },
    }))
  );
  return result.modifiedCount;
}

/**
 * What the automatic rules would give a task today (used when a manual value is
 * cleared, and by `bun run backfill:actual-dates`): start = the earliest of the
 * first move to in_progress (history) and the first time log; end = completedAt
 * for completed tasks.
 */
export async function computeAutoActualDates(
  task: Pick<ITask, "status" | "completedAt"> & { _id: unknown }
): Promise<{ start: Date | null; end: Date | null }> {
  const id = task._id as Id;
  const [history, log] = await Promise.all([
    TaskHistory.findOne({ task: id, ...IN_PROGRESS_HISTORY })
      .sort({ createdAt: 1 })
      .select("createdAt")
      .lean(),
    earliestLogStart(id),
  ]);
  const candidates = [history?.createdAt ?? null, log].filter((d): d is Date => d instanceof Date);
  const start = candidates.length ? new Date(Math.min(...candidates.map((d) => d.getTime()))) : null;
  const end = task.status === "completed" ? (task.completedAt ?? null) : null;
  return { start, end };
}

/** History rows that moved a task to in_progress (or created it there). */
export const IN_PROGRESS_HISTORY: Record<string, unknown> = {
  $or: [
    { action: "status_changed", "details.to": "in_progress" },
    { action: { $in: ["created", "created_from_meeting"] }, "details.status": "in_progress" },
  ],
};

// ---------------------------------------------------------------------------
// Manual edits (PATCH /api/tasks/:id { actualStartAt?, actualEndAt? })
// ---------------------------------------------------------------------------

export interface ActualDatesInput {
  actualStartAt?: unknown;
  actualEndAt?: unknown;
}

export interface ActualDateChange {
  field: "actualStartAt" | "actualEndAt";
  from: string | null;
  to: string | null;
  fromSource: ActualDateSource | null;
  source: ActualDateSource | null;
}

type Invalid = { status: number; error: string };

/** undefined = untouched, null/"" = cleared (back to automatic), else an ISO date-time. */
function parseInstant(raw: unknown, field: string): Date | null | undefined | Invalid {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw.trim())) {
    return { status: 400, error: `${field} must be an ISO date-time or null` };
  }
  const date = new Date(raw.trim());
  if (Number.isNaN(date.getTime())) return { status: 400, error: `${field} must be an ISO date-time or null` };
  return date;
}

const isInvalid = (v: unknown): v is Invalid => typeof v === "object" && v !== null && "error" in v && !(v instanceof Date);

/** True when the body touches the actual dates. */
export function hasActualDates(body: ActualDatesInput): boolean {
  return body.actualStartAt !== undefined || body.actualEndAt !== undefined;
}

/**
 * Validates and applies a manual edit to `task` (in memory, nothing saved).
 * Clearing a field returns it to automatic: it is recomputed by the rules.
 * Returns the changes for the `actual_dates_updated` history row.
 */
export async function applyManualActualDates(
  task: ITask,
  body: ActualDatesInput,
  now = new Date()
): Promise<Invalid | ActualDateChange[]> {
  const start = parseInstant(body.actualStartAt, "actualStartAt");
  if (isInvalid(start)) return start;
  const end = parseInstant(body.actualEndAt, "actualEndAt");
  if (isInvalid(end)) return end;
  if (start === undefined && end === undefined) return [];

  const limit = now.getTime() + ACTUAL_FUTURE_GRACE_MS;
  if (start && start.getTime() > limit) return { status: 400, error: "Actual start can't be in the future" };
  if (end && end.getTime() > limit) return { status: 400, error: "Actual end can't be in the future" };

  const auto = start === null || end === null ? await computeAutoActualDates(task) : null;
  let nextStart = task.actualStartAt ?? null;
  let nextStartSource = task.actualStartSource ?? null;
  let nextEnd = task.actualEndAt ?? null;
  let nextEndSource = task.actualEndSource ?? null;
  if (start !== undefined) {
    nextStart = start ?? auto!.start;
    nextStartSource = start ? "manual" : nextStart ? "auto" : null;
  }
  if (end !== undefined) {
    nextEnd = end ?? auto!.end;
    nextEndSource = end ? "manual" : nextEnd ? "auto" : null;
  }
  // Consistency: an end without a start takes the earliest time log.
  if (nextEnd && !nextStart) {
    const first = await earliestLogStart(task._id as Id);
    if (first && first.getTime() <= nextEnd.getTime()) {
      nextStart = first;
      nextStartSource = "auto";
    }
  }
  if (nextStart && nextEnd && nextEnd.getTime() < nextStart.getTime()) {
    return { status: 400, error: "Actual end must be on or after the actual start" };
  }

  const changes: ActualDateChange[] = [];
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  if (iso(nextStart) !== iso(task.actualStartAt ?? null) || nextStartSource !== (task.actualStartSource ?? null)) {
    changes.push({
      field: "actualStartAt",
      from: iso(task.actualStartAt ?? null),
      to: iso(nextStart),
      fromSource: task.actualStartSource ?? null,
      source: nextStartSource,
    });
    task.actualStartAt = nextStart;
    task.actualStartSource = nextStartSource;
  }
  if (iso(nextEnd) !== iso(task.actualEndAt ?? null) || nextEndSource !== (task.actualEndSource ?? null)) {
    changes.push({
      field: "actualEndAt",
      from: iso(task.actualEndAt ?? null),
      to: iso(nextEnd),
      fromSource: task.actualEndSource ?? null,
      source: nextEndSource,
    });
    task.actualEndAt = nextEnd;
    task.actualEndSource = nextEndSource;
  }
  return changes;
}

/**
 * Validates import-supplied actual dates (Excel import): not in the future,
 * end ≥ start. Returns an error message or null.
 */
export function importActualDatesProblem(start: Date | null, end: Date | null, now = new Date()): string | null {
  const limit = now.getTime() + ACTUAL_FUTURE_GRACE_MS;
  if (start && start.getTime() > limit) return "Actual start can't be in the future";
  if (end && end.getTime() > limit) return "Actual end can't be in the future";
  if (start && end && end.getTime() < start.getTime()) return "Actual end must be on or after the actual start";
  return null;
}

/**
 * Whole days between an actual instant (app-timezone calendar date) and a
 * planned date-only value: positive = late, negative = early; null when either is missing.
 */
export function varianceDays(actual: Date | null | undefined, planned: Date | null | undefined): number | null {
  if (!actual || !planned) return null;
  return dayFromKey(appDateKey(actual)) - dayFromKey(planned.toISOString().slice(0, 10));
}
