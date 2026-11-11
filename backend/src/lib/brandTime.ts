import mongoose from "mongoose";
import { Brand } from "../models/Brand.js";
import { Department } from "../models/Department.js";
import { APPROVED_PLAN, ManpowerPlan, latestPlan, type IManpowerPlan } from "../models/ManpowerPlan.js";
import { getProjectSettings } from "../models/ProjectSettings.js";
import type { IUser } from "../models/User.js";
import { isLeadershipUser } from "./leadership.js";
import { currentAppMonth } from "./projectExpiry.js";

// ---------------------------------------------------------------------------
// Brand time: Program, CM and leadership log weekly-timesheet hours on a brand as a
// whole (no project or task). Who may: leadership, the people of the departments in
// Settings → Time log settings (empty = the departments named like the defaults), and
// program people (program lead, PM, execution, CM lead, CM in the manpower plan, brand leads).
// Their allocated brands show on the timesheet from the start with 0 hours.
// Brand hours need no approval.
// ---------------------------------------------------------------------------

/** Department names used while the setting is empty. */
const DEFAULT_DEPARTMENTS = /^(360 program|program|community management|cm|leadership)$/i;

/** The departments whose people may log brand time. */
export async function brandTimeDepartmentIds(): Promise<mongoose.Types.ObjectId[]> {
  const settings = await getProjectSettings();
  if (settings.brandTimeDepartments?.length) return settings.brandTimeDepartments;
  const defaults = await Department.find({ name: DEFAULT_DEPARTMENTS }).select("_id").lean();
  return defaults.map((d) => d._id as mongoose.Types.ObjectId);
}

/** True for leadership, people in a brand-time department, and program people with brands (see assignedBrands). */
export async function canLogBrandTime(user: Pick<IUser, "_id" | "department"> & object): Promise<boolean> {
  if (isLeadershipUser(user)) return true;
  if (user.department && (await brandTimeDepartmentIds()).some((id) => id.equals(user.department as mongoose.Types.ObjectId))) return true;
  return (await assignedBrandIds(user._id as mongoose.Types.ObjectId, [currentAppMonth()])).length > 0;
}

/** Program roles in the manpower plan: their people log brand time on the brands they're allocated to. */
const PROGRAM_ROLES = ["programLead", "pm", "programExecution", "cmLead", "communityManager"];

/** The plan in use for a month: its latest approved version, else the latest approved plan before it. */
async function planFor(month: string): Promise<IManpowerPlan | null> {
  return (await latestPlan(month)) ?? ManpowerPlan.findOne({ month: { $lt: month }, ...APPROVED_PLAN }).sort({ month: -1, version: -1 });
}

/** Brands the user is allocated to in the months' plans (program roles) or leads. */
async function assignedBrandIds(userId: mongoose.Types.ObjectId, months: string[]): Promise<string[]> {
  const ids = new Set<string>();
  for (const month of months) {
    const plan = await planFor(month);
    for (const row of plan?.rows ?? []) {
      if (!row.brand || row.section === "pitch") continue;
      if (row.cells.some((c) => PROGRAM_ROLES.includes(c.role) && c.users.some((u) => u.equals(userId)))) ids.add(String(row.brand));
    }
  }
  for (const b of await Brand.find({ leads: userId }).select("_id").lean()) ids.add(String(b._id));
  return [...ids];
}

/**
 * Brands shown on the user's timesheet from the start (0 hours until filled in): the active,
 * approved brands they're allocated to in the months' manpower plans (program roles) or lead.
 */
export async function assignedBrands(userId: mongoose.Types.ObjectId, months: string[]): Promise<Array<{ _id: string; name: string; organisation: string }>> {
  const ids = await assignedBrandIds(userId, months);
  if (ids.length === 0) return [];
  const brands = await Brand.find({ _id: { $in: ids }, active: { $ne: false }, $or: [{ status: { $exists: false } }, { status: "approved" }] })
    .select("name organisation")
    .sort({ name: 1 })
    .lean();
  return brands.map((b) => ({ _id: String(b._id), name: b.name, organisation: (b as { organisation?: string }).organisation ?? "" }));
}
