import type { Request, Response } from "express";
import mongoose from "mongoose";
import {
  canManageProject,
  ensureNotArchived,
  getProjectOr404,
  getViewableProjectOr404,
  isInvalidObjectId,
  param,
  pushProjectUpdate,
  recordProjectActivity,
} from "../lib/projectAccess.js";
import { parseDateOnly } from "../lib/taskAccess.js";
import { Milestone, MILESTONE_STATUSES } from "../models/Milestone.js";
import type { IMilestone, MilestoneStatus } from "../models/Milestone.js";
import type { IProject } from "../models/Project.js";
import { Task } from "../models/Task.js";

interface MilestoneBody {
  title?: unknown;
  summary?: unknown;
  startDate?: unknown;
  endDate?: unknown;
}

/** Adds taskCount / completedTaskCount / progress to each milestone. */
async function withProgress(milestones: IMilestone[]): Promise<Record<string, unknown>[]> {
  const ids = milestones.map((m) => m._id as mongoose.Types.ObjectId);
  const rows =
    ids.length === 0
      ? []
      : await Task.aggregate<{ _id: mongoose.Types.ObjectId; total: number; completed: number }>([
          { $match: { milestone: { $in: ids } } },
          {
            $group: {
              _id: "$milestone",
              total: { $sum: 1 },
              completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
            },
          },
        ]);
  const byId = new Map(rows.map((r) => [r._id.toString(), r]));
  return milestones.map((m) => {
    const row = byId.get(m._id.toString());
    const total = row?.total ?? 0;
    const completed = row?.completed ?? 0;
    return {
      ...(m.toJSON() as unknown as Record<string, unknown>),
      taskCount: total,
      completedTaskCount: completed,
      progress: m.status === "complete" ? 100 : total > 0 ? Math.round((completed / total) * 100) : 0,
    };
  });
}

/** Loads `:mid` within the project or responds 404. */
async function getMilestoneOr404(req: Request, res: Response, project: IProject): Promise<IMilestone | undefined> {
  const mid = param(req, "mid");
  const milestone = mid && !isInvalidObjectId(mid) ? await Milestone.findOne({ _id: mid, project: project._id }) : null;
  if (!milestone) {
    res.status(404).json({ error: "Milestone not found" });
    return undefined;
  }
  return milestone;
}

/** Manage + not archived (responds and returns false otherwise). */
function ensureCanManage(req: Request, res: Response, project: IProject): boolean {
  if (!canManageProject(req.user!, project)) {
    res.status(403).json({ error: "Only the project manager, its creator or an admin can manage milestones" });
    return false;
  }
  return ensureNotArchived(project, res);
}

/** Validates the editable fields onto `target`; returns an error message or null. */
function applyFields(body: MilestoneBody, target: IMilestone, creating: boolean): string | null {
  if (body.title !== undefined || creating) {
    if (typeof body.title !== "string" || !body.title.trim()) return "title is required";
    if (body.title.trim().length > 150) return "title must be 150 characters or fewer";
    target.title = body.title.trim();
  }
  if (body.summary !== undefined) {
    if (body.summary !== null && (typeof body.summary !== "string" || body.summary.trim().length > 2000)) {
      return "summary must be 2000 characters or fewer";
    }
    target.summary = typeof body.summary === "string" ? body.summary.trim() || undefined : undefined;
  }
  for (const field of ["startDate", "endDate"] as const) {
    const raw = body[field];
    if (raw === undefined) continue;
    if (raw === null || raw === "") {
      target[field] = null;
      continue;
    }
    const parsed = parseDateOnly(raw);
    if (!parsed) return `${field} must be a valid date (YYYY-MM-DD)`;
    target[field] = parsed;
  }
  if (target.startDate && target.endDate && target.startDate.getTime() > target.endDate.getTime()) {
    return "startDate must be on or before endDate";
  }
  return null;
}

/** GET /api/projects/:id/milestones */
export async function listMilestones(req: Request, res: Response): Promise<void> {
  const project = await getViewableProjectOr404(req, res);
  if (!project) return;
  const milestones = await Milestone.find({ project: project._id }).sort({ endDate: 1, createdAt: 1 });
  const items = await withProgress(milestones);
  res.json({ milestones: items, total: items.length, limit: null, offset: 0 });
}

/** POST /api/projects/:id/milestones — `{ title, summary?, startDate?, endDate? }`. */
export async function createMilestone(req: Request, res: Response): Promise<void> {
  const project = await getProjectOr404(req, res);
  if (!project || !ensureCanManage(req, res, project)) return;
  const milestone = new Milestone({ project: project._id, status: "incomplete" });
  const error = applyFields((req.body ?? {}) as MilestoneBody, milestone, true);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  await milestone.save();
  recordProjectActivity(project._id as mongoose.Types.ObjectId, req.user, "milestone_created", { title: milestone.title });
  pushProjectUpdate(project, "milestone-changed", { milestoneId: milestone._id.toString() });
  const [item] = await withProgress([milestone]);
  res.status(201).json({ milestone: item });
}

/** PATCH /api/projects/:id/milestones/:mid */
export async function updateMilestone(req: Request, res: Response): Promise<void> {
  const project = await getProjectOr404(req, res);
  if (!project || !ensureCanManage(req, res, project)) return;
  const milestone = await getMilestoneOr404(req, res, project);
  if (!milestone) return;
  const error = applyFields((req.body ?? {}) as MilestoneBody, milestone, false);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  await milestone.save();
  recordProjectActivity(project._id as mongoose.Types.ObjectId, req.user, "milestone_updated", { title: milestone.title });
  pushProjectUpdate(project, "milestone-changed", { milestoneId: milestone._id.toString() });
  const [item] = await withProgress([milestone]);
  res.json({ milestone: item });
}

/** PATCH /api/projects/:id/milestones/:mid/status — `{ status: "incomplete" | "complete" }`. */
export async function updateMilestoneStatus(req: Request, res: Response): Promise<void> {
  const project = await getProjectOr404(req, res);
  if (!project || !ensureCanManage(req, res, project)) return;
  const milestone = await getMilestoneOr404(req, res, project);
  if (!milestone) return;
  const status = (req.body ?? {}).status;
  if (typeof status !== "string" || !MILESTONE_STATUSES.includes(status as MilestoneStatus)) {
    res.status(400).json({ error: "status must be incomplete or complete" });
    return;
  }
  if (milestone.status !== status) {
    milestone.status = status as MilestoneStatus;
    milestone.completedAt = status === "complete" ? new Date() : null;
    await milestone.save();
    recordProjectActivity(
      project._id as mongoose.Types.ObjectId,
      req.user,
      status === "complete" ? "milestone_completed" : "milestone_reopened",
      { title: milestone.title }
    );
    pushProjectUpdate(project, "milestone-changed", { milestoneId: milestone._id.toString() });
  }
  const [item] = await withProgress([milestone]);
  res.json({ milestone: item });
}

/** DELETE /api/projects/:id/milestones/:mid — tasks keep existing without a milestone. */
export async function deleteMilestone(req: Request, res: Response): Promise<void> {
  const project = await getProjectOr404(req, res);
  if (!project || !ensureCanManage(req, res, project)) return;
  const milestone = await getMilestoneOr404(req, res, project);
  if (!milestone) return;
  await milestone.deleteOne();
  const result = await Task.updateMany({ milestone: milestone._id }, { $set: { milestone: null } });
  recordProjectActivity(project._id as mongoose.Types.ObjectId, req.user, "milestone_deleted", { title: milestone.title });
  pushProjectUpdate(project, "milestone-changed", { milestoneId: milestone._id.toString(), deleted: true });
  res.json({ success: true, tasksUpdated: result.modifiedCount });
}
