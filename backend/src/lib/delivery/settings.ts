import { DELIVERY_DEFAULTS, DeliverySettings, type IDeliverySettings } from "../../models/DeliverySettings.js";
import { TaskCategory } from "../../models/TaskCategory.js";
import { appDateKey, appToday } from "../appTime.js";
import { exactNameRegex } from "../pagination.js";
import { deliveryCached } from "./cache.js";

// ---------------------------------------------------------------------------
// Delivery settings snapshot (plain strings, safe to share between requests).
// Cached with the analytics responses and cleared on every settings save.
// ---------------------------------------------------------------------------

export interface DeliverySettingsSnapshot {
  exists: boolean;
  trafficManagers: string[];
  /** null = every department is a dashboard team (an empty list is stored/read as null). */
  dashboardTeams: string[] | null;
  reworkKeywords: string[];
  reworkCategories: string[];
  briefingWeekday: number;
  minLeadDays: number;
  sameDayBrands: string[];
  finalAssetDomains: string[];
  briefMinLength: number;
  minCompletedToRank: number;
  staleDays: number;
  /** Outcome readiness advice when closing tasks (default on). */
  outcomeReadiness: boolean;
  brandTeamMap: Array<{ brand: string; users: string[] }>;
  /** "YYYY-MM-DD". */
  teamMapStartDate: string;
  updatedAt: string | null;
}

/** Ids of task categories named like the default rework categories ("Amends"), case-insensitive. */
async function defaultReworkCategoryIds(): Promise<string[]> {
  const names: readonly string[] = DELIVERY_DEFAULTS.reworkCategoryNames;
  const rows = await TaskCategory.find({ name: { $in: names.map(exactNameRegex) } })
    .select("_id")
    .lean();
  return rows.map((r) => String(r._id));
}

export function toDeliverySnapshot(doc: IDeliverySettings): DeliverySettingsSnapshot {
  const ids = (list: unknown[] | null | undefined) => (list ?? []).map((id) => String(id));
  return {
    exists: true,
    trafficManagers: ids(doc.trafficManagers),
    dashboardTeams: doc.dashboardTeams?.length ? ids(doc.dashboardTeams) : null,
    reworkKeywords: [...(doc.reworkKeywords ?? [])],
    reworkCategories: ids(doc.reworkCategories),
    briefingWeekday: doc.briefingWeekday,
    minLeadDays: doc.minLeadDays,
    sameDayBrands: ids(doc.sameDayBrands),
    finalAssetDomains: [...(doc.finalAssetDomains ?? [])],
    briefMinLength: doc.briefMinLength,
    minCompletedToRank: doc.minCompletedToRank,
    staleDays: doc.staleDays,
    outcomeReadiness: doc.outcomeReadiness !== false,
    brandTeamMap: (doc.brandTeamMap ?? []).map((e) => ({ brand: String(e.brand), users: ids(e.users) })),
    teamMapStartDate: doc.teamMapStartDate ? doc.teamMapStartDate.toISOString().slice(0, 10) : appDateKey(),
    updatedAt: doc.updatedAt ? doc.updatedAt.toISOString() : null,
  };
}

async function defaultSnapshot(): Promise<DeliverySettingsSnapshot> {
  return {
    exists: false,
    trafficManagers: [],
    dashboardTeams: null,
    reworkKeywords: [...DELIVERY_DEFAULTS.reworkKeywords],
    reworkCategories: await defaultReworkCategoryIds(),
    briefingWeekday: DELIVERY_DEFAULTS.briefingWeekday,
    minLeadDays: DELIVERY_DEFAULTS.minLeadDays,
    sameDayBrands: [],
    finalAssetDomains: [...DELIVERY_DEFAULTS.finalAssetDomains],
    briefMinLength: DELIVERY_DEFAULTS.briefMinLength,
    minCompletedToRank: DELIVERY_DEFAULTS.minCompletedToRank,
    staleDays: DELIVERY_DEFAULTS.staleDays,
    outcomeReadiness: DELIVERY_DEFAULTS.outcomeReadiness,
    brandTeamMap: [],
    teamMapStartDate: appDateKey(),
    updatedAt: null,
  };
}

/** Current settings (defaults when the singleton doesn't exist yet). Cached ≤ 60 s. */
export function getDeliverySettings(): Promise<DeliverySettingsSnapshot> {
  return deliveryCached("settings", async () => {
    const doc = await DeliverySettings.findOne({ key: "delivery" });
    return doc ? toDeliverySnapshot(doc) : defaultSnapshot();
  });
}

/** Returns the singleton, creating it with the defaults on first use. */
export async function getOrCreateDeliverySettings(): Promise<IDeliverySettings> {
  const existing = await DeliverySettings.findOne({ key: "delivery" });
  if (existing) return existing;
  const reworkCategories = await defaultReworkCategoryIds();
  const created = await DeliverySettings.findOneAndUpdate(
    { key: "delivery" },
    {
      $setOnInsert: {
        key: "delivery",
        trafficManagers: [],
        dashboardTeams: null,
        reworkKeywords: [...DELIVERY_DEFAULTS.reworkKeywords],
        reworkCategories,
        briefingWeekday: DELIVERY_DEFAULTS.briefingWeekday,
        minLeadDays: DELIVERY_DEFAULTS.minLeadDays,
        sameDayBrands: [],
        finalAssetDomains: [...DELIVERY_DEFAULTS.finalAssetDomains],
        briefMinLength: DELIVERY_DEFAULTS.briefMinLength,
        minCompletedToRank: DELIVERY_DEFAULTS.minCompletedToRank,
        staleDays: DELIVERY_DEFAULTS.staleDays,
        outcomeReadiness: DELIVERY_DEFAULTS.outcomeReadiness,
        brandTeamMap: [],
        teamMapStartDate: appToday(),
      },
    },
    { upsert: true, returnDocument: "after" }
  );
  return created!;
}
