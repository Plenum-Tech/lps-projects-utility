import type { Request, Response } from "express";
import mongoose from "mongoose";
import { logActivity } from "../lib/activityLog.js";
import { canCreateBrand, canManageBrand, canRenameBrand } from "../lib/brandAccess.js";
import { runBrandSplit, type BrandSplitSetup } from "../lib/brandSplit.js";
import { isDuplicateKeyError } from "../lib/errors.js";
import { copyGridFsFile, deleteFromGridFs, openGridFsDownload, uploadToGridFs } from "../lib/gridfs.js";
import { isLeadershipUser } from "../lib/leadership.js";
import { linkProjectsToRows } from "../lib/manpower/match.js";
import { canEditManpower } from "../lib/manpowerAccess.js";
import { MANPOWER_ROLE_KEYS, MANPOWER_ROLES } from "../lib/manpowerRoles.js";
import { isInvalidObjectId, param } from "../lib/projectAccess.js";
import { isProjectApprover } from "../lib/projectApproval.js";
import { currentAppMonth, projectMonth } from "../lib/projectExpiry.js";
import { scopeText, type ScopeItem } from "../lib/scopeUnits.js";
import { Brand, brandNameKey, BRAND_LIMITS, type IBrand } from "../models/Brand.js";
import { latestPlan, ManpowerPlan, type IManpowerRow } from "../models/ManpowerPlan.js";
import { Project } from "../models/Project.js";
import { ProjectFile } from "../models/ProjectFile.js";
import { TimeLog } from "../models/TimeLog.js";
import { User, type IUser } from "../models/User.js";
import { ChangeRequest } from "../models/ChangeRequest.js";
import { BrandScopeVersion } from "../models/BrandScopeVersion.js";
import { isLeadershipActor } from "../lib/changeRequests.js";
import { FieldError, notifyBrandApprovalRequested, parseName, parseOrganisation, sendFieldError, serialize } from "./brands.js";
import { monthTeamLoad } from "./projects.js";

// ---------------------------------------------------------------------------
// Brands section (/brands): one call for the overview + allocation grid, one
// for a brand's page (team, utilisation, projects, documents), brand splits and
// the brand's scope files. The team shown is the month's manpower plan (the same
// data as the Manpower page) plus the teams of the brand's current projects.
// ---------------------------------------------------------------------------

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

type Person = { _id: string; name: string };
type RoleMap = Record<string, Person[]>;

function monthOf(req: Request): string | null {
  const raw = typeof req.query.month === "string" && req.query.month ? req.query.month : currentAppMonth();
  return MONTH.test(raw) ? raw : null;
}

const monthStart = (month: string) => new Date(`${month}-01T00:00:00.000Z`);
const nextMonthStart = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 1));
};

/** Brands the user may see: approved ones (+ own proposals); admins see pending ones too. Rejected never. */
function visibleBrands(user: IUser): Record<string, unknown> {
  const notRejected = { status: { $ne: "rejected" } };
  return user.role === "admin"
    ? notRejected
    : { $and: [notRejected, { $or: [{ status: { $exists: false } }, { status: "approved" }, { requestedBy: user._id }] }] };
}

/** Reads the people / utilisation numbers: admins (leadership included), heads and brand creators. */
function canSeeUtilisation(user: IUser): boolean {
  return user.role === "admin" || user.role === "head" || canCreateBrand(user);
}

interface LeanProject {
  _id: mongoose.Types.ObjectId;
  name: string;
  code: string;
  brand?: mongoose.Types.ObjectId | null;
  naming?: { brand?: mongoose.Types.ObjectId; type: string; month: string; title: string } | null;
  startDate?: Date;
  deadline?: Date | null;
  manpowerRow?: string | null;
  scopeItems?: ScopeItem[];
  team?: Array<{ role: string; users: mongoose.Types.ObjectId[] }>;
}

const brandOf = (p: LeanProject) => (p.brand ? String(p.brand) : p.naming?.brand ? String(p.naming.brand) : null);

/**
 * The month's plan version waiting for leadership approval (if any): who saved it, when, its
 * note and the change request to open. Its rows are shown as the proposed team on the Brands pages.
 */
async function pendingPlanOf(month: string) {
  const pending = await ManpowerPlan.findOne({ month, status: "pending" }).sort({ version: -1 }).populate("createdBy", "name").lean();
  if (!pending) return null;
  const request = await ChangeRequest.findOne({ kind: "manpower_plan", status: "pending", month, version: pending.version }).select("_id").lean();
  const by = pending.createdBy as unknown as { _id: mongoose.Types.ObjectId; name?: string } | null;
  const { pendingRequestInfo } = await import("./manpower.js");
  return {
    info: {
      version: pending.version,
      by: by ? { _id: String(by._id), name: by.name ?? "Someone" } : null,
      at: pending.createdAt,
      note: pending.note ?? "",
      changeRequestId: request ? String(request._id) : null,
      // Sent to leadership or not, and what is new since (the "Send for approval" banner).
      request: await pendingRequestInfo(month, pending.version),
    },
    rows: (pending.rows ?? []) as IManpowerRow[],
  };
}

/** A brand's plan lines → people per role (each person once) and the roles marked not needed. */
function rolesOfLines(lines: IManpowerRow[], person: (id: string) => Person): { roles: RoleMap; notNeeded: string[] } {
  const roles: RoleMap = {};
  const notNeeded: string[] = [];
  for (const line of lines) {
    for (const c of line.cells) {
      if (c.notNeeded) {
        if (!notNeeded.includes(c.role)) notNeeded.push(c.role);
        continue;
      }
      for (const u of c.users ?? []) {
        const list = (roles[c.role] ??= []);
        if (!list.some((x) => x._id === String(u))) list.push(person(String(u)));
      }
    }
  }
  return { roles, notNeeded: notNeeded.filter((r) => !roles[r]?.length) };
}

/** Everything the Brands pages need for one month, computed once. */
async function monthContext(month: string, user: IUser, onlyBrand?: mongoose.Types.ObjectId) {
  const brandFilter = onlyBrand ? { _id: onlyBrand } : visibleBrands(user);
  const [brands, plan, pending, projects, allBrandNames, load] = await Promise.all([
    Brand.find(brandFilter).sort({ nameKey: 1, name: 1 }).lean(),
    latestPlan(month),
    pendingPlanOf(month),
    Project.find({ archivedAt: null })
      .select("name code brand naming startDate deadline manpowerRow scopeItems team")
      .lean<LeanProject[]>(),
    Brand.find({}).select("name").lean(),
    monthTeamLoad(month),
  ]);
  const rows = (plan?.toObject().rows ?? []) as IManpowerRow[];
  const brandNames = new Map(allBrandNames.map((b) => [String(b._id), b.name]));
  const links = linkProjectsToRows(
    month,
    rows.map((r) => ({ key: r.key, brand: r.brand ? String(r.brand) : null, type: r.type, name: r.name })),
    projects.map((p) => ({
      _id: String(p._id),
      name: p.name,
      brand: brandOf(p),
      naming: p.naming ? { type: p.naming.type, month: p.naming.month, title: p.naming.title } : null,
      deadline: p.deadline ?? null,
      manpowerRow: p.manpowerRow ?? null,
    })),
    brandNames
  );
  const start = monthStart(month);
  // Current: the month's projects, and earlier monthly projects still running into it.
  const isCurrent = (p: LeanProject) => {
    const m = projectMonth({ name: p.name, naming: p.naming as never, deadline: p.deadline ?? null });
    return m === month || Boolean(m && m < month && p.deadline && p.deadline >= start);
  };
  const projectsByBrand = new Map<string, LeanProject[]>();
  for (const p of projects) {
    const b = brandOf(p);
    if (b) projectsByBrand.set(b, [...(projectsByBrand.get(b) ?? []), p]);
  }

  // Names of everyone referenced.
  const userIds = new Set<string>();
  for (const r of rows) for (const c of r.cells) for (const u of c.users ?? []) userIds.add(String(u));
  for (const b of brands) for (const l of b.leads ?? []) userIds.add(String(l));
  for (const p of projects) if (isCurrent(p)) for (const t of p.team ?? []) for (const u of t.users) userIds.add(String(u));
  // The pending version's people are named too (proposed cells), but don't count in the load.
  const pendingIds = new Set<string>();
  for (const r of pending?.rows ?? []) for (const c of r.cells) for (const u of c.users ?? []) if (!userIds.has(String(u))) pendingIds.add(String(u));
  const users = await User.find({ _id: { $in: [...userIds, ...pendingIds] } }).select("name").lean();
  const nameOf = new Map(users.map((u) => [String(u._id), u.name]));
  const person = (id: string): Person => ({ _id: id, name: nameOf.get(id) ?? "Unknown" });

  // Per person: brands this month (plan lines + current project teams); plan roles held anywhere (the pool).
  const brandsOfPerson = new Map<string, Set<string>>();
  const addBrand = (u: string, b: string) => brandsOfPerson.set(u, (brandsOfPerson.get(u) ?? new Set()).add(b));
  const pool: Record<string, string[]> = {};
  for (const r of rows) {
    for (const c of r.cells) {
      for (const u of c.users ?? []) {
        const id = String(u);
        if (r.brand) addBrand(id, String(r.brand));
        if (!(pool[c.role] ??= []).includes(id)) pool[c.role]!.push(id);
      }
    }
  }
  for (const p of projects) {
    const b = brandOf(p);
    if (!b || !isCurrent(p)) continue;
    for (const t of p.team ?? []) for (const u of t.users) addBrand(String(u), b);
  }

  const fileCounts = new Map<string, number>();
  {
    const counts = await ProjectFile.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>([{ $group: { _id: "$project", n: { $sum: 1 } } }]);
    const projectBrand = new Map(projects.map((p) => [String(p._id), brandOf(p)]));
    for (const c of counts) {
      const b = projectBrand.get(String(c._id));
      if (b) fileCounts.set(b, (fileCounts.get(b) ?? 0) + c.n);
    }
  }

  const rowNames = new Map(rows.map((r) => [r.key, r.name]));
  const summaries = brands.map((b) => {
    const id = String(b._id);
    const lines = rows.filter((r) => r.brand && String(r.brand) === id);
    const { roles, notNeeded } = rolesOfLines(lines, person);
    // The team as proposed by the version waiting for approval (null: nothing pending this month).
    const pendingTeam = pending ? rolesOfLines(pending.rows.filter((r) => r.brand && String(r.brand) === id), person) : null;
    const all = projectsByBrand.get(id) ?? [];
    const current = all.filter(isCurrent);
    const team = new Set<string>(Object.values(roles).flatMap((list) => list.map((x) => x._id)));
    for (const p of current) for (const t of p.team ?? []) for (const u of t.users) team.add(String(u));
    const scopeItems = (b.scopeItems ?? []).map((r) => ({ unit: r.unit, what: r.what ?? "", quantity: r.quantity, languages: r.languages, languageList: r.languageList ?? [], sizes: r.sizes, source: r.source ?? "" }));
    const leads = (b.leads ?? []).map((l) => person(String(l)));
    return {
      _id: id,
      name: b.name,
      organisation: b.organisation ?? "",
      status: b.status ?? "approved",
      isPitch: Boolean(b.isPitch),
      monthlyRetainer: Boolean(b.monthlyRetainer),
      active: current.length > 0 || lines.length > 0,
      checks: { scope: scopeItems.length > 0, docs: (b.scopeFiles ?? []).length > 0, plan: lines.length > 0, lead: leads.length > 0 },
      scopeItems,
      // How close the scope is to its agreement (advice only; null = not compared yet).
      scopeMatch: b.scopeMatch && typeof b.scopeMatch.score === "number"
        ? { score: b.scopeMatch.score, missing: b.scopeMatch.missing ?? [], extra: b.scopeMatch.extra ?? [], changed: b.scopeMatch.changed ?? [], source: b.scopeMatch.source, at: b.scopeMatch.at }
        : null,
      scopeFiles: (b.scopeFiles ?? []).length,
      projectFiles: fileCounts.get(id) ?? 0,
      planLines: lines.map((l) => ({ key: l.key, name: l.name, section: l.section })),
      roles,
      notNeeded,
      pending: pendingTeam,
      leads,
      people: [...team],
      projectCount: all.length,
      current: current.map((p) => ({
        _id: String(p._id),
        name: p.name,
        code: p.code,
        startDate: p.startDate ?? null,
        deadline: p.deadline ?? null,
        scope: p.scopeItems?.length ? scopeText(p.scopeItems) : "",
        planLine: links.has(String(p._id)) ? { key: links.get(String(p._id))!, name: rowNames.get(links.get(String(p._id))!) ?? "" } : null,
      })),
    };
  });

  const people: Record<string, { name: string; projects: number; brands: number }> = {};
  for (const id of new Set([...userIds])) {
    people[id] = { name: nameOf.get(id) ?? "Unknown", projects: load.load[id] ?? 0, brands: brandsOfPerson.get(id)?.size ?? 0 };
  }
  // Every referenced person's name (plan, proposed plan, leads, teams), for everyone who sees the cells.
  const names = Object.fromEntries(users.map((u) => [String(u._id), u.name]));
  return { month, plan, pendingPlan: pending?.info ?? null, rows, summaries, people, names, pool, max: load.max, projectsByBrand, isCurrent };
}

/** Leadership and plan editors: the plan's live changes not emailed yet ("Send email"). */
async function planNoticeFor(month: string, user: IUser) {
  if (!canEditManpower(user) && !(await isLeadershipActor(user))) return null;
  const { planNoticeInfo } = await import("../lib/manpowerNotice.js");
  return planNoticeInfo(month, String(user._id));
}

async function permissions(user: IUser) {
  return {
    canCreate: canCreateBrand(user),
    canManage: canManageBrand(user),
    canRename: canRenameBrand(user),
    canEditPlan: canEditManpower(user),
    canApprove: await isProjectApprover(user._id as mongoose.Types.ObjectId),
    // Plan saves are approved at once (leadership); else they wait for approval and edits start from the pending version.
    planSavesApproved: await isLeadershipActor(user),
    canSeeUtilisation: canSeeUtilisation(user),
  };
}

/** GET /api/brands/overview?month=YYYY-MM — every visible brand with its checks, plan lines, team and current projects. */
export async function brandOverview(req: Request, res: Response): Promise<void> {
  const month = monthOf(req);
  if (!month) {
    res.status(400).json({ error: "month must be YYYY-MM" });
    return;
  }
  const user = req.user!;
  const ctx = await monthContext(month, user);
  const showPeople = canSeeUtilisation(user);
  res.json({
    month,
    planVersion: ctx.plan?.version ?? null,
    pendingPlan: ctx.pendingPlan,
    planNotice: await planNoticeFor(month, user),
    max: ctx.max,
    roles: MANPOWER_ROLES,
    ...(await permissions(user)),
    brands: ctx.summaries.map((b) => ({ ...b, people: b.people.length })),
    names: ctx.names,
    people: showPeople ? ctx.people : {},
    pool: showPeople ? ctx.pool : {},
  });
}

async function findBrandOr404(req: Request, res: Response): Promise<IBrand | null> {
  const id = param(req, "id");
  const brand = id && !isInvalidObjectId(id) ? await Brand.findById(id) : null;
  const user = req.user!;
  const visible =
    brand &&
    (user.role === "admin" || !brand.status || brand.status === "approved" || String(brand.requestedBy ?? "") === String(user._id));
  if (!brand || !visible) {
    res.status(404).json({ error: "Brand not found" });
    return null;
  }
  return brand;
}

/**
 * The brand's latest scope change request (rows, "Other scope" or the agreement total) when it is
 * still waiting (`pendingScope`) or was rejected and not dismissed (`lastRejectedScope`): what it
 * proposes, who sent it, and what the viewer may do with it (edit and resend, withdraw).
 */
async function scopeRequests(brand: IBrand, user: IUser) {
  const latest = await ChangeRequest.findOne({
    kind: "brand_edit",
    brand: brand._id,
    status: { $in: ["pending", "approved", "rejected", "withdrawn"] },
    $or: [{ "payload.scopeItems": { $exists: true } }, { "payload.scopeText": { $exists: true } }, { "payload.scopeTotal": { $exists: true } }],
  })
    .sort({ createdAt: -1 })
    .populate("requestedBy", "name")
    .populate("decidedBy", "name");
  if (!latest || (latest.status !== "pending" && !(latest.status === "rejected" && !latest.dismissedAt))) return {};
  // A rejection the scope has moved on from (leadership saved a new version since) isn't shown.
  if (latest.status === "rejected" && (await BrandScopeVersion.exists({ brand: brand._id, at: { $gt: latest.decidedAt ?? latest.updatedAt } }))) return {};
  const payload = (latest.payload ?? {}) as Record<string, unknown>;
  const requester = latest.requestedBy as unknown as { _id: mongoose.Types.ObjectId; name?: string } | null;
  const decider = latest.decidedBy as unknown as { _id: mongoose.Types.ObjectId; name?: string } | null;
  const isRequester = String(requester?._id ?? "") === String(user._id);
  const rowsChanged = Array.isArray(payload.scopeItems);
  const textChanged = typeof payload.scopeText === "string";
  const totalChanged = "scopeTotal" in payload;
  const view = {
    _id: String(latest._id),
    requestedBy: requester ? { _id: String(requester._id), name: requester.name ?? "Someone" } : null,
    createdAt: latest.createdAt,
    // What the request proposes; the parts it doesn't change are the current ones.
    scopeItems: rowsChanged ? (payload.scopeItems as unknown[]) : (brand.scopeItems ?? []),
    scopeText: textChanged ? String(payload.scopeText) : (brand.scopeText ?? ""),
    scopeTotal: totalChanged ? (payload.scopeTotal ?? null) : (brand.scopeTotal ?? null),
    rowsChanged,
    textChanged,
    totalChanged,
    scopeMatch: payload.scopeMatch && typeof (payload.scopeMatch as { score?: unknown }).score === "number" ? payload.scopeMatch : null,
    canEdit: isRequester || canManageBrand(user),
  };
  if (latest.status === "pending") return { pendingScope: { ...view, canWithdraw: isRequester || (await isLeadershipActor(user)) } };
  return {
    lastRejectedScope: {
      ...view,
      decidedBy: decider ? { _id: String(decider._id), name: decider.name ?? "Leadership" } : null,
      decidedAt: latest.decidedAt,
      reason: latest.reason ?? "",
      canDismiss: view.canEdit,
    },
  };
}

/** GET /api/brands/:id/detail?month=YYYY-MM — the brand page. */
export async function brandDetail(req: Request, res: Response): Promise<void> {
  const month = monthOf(req);
  if (!month) {
    res.status(400).json({ error: "month must be YYYY-MM" });
    return;
  }
  const brand = await findBrandOr404(req, res);
  if (!brand) return;
  const user = req.user!;
  const ctx = await monthContext(month, user, brand._id as mongoose.Types.ObjectId);
  const summary = ctx.summaries[0]!;
  const all = ctx.projectsByBrand.get(String(brand._id)) ?? [];

  // Utilisation of the brand's people: roles here, projects vs max, brands, hours this month.
  let utilisation: Array<Record<string, unknown>> | null = null;
  if (canSeeUtilisation(user)) {
    const rolesOf = new Map<string, Set<string>>();
    const add = (u: string, role: string) => rolesOf.set(u, (rolesOf.get(u) ?? new Set()).add(role));
    for (const [role, list] of Object.entries(summary.roles)) for (const p of list) add(p._id, role);
    for (const p of all.filter(ctx.isCurrent)) for (const t of p.team ?? []) for (const u of t.users) add(String(u), t.role);
    const ids = [...rolesOf.keys()];
    const brandProjectIds = all.map((p) => p._id);
    const hours = ids.length
      ? await TimeLog.aggregate<{ _id: mongoose.Types.ObjectId; total: number; brand: number }>([
          {
            $match: {
              user: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) },
              status: { $in: ["approved", "pending"] },
              startTime: { $gte: monthStart(month), $lt: nextMonthStart(month) },
            },
          },
          {
            $group: {
              _id: "$user",
              total: { $sum: "$durationMinutes" },
              brand: { $sum: { $cond: [{ $in: ["$project", brandProjectIds] }, "$durationMinutes", 0] } },
            },
          },
        ])
      : [];
    const hoursOf = new Map(hours.map((h) => [String(h._id), h]));
    utilisation = ids
      .map((id) => ({
        user: { _id: id, name: ctx.people[id]?.name ?? "Unknown" },
        roles: [...rolesOf.get(id)!].sort((a, b) => MANPOWER_ROLE_KEYS.indexOf(a) - MANPOWER_ROLE_KEYS.indexOf(b)),
        projects: ctx.people[id]?.projects ?? 0,
        max: ctx.max,
        brands: ctx.people[id]?.brands ?? 0,
        hours: Math.round(((hoursOf.get(id)?.total ?? 0) / 60) * 10) / 10,
        brandHours: Math.round(((hoursOf.get(id)?.brand ?? 0) / 60) * 10) / 10,
      }))
      .sort((a, b) => b.projects - a.projects || a.user.name.localeCompare(b.user.name));
  }

  const showPeople = canSeeUtilisation(user);
  res.json({
    month,
    planVersion: ctx.plan?.version ?? null,
    pendingPlan: ctx.pendingPlan,
    planNotice: await planNoticeFor(month, user),
    max: ctx.max,
    roles: MANPOWER_ROLES,
    ...(await permissions(user)),
    names: ctx.names,
    brand: {
      ...summary,
      people: summary.people.length,
      shortName: brand.shortName ?? "",
      revenue: brand.revenue ?? null,
      revenueTbc: Boolean(brand.revenueTbc),
      platforms: brand.platforms ?? [],
      scopeNotes: brand.scopeNotes ?? [],
      scopeText: brand.scopeText ?? "",
      scopeTotal: brand.scopeTotal ?? null,
      setupWaiting: Boolean(brand.pendingSetup),
      files: (brand.scopeFiles ?? []).map((f) => ({ _id: String(f.gridFsId), filename: f.filename, mimeType: f.mimeType, size: f.size })),
      projects: all
        .map((p) => ({ _id: String(p._id), name: p.name, code: p.code, current: ctx.isCurrent(p) }))
        .sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name)),
    },
    utilisation,
    people: showPeople ? ctx.people : {},
    pool: showPeople ? ctx.pool : {},
    // A scope change waiting for approval, or the last one rejected (to fix and resend).
    ...(await scopeRequests(brand, user)),
  });
}

/**
 * POST /api/brands/:id/split — brand creators; `{ name, projectIds, organisation? }`.
 * Creates the new brand and moves the projects (and their plan lines) to it: at once
 * when the creator is leadership, else when leadership approves the new brand.
 */
export async function splitBrand(req: Request, res: Response): Promise<void> {
  const source = await findBrandOr404(req, res);
  if (!source) return;
  const user = req.user!;
  const body = (req.body ?? {}) as { name?: unknown; projectIds?: unknown; organisation?: unknown };
  let name: string;
  let organisation: string;
  try {
    name = parseName(body.name);
    if (name.includes("_")) throw new FieldError("name", "Brand names can't contain “_”");
    organisation = body.organisation === undefined ? (source.organisation ?? "") : parseOrganisation(body.organisation);
  } catch (err) {
    if (!sendFieldError(res, err)) throw err;
    return;
  }
  const projectIds = Array.isArray(body.projectIds) ? [...new Set(body.projectIds.map(String))] : [];
  if (projectIds.length === 0 || projectIds.some((id) => !mongoose.isValidObjectId(id))) {
    res.status(400).json({ error: "Tick the projects to move", field: "projectIds" });
    return;
  }
  const found = await Project.countDocuments({
    _id: { $in: projectIds },
    archivedAt: null,
    $or: [{ brand: source._id }, { "naming.brand": source._id }],
  });
  if (found !== projectIds.length) {
    res.status(400).json({ error: "Some of those projects aren't open projects of this brand", field: "projectIds" });
    return;
  }
  if (await Brand.exists({ nameKey: brandNameKey(name) })) {
    res.status(409).json({ error: `A brand named "${name}" already exists`, field: "name" });
    return;
  }
  const leader = isLeadershipUser(user) || (await isProjectApprover(user._id as mongoose.Types.ObjectId));
  const setup: BrandSplitSetup = { kind: "split", from: String(source._id), projectIds };
  // The new brand starts with the source brand's scope, documents (own copies), leads,
  // platforms, notes and organisation — the moved projects keep their scope.
  const scopeFiles: NonNullable<IBrand["scopeFiles"]> = [];
  for (const f of source.scopeFiles ?? []) {
    try {
      const gridFsId = await copyGridFsFile(f.gridFsId, f.filename, { contentType: f.mimeType, uploadedBy: user._id, copiedFrom: String(f.gridFsId) });
      scopeFiles.push({ gridFsId, filename: f.filename, mimeType: f.mimeType, size: f.size });
    } catch (err) {
      console.error("[brand-split] couldn't copy a brand file", String(f.gridFsId), err);
    }
  }
  let brand: IBrand;
  try {
    brand = await Brand.create({
      name,
      organisation,
      color: source.color,
      isPitch: Boolean(source.isPitch),
      scopeItems: (source.scopeItems ?? []).map((r) => ({
        unit: r.unit,
        quantity: r.quantity,
        languages: r.languages,
        ...(r.languageList?.length ? { languageList: [...r.languageList] } : {}),
        sizes: r.sizes,
        what: r.what ?? "",
        source: r.source ?? "",
      })),
      scopeFiles,
      leads: [...(source.leads ?? [])],
      platforms: [...(source.platforms ?? [])],
      scopeNotes: [...(source.scopeNotes ?? [])],
      scopeText: source.scopeText ?? "",
      scopeTotal: source.scopeTotal ?? null,
      status: leader ? "approved" : "pending",
      requestedBy: user._id,
      ...(leader ? { decidedBy: user._id, decidedAt: new Date() } : {}),
      pendingSetup: leader ? null : (setup as unknown as Record<string, unknown>),
    });
  } catch (err) {
    for (const f of scopeFiles) await deleteFromGridFs(f.gridFsId);
    if (isDuplicateKeyError(err)) {
      res.status(409).json({ error: `A brand named "${name}" already exists`, field: "name" });
      return;
    }
    throw err;
  }
  logActivity({
    action: "settings_updated",
    actor: user,
    targetType: "brand",
    targetId: brand._id as mongoose.Types.ObjectId,
    targetName: brand.name,
    details: { brand: "created", via: "split", from: source.name, projects: projectIds.length },
    ip: req.ip,
  });
  if (!leader) {
    await notifyBrandApprovalRequested(brand, user, `It is split from ${source.name}: ${projectIds.length} project${projectIds.length === 1 ? " moves" : "s move"} to it when you approve.`);
    res.status(201).json({
      brand: serialize(brand, 0),
      pendingApproval: `${brand.name} was sent to leadership for approval. The ${projectIds.length} project${projectIds.length === 1 ? "" : "s"} move to it when it's approved.`,
    });
    return;
  }
  const result = await runBrandSplit(brand, setup, user, req.ip);
  res.status(201).json({ brand: serialize(brand, result.moved), ...result });
}

/** GET /api/brands/:id/files/:fileId — any signed-in user: download a brand scope file. */
export async function downloadBrandFile(req: Request, res: Response): Promise<void> {
  const brand = await findBrandOr404(req, res);
  if (!brand) return;
  const fileId = param(req, "fileId");
  const file = (brand.scopeFiles ?? []).find((f) => String(f.gridFsId) === fileId);
  if (!file) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  const safe = file.filename.replace(/["\\\r\n]/g, "_");
  res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
  if (file.size) res.setHeader("Content-Length", String(file.size));
  res.setHeader("Content-Disposition", `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  await new Promise<void>((resolve) => {
    const stream = openGridFsDownload(file.gridFsId);
    stream.once("error", (err) => {
      console.error("[brand-files] Download failed", String(file.gridFsId), err.message);
      if (!res.headersSent) {
        res.removeHeader("Content-Disposition");
        res.status(404).json({ error: "File content not found" });
      } else res.end();
      resolve();
    });
    stream.once("end", () => resolve());
    stream.pipe(res);
  });
}

/** POST /api/brands/:id/files — creators and leadership; multipart `files`: attach scope documents to the brand. */
export async function uploadBrandFiles(req: Request, res: Response): Promise<void> {
  const brand = await findBrandOr404(req, res);
  if (!brand) return;
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) {
    res.status(400).json({ error: "Choose at least one file" });
    return;
  }
  const existing = brand.scopeFiles ?? [];
  if (existing.length + files.length > BRAND_LIMITS.maxScopeFiles) {
    res.status(400).json({ error: `A brand keeps at most ${BRAND_LIMITS.maxScopeFiles} documents — remove some first` });
    return;
  }
  const user = req.user!;
  const added: NonNullable<IBrand["scopeFiles"]> = [];
  for (const file of files) {
    const filename = file.originalname.slice(0, 255) || "file";
    added.push({
      gridFsId: await uploadToGridFs(file.buffer, filename, { brand: brand._id, contentType: file.mimetype, uploadedBy: user._id }),
      filename,
      mimeType: file.mimetype,
      size: file.size,
    });
  }
  brand.scopeFiles = [...existing, ...added];
  await brand.save();
  logActivity({
    action: "settings_updated",
    actor: user,
    targetType: "brand",
    targetId: brand._id as mongoose.Types.ObjectId,
    targetName: brand.name,
    details: { brand: "files_added", files: added.map((f) => f.filename) },
    ip: req.ip,
  });
  res.status(201).json({ files: (brand.scopeFiles ?? []).map((f) => ({ _id: String(f.gridFsId), filename: f.filename, mimeType: f.mimeType, size: f.size })) });
}

/** DELETE /api/brands/:id/files/:fileId — creators and leadership. */
export async function deleteBrandFile(req: Request, res: Response): Promise<void> {
  const brand = await findBrandOr404(req, res);
  if (!brand) return;
  const fileId = param(req, "fileId");
  const file = (brand.scopeFiles ?? []).find((f) => String(f.gridFsId) === fileId);
  if (!file) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  brand.scopeFiles = (brand.scopeFiles ?? []).filter((f) => String(f.gridFsId) !== fileId);
  await brand.save();
  await deleteFromGridFs(file.gridFsId);
  logActivity({
    action: "settings_updated",
    actor: req.user,
    targetType: "brand",
    targetId: brand._id as mongoose.Types.ObjectId,
    targetName: brand.name,
    details: { brand: "file_removed", filename: file.filename },
    ip: req.ip,
  });
  res.json({ success: true });
}
