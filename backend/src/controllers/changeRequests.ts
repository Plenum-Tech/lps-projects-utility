import type { Request, Response } from "express";
import mongoose from "mongoose";
import { logActivity } from "../lib/activityLog.js";
import { isLeadershipActor, isScopeChange, notifyDecision } from "../lib/changeRequests.js";
import { canManageBrand } from "../lib/brandAccess.js";
import { isProjectApprover } from "../lib/projectApproval.js";
import { isInvalidObjectId, param } from "../lib/projectAccess.js";
import { Brand } from "../models/Brand.js";
import { ChangeRequest, type IChangeRequest } from "../models/ChangeRequest.js";
import { APPROVED_PLAN, ManpowerPlan, type IManpowerRow } from "../models/ManpowerPlan.js";
import { Project } from "../models/Project.js";
import { User } from "../models/User.js";
import { MANPOWER_ROLES } from "../lib/manpowerRoles.js";
import { applyAddMembers, applyRemoveMember, updateProjectCore, type ProjectBody } from "./projects.js";
import { syncPlanToProjects } from "./manpower.js";
import { diffScope, parseMatchRows } from "../lib/scopeMatch.js";
import { ensureBaseVersion, recordScopeVersion } from "../lib/scopeVersions.js";

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
    // Member adds / removals (POST / DELETE members), then the rest of the change.
    const { addMembers, removeMembers, memberRate, ...rest } = payload as Record<string, unknown>;
    const ids = (v: unknown) => (Array.isArray(v) ? v.map(String).filter((id) => mongoose.isValidObjectId(id)) : []);
    if (ids(addMembers).length) {
      const added = await applyAddMembers(project, ids(addMembers), typeof memberRate === "number" ? memberRate : 0, decider);
      if ("error" in added) return added.error;
    }
    for (const id of ids(removeMembers)) {
      if (!(await applyRemoveMember(project, new mongoose.Types.ObjectId(id), decider))) return "The project manager can't be removed — change the manager first";
    }
    if (Object.keys(rest).length === 0) return null;
    const result = await updateProjectCore(decider, project, rest as ProjectBody, ip, { skipApproval: true });
    return "error" in result ? result.error : null;
  }
  if (request.kind === "project_move") {
    const { from, to, projectIds } = payload as { from?: string; to?: string; projectIds?: string[] };
    if (!from || !to || !Array.isArray(projectIds)) return "This move request is incomplete";
    const { applyBrandMove } = await import("../lib/brandMove.js");
    const result = await applyBrandMove(from, to, projectIds.map(String), decider, ip);
    if ("error" in result) return result.error;
    if (result.moved === 0 && result.errors.length) return result.errors.join(" ");
    return null;
  }
  if (request.kind === "brand_edit") {
    const brand = request.brand ? await Brand.findById(request.brand) : null;
    if (!brand) return "The brand no longer exists";
    // Renames don't go through approval any more (admins rename at once); a name in an older
    // pending request is still applied with its follow-ups. Still free?
    const { renameProjects, ...changes } = payload as Record<string, unknown>;
    if (typeof changes.name === "string" && changes.name !== brand.name) {
      const { brandNameKey } = await import("../models/Brand.js");
      if (await Brand.exists({ nameKey: brandNameKey(changes.name), _id: { $ne: brand._id } })) return `A brand named "${changes.name}" already exists`;
    }
    const oldName = brand.name;
    const previous = (brand.scopeItems ?? []).map((r) => ({ unit: r.unit, quantity: r.quantity, languages: r.languages, languageList: r.languageList ? [...r.languageList] : [], sizes: r.sizes }));
    const rowsChanged = Boolean((payload as Record<string, unknown>).scopeItems);
    const textChanged = typeof (payload as Record<string, unknown>).scopeText === "string";
    const scopeChanged = rowsChanged || textChanged;
    // The scope as it was becomes version 1 when the brand has no history yet.
    if (scopeChanged) await ensureBaseVersion(brand);
    Object.assign(brand, changes);
    await brand.save();
    // The name: structured project names (unless the requester unticked it) and plan lines follow.
    if (typeof changes.name === "string" && changes.name !== oldName) {
      const { afterBrandRename } = await import("./brands.js");
      await afterBrandRename(brand, oldName, renameProjects !== false, decider, ip);
    }
    // A new brand scope reaches the brand's open projects (their scope is locked to it).
    if (scopeChanged) {
      const { applyBrandScopeToProjects, applyBrandScopeTextToProjects } = await import("../lib/brandFlow.js");
      if (rowsChanged) await applyBrandScopeToProjects(brand, previous);
      if (textChanged) await applyBrandScopeTextToProjects(brand);
      await recordScopeVersion(brand, "approval", request.requestedBy, decider._id as mongoose.Types.ObjectId);
    }
    return null;
  }
  const plan = await ManpowerPlan.findOne({ month: request.month, version: request.version });
  if (!plan) return "That plan version no longer exists";
  if (plan.status !== "pending") return `That plan version is ${plan.status}`;
  const live = await ManpowerPlan.findOne({ month: request.month, ...APPROVED_PLAN }).sort({ version: -1 }).select("version rows").lean();
  // Approved saves rebase the pending version, so it is normally made on `live`. If the approved
  // plan moved on anyway, its changes are kept: the pending changes are laid onto it.
  if (live && plan.baseVersion != null && plan.baseVersion !== live.version) {
    const { applyPlanDelta, planDelta, withoutConflicts } = await import("../lib/manpowerMerge.js");
    const base = ((await ManpowerPlan.findOne({ month: request.month, version: plan.baseVersion }).select("rows").lean())?.rows ?? []) as IManpowerRow[];
    const liveRows = live.rows as IManpowerRow[];
    plan.set("rows", applyPlanDelta(liveRows, withoutConflicts(planDelta(base, plan.rows as IManpowerRow[]), planDelta(base, liveRows))));
    plan.baseVersion = live.version;
  }
  plan.status = "approved";
  await plan.save();
  // The approved lines' people become the linked projects' teams.
  await syncPlanToProjects(plan.month, (live?.rows ?? []) as IManpowerRow[], plan.rows as IManpowerRow[], decider, ip);
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

/** What the viewer of a change may do: decide (leadership), resend / withdraw / dismiss (the requester). */
async function viewerOf(request: IChangeRequest, user: NonNullable<Request["user"]>) {
  const requesterId = (request.requestedBy as unknown as { _id?: mongoose.Types.ObjectId })?._id ?? request.requestedBy;
  const isRequester = String(requesterId) === String(user._id);
  const leadership = await isLeadershipActor(user);
  const scope = request.kind === "brand_edit" && Boolean(request.brand) && isScopeChange(request);
  return {
    isRequester,
    canDecide: await isProjectApprover(user._id as mongoose.Types.ObjectId),
    canWithdraw: request.status === "pending" && (isRequester || leadership),
    // A brand scope change waiting or rejected: edit it on the brand page and send it again.
    canResend: scope && (request.status === "pending" || request.status === "rejected") && (isRequester || canManageBrand(user)),
  };
}

/**
 * POST /api/projects/approvals/changes/:id/withdraw — the requester or leadership; only while pending.
 * The request is "withdrawn": it leaves the approvals list and counts, nothing is applied.
 */
export async function withdrawChangeRequest(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const id = param(req, "id");
  const request = id && !isInvalidObjectId(id) ? await ChangeRequest.findById(id) : null;
  if (!request) {
    res.status(404).json({ error: "Change request not found" });
    return;
  }
  const isRequester = String(request.requestedBy) === String(user._id);
  if (!isRequester && !(await isLeadershipActor(user))) {
    res.status(403).json({ error: "Only the person who asked for the change (or leadership) can withdraw it" });
    return;
  }
  if (request.status !== "pending") {
    res.status(409).json({ error: `This change is already ${request.status}` });
    return;
  }
  request.status = "withdrawn";
  request.decidedBy = user._id as mongoose.Types.ObjectId;
  request.decidedAt = new Date();
  await request.save();
  // A withdrawn plan request takes its pending version with it (it no longer shows as waiting).
  if (request.kind === "manpower_plan" && request.month && request.version != null) {
    await ManpowerPlan.updateOne({ month: request.month, version: request.version, status: "pending" }, { $set: { status: "superseded" } });
  }
  logActivity({
    action: "settings_updated",
    actor: user,
    targetType: "change_request",
    targetId: request._id as mongoose.Types.ObjectId,
    targetName: request.title,
    details: { change: "withdrawn", kind: request.kind, by: isRequester ? "requester" : "leadership" },
    ip: req.ip,
  });
  res.json({ change: request.toJSON() });
}

/** POST /api/projects/approvals/changes/:id/dismiss — hides a rejected brand scope change's banner on the brand page. */
export async function dismissChangeRequest(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const id = param(req, "id");
  const request = id && !isInvalidObjectId(id) ? await ChangeRequest.findById(id) : null;
  if (!request) {
    res.status(404).json({ error: "Change request not found" });
    return;
  }
  const isRequester = String(request.requestedBy) === String(user._id);
  if (!isRequester && !canManageBrand(user) && !(await isLeadershipActor(user))) {
    res.status(403).json({ error: "Only the person who asked for the change can dismiss it" });
    return;
  }
  if (request.status !== "rejected") {
    res.status(409).json({ error: "Only a rejected change can be dismissed" });
    return;
  }
  if (!request.dismissedAt) {
    request.dismissedAt = new Date();
    await request.save();
  }
  res.json({ change: request.toJSON() });
}

/** GET /api/projects/approvals/changes/:id — leadership, or the person who asked for the change. */
export async function getChangeRequest(req: Request, res: Response): Promise<void> {
  const user = req.user!;
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
  const viewer = await viewerOf(request, user);
  if (!viewer.canDecide && !viewer.isRequester) {
    res.status(403).json({ error: "Only leadership can review changes" });
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
        scopeRows: {
          changed: Array.isArray(payload.scopeItems),
          current: project.scopeItems ?? [],
          proposed: Array.isArray(payload.scopeItems) ? payload.scopeItems : (project.scopeItems ?? []),
        },
        // What is added / removed / changed against the project's current scope.
        ...(Array.isArray(payload.scopeItems)
          ? { scopeDiff: diffScope(parseMatchRows(project.scopeItems ?? []), parseMatchRows(payload.scopeItems)) }
          : {}),
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
      const { name, shortName, color, active } = { ...current, ...payload } as typeof current;
      context = { brand: { _id: String(brand._id), projects, current, proposed: { name, shortName, color, active } } };
      // A brand scope change: the rows now and proposed, what is missing / added / changed against
      // the current version, and how close the proposed rows are to the agreement.
      if (Array.isArray(payload.scopeItems)) {
        const currentRows = parseMatchRows(brand.scopeItems ?? []);
        const proposedRows = parseMatchRows(payload.scopeItems);
        const match = (payload.scopeMatch ?? null) as { score?: number; missing?: string[]; extra?: string[]; changed?: unknown[] } | null;
        context.scopeRows = { changed: true, current: brand.scopeItems ?? [], proposed: payload.scopeItems };
        context.scopeDiff = diffScope(currentRows, proposedRows);
        if (match && typeof match.score === "number") context.scopeMatch = match;
      }
      // The agreement's stated total: the rows are checked against it (advice only).
      if ("scopeTotal" in payload || brand.scopeTotal) {
        context.scopeTotal = {
          changed: "scopeTotal" in payload,
          current: brand.scopeTotal ?? null,
          proposed: "scopeTotal" in payload ? (payload.scopeTotal ?? null) : (brand.scopeTotal ?? null),
        };
        // The rows the check is made on, when the request doesn't change them.
        if (!context.scopeRows) context.scopeRows = { changed: false, current: brand.scopeItems ?? [], proposed: brand.scopeItems ?? [] };
      }
      // "Other scope" (the scope kept as text): before / after in full.
      if (typeof payload.scopeText === "string") {
        context.scopeText = { changed: true, current: brand.scopeText ?? "", proposed: payload.scopeText };
        const match = (payload.scopeMatch ?? null) as { score?: number } | null;
        if (!context.scopeMatch && match && typeof match.score === "number") context.scopeMatch = match;
      }
    }
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
  res.json({ change: request.toJSON(), context, viewer });
}
