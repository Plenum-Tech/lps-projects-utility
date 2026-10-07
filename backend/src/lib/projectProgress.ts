import type mongoose from "mongoose";
import { Project } from "../models/Project.js";
import type { IProject } from "../models/Project.js";
import { Task } from "../models/Task.js";
import { isProjectStatusCompleted, loggedTotalsByProject, pushProjectUpdate } from "./projectAccess.js";
import { appToday } from "./taskJobs.js";

// ---------------------------------------------------------------------------
// Progress per `progressMode` (Worksuite calculate_task_progress):
// - manual:          stored value, never recalculated
// - task_completion: completed tasks / all tasks
// - total_time:      logged (approved + pending) minutes / hoursAllocated
// - deadline:        elapsed calendar days between startDate and deadline
// An `isCompleted` status always means 100.
// ---------------------------------------------------------------------------

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Computes the progress a project should have right now. */
export async function computeProgress(project: IProject, now: Date = new Date()): Promise<number> {
  if (await isProjectStatusCompleted(project)) return 100;

  switch (project.progressMode) {
    case "manual":
      return clampPercent(project.progress);
    case "task_completion": {
      const projectId = project._id as mongoose.Types.ObjectId;
      const [total, completed] = await Promise.all([
        Task.countDocuments({ project: projectId }),
        Task.countDocuments({ project: projectId, status: "completed" }),
      ]);
      return total === 0 ? 0 : clampPercent((completed / total) * 100);
    }
    case "total_time": {
      if (!project.hoursAllocated || project.hoursAllocated <= 0) return 0;
      const totals = await loggedTotalsByProject([project._id as mongoose.Types.ObjectId]);
      const minutes = totals.get(String(project._id))?.minutes ?? 0;
      return clampPercent((minutes / (project.hoursAllocated * 60)) * 100);
    }
    case "deadline": {
      if (!project.deadline) return 0;
      const start = project.startDate.getTime();
      const end = project.deadline.getTime();
      const today = appToday(now).getTime();
      if (end <= start) return today >= end ? 100 : 0;
      return clampPercent(((today - start) / (end - start)) * 100);
    }
    default:
      return clampPercent(project.progress);
  }
}

/** Recalculates and stores a project's progress; pushes `project-updated` when it changed. */
export async function recalcProjectProgress(
  projectId: mongoose.Types.ObjectId | string,
  now: Date = new Date()
): Promise<number | null> {
  const project = await Project.findById(projectId);
  if (!project) return null;
  const next = await computeProgress(project, now);
  if (next !== project.progress) {
    await Project.updateOne({ _id: project._id }, { $set: { progress: next } });
    pushProjectUpdate(project, "progress", { progress: next });
  }
  return next;
}

/** Pending debounced recalculations, per project id. */
const pendingRecalcs = new Map<string, ReturnType<typeof setTimeout>>();
const RECALC_DEBOUNCE_MS = 1_000;

/**
 * Fire-and-forget recalculation hook (task status changes, time log changes).
 * Debounced per project: a burst of changes (busy board, bulk edits) costs one
 * recalculation ~1 s after the last change instead of one per change.
 */
export function scheduleProgressRecalc(projectId: mongoose.Types.ObjectId | string | null | undefined): void {
  if (!projectId) return;
  const key = String(projectId);
  const existing = pendingRecalcs.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingRecalcs.delete(key);
    void recalcProjectProgress(key).catch((err) => {
      console.error("[projects] Progress recalculation failed", key, err);
    });
  }, RECALC_DEBOUNCE_MS);
  timer.unref?.();
  pendingRecalcs.set(key, timer);
}

/** Runs every pending debounced recalculation now (scripts and graceful shutdown). */
export async function flushProgressRecalcs(): Promise<void> {
  const keys = [...pendingRecalcs.keys()];
  for (const key of keys) clearTimeout(pendingRecalcs.get(key)!);
  pendingRecalcs.clear();
  await Promise.allSettled(keys.map((key) => recalcProjectProgress(key)));
}
