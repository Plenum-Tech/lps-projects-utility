import mongoose from "mongoose";
import { latestPlan, type IManpowerRow } from "../models/ManpowerPlan.js";
import { STAFF_FILTER, User } from "../models/User.js";
import { currentMonth } from "./brandReadiness.js";
import { MANPOWER_ROLE_KEYS } from "./manpowerRoles.js";

// ---------------------------------------------------------------------------
// Brand leads: each brand has a Program Lead, a Creative Lead and a Production
// Lead, taken from the month's latest approved manpower plan (union over the
// brand's lines). Names are entered once, in the plan; Pearity reads them through
// the API (controllers/pearityApi.ts).
// ---------------------------------------------------------------------------

/** Lead → plan role key (the Production Lead is the plan's "producer" column). */
export const BRAND_LEAD_ROLES = {
  programLead: "programLead",
  creativeLead: "creativeLead",
  productionLead: "producer",
} as const;

export type BrandLeadKey = keyof typeof BRAND_LEAD_ROLES;

export interface LeadPerson {
  id: string;
  name: string;
  email: string;
}

export type BrandLeads = Record<BrandLeadKey, LeadPerson[]>;

const LEAD_KEYS = Object.keys(BRAND_LEAD_ROLES) as BrandLeadKey[];

export const emptyLeads = (): BrandLeads => ({ programLead: [], creativeLead: [], productionLead: [] });

/**
 * Brand id → its three leads in `month` (default: the current month), from the latest
 * approved plan. `brandIds` limits the result; brands without a line are left out
 * (use `emptyLeads()` for them). Guests never hold plan cells, but are skipped anyway.
 */
export async function brandLeadsFor(month: string = currentMonth(), brandIds?: Iterable<string>): Promise<Map<string, BrandLeads>> {
  const only = brandIds ? new Set([...brandIds].map(String)) : null;
  const out = new Map<string, BrandLeads>();
  if (only && only.size === 0) return out;
  const plan = await latestPlan(month);
  if (!plan) return out;
  const rows = (plan.toObject().rows ?? []) as IManpowerRow[];

  // brand → lead → user ids (each once, in plan order).
  const ids = new Map<string, Record<BrandLeadKey, string[]>>();
  const userIds = new Set<string>();
  for (const row of rows) {
    if (!row.brand) continue;
    const brand = String(row.brand);
    if (only && !only.has(brand)) continue;
    let entry = ids.get(brand);
    if (!entry) ids.set(brand, (entry = { programLead: [], creativeLead: [], productionLead: [] }));
    for (const key of LEAD_KEYS) {
      for (const cell of row.cells) {
        if (cell.role !== BRAND_LEAD_ROLES[key] || cell.notNeeded) continue;
        for (const u of cell.users ?? []) {
          const id = String(u);
          if (!entry[key].includes(id)) entry[key].push(id);
          userIds.add(id);
        }
      }
    }
  }
  const users = userIds.size
    ? await User.find({ _id: { $in: [...userIds].map((id) => new mongoose.Types.ObjectId(id)) }, ...STAFF_FILTER })
        .select("name email")
        .lean()
    : [];
  const byId = new Map(users.map((u) => [String(u._id), { id: String(u._id), name: u.name, email: u.email }]));
  for (const [brand, entry] of ids) {
    const leads = emptyLeads();
    for (const key of LEAD_KEYS) leads[key] = entry[key].map((id) => byId.get(id)).filter((p): p is LeadPerson => Boolean(p));
    out.set(brand, leads);
  }
  return out;
}

/** User id → plan role keys (sheet order) they hold in `month`'s latest approved plan (any line). */
export async function planRolesFor(month: string = currentMonth()): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const plan = await latestPlan(month);
  for (const row of (plan?.toObject().rows ?? []) as IManpowerRow[]) {
    for (const cell of row.cells) {
      if (cell.notNeeded) continue;
      for (const u of cell.users ?? []) {
        const list = out.get(String(u)) ?? [];
        if (!list.includes(cell.role)) list.push(cell.role);
        out.set(String(u), list);
      }
    }
  }
  for (const list of out.values()) list.sort((a, b) => MANPOWER_ROLE_KEYS.indexOf(a) - MANPOWER_ROLE_KEYS.indexOf(b));
  return out;
}
