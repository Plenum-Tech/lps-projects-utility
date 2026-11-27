import mongoose from "mongoose";
import { appDayStart, addDays } from "./appTime.js";
import { projectMonth } from "./projectExpiry.js";
import { scopeTotals } from "./scopeUnits.js";
import type { IProject } from "../models/Project.js";
import { getProjectSettings } from "../models/ProjectSettings.js";
import { Task, deliverablesOf, isUncountedUnit } from "../models/Task.js";

// ---------------------------------------------------------------------------
// Project readiness (out of 100): was the project planned — its scope entered as tasks, with
// assignees, due dates and estimates — by the cut-off?
//   - retainers / projects / campaigns: the Nth working day of the project's month;
//   - pitches: N working days after the internal briefing (the Milestone 1 meeting, else the
//     pitch's start date, else the day it was created).
// The cut-off days and the green / amber lines are settings (leadership).
//
//   40  scope planned: deliverables of the scope that have a task (a pitch without a scope:
//       its three steps scheduled; any other project without a scope scores 0 here)
//   20  entered on time: tasks created by the cut-off
//   15  tasks with an assignee
//   15  tasks with a due date
//   10  tasks with an estimate
// New work only (reworks and rejected extras don't count).
// ---------------------------------------------------------------------------

type Id = mongoose.Types.ObjectId;

export const READINESS_WEIGHTS = { scope: 40, onTime: 20, assignee: 15, dueDate: 15, estimate: 10 } as const;
export const READINESS_DEFAULTS = { retainerDay: 3, pitchDays: 2, greenFrom: 80, amberFrom: 50 } as const;
export type ReadinessBand = "green" | "amber" | "red";
export interface ReadinessSettings {
  retainerDay: number;
  pitchDays: number;
  greenFrom: number;
  amberFrom: number;
}

export interface Readiness {
  score: number;
  band: ReadinessBand;
  /** "YYYY-MM-DD": the day planning was due; null when the project has no month / start. */
  cutoff: string | null;
  pastCutoff: boolean;
  kind: "pitch" | "project";
  parts: {
    scope: { points: number; max: number; planned: number; total: number; note: string };
    onTime: { points: number; max: number; onTime: number; tasks: number };
    assignee: { points: number; max: number; with: number; tasks: number };
    dueDate: { points: number; max: number; with: number; tasks: number };
    estimate: { points: number; max: number; with: number; tasks: number };
  };
  tasks: number;
}

export async function readinessSettings(): Promise<ReadinessSettings> {
  const s = await getProjectSettings();
  return {
    retainerDay: s.readinessRetainerDay ?? READINESS_DEFAULTS.retainerDay,
    pitchDays: s.readinessPitchDays ?? READINESS_DEFAULTS.pitchDays,
    greenFrom: s.readinessGreenFrom ?? READINESS_DEFAULTS.greenFrom,
    amberFrom: s.readinessAmberFrom ?? READINESS_DEFAULTS.amberFrom,
  };
}

const key = (d: Date) => d.toISOString().slice(0, 10);
const isWeekend = (d: Date) => d.getUTCDay() === 0 || d.getUTCDay() === 6;

/** `n` working days (Mon–Fri) on from the date-only `from` (n = 0: the day itself, or the next working day). */
function addWorkingDays(from: Date, n: number): Date {
  let d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  while (isWeekend(d)) d = addDays(d, 1);
  for (let left = n; left > 0; ) {
    d = addDays(d, 1);
    if (!isWeekend(d)) left--;
  }
  return d;
}

type ScoredProject = Pick<IProject, "_id" | "name" | "naming" | "deadline" | "scopeItems" | "startDate" | "pitch"> & { createdAt?: Date };

export const isPitchProject = (p: Pick<IProject, "naming" | "pitch">) => /^pitch$/i.test(p.naming?.type ?? "") || Boolean(p.pitch?.status);

/** The day planning is due ("YYYY-MM-DD"), or null. */
export function readinessCutoff(p: ScoredProject, settings: ReadinessSettings): string | null {
  if (isPitchProject(p)) {
    const briefing = p.pitch?.milestone1 ?? p.startDate ?? p.createdAt ?? null;
    return briefing ? key(addWorkingDays(briefing, settings.pitchDays)) : null;
  }
  const month = projectMonth(p);
  if (!month) return null;
  const [y, m] = month.split("-").map(Number);
  // The Nth working day: the first working day, then N − 1 more.
  return key(addWorkingDays(new Date(Date.UTC(y!, m! - 1, 1)), Math.max(0, settings.retainerDay - 1)));
}

const share = (n: number, of: number) => (of > 0 ? Math.min(1, n / of) : 0);

/** Readiness of each project (by id). */
export async function readinessOf(projects: ScoredProject[], settings?: ReadinessSettings, today: string = key(new Date())): Promise<Map<string, Readiness>> {
  const out = new Map<string, Readiness>();
  if (projects.length === 0) return out;
  const s = settings ?? (await readinessSettings());
  const tasks = await Task.find({
    project: { $in: projects.map((p) => p._id as Id) },
    iteration: { $ne: "rework" },
    "overScope.status": { $ne: "rejected" },
  })
    .select("project titleParts assignees dueDate estimateMinutes createdAt")
    .lean<Array<{ project: Id; titleParts?: { unit?: string; quantity?: number; items?: Array<{ unit: string; n: number }> | null } | null; assignees?: Id[]; dueDate?: Date | null; estimateMinutes?: number | null; createdAt: Date }>>();
  const byProject = new Map<string, typeof tasks>();
  for (const t of tasks) byProject.set(String(t.project), [...(byProject.get(String(t.project)) ?? []), t]);

  for (const p of projects) {
    const mine = byProject.get(String(p._id)) ?? [];
    const pitch = isPitchProject(p);
    const cutoff = readinessCutoff(p, s);
    // Tasks created up to the end of the cut-off day (app timezone).
    const cutoffEnd = cutoff ? appDayStart(addDays(new Date(`${cutoff}T00:00:00.000Z`), 1)) : null;
    const n = mine.length;

    // Scope planned.
    const totals = scopeTotals(p.scopeItems);
    let planned = 0;
    let total = 0;
    let note: string;
    if (totals.size > 0) {
      const seen = new Set<string>();
      for (const t of mine) {
        // Every deliverable the task covers (one task can cover several, of several types).
        for (const d of deliverablesOf(t.titleParts)) {
          const unit = d.unit.trim().toLowerCase();
          const allowed = totals.get(unit)?.total ?? 0;
          if (unit && !isUncountedUnit(unit) && d.n >= 1 && d.n <= allowed) seen.add(`${unit}#${d.n}`);
        }
      }
      planned = seen.size;
      // "Others" isn't counted: it's neither planned nor expected.
      total = [...totals.entries()].reduce((sum, [unit, u]) => sum + (isUncountedUnit(unit) ? 0 : u.total), 0);
      note = "scope deliverables with a task";
    } else if (pitch) {
      planned = [p.pitch?.milestone1, p.pitch?.milestone2, p.pitch?.clientPresentation].filter(Boolean).length;
      total = 3;
      note = "pitch steps with a date (no scope on the pitch)";
    } else {
      note = "no scope on the project";
    }

    const onTime = cutoffEnd ? mine.filter((t) => t.createdAt.getTime() < cutoffEnd.getTime()).length : 0;
    const withAssignee = mine.filter((t) => (t.assignees?.length ?? 0) > 0).length;
    const withDue = mine.filter((t) => Boolean(t.dueDate)).length;
    const withEstimate = mine.filter((t) => (t.estimateMinutes ?? 0) > 0).length;
    const W = READINESS_WEIGHTS;
    const points = (weight: number, value: number) => Math.round(weight * value);
    const parts = {
      scope: { points: points(W.scope, share(planned, total)), max: W.scope, planned, total, note },
      onTime: { points: points(W.onTime, share(onTime, n)), max: W.onTime, onTime, tasks: n },
      assignee: { points: points(W.assignee, share(withAssignee, n)), max: W.assignee, with: withAssignee, tasks: n },
      dueDate: { points: points(W.dueDate, share(withDue, n)), max: W.dueDate, with: withDue, tasks: n },
      estimate: { points: points(W.estimate, share(withEstimate, n)), max: W.estimate, with: withEstimate, tasks: n },
    };
    const score = Object.values(parts).reduce((sum, part) => sum + part.points, 0);
    out.set(String(p._id), {
      score,
      band: score >= s.greenFrom ? "green" : score >= s.amberFrom ? "amber" : "red",
      cutoff,
      pastCutoff: cutoff ? today > cutoff : false,
      kind: pitch ? "pitch" : "project",
      parts,
      tasks: n,
    });
  }
  return out;
}
