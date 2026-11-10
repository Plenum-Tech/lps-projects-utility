import mongoose from "mongoose";
import { Brand, type IBrand } from "../models/Brand.js";
import { APPROVED_PLAN, ManpowerPlan, type IManpowerRow } from "../models/ManpowerPlan.js";
import { appDateKey } from "./appTime.js";
import { brandLocksScope } from "./brandFlow.js";

// ---------------------------------------------------------------------------
// Brand readiness: a brand can get a NEW (non-pitch) project only when
//  (a) it has a scope (scopeItems),
//  (b) it has a line in the current month's latest approved manpower plan, and
//  (c) it has at least one lead.
// Pitches, the brand flow, the Excel import and the retainer job are exempt from
// the server check (the retainer job runs its own check against the plan it uses).
// ---------------------------------------------------------------------------

export type BrandNotReadyReason = "no_scope" | "not_in_plan" | "no_lead";

export interface BrandReadiness {
  ready: boolean;
  reasons: BrandNotReadyReason[];
}

/** The current month ("YYYY-MM", app timezone). */
export function currentMonth(): string {
  return appDateKey().slice(0, 7);
}

/** "2026-10" → "October". */
export function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
}

/** Brand ids with a line in the month's plan (latest approved version; `includePending`: the latest version of any status but rejected / superseded). */
export async function brandsInPlan(month: string, options: { includePending?: boolean } = {}): Promise<Set<string>> {
  const filter = options.includePending ? { month, status: { $nin: ["rejected", "superseded"] as Array<"rejected" | "superseded"> } } : { month, ...APPROVED_PLAN };
  const plan = await ManpowerPlan.findOne(filter).sort({ version: -1 }).select("rows.brand").lean();
  const rows = (plan?.rows ?? []) as Array<Pick<IManpowerRow, "brand">>;
  return new Set(rows.filter((r) => r.brand).map((r) => String(r.brand)));
}

/** Readiness of one brand against a set of plan brands. */
export function readinessOf(brand: Pick<IBrand, "scopeItems" | "leads"> & { _id: unknown }, inPlan: Set<string>): BrandReadiness {
  const reasons: BrandNotReadyReason[] = [];
  if (!brandLocksScope(brand)) reasons.push("no_scope");
  // Brands carry over month to month (the plan is copied on the 1st): a plan line isn't required.
  void inPlan;
  if (!(brand.leads ?? []).length) reasons.push("no_lead");
  return { ready: reasons.length === 0, reasons };
}

/** "no scope", "not in October's plan", "no lead". */
export function reasonText(reason: BrandNotReadyReason, month: string): string {
  return reason === "no_scope" ? "no scope" : reason === "not_in_plan" ? `not in ${monthName(month)}'s plan` : "no lead";
}

/** The 409 message for a brand that isn't ready. */
export function notReadyMessage(brandName: string, reasons: BrandNotReadyReason[], month: string): string {
  const parts: string[] = [];
  if (reasons.includes("no_scope")) parts.push("add the brand's scope");
  if (reasons.includes("not_in_plan")) parts.push(`add it to the ${monthName(month)} manpower plan (Brands → Allocation)`);
  if (reasons.includes("no_lead")) parts.push("give it a lead");
  return `${brandName} isn't ready for new projects (${reasons.map((r) => reasonText(r, month)).join(", ")}) — ${parts.join(", ")} first.`;
}

/** Readiness of every given brand (default: all) for the current month. */
export async function brandReadinessMap(brandIds?: Array<string | mongoose.Types.ObjectId>): Promise<{ month: string; byBrand: Map<string, BrandReadiness> }> {
  const month = currentMonth();
  const [brands, inPlan] = await Promise.all([
    Brand.find(brandIds ? { _id: { $in: brandIds } } : {}).select("scopeItems leads").lean(),
    brandsInPlan(month),
  ]);
  return { month, byBrand: new Map(brands.map((b) => [String(b._id), readinessOf(b, inPlan)])) };
}
