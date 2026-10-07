import type { Request, Response } from "express";
import mongoose from "mongoose";
import { logActivity } from "../lib/activityLog.js";
import { isDuplicateKeyError } from "../lib/errors.js";
import { isInvalidObjectId, param } from "../lib/projectAccess.js";
import { Brand, BRAND_COLORS, BRAND_LIMITS, type BrandColor, type IBrand } from "../models/Brand.js";
import { DeliverySettings } from "../models/DeliverySettings.js";
import { Project } from "../models/Project.js";

// ---------------------------------------------------------------------------
// /api/brands — GET for every signed-in user; POST/PATCH/DELETE admin only.
// A brand used by projects can't be deleted (409) — deactivate it instead.
// ---------------------------------------------------------------------------

const NAME_COLLATION = { locale: "en", strength: 2 };

class FieldError extends Error {
  constructor(
    readonly field: string,
    message: string
  ) {
    super(message);
  }
}

function parseName(raw: unknown): string {
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

function serialize(brand: IBrand, projectCount: number) {
  return { ...(brand.toJSON() as Record<string, unknown>), projectCount };
}

function sendFieldError(res: Response, err: unknown): boolean {
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
  const filter = req.query.active === "true" ? { active: true } : {};
  const brands = await Brand.find(filter).collation(NAME_COLLATION).sort({ name: 1 });
  const counts = await projectCounts(brands.map((b) => b._id as mongoose.Types.ObjectId));
  res.json({ brands: brands.map((b) => serialize(b, counts.get(String(b._id)) ?? 0)), total: brands.length });
}

/** POST /api/brands — admin; `{ name, shortName?, color?, active? }`. */
export async function createBrand(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const brand = await Brand.create({
      name: parseName(body.name),
      shortName: parseShortName(body.shortName),
      color: body.color === undefined ? "chart-1" : parseColor(body.color),
      active: body.active === undefined ? true : parseActive(body.active),
    });
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
  const changed: string[] = [];
  try {
    if ("name" in body) {
      const name = parseName(body.name);
      if (name !== brand.name) {
        brand.name = name;
        changed.push("name");
      }
    }
    if ("shortName" in body) {
      const shortName = parseShortName(body.shortName);
      if (shortName !== (brand.shortName ?? "")) {
        brand.shortName = shortName;
        changed.push("shortName");
      }
    }
    if ("color" in body) {
      const color = parseColor(body.color);
      if (color !== brand.color) {
        brand.color = color;
        changed.push("color");
      }
    }
    if ("active" in body) {
      const active = parseActive(body.active);
      if (active !== brand.active) {
        brand.active = active;
        changed.push("active");
      }
    }
    if (changed.length > 0) await brand.save();
  } catch (err) {
    if (!sendFieldError(res, err)) throw err;
    return;
  }
  if (changed.length > 0) {
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
  res.json({ brand: serialize(brand, counts.get(String(brand._id)) ?? 0), changed });
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
