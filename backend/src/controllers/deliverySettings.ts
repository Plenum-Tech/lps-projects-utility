import type { Request, Response } from "express";
import mongoose from "mongoose";
import { logActivity } from "../lib/activityLog.js";
import { clearDeliveryCache } from "../lib/delivery/cache.js";
import { getOrCreateDeliverySettings, toDeliverySnapshot } from "../lib/delivery/settings.js";
import { parseDateOnly } from "../lib/taskAccess.js";
import { Brand } from "../models/Brand.js";
import { DELIVERY_DEFAULTS, DELIVERY_LIMITS as L, type IDeliverySettings } from "../models/DeliverySettings.js";
import { Department } from "../models/Department.js";
import { TaskCategory } from "../models/TaskCategory.js";
import { User } from "../models/User.js";

// ---------------------------------------------------------------------------
// /api/settings/delivery — GET / PATCH (admin). Partial updates; every id list
// is validated against its collection. Saving clears the analytics cache.
// ---------------------------------------------------------------------------

class FieldError extends Error {
  constructor(
    readonly field: string,
    message: string
  ) {
    super(message);
  }
}

const isId = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{24}$/i.test(v);

async function idList(
  field: string,
  raw: unknown,
  max: number,
  model: mongoose.Model<any>,
  what: string
): Promise<mongoose.Types.ObjectId[]> {
  if (!Array.isArray(raw)) throw new FieldError(field, `${field} must be an array of ${what} ids`);
  if (!raw.every(isId)) throw new FieldError(field, `${field} must be an array of ${what} ids`);
  const unique = [...new Set(raw.map((v) => v.toLowerCase()))];
  if (unique.length > max) throw new FieldError(field, `${field} can have at most ${max} entries`);
  const ids = unique.map((v) => new mongoose.Types.ObjectId(v));
  if (ids.length > 0 && (await model.countDocuments({ _id: { $in: ids } })) !== ids.length) {
    throw new FieldError(field, `${field} contains an unknown ${what}`);
  }
  return ids;
}

function intIn(field: string, raw: unknown, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    throw new FieldError(field, `${field} must be a whole number between ${min} and ${max}`);
  }
  return raw;
}

function keywords(raw: unknown): string[] {
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === "string")) {
    throw new FieldError("reworkKeywords", "reworkKeywords must be an array of words");
  }
  const list = [...new Set((raw as string[]).map((v) => v.trim().toLowerCase()).filter(Boolean))];
  if (list.length > L.maxKeywords) throw new FieldError("reworkKeywords", `At most ${L.maxKeywords} rework keywords`);
  if (list.some((k) => k.length > L.keywordMax)) {
    throw new FieldError("reworkKeywords", `Rework keywords must be ${L.keywordMax} characters or fewer`);
  }
  return list;
}

const DOMAIN_PATTERN = /^(?=.{1,120}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function domains(raw: unknown): string[] {
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === "string")) {
    throw new FieldError("finalAssetDomains", "finalAssetDomains must be an array of domains");
  }
  const list = [
    ...new Set(
      (raw as string[])
        .map((v) => v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^\*?\./, "").replace(/\/.*$/, ""))
        .filter(Boolean)
    ),
  ];
  if (list.length > L.maxDomains) throw new FieldError("finalAssetDomains", `At most ${L.maxDomains} domains`);
  const bad = list.find((d) => !DOMAIN_PATTERN.test(d));
  if (bad) throw new FieldError("finalAssetDomains", `"${bad}" is not a valid domain (e.g. frame.io)`);
  return list;
}

async function teamMap(raw: unknown): Promise<Array<{ brand: mongoose.Types.ObjectId; users: mongoose.Types.ObjectId[] }>> {
  const field = "brandTeamMap";
  if (!Array.isArray(raw)) throw new FieldError(field, "brandTeamMap must be an array of { brand, users }");
  if (raw.length > L.maxMapBrands) throw new FieldError(field, `At most ${L.maxMapBrands} brands in the team map`);
  const seen = new Set<string>();
  const entries: Array<{ brand: mongoose.Types.ObjectId; users: mongoose.Types.ObjectId[] }> = [];
  const allUsers = new Set<string>();
  for (const entry of raw) {
    const e = entry as { brand?: unknown; users?: unknown } | null;
    if (!e || typeof e !== "object" || !isId(e.brand) || !Array.isArray(e.users) || !e.users.every(isId)) {
      throw new FieldError(field, "Each team map entry needs a brand id and an array of user ids");
    }
    const brand = e.brand.toLowerCase();
    if (seen.has(brand)) throw new FieldError(field, "A brand can appear only once in the team map");
    seen.add(brand);
    const users = [...new Set((e.users as string[]).map((u) => u.toLowerCase()))];
    if (users.length > L.maxMapUsersPerBrand) {
      throw new FieldError(field, `At most ${L.maxMapUsersPerBrand} people per brand`);
    }
    users.forEach((u) => allUsers.add(u));
    entries.push({ brand: new mongoose.Types.ObjectId(brand), users: users.map((u) => new mongoose.Types.ObjectId(u)) });
  }
  if (seen.size > 0 && (await Brand.countDocuments({ _id: { $in: [...seen].map((b) => new mongoose.Types.ObjectId(b)) } })) !== seen.size) {
    throw new FieldError(field, "The team map contains an unknown brand");
  }
  if (allUsers.size > 0 && (await User.countDocuments({ _id: { $in: [...allUsers].map((u) => new mongoose.Types.ObjectId(u)) } })) !== allUsers.size) {
    throw new FieldError(field, "The team map contains an unknown user");
  }
  return entries;
}

const PATCHABLE = [
  "trafficManagers", "dashboardTeams", "reworkKeywords", "reworkCategories", "briefingWeekday", "minLeadDays",
  "sameDayBrands", "finalAssetDomains", "briefMinLength", "minCompletedToRank", "staleDays", "brandTeamMap",
  "teamMapStartDate",
] as const;

async function applyPatch(doc: IDeliverySettings, body: Record<string, unknown>): Promise<string[]> {
  const changed: string[] = [];
  const set = (key: (typeof PATCHABLE)[number], value: unknown) => {
    const before = JSON.stringify((doc as unknown as Record<string, unknown>)[key] ?? null);
    if (before !== JSON.stringify(value ?? null)) {
      doc.set(key, value);
      changed.push(key);
    }
  };
  if ("trafficManagers" in body) set("trafficManagers", await idList("trafficManagers", body.trafficManagers, L.maxTrafficManagers, User, "user"));
  if ("dashboardTeams" in body) {
    set("dashboardTeams", body.dashboardTeams === null ? null : await idList("dashboardTeams", body.dashboardTeams, L.maxTeams, Department, "department"));
  }
  if ("reworkKeywords" in body) set("reworkKeywords", keywords(body.reworkKeywords));
  if ("reworkCategories" in body) set("reworkCategories", await idList("reworkCategories", body.reworkCategories, L.maxCategories, TaskCategory, "task category"));
  if ("briefingWeekday" in body) set("briefingWeekday", intIn("briefingWeekday", body.briefingWeekday, 0, 6));
  if ("minLeadDays" in body) set("minLeadDays", intIn("minLeadDays", body.minLeadDays, 0, L.minLeadDaysMax));
  if ("sameDayBrands" in body) set("sameDayBrands", await idList("sameDayBrands", body.sameDayBrands, L.maxSameDayBrands, Brand, "brand"));
  if ("finalAssetDomains" in body) set("finalAssetDomains", domains(body.finalAssetDomains));
  if ("briefMinLength" in body) set("briefMinLength", intIn("briefMinLength", body.briefMinLength, 0, L.briefMinLengthMax));
  if ("minCompletedToRank" in body) set("minCompletedToRank", intIn("minCompletedToRank", body.minCompletedToRank, 0, L.minCompletedMax));
  if ("staleDays" in body) set("staleDays", intIn("staleDays", body.staleDays, 1, L.staleDaysMax));
  if ("brandTeamMap" in body) set("brandTeamMap", await teamMap(body.brandTeamMap));
  if ("teamMapStartDate" in body) {
    const date = typeof body.teamMapStartDate === "string" ? parseDateOnly(body.teamMapStartDate) : null;
    if (!date) throw new FieldError("teamMapStartDate", "teamMapStartDate must be a valid date (YYYY-MM-DD)");
    set("teamMapStartDate", date);
  }
  return changed;
}

function serialize(doc: IDeliverySettings) {
  const { exists: _exists, ...settings } = toDeliverySnapshot(doc);
  return {
    settings,
    defaults: {
      reworkKeywords: [...DELIVERY_DEFAULTS.reworkKeywords],
      reworkCategoryNames: [...DELIVERY_DEFAULTS.reworkCategoryNames],
      briefingWeekday: DELIVERY_DEFAULTS.briefingWeekday,
      minLeadDays: DELIVERY_DEFAULTS.minLeadDays,
      finalAssetDomains: [...DELIVERY_DEFAULTS.finalAssetDomains],
      briefMinLength: DELIVERY_DEFAULTS.briefMinLength,
      minCompletedToRank: DELIVERY_DEFAULTS.minCompletedToRank,
      staleDays: DELIVERY_DEFAULTS.staleDays,
    },
  };
}

/** GET /api/settings/delivery — admin; creates the singleton with defaults on first use. */
export async function getDeliverySettingsHandler(_req: Request, res: Response): Promise<void> {
  const doc = await getOrCreateDeliverySettings();
  res.setHeader("Cache-Control", "private, no-store");
  res.json(serialize(doc));
}

/** PATCH /api/settings/delivery — admin; partial update. */
export async function updateDeliverySettings(req: Request, res: Response): Promise<void> {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body) || !PATCHABLE.some((k) => k in body)) {
    res.status(400).json({ error: `At least one of ${PATCHABLE.join(", ")} is required` });
    return;
  }
  const doc = await getOrCreateDeliverySettings();
  let changed: string[];
  try {
    changed = await applyPatch(doc, body as Record<string, unknown>);
  } catch (err) {
    if (err instanceof FieldError) {
      res.status(400).json({ error: err.message, field: err.field });
      return;
    }
    throw err;
  }
  if (changed.length > 0) {
    doc.updatedBy = req.user!._id as mongoose.Types.ObjectId;
    await doc.save();
    clearDeliveryCache();
    logActivity({
      action: "settings_updated",
      actor: req.user,
      targetType: "delivery_settings",
      targetId: doc._id as mongoose.Types.ObjectId,
      targetName: "Delivery settings",
      details: { changed },
      ip: req.ip,
    });
  }
  res.json({ ...serialize(doc), changed });
}
