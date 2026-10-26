import type { Request, Response } from "express";
import mongoose from "mongoose";
import { logActivity } from "../lib/activityLog.js";
import { isDuplicateKeyError } from "../lib/errors.js";
import { isInvalidObjectId, param } from "../lib/projectAccess.js";
import { Brand, BRAND_COLORS, BRAND_LIMITS, brandNameKey, type BrandColor, type IBrand } from "../models/Brand.js";
import {
  applyBrandMove,
  followBrandRename,
  moveAccess,
  moveCandidates,
  planBrandMove,
  requestBrandMove,
  targetError,
} from "../lib/brandMove.js";
import { DeliverySettings } from "../models/DeliverySettings.js";
import { Project } from "../models/Project.js";
import { isProjectApprover, projectApproverIds } from "../lib/projectApproval.js";
import { isLeadershipActor, requestChange } from "../lib/changeRequests.js";
import { notifyUsers } from "../lib/notifications.js";
import { applyBrandScopeTextToProjects, applyBrandScopeToProjects } from "../lib/brandFlow.js";
import { parseScopeItems, scopeText } from "../lib/scopeUnits.js";
import { User, type IUser } from "../models/User.js";
import { canManageBrand, canRenameBrand } from "../lib/brandAccess.js";
import { isSplitSetup, runBrandSplit } from "../lib/brandSplit.js";
import { parseAgreement, parseMatchRows, storedScopeMatch } from "../lib/scopeMatch.js";
import { ensureBaseVersion, recordScopeVersion, scopeTextDiff } from "../lib/scopeVersions.js";
import { BrandScopeVersion } from "../models/BrandScopeVersion.js";
import { brandScopeMatch, storedAgreementFrom } from "./brandScope.js";
import { parseStatedTotal, type StatedTotal } from "../lib/scopeExtract.js";

/** A brand's stated agreement total from a request body (null = none / cleared). */
export function parseScopeTotal(raw: unknown): StatedTotal | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const total = parseStatedTotal(raw);
  if (!total) throw new FieldError("scopeTotal", "scopeTotal needs a quantity of at least 1");
  return total;
}

/** Comparable form of a stated total ("" when none). */
export function scopeTotalKey(t: StatedTotal | null | undefined): string {
  return t ? `${t.quantity}|${t.per ?? ""}|${(t.phases ?? []).map((p) => `${p.phase}:${p.quantity}`).join(";")}` : "";
}

/** "96 per month", "344 (4 phases)". */
export function scopeTotalLabel(t: StatedTotal | null | undefined): string {
  if (!t) return "—";
  return `${t.quantity}${t.per === "month" ? " per month" : ""}${t.phases?.length ? ` (${t.phases.length} phases)` : ""}`;
}

/** Tells leadership a brand waits for their approval (bell + email). */
export async function notifyBrandApprovalRequested(brand: IBrand, user: IUser, extra = ""): Promise<void> {
  notifyUsers({
    recipients: await projectApproverIds(),
    actor: user,
    type: "brand_approval_requested",
    title: "New brand awaiting your approval",
    message: `${user.name} proposed the brand "${brand.name}". Approve it so projects can use it.${extra ? ` ${extra}` : ""}`,
    link: "/approvals",
    email: {
      subject: `New brand to approve: ${brand.name}`,
      heading: "New Brand Awaiting Approval",
      intro: `${user.name} proposed a new brand. Projects can use it once you approve it.${extra ? ` ${extra}` : ""}`,
      cardTitle: brand.name,
      rows: brand.shortName ? [["Short name", brand.shortName]] : [],
      buttonLabel: "Open Approvals",
    },
  });
}

/** Brand scope rows from a request: project scope rows plus what / source. */
export function parseBrandScope(raw: unknown, keep: Array<{ unit: string }> = []) {
  // Units already on the brand stay valid (removed from Settings since).
  const parsed = parseScopeItems(raw, keep.map((r) => r.unit));
  if (typeof parsed === "string") throw new FieldError("scopeItems", parsed);
  const items = raw as Array<Record<string, unknown>>;
  return parsed.map((row, i) => ({
    ...row,
    what: typeof items[i]?.what === "string" ? String(items[i]!.what).trim().slice(0, 80) : "",
    source: typeof items[i]?.source === "string" ? String(items[i]!.source).trim().slice(0, 255) : "",
  }));
}

// ---------------------------------------------------------------------------
// /api/brands — GET for every signed-in user; POST/PATCH/DELETE admin only.
// A brand used by projects can't be deleted (409) — deactivate it instead.
// ---------------------------------------------------------------------------

export class FieldError extends Error {
  constructor(
    readonly field: string,
    message: string
  ) {
    super(message);
  }
}

/** "Other scope" (the scope kept as text, not rows): a string up to BRAND_LIMITS.scopeTextMax. */
export function parseScopeText(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw !== "string") throw new FieldError("scopeText", "Other scope must be text");
  const text = raw.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length > BRAND_LIMITS.scopeTextMax) throw new FieldError("scopeText", `Other scope must be ${BRAND_LIMITS.scopeTextMax} characters or fewer`);
  return text;
}

export function parseName(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new FieldError("name", "name is required");
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length > BRAND_LIMITS.nameMax) throw new FieldError("name", `name must be ${BRAND_LIMITS.nameMax} characters or fewer`);
  return name;
}

function parseShortName(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw !== "string") throw new FieldError("shortName", "shortName must be a string");
  const value = raw.trim();
  if (value.length > BRAND_LIMITS.shortNameMax) {
    throw new FieldError("shortName", `shortName must be ${BRAND_LIMITS.shortNameMax} characters or fewer`);
  }
  return value;
}

/** Optional client group ("Ajmal"); "" = none. */
export function parseOrganisation(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw !== "string") throw new FieldError("organisation", "organisation must be a string");
  const value = raw.trim().replace(/\s+/g, " ");
  if (value.length > BRAND_LIMITS.organisationMax) {
    throw new FieldError("organisation", `organisation must be ${BRAND_LIMITS.organisationMax} characters or fewer`);
  }
  return value;
}

const MAX_LEADS = 5;

/** Lead user ids (existing users), at most MAX_LEADS. */
async function parseLeads(raw: unknown): Promise<mongoose.Types.ObjectId[]> {
  if (!Array.isArray(raw)) throw new FieldError("leads", "leads must be a list of user IDs");
  const ids = [...new Set(raw.map(String))];
  if (ids.some((id) => !mongoose.isValidObjectId(id))) throw new FieldError("leads", "leads must contain valid user IDs");
  if (ids.length > MAX_LEADS) throw new FieldError("leads", `At most ${MAX_LEADS} leads`);
  if ((await User.countDocuments({ _id: { $in: ids } })) !== ids.length) throw new FieldError("leads", "A lead no longer exists");
  return ids.map((id) => new mongoose.Types.ObjectId(id));
}

function parseColor(raw: unknown): BrandColor {
  if (typeof raw !== "string" || !(BRAND_COLORS as readonly string[]).includes(raw)) {
    throw new FieldError("color", `color must be one of: ${BRAND_COLORS.join(", ")}`);
  }
  return raw as BrandColor;
}

function parseActive(raw: unknown): boolean {
  if (typeof raw !== "boolean") throw new FieldError("active", "active must be a boolean");
  return raw;
}

async function projectCounts(ids: mongoose.Types.ObjectId[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await Project.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
    { $match: { brand: { $in: ids } } },
    { $group: { _id: "$brand", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.count]));
}

export function serialize(brand: IBrand, projectCount: number) {
  return { ...(brand.toJSON() as Record<string, unknown>), projectCount };
}

export function sendFieldError(res: Response, err: unknown): boolean {
  if (err instanceof FieldError) {
    res.status(400).json({ error: err.message, field: err.field });
    return true;
  }
  if (isDuplicateKeyError(err)) {
    res.status(409).json({ error: "A brand with this name already exists", field: "name" });
    return true;
  }
  return false;
}

/** GET /api/brands[?active=true] — any signed-in user; sorted by name, with `projectCount`. */
export async function listBrands(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  // Approved brands for everyone (older brands have no status = approved); your own
  // pending / rejected proposals too, so the form can show them as waiting.
  // Admins (Settings → Brands) see every brand, with its status.
  const visible: Record<string, unknown> =
    user.role === "admin"
      ? {}
      : { $or: [{ status: { $exists: false } }, { status: "approved" }, { requestedBy: user._id }] };
  const filter: Record<string, unknown> = req.query.active === "true" ? { $and: [visible, { active: true }] } : visible;
  const brands = await Brand.find(filter).sort({ nameKey: 1, name: 1, _id: 1 });
  const counts = await projectCounts(brands.map((b) => b._id as mongoose.Types.ObjectId));
  res.json({ brands: brands.map((b) => serialize(b, counts.get(String(b._id)) ?? 0)), total: brands.length });
}

/**
 * POST /api/brands — brand creators (lib/brandAccess.ts); `{ name, shortName?, organisation?, color?, active? }`. Leadership's
 * brands are approved at once; other admins' wait for leadership approval.
 */
export async function createBrand(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const user = req.user!;
  const leader = await isProjectApprover(user._id as mongoose.Types.ObjectId);
  try {
    const brand = await Brand.create({
      name: parseName(body.name),
      shortName: parseShortName(body.shortName),
      organisation: parseOrganisation(body.organisation),
      color: body.color === undefined ? "chart-1" : parseColor(body.color),
      active: body.active === undefined ? true : parseActive(body.active),
      status: leader ? "approved" : "pending",
      requestedBy: user._id,
      ...(leader ? { decidedBy: user._id, decidedAt: new Date() } : {}),
    });
    if (!leader) await notifyBrandApprovalRequested(brand, user);
    logActivity({
      action: "settings_updated",
      actor: req.user,
      targetType: "brand",
      targetId: brand._id as mongoose.Types.ObjectId,
      targetName: brand.name,
      details: { brand: "created" },
      ip: req.ip,
    });
    res.status(201).json({ brand: serialize(brand, 0) });
  } catch (err) {
    if (!sendFieldError(res, err)) throw err;
  }
}

async function findBrandOr404(req: Request, res: Response): Promise<IBrand | null> {
  const id = param(req, "id");
  const brand = id && !isInvalidObjectId(id) ? await Brand.findById(id) : null;
  if (!brand) res.status(404).json({ error: "Brand not found" });
  return brand;
}

/**
 * PATCH /api/brands/:id — admin; any of name, shortName, color, active, scopeItems
 * (leadership applies them, other admins send them for approval) and leads,
 * organisation (creators and leadership, applied at once).
 */
export async function updateBrand(req: Request, res: Response): Promise<void> {
  const brand = await findBrandOr404(req, res);
  if (!brand) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  // Leads and the organisation label: brand creators and leadership, applied at once (no approval).
  const direct: { leads?: mongoose.Types.ObjectId[]; organisation?: string; monthlyRetainer?: boolean } = {};
  try {
    if ("leads" in body) direct.leads = await parseLeads(body.leads);
    // A brand keeps at least one lead (new projects need one): clearing the last one is refused.
    if (direct.leads?.length === 0 && (brand.leads ?? []).length > 0) throw new FieldError("leads", "A brand needs at least one lead — add another lead before removing the last one");
    if ("organisation" in body) direct.organisation = parseOrganisation(body.organisation);
    if ("monthlyRetainer" in body) {
      if (typeof body.monthlyRetainer !== "boolean") throw new FieldError("monthlyRetainer", "monthlyRetainer must be a boolean");
      direct.monthlyRetainer = body.monthlyRetainer;
    }
  } catch (err) {
    if (!sendFieldError(res, err)) throw err;
    return;
  }
  const directChanged: string[] = [];
  if (direct.leads && direct.leads.map(String).join(",") !== (brand.leads ?? []).map(String).join(",")) directChanged.push("leads");
  if (direct.organisation !== undefined && direct.organisation !== (brand.organisation ?? "")) directChanged.push("organisation");
  if (direct.monthlyRetainer !== undefined && direct.monthlyRetainer !== Boolean(brand.monthlyRetainer)) directChanged.push("monthlyRetainer");
  if (directChanged.length) {
    if (!canManageBrand(req.user!)) {
      res.status(403).json({ error: "Only leadership and Nazeer can change a brand's leads, organisation or monthly retainer" });
      return;
    }
    if (direct.leads && directChanged.includes("leads")) brand.leads = direct.leads;
    if (direct.organisation !== undefined && directChanged.includes("organisation")) brand.organisation = direct.organisation;
    if (direct.monthlyRetainer !== undefined && directChanged.includes("monthlyRetainer")) brand.monthlyRetainer = direct.monthlyRetainer;
    await brand.save();
    logActivity({
      action: "settings_updated",
      actor: req.user,
      targetType: "brand",
      targetId: brand._id as mongoose.Types.ObjectId,
      targetName: brand.name,
      details: { brand: "updated", changed: directChanged },
      ip: req.ip,
    });
  }
  // The requested values (validated), then: leadership applies them, anyone else
  // sends them to leadership for approval (one request per brand, emailed now).
  const next: { name?: string; shortName?: string; color?: IBrand["color"]; active?: boolean; scopeItems?: ReturnType<typeof parseBrandScope>; scopeText?: string; scopeTotal?: StatedTotal | null } = {};
  // Scope parts sent but equal to the current scope: dropped from a pending request this one replaces.
  const unchangedScope: Array<{ key: string; label: string }> = [];
  try {
    if ("name" in body) {
      const name = parseName(body.name);
      if (name !== brand.name) {
        if (name.includes("_")) throw new FieldError("name", "Brand names can't contain “_” (it separates the parts of project names)");
        next.name = name;
      }
    }
    if ("shortName" in body) {
      const shortName = parseShortName(body.shortName);
      if (shortName !== (brand.shortName ?? "")) next.shortName = shortName;
    }
    if ("color" in body) {
      const color = parseColor(body.color);
      if (color !== brand.color) next.color = color;
    }
    if ("active" in body) {
      const active = parseActive(body.active);
      if (active !== brand.active) next.active = active;
    }
    if ("scopeItems" in body) {
      const scopeItems = parseBrandScope(body.scopeItems, brand.scopeItems ?? []);
      if (scopeText(scopeItems) !== scopeText(brand.scopeItems ?? [])) next.scopeItems = scopeItems;
      else unchangedScope.push({ key: "scopeItems", label: "Scope" });
    }
    // "Other scope" (the scope kept as text): the same approval rules as the scope rows.
    if ("scopeText" in body) {
      const text = parseScopeText(body.scopeText);
      if (scopeTextDiff(brand.scopeText, text)) next.scopeText = text;
      else unchangedScope.push({ key: "scopeText", label: "Other scope" });
    }
    // The agreement's stated total (a check for the rows): with the scope, same approval rules.
    if ("scopeTotal" in body) {
      const total = parseScopeTotal(body.scopeTotal);
      if (scopeTotalKey(total) !== scopeTotalKey(brand.scopeTotal)) next.scopeTotal = total;
      else unchangedScope.push({ key: "scopeTotal", label: "Agreement total" });
    }
  } catch (err) {
    if (!sendFieldError(res, err)) throw err;
    return;
  }
  // A new name: admins only, applied at once (no approval); the brand's structured project
  // names follow unless `renameProjects: false`, its plan lines always.
  if (next.name) {
    if (!canRenameBrand(req.user!)) {
      res.status(403).json({ error: "Only an admin can rename a brand", field: "name" });
      return;
    }
    if (await Brand.exists({ nameKey: brandNameKey(next.name), _id: { $ne: brand._id } })) {
      res.status(409).json({ error: `A brand named "${next.name}" already exists`, field: "name" });
      return;
    }
    const oldName = brand.name;
    brand.name = next.name;
    try {
      await brand.save();
    } catch (err) {
      if (!sendFieldError(res, err)) throw err;
      return;
    }
    await afterBrandRename(brand, oldName, body.renameProjects !== false, req.user!, req.ip);
    directChanged.push("name");
    delete next.name;
  }
  const changed = Object.keys(next);
  // A new scope: compared with the agreement (one sent with it — a scope upload's read result —
  // else the brand's), stored with it. Advice only; it never blocks the change.
  const scopeExtra: { scopeMatch?: IBrand["scopeMatch"]; scopeAgreement?: IBrand["scopeAgreement"] } = {};
  if (next.scopeItems || next.scopeText !== undefined) {
    const agreement = storedAgreementFrom(body.agreement);
    if (agreement) scopeExtra.scopeAgreement = agreement;
    const parsed = agreement ? parseAgreement(agreement) : null;
    const rows = next.scopeItems ?? parseMatchRows(brand.scopeItems ?? []);
    const match = await brandScopeMatch(brand, rows, parsed, next.scopeText ?? brand.scopeText ?? "");
    if (match) scopeExtra.scopeMatch = storedScopeMatch(match);
  }
  const scopeSource = body.scopeSource === "upload" ? "upload" : "edit";
  let pendingApproval: string | undefined;
  if (changed.length > 0 && brand.status !== "pending" && !(await isLeadershipActor(req.user!))) {
    const label: Record<string, string> = { name: "Name", shortName: "Short name", color: "Colour", active: "Active", scopeItems: "Scope", scopeText: "Other scope", scopeTotal: "Agreement total" };
    const clip = (s: string) => (s.length > 1500 ? `${s.slice(0, 1497)}…` : s);
    const colourName: Record<string, string> = { "chart-1": "Teal", "chart-2": "Sky", "chart-3": "Indigo", "chart-4": "Amber", "chart-5": "Coral" };
    const show = (key: string, value: unknown) =>
      key === "active"
        ? value ? "Active" : "Inactive"
        : key === "color"
          ? (colourName[String(value)] ?? String(value))
          : key === "scopeItems"
            ? scopeText(value as never) || "—"
            : key === "scopeText"
              ? clip(String(value ?? "")) || "—"
              : key === "scopeTotal"
                ? scopeTotalLabel(value as StatedTotal | null)
                : String(value ?? "") || "—";
    const lines = changed.map((key) => ({
      label: label[key] ?? key,
      before: show(key, (brand as unknown as Record<string, unknown>)[key]),
      after: show(key, (next as Record<string, unknown>)[key]),
    }));
    await requestChange({
      kind: "brand_edit",
      actor: req.user!,
      title: `Brand ${brand.name}`,
      changes: lines,
      payload: { ...next, ...scopeExtra },
      brand: brand._id as mongoose.Types.ObjectId,
      ip: req.ip,
      dropKeys: unchangedScope,
    });
    pendingApproval = "Brand changes were sent to leadership for approval.";
  } else if (changed.length > 0) {
    try {
      const previous = (brand.scopeItems ?? []).map((r) => ({ unit: r.unit, quantity: r.quantity, languages: r.languages, languageList: r.languageList ? [...r.languageList] : [], sizes: r.sizes }));
      // The scope as it was becomes version 1 when the brand has no history yet.
      const scopeChanged = Boolean(next.scopeItems) || next.scopeText !== undefined;
      if (scopeChanged) await ensureBaseVersion(brand);
      Object.assign(brand, next, scopeExtra);
      await brand.save();
      if (next.scopeItems) await applyBrandScopeToProjects(brand, previous);
      if (next.scopeText !== undefined) await applyBrandScopeTextToProjects(brand);
      if (scopeChanged) await recordScopeVersion(brand, scopeSource, req.user!._id as mongoose.Types.ObjectId);
    } catch (err) {
      if (!sendFieldError(res, err)) throw err;
      return;
    }
    logActivity({
      action: "settings_updated",
      actor: req.user,
      targetType: "brand",
      targetId: brand._id as mongoose.Types.ObjectId,
      targetName: brand.name,
      details: { brand: "updated", changed },
      ip: req.ip,
    });
  }
  const counts = await projectCounts([brand._id as mongoose.Types.ObjectId]);
  res.json({ brand: serialize(brand, counts.get(String(brand._id)) ?? 0), changed: [...directChanged, ...changed], ...(pendingApproval ? { pendingApproval } : {}) });
}

// ---------------------------------------------------------------------------
// Rename (brand page header; admins only, applied at once) and moving projects to
// another brand (brand page projects list: leadership at once, the approvers are
// told; brand creators and the projects' managers send it for approval).
// ---------------------------------------------------------------------------

/** After a rename is applied: project names / plan lines follow and the activity is logged (no approval, no notice). */
export async function afterBrandRename(brand: IBrand, oldName: string, renameProjects: boolean, actor: IUser, ip: string | undefined) {
  const follow = await followBrandRename(brand, oldName, renameProjects, actor, ip);
  logActivity({
    action: "settings_updated",
    actor,
    targetType: "brand",
    targetId: brand._id as mongoose.Types.ObjectId,
    targetName: brand.name,
    details: {
      brand: "renamed",
      from: oldName,
      to: brand.name,
      projects: follow.projects,
      skipped: follow.skipped.length || undefined,
      plans: follow.plans.map((p) => (p.inPlace ? `${p.month} (names)` : `${p.month} v${p.version}`)),
    },
    ip,
  });
  return follow;
}

/**
 * POST /api/brands/:id/rename — admins only (lib/brandAccess.ts canRenameBrand), applied at once;
 * `{ name, shortName?, renameProjects? (default true) }`. Structured project names follow (codes
 * kept) when renameProjects; the brand's manpower plan lines always take the new name.
 */
export async function renameBrand(req: Request, res: Response): Promise<void> {
  const brand = await findBrandOr404(req, res);
  if (!brand) return;
  const user = req.user!;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const next: { name?: string; shortName?: string } = {};
  try {
    const name = parseName(body.name);
    if (name !== brand.name) {
      if (name.includes("_")) throw new FieldError("name", "Brand names can't contain “_” (it separates the parts of project names)");
      next.name = name;
    }
    if ("shortName" in body) {
      const shortName = parseShortName(body.shortName);
      if (shortName !== (brand.shortName ?? "")) next.shortName = shortName;
    }
  } catch (err) {
    if (!sendFieldError(res, err)) throw err;
    return;
  }
  if (!next.name && next.shortName === undefined) {
    res.status(400).json({ error: "Nothing to change — enter a different name", field: "name" });
    return;
  }
  if (next.name && (await Brand.exists({ nameKey: brandNameKey(next.name), _id: { $ne: brand._id } }))) {
    res.status(409).json({ error: `A brand named "${next.name}" already exists`, field: "name" });
    return;
  }
  const oldName = brand.name;
  Object.assign(brand, next);
  try {
    await brand.save();
  } catch (err) {
    if (!sendFieldError(res, err)) throw err;
    return;
  }
  let follow: Awaited<ReturnType<typeof afterBrandRename>> | null = null;
  if (next.name) follow = await afterBrandRename(brand, oldName, body.renameProjects !== false, user, req.ip);
  else
    logActivity({
      action: "settings_updated",
      actor: user,
      targetType: "brand",
      targetId: brand._id as mongoose.Types.ObjectId,
      targetName: brand.name,
      details: { brand: "updated", changed: ["shortName"] },
      ip: req.ip,
    });
  const counts = await projectCounts([brand._id as mongoose.Types.ObjectId]);
  res.json({
    brand: serialize(brand, counts.get(String(brand._id)) ?? 0),
    projectsRenamed: follow?.projects ?? 0,
    skipped: follow?.skipped ?? [],
    plans: follow?.plans ?? [],
  });
}

/** Body of a move: `{ projectIds, targetBrandId }` → the source brand, target and projects (or a response sent). */
async function moveInput(req: Request, res: Response) {
  const from = await findBrandOr404(req, res);
  if (!from) return null;
  const body = (req.body ?? {}) as { projectIds?: unknown; targetBrandId?: unknown };
  const targetId = typeof body.targetBrandId === "string" && mongoose.isValidObjectId(body.targetBrandId) ? body.targetBrandId : null;
  const target = targetId ? await Brand.findById(targetId) : null;
  const bad = targetId ? targetError(from, target) : "Pick the brand to move them to";
  if (bad) {
    res.status(400).json({ error: bad, field: "targetBrandId" });
    return null;
  }
  const projects = await moveCandidates(from._id as mongoose.Types.ObjectId, Array.isArray(body.projectIds) ? body.projectIds.map(String) : []);
  if ("error" in projects) {
    res.status(400).json({ error: projects.error, field: "projectIds" });
    return null;
  }
  return { from, target: target!, projects };
}

const moveView = (plan: Awaited<ReturnType<typeof planBrandMove>>) => ({ from: plan.from, to: plan.to, items: plan.items, notes: plan.notes });

/** POST /api/brands/:id/move-projects/preview — what a move would do (new names, scope, plan lines). */
export async function previewMoveProjects(req: Request, res: Response): Promise<void> {
  const input = await moveInput(req, res);
  if (!input) return;
  const access = await moveAccess(req.user!, await Project.find({ _id: { $in: input.projects.map((p) => p._id) } }).select("manager createdBy").lean());
  if (!access) {
    res.status(403).json({ error: "Only leadership, brand creators and the projects' managers can move projects" });
    return;
  }
  res.json({ ...moveView(await planBrandMove(input.from, input.target, input.projects)), applies: access === "apply" });
}

/**
 * POST /api/brands/:id/move-projects — `{ projectIds, targetBrandId }`. Leadership moves at once
 * (approvers told); brand creators and the projects' managers send a project_move request; others 403.
 */
export async function moveProjects(req: Request, res: Response): Promise<void> {
  const input = await moveInput(req, res);
  if (!input) return;
  const user = req.user!;
  const access = await moveAccess(user, await Project.find({ _id: { $in: input.projects.map((p) => p._id) } }).select("manager createdBy").lean());
  if (!access) {
    res.status(403).json({ error: "Only leadership, brand creators and the projects' managers can move projects" });
    return;
  }
  if (access === "request") {
    const plan = await planBrandMove(input.from, input.target, input.projects);
    const change = await requestBrandMove(plan, user, req.ip);
    res.status(202).json({
      ...moveView(plan),
      changeRequest: String(change._id),
      pendingApproval: `Moving ${plan.items.length} project${plan.items.length === 1 ? "" : "s"} to ${input.target.name} was sent to leadership for approval.`,
    });
    return;
  }
  const result = await applyBrandMove(input.from._id as mongoose.Types.ObjectId, input.target._id as mongoose.Types.ObjectId, input.projects.map((p) => String(p._id)), user, req.ip, { notify: true });
  if ("error" in result) {
    res.status(result.status ?? 400).json({ error: result.error });
    return;
  }
  res.json(result);
}

/** DELETE /api/brands/:id — admin; 409 while projects use it (deactivate instead). */
export async function deleteBrand(req: Request, res: Response): Promise<void> {
  const brand = await findBrandOr404(req, res);
  if (!brand) return;
  const projectCount = await Project.countDocuments({ brand: brand._id });
  if (projectCount > 0) {
    res.status(409).json({
      error: `This brand is used by ${projectCount} project${projectCount === 1 ? "" : "s"}. Deactivate it instead.`,
      projectCount,
    });
    return;
  }
  await brand.deleteOne();
  await BrandScopeVersion.deleteMany({ brand: brand._id });
  // Drop it from the delivery settings (same-day allowlist, team map).
  await DeliverySettings.updateOne(
    { key: "delivery" },
    { $pull: { sameDayBrands: brand._id, brandTeamMap: { brand: brand._id } } }
  );
  logActivity({
    action: "settings_updated",
    actor: req.user,
    targetType: "brand",
    targetId: brand._id as mongoose.Types.ObjectId,
    targetName: brand.name,
    details: { brand: "deleted" },
    ip: req.ip,
  });
  res.json({ success: true });
}

/**
 * POST /api/brands/:id/approval — leadership; `{ decision: "approve" | "reject", reason? }`.
 * GET-less: the queue is part of GET /api/projects/approvals.
 */
export async function decideBrand(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  if (!(await isProjectApprover(user._id as mongoose.Types.ObjectId))) {
    res.status(403).json({ error: "Only leadership can approve brands" });
    return;
  }
  const brand = await findBrandOr404(req, res);
  if (!brand) return;
  const body = (req.body ?? {}) as { decision?: unknown; reason?: unknown };
  if (body.decision !== "approve" && body.decision !== "reject") {
    res.status(400).json({ error: 'decision must be "approve" or "reject"' });
    return;
  }
  if (brand.status !== "pending") {
    res.status(409).json({ error: `This brand is already ${brand.status ?? "approved"}` });
    return;
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  brand.status = body.decision === "approve" ? "approved" : "rejected";
  brand.decidedBy = user._id as mongoose.Types.ObjectId;
  brand.decidedAt = new Date();
  brand.rejectReason = brand.status === "rejected" ? reason : "";
  const setup = brand.pendingSetup;
  brand.pendingSetup = null;
  await brand.save();
  // Brand flow: the project, lead tasks and plan line waited for this approval.
  let setupNote = "";
  if (setup && brand.status === "approved" && isSplitSetup(setup)) {
    // The approver runs the move (plan lines follow as an approved version).
    const split = await runBrandSplit(brand, setup, user, req.ip);
    setupNote = ` ${split.moved} project${split.moved === 1 ? " was" : "s were"} moved to it.`;
  } else if (setup && brand.status === "approved" && !brand.isPitch) {
    // A brand gets no project: its team becomes its line in the month's plan, written as
    // the approver (so it lands approved, not as another pending version).
    const { addBrandPlanLine, planMonthLabel } = await import("./brandFlow.js");
    const result = await addBrandPlanLine(brand, setup as never, user, req.ip);
    setupNote = result.planLine
      ? ` Its team was added to the ${planMonthLabel(result.planLine.month)} manpower plan.`
      : ` ${result.warnings[0] ?? "Its team couldn't be added to the manpower plan."}`;
  } else if (setup && brand.status === "approved") {
    // A pitch: its Pitch project and tasks, created as the requester.
    const { runBrandSetup } = await import("./brandFlow.js");
    const requester = brand.requestedBy ? await User.findById(brand.requestedBy) : null;
    const result = await runBrandSetup(brand, setup as never, requester ?? user, req.ip);
    setupNote =
      "error" in result
        ? ` The project couldn't be created: ${result.error}`
        : "project" in result
          ? ` Project ${result.project.name} was created.`
          : "";
  }
  logActivity({
    action: "settings_updated",
    actor: user,
    targetType: "brand",
    targetId: brand._id as mongoose.Types.ObjectId,
    targetName: brand.name,
    details: { brand: brand.status, reason: reason || undefined },
    ip: req.ip,
  });
  if (brand.requestedBy) {
    const approved = brand.status === "approved";
    notifyUsers({
      recipients: [brand.requestedBy],
      actor: user,
      type: approved ? "brand_approved" : "brand_rejected",
      title: approved ? "Brand approved" : "Brand not approved",
      message: approved
        ? `${user.name} approved the brand "${brand.name}". You can use it on projects now.${setupNote}`
        : `${user.name} didn't approve the brand "${brand.name}"${reason ? `: ${reason}` : "."}`,
      link: "/projects",
      email: {
        subject: approved ? `Brand approved: ${brand.name}` : `Brand not approved: ${brand.name}`,
        heading: approved ? "Brand Approved" : "Brand Not Approved",
        intro: approved
          ? `${user.name} approved "${brand.name}". You can pick it when you create a project.`
          : `${user.name} didn't approve "${brand.name}".`,
        cardTitle: brand.name,
        rows: reason ? [["Reason", reason]] : [],
        buttonLabel: "Open Projects",
      },
    });
  }
  res.json({ brand: serialize(brand, 0) });
}
