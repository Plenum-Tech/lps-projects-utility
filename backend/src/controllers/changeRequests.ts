import type { Request, Response } from "express";
import mongoose from "mongoose";
import { logActivity } from "../lib/activityLog.js";
import { notifyDecision } from "../lib/changeRequests.js";
import { isProjectApprover } from "../lib/projectApproval.js";
import { isInvalidObjectId, param } from "../lib/projectAccess.js";
import { Brand } from "../models/Brand.js";
import { ChangeRequest, type IChangeRequest } from "../models/ChangeRequest.js";
import { ManpowerPlan } from "../models/ManpowerPlan.js";
import { Project } from "../models/Project.js";
import { updateProjectCore, type ProjectBody } from "./projects.js";

// ---------------------------------------------------------------------------
// Leadership approvals of scope / team, brand and manpower plan changes
// (models/ChangeRequest.ts). Listed in GET /api/projects/approvals.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function row(r: IChangeRequest & { requestedBy?: unknown; decidedBy?: unknown; brand?: unknown; project?: unknown }): Row {
  const json = r.toJSON() as Row;
  return json;
}

/** Pending requests (oldest first) and the last 30 days' decisions. */
export async function changeRequestsForApprovals(): Promise<{ pending: Row[]; recent: Row[] }> {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const populate = [
    { path: "requestedBy", select: "name email" },
    { path: "decidedBy", select: "name" },
    { path: "brand", select: "name" },
    { path: "project", select: "name code" },
  ];
  const [pending, recent] = await Promise.all([
    ChangeRequest.find({ status: "pending" }).sort({ createdAt: 1 }).limit(200).populate(populate),
    ChangeRequest.find({ status: { $in: ["approved", "rejected"] }, decidedAt: { $gte: since } })
      .sort({ decidedAt: -1 })
      .limit(50)
      .populate(populate),
  ]);
  return { pending: pending.map(row), recent: recent.map(row) };
}

/** Applies an approved request. Returns an error message when it can't be applied any more. */
async function apply(request: IChangeRequest, decider: Parameters<typeof updateProjectCore>[0], ip: string | undefined): Promise<string | null> {
  const payload = request.payload ?? {};
  if (request.kind === "project_change") {
    const project = request.project ? await Project.findById(request.project) : null;
    if (!project) return "The project no longer exists";
    const result = await updateProjectCore(decider, project, payload as ProjectBody, ip, { skipApproval: true });
    return "error" in result ? result.error : null;
  }
  if (request.kind === "brand_edit") {
    const brand = request.brand ? await Brand.findById(request.brand) : null;
    if (!brand) return "The brand no longer exists";
    Object.assign(brand, payload);
    await brand.save();
    return null;
  }
  const plan = await ManpowerPlan.findOne({ month: request.month, version: request.version });
  if (!plan) return "That plan version no longer exists";
  if (plan.status !== "pending") return `That plan version is ${plan.status}`;
  plan.status = "approved";
  await plan.save();
  return null;
}

/** POST /api/projects/approvals/changes/:id — leadership; `{ decision: "approve" | "reject", reason? }`. */
export async function decideChangeRequest(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  if (!(await isProjectApprover(user._id as mongoose.Types.ObjectId))) {
    res.status(403).json({ error: "Only leadership can approve changes" });
    return;
  }
  const id = param(req, "id");
  const request = id && !isInvalidObjectId(id) ? await ChangeRequest.findById(id) : null;
  if (!request) {
    res.status(404).json({ error: "Change request not found" });
    return;
  }
  const body = (req.body ?? {}) as { decision?: unknown; reason?: unknown };
  if (body.decision !== "approve" && body.decision !== "reject") {
    res.status(400).json({ error: 'decision must be "approve" or "reject"' });
    return;
  }
  if (request.status !== "pending") {
    res.status(409).json({ error: `This change is already ${request.status}` });
    return;
  }
  const approve = body.decision === "approve";
  if (approve) {
    const failed = await apply(request, user, req.ip);
    if (failed) {
      res.status(409).json({ error: failed });
      return;
    }
  } else if (request.kind === "manpower_plan") {
    await ManpowerPlan.updateOne({ month: request.month, version: request.version, status: "pending" }, { $set: { status: "rejected" } });
  }
  request.status = approve ? "approved" : "rejected";
  request.decidedBy = user._id as mongoose.Types.ObjectId;
  request.decidedAt = new Date();
  request.reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  await request.save();
  logActivity({
    action: "settings_updated",
    actor: user,
    targetType: "change_request",
    targetId: request._id as mongoose.Types.ObjectId,
    targetName: request.title,
    details: { change: request.status, kind: request.kind, reason: request.reason || undefined },
    ip: req.ip,
  });
  notifyDecision(request, user, approve);
  res.json({ change: request.toJSON() });
}
