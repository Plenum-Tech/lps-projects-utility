import type { Request, Response } from "express";
import mongoose from "mongoose";
import { logActivity } from "../lib/activityLog.js";
import { isDuplicateKeyError } from "../lib/errors.js";
import { isInvalidObjectId, param } from "../lib/projectAccess.js";
import { Brand, BRAND_COLORS, BRAND_LIMITS, type BrandColor, type IBrand } from "../models/Brand.js";
import { DeliverySettings } from "../models/DeliverySettings.js";
import { Project } from "../models/Project.js";
import { isProjectApprover, projectApproverIds } from "../lib/projectApproval.js";
import { isLeadershipActor, requestChange } from "../lib/changeRequests.js";
import { notifyUsers } from "../lib/notifications.js";
import { applyBrandScopeToProjects } from "../lib/brandFlow.js";
import { parseScopeItems, scopeText } from "../lib/scopeUnits.js";
import { User, type IUser } from "../models/User.js";

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
export function parseBrandScope(raw: unknown) {
  const parsed = parseScopeItems(raw);
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
 * POST /api/brands — admins; `{ name, shortName?, color?, active? }`. Leadership's
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

/** PATCH /api/brands/:id — admin; any of name, shortName, color, active. */
export async function updateBrand(req: Request, res: Response): Promise<void> {
  const brand = await findBrandOr404(req, res);
  if (!brand) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  // The requested values (validated), then: leadership applies them, anyone else
  // sends them to leadership for approval (one request per brand, emailed now).
  const next: { name?: string; shortName?: string; color?: IBrand["color"]; active?: boolean; scopeItems?: ReturnType<typeof parseBrandScope> } = {};
  try {
    if ("name" in body) {
      const name = parseName(body.name);
      if (name !== brand.name) next.name = name;
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
      const scopeItems = parseBrandScope(body.scopeItems);
      if (scopeText(scopeItems) !== scopeText(brand.scopeItems ?? [])) next.scopeItems = scopeItems;
    }
  } catch (err) {
    if (!sendFieldError(res, err)) throw err;
    return;
  }
  const changed = Object.keys(next);
  let pendingApproval: string | undefined;
  if (changed.length > 0 && brand.status !== "pending" && !(await isLeadershipActor(req.user!))) {
    const label: Record<string, string> = { name: "Name", shortName: "Short name", color: "Colour", active: "Active", scopeItems: "Scope" };
    const colourName: Record<string, string> = { "chart-1": "Teal", "chart-2": "Sky", "chart-3": "Indigo", "chart-4": "Amber", "chart-5": "Coral" };
    const show = (key: string, value: unknown) =>
      key === "active"
        ? value ? "Active" : "Inactive"
        : key === "color"
          ? (colourName[String(value)] ?? String(value))
          : key === "scopeItems"
            ? scopeText(value as never) || "—"
            : String(value ?? "") || "—";
    await requestChange({
      kind: "brand_edit",
      actor: req.user!,
      title: `Brand ${brand.name}`,
      changes: changed.map((key) => ({
        label: label[key] ?? key,
        before: show(key, (brand as unknown as Record<string, unknown>)[key]),
        after: show(key, (next as Record<string, unknown>)[key]),
      })),
      payload: next,
      brand: brand._id as mongoose.Types.ObjectId,
      ip: req.ip,
    });
    pendingApproval = "Brand changes were sent to leadership for approval.";
  } else if (changed.length > 0) {
    try {
      Object.assign(brand, next);
      await brand.save();
      if (next.scopeItems) await applyBrandScopeToProjects(brand);
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
  res.json({ brand: serialize(brand, counts.get(String(brand._id)) ?? 0), changed, ...(pendingApproval ? { pendingApproval } : {}) });
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
  if (setup && brand.status === "approved") {
    const { runBrandSetup } = await import("./brandFlow.js");
    const requester = brand.requestedBy ? await User.findById(brand.requestedBy) : null;
    const result = await runBrandSetup(brand, setup as never, requester ?? user, req.ip);
    setupNote = "error" in result ? ` The project couldn't be created: ${result.error}` : ` Project ${result.project.name} was created.`;
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
