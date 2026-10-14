import type { Request, Response } from "express";
import mongoose from "mongoose";
import { logActivity } from "../lib/activityLog.js";
import { notifyDecision } from "../lib/changeRequests.js";
import { isProjectApprover } from "../lib/projectApproval.js";
import { isInvalidObjectId, param } from "../lib/projectAccess.js";
import { Brand } from "../models/Brand.js";
import { Campaign } from "../models/Campaign.js";
import { ChangeRequest, type IChangeRequest } from "../models/ChangeRequest.js";
import { APPROVED_PLAN, ManpowerPlan, type IManpowerRow } from "../models/ManpowerPlan.js";
import { Project } from "../models/Project.js";
import { User } from "../models/User.js";
import { MANPOWER_ROLES } from "../lib/manpowerRoles.js";
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
  if (request.kind === "campaign_new") {
    const campaign = await Campaign.findById(payload.campaign);
    if (!campaign) return "The campaign no longer exists";
    campaign.status = "approved";
    campaign.decidedBy = decider._id as mongoose.Types.ObjectId;
    campaign.decidedAt = new Date();
    await campaign.save();
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
  } else if (request.kind === "campaign_new") {
    await Campaign.updateOne({ _id: String((request.payload ?? {}).campaign ?? ""), status: "pending" }, { $set: { status: "rejected", decidedBy: user._id, decidedAt: new Date() } });
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

// ---------------------------------------------------------------------------
// Review page: GET /api/projects/approvals/changes/:id — the request plus the
// full context needed to decide (whole project / brand / plan version).
// ---------------------------------------------------------------------------

const ROLE_LABEL = new Map<string, string>([...MANPOWER_ROLES.map((r) => [r.key as string, r.label as string] as [string, string]), ["others", "Others"]]);

type TeamView = Array<{ role: string; label: string; people: string[] }>;

async function teamView(team: Array<{ role: string; users: Array<mongoose.Types.ObjectId | string> }>): Promise<TeamView> {
  const ids = [...new Set(team.flatMap((e) => e.users.map(String)))];
  const names = new Map((await User.find({ _id: { $in: ids } }).select("name").lean()).map((u) => [String(u._id), u.name]));
  return team
    .filter((e) => e.users.length)
    .map((e) => ({ role: e.role, label: ROLE_LABEL.get(e.role) ?? e.role, people: e.users.map((u) => names.get(String(u)) ?? "Unknown") }));
}

export async function getChangeRequest(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  if (!(await isProjectApprover(user._id as mongoose.Types.ObjectId))) {
    res.status(403).json({ error: "Only leadership can review changes" });
    return;
  }
  const id = param(req, "id");
  const request =
    id && !isInvalidObjectId(id)
      ? await ChangeRequest.findById(id).populate([
          { path: "requestedBy", select: "name email" },
          { path: "decidedBy", select: "name" },
          { path: "brand", select: "name" },
          { path: "project", select: "name code" },
        ])
      : null;
  if (!request) {
    res.status(404).json({ error: "Change request not found" });
    return;
  }
  const payload = (request.payload ?? {}) as Record<string, unknown>;
  const projectId = (request.project as unknown as { _id?: mongoose.Types.ObjectId } | null)?._id ?? null;
  const brandId = (request.brand as unknown as { _id?: mongoose.Types.ObjectId } | null)?._id ?? null;
  let context: Record<string, unknown> = {};

  if (request.kind === "project_change" && projectId) {
    const project = await Project.findById(projectId)
      .populate("manager", "name")
      .populate("status", "name")
      .populate("brand", "name")
      .populate("category", "name")
      .lean();
    if (project) {
      const proposedTeam = Array.isArray(payload.team) ? (payload.team as Array<{ role: string; users: string[] }>) : null;
      const p = project as unknown as Record<string, any>;
      context = {
        project: {
          _id: String(project._id),
          name: project.name,
          code: project.code,
          brand: p.brand?.name ?? null,
          type: project.naming?.type ?? null,
          month: project.naming?.month ?? null,
          manager: p.manager?.name ?? null,
          status: p.status?.name ?? null,
          category: p.category?.name ?? null,
          startDate: project.startDate ?? null,
          deadline: project.deadline ?? null,
          members: (project.members ?? []).length,
          archived: Boolean(project.archivedAt),
        },
        scope: {
          changed: typeof payload.summary === "string",
          current: project.summary ?? "",
          proposed: typeof payload.summary === "string" ? (payload.summary as string) : (project.summary ?? ""),
        },
        team: {
          changed: Boolean(proposedTeam),
          current: await teamView((project.team ?? []) as never),
          proposed: proposedTeam ? await teamView(proposedTeam) : await teamView((project.team ?? []) as never),
        },
      };
    }
  } else if (request.kind === "brand_edit" && brandId) {
    const brand = await Brand.findById(brandId).lean();
    if (brand) {
      const projects = await Project.countDocuments({ $or: [{ brand: brandId }, { "naming.brand": brandId }], archivedAt: null });
      const current = { name: brand.name, shortName: brand.shortName ?? "", color: brand.color, active: brand.active };
      context = { brand: { _id: String(brand._id), projects, current, proposed: { ...current, ...payload } } };
    }
  } else if (request.kind === "campaign_new" && brandId) {
    const [campaign, others, projects] = await Promise.all([
      Campaign.findById(payload.campaign).lean(),
      Campaign.find({ brand: brandId, status: "approved", active: true }).sort({ name: 1 }).select("name startMonth endMonth").lean(),
      Project.countDocuments({ $or: [{ brand: brandId }, { "naming.brand": brandId }], archivedAt: null }),
    ]);
    context = {
      campaign: campaign
        ? { name: campaign.name, startMonth: campaign.startMonth, endMonth: campaign.endMonth, status: campaign.status }
        : null,
      brandCampaigns: others.map((c) => ({ name: c.name, startMonth: c.startMonth, endMonth: c.endMonth })),
      brandProjects: projects,
    };
  } else if (request.kind === "manpower_plan" && request.month) {
    const [proposed, live] = await Promise.all([
      ManpowerPlan.findOne({ month: request.month, version: request.version }).select("version status rows.key rows.name").lean(),
      ManpowerPlan.findOne({ month: request.month, ...APPROVED_PLAN, version: { $lt: request.version ?? 0 } })
        .sort({ version: -1 })
        .select("version rows")
        .lean(),
    ]);
    if (proposed) {
      const before = new Map(((live?.rows ?? []) as IManpowerRow[]).map((r) => [r.key, JSON.stringify(r)]));
      const full = await ManpowerPlan.findOne({ month: request.month, version: request.version }).select("rows").lean();
      const changedKeys = ((full?.rows ?? []) as IManpowerRow[])
        .filter((r) => before.get(r.key) !== JSON.stringify(r))
        .map((r) => r.key);
      const nowKeys = new Set(((full?.rows ?? []) as IManpowerRow[]).map((r) => r.key));
      context = {
        plan: {
          month: request.month,
          version: proposed.version,
          status: proposed.status ?? "approved",
          liveVersion: live?.version ?? null,
          lines: (full?.rows ?? []).length,
          changedKeys,
          removed: ((live?.rows ?? []) as IManpowerRow[]).filter((r) => !nowKeys.has(r.key)).map((r) => r.name),
        },
      };
    }
  }
  res.json({ change: request.toJSON(), context });
}
