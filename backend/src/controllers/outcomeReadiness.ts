import type { Request, Response } from "express";
import { Project } from "../models/Project.js";
import {
  evaluateOutcome,
  outcomeReadinessEnabled,
  type OutcomeProjectInput,
  type OutcomeTaskInput,
} from "../lib/outcomeReadiness.js";
import { canViewTaskAsync, getTaskOr404 } from "../lib/taskAccess.js";

/**
 * POST /api/tasks/:id/outcome-readiness — body { notes?, finalUrl?, hasFile? }.
 * Scores a draft outcome (nothing is saved) so the close dialog can advise
 * before the task is closed. Advice only; never blocks anything.
 */
export async function checkOutcomeReadiness(req: Request, res: Response): Promise<void> {
  const task = await getTaskOr404(req, res);
  if (!task) return;
  if (!(await canViewTaskAsync(req.user!, task))) {
    res.status(403).json({ error: "You can't view this task" });
    return;
  }
  if (!(await outcomeReadinessEnabled())) {
    res.json({ enabled: false, result: null });
    return;
  }
  const body = (req.body ?? {}) as { notes?: unknown; finalUrl?: unknown; finalUrls?: unknown; hasFile?: unknown };
  if (body.notes !== undefined && (typeof body.notes !== "string" || body.notes.length > 2000)) {
    res.status(400).json({ error: "notes must be 2000 characters or fewer" });
    return;
  }
  if (body.finalUrl !== undefined && (typeof body.finalUrl !== "string" || body.finalUrl.length > 2000)) {
    res.status(400).json({ error: "finalUrl must be 2000 characters or fewer" });
    return;
  }
  const notes = typeof body.notes === "string" ? body.notes : (task.submissionNotes ?? "");
  const urls = Array.isArray(body.finalUrls)
    ? body.finalUrls.filter((u): u is string => typeof u === "string" && u.trim() !== "" && u.length <= 2000).slice(0, 10)
    : null;
  const url = urls ? (urls[0] ?? "") : typeof body.finalUrl === "string" ? body.finalUrl.trim() : (task.finalFile?.url ?? "");
  const links = urls ?? (typeof body.finalUrl === "string" ? undefined : task.finalFile?.links);
  const hasFile =
    body.hasFile === true || (body.finalUrl === undefined && !urls && Boolean(task.finalFile?.fileId));
  const draft: OutcomeTaskInput = {
    title: task.title,
    description: task.description,
    titleParts: task.titleParts ?? null,
    submissionNotes: notes,
    finalFile: url ? { url, links } : hasFile ? { fileId: true, url: null } : null,
  };
  const project = task.project
    ? await Project.findById(task.project).select("name summary scopeItems").lean<OutcomeProjectInput>()
    : null;
  try {
    res.json({ enabled: true, result: await evaluateOutcome(draft, project) });
  } catch (err) {
    console.error("[outcome-readiness] draft check failed", err instanceof Error ? err.message : err);
    res.json({ enabled: true, result: null });
  }
}
