import type { Request, Response } from "express";
import { changeRequestsForApprovals } from "./changeRequests.js";
import mongoose from "mongoose";
import { canManageProject, isInvalidObjectId, param } from "../lib/projectAccess.js";
import {
  approvalView,
  decideProjectApproval,
  hashToken,
  isProjectApprover,
  requestProjectApproval,
} from "../lib/projectApproval.js";
import { formatNamingMonth } from "../lib/projectNaming.js";
import { Brand } from "../models/Brand.js";
import { Project, type IProject } from "../models/Project.js";
import { User } from "../models/User.js";

const REASON_MAX = 500;

function parseDecision(body: unknown): { decision: "approve" | "reject"; reason: string } | string {
  const b = (body ?? {}) as { decision?: unknown; reason?: unknown };
  if (b.decision !== "approve" && b.decision !== "reject") return "decision must be approve or reject";
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (reason.length > REASON_MAX) return `Keep the reason under ${REASON_MAX} characters`;
  if (b.decision === "reject" && !reason) return "Say why the project is rejected";
  return { decision: b.decision, reason };
}

/** The pending project and the approver a link token belongs to (or an error). */
async function byToken(token: string | undefined) {
  if (!token || token.length < 20 || token.length > 100) return { error: "This approval link isn't valid.", status: 404 } as const;
  const hash = hashToken(token);
  const project = await Project.findOne({ "approval.tokens.hash": hash });
  if (!project) {
    return {
      error: "This approval link has already been used or replaced. Open the project in the app to see its status.",
      status: 410,
    } as const;
  }
  const entry = project.approval!.tokens.find((t) => t.hash === hash)!;
  if (entry.expiresAt.getTime() < Date.now()) {
    return { error: "This approval link has expired. Open the project in the app to approve it.", status: 410 } as const;
  }
  const approver = await User.findById(entry.user).select("name email role").lean();
  if (!approver) return { error: "This approval link isn't valid.", status: 404 } as const;
  // Links sent before the approvers changed stop working for anyone no longer an approver.
  if (!(await isProjectApprover(approver._id))) return { error: "This approval link isn't valid.", status: 404 } as const;
  return { project, approver } as const;
}

async function summary(project: IProject) {
  const brandId = project.naming?.brand ?? project.brand ?? null;
  const [brand, manager, creator] = await Promise.all([
    brandId ? Brand.findById(brandId).select("name").lean() : null,
    project.manager ? User.findById(project.manager).select("name").lean() : null,
    User.findById(project.approval?.requestedBy ?? project.createdBy).select("name").lean(),
  ]);
  const teamIds = [...new Set((project.team ?? []).flatMap((t) => t.users.map(String)))];
  const team = teamIds.length ? await User.find({ _id: { $in: teamIds } }).select("name").lean() : [];
  return {
    _id: project._id.toString(),
    name: project.name,
    code: project.code,
    tag: project.tag ?? null,
    brand: brand?.name ?? null,
    type: project.naming?.type ?? null,
    month: project.naming?.month ? formatNamingMonth(project.naming.month) : null,
    manager: manager?.name ?? null,
    requestedBy: creator?.name ?? null,
    summary: project.summary ?? "",
    team: team.map((u) => u.name).sort(),
    approval: await approvalView(project),
  };
}

/** GET /api/project-approval/:token — public: what the approver is asked to approve. */
export async function getApprovalByToken(req: Request, res: Response): Promise<void> {
  const found = await byToken(param(req, "token"));
  if ("error" in found) {
    res.status(found.status ?? 400).json({ error: found.error });
    return;
  }
  res.json({ approver: { name: found.approver.name }, project: await summary(found.project) });
}

/** POST /api/project-approval/:token — public: { decision, reason? } from the emailed link. */
export async function decideByToken(req: Request, res: Response): Promise<void> {
  const parsed = parseDecision(req.body);
  if (typeof parsed === "string") {
    res.status(400).json({ error: parsed });
    return;
  }
  const found = await byToken(param(req, "token"));
  if ("error" in found) {
    res.status(found.status ?? 400).json({ error: found.error });
    return;
  }
  const error = await decideProjectApproval(found.project, found.approver as never, parsed.decision, parsed.reason, "email", req.ip);
  if (error) {
    res.status(409).json({ error });
    return;
  }
  const project = await Project.findById(found.project._id);
  res.json({ project: await summary(project!) });
}

async function loadProject(req: Request, res: Response): Promise<IProject | null> {
  const id = param(req, "id");
  if (!id || isInvalidObjectId(id)) {
    res.status(400).json({ error: "Invalid project ID" });
    return null;
  }
  const project = await Project.findById(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return null;
  }
  return project;
}

/** POST /api/projects/:id/approval — approvers decide in the app: { decision, reason? }. */
export async function decideInApp(req: Request, res: Response): Promise<void> {
  const parsed = parseDecision(req.body);
  if (typeof parsed === "string") {
    res.status(400).json({ error: parsed });
    return;
  }
  const project = await loadProject(req, res);
  if (!project) return;
  if (!(await isProjectApprover(req.user!._id as mongoose.Types.ObjectId))) {
    res.status(403).json({ error: "Only the project approvers can approve projects" });
    return;
  }
  const error = await decideProjectApproval(project, req.user!, parsed.decision, parsed.reason, "app", req.ip);
  if (error) {
    res.status(409).json({ error });
    return;
  }
  const updated = await Project.findById(project._id);
  res.json({ approval: await approvalView(updated!) });
}

/** POST /api/projects/:id/approval/request — manager/creator/admin: send for approval again (rejected or pending). */
export async function requestAgain(req: Request, res: Response): Promise<void> {
  const project = await loadProject(req, res);
  if (!project) return;
  if (!canManageProject(req.user!, project)) {
    res.status(403).json({ error: "Only the project manager, its creator or an admin can request approval" });
    return;
  }
  if (!project.approval?.status || project.approval.status === "approved") {
    res.status(409).json({ error: "This project is already approved" });
    return;
  }
  await requestProjectApproval(project._id as mongoose.Types.ObjectId, req.user!, { resubmit: true });
  const updated = await Project.findById(project._id);
  res.json({ approval: await approvalView(updated!) });
}

/**
 * GET /api/projects/approvals — the approver's queue: projects awaiting approval
 * (oldest first) and those decided in the last 30 days. Non-approvers get
 * `isApprover: false` and empty lists (the sidebar uses this to hide the menu).
 */
export async function listApprovals(req: Request, res: Response): Promise<void> {
  if (!(await isProjectApprover(req.user!._id as mongoose.Types.ObjectId))) {
    res.json({ isApprover: false, pending: [], recent: [], brands: { pending: [], recent: [] }, changes: { pending: [], recent: [] } });
    return;
  }
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [pending, recent] = await Promise.all([
    Project.find({ "approval.status": "pending", archivedAt: null }).sort({ "approval.requestedAt": 1 }).limit(100),
    Project.find({
      "approval.status": { $in: ["approved", "rejected"] },
      "approval.decidedAt": { $gte: since },
      "approval.decidedBy": { $ne: null },
      "approval.reason": { $ne: "Created by an approver" },
    })
      .sort({ "approval.decidedAt": -1 })
      .limit(30),
  ]);
  // New brands proposed for leadership approval (same approvers).
  const [brandPending, brandRecent] = await Promise.all([
    Brand.find({ status: "pending" }).sort({ createdAt: 1 }).populate("requestedBy", "name email").limit(100).lean(),
    Brand.find({ status: { $in: ["approved", "rejected"] }, decidedAt: { $gte: since }, requestedBy: { $ne: null } })
      .sort({ decidedAt: -1 })
      .populate("requestedBy", "name email")
      .populate("decidedBy", "name")
      .limit(30)
      .lean(),
  ]);
  const brandRow = (b: (typeof brandPending)[number]) => ({
    _id: String(b._id),
    name: b.name,
    shortName: b.shortName ?? "",
    status: b.status,
    requestedBy: b.requestedBy ?? null,
    decidedBy: (b as { decidedBy?: unknown }).decidedBy ?? null,
    decidedAt: b.decidedAt ?? null,
    rejectReason: b.rejectReason ?? "",
    createdAt: b.createdAt,
  });
  res.json({
    isApprover: true,
    pending: await Promise.all(pending.map(summary)),
    recent: await Promise.all(recent.map(summary)),
    brands: { pending: brandPending.map(brandRow), recent: brandRecent.map(brandRow) },
    // Scope / team, brand and manpower plan changes waiting for leadership.
    changes: await changeRequestsForApprovals(),
  });
}
