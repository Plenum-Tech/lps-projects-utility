import mongoose from "mongoose";
import { Department } from "../models/Department.js";
import { getProjectSettings } from "../models/ProjectSettings.js";
import type { IUser } from "../models/User.js";
import { isLeadershipUser } from "./leadership.js";

// ---------------------------------------------------------------------------
// Brand time: Program, CM and leadership log weekly-timesheet hours on a brand as a
// whole (no project or task). Who may: leadership, and the people of the departments
// in Settings → Time log settings (empty = the departments named like the defaults).
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

/** True for leadership and for people in a brand-time department. */
export async function canLogBrandTime(user: Pick<IUser, "department"> & object): Promise<boolean> {
  if (isLeadershipUser(user)) return true;
  if (!user.department) return false;
  return (await brandTimeDepartmentIds()).some((id) => id.equals(user.department as mongoose.Types.ObjectId));
}
