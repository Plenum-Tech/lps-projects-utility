import type { NextFunction, Request, Response } from "express";
import { Department } from "../models/Department.js";
import type { IUser } from "../models/User.js";

// ---------------------------------------------------------------------------
// Report access: Delivery Pulse and the Task Report are view-only and open to
// everyone; the Time Log Report (and timesheets) is for admins, heads of
// department and Finance (anyone in a "Finance…" department).
// ---------------------------------------------------------------------------

const FINANCE_DEPARTMENT = /financ/i;

/** In a Finance department ("Finance", "Finance & Admin"). */
export async function isFinance(user: Pick<IUser, "department">): Promise<boolean> {
  if (!user.department) return false;
  const dept = await Department.findById(user.department).select("name").lean<{ name?: string }>();
  return Boolean(dept?.name && FINANCE_DEPARTMENT.test(dept.name));
}

export async function canViewTimeReport(user: Pick<IUser, "role" | "department">): Promise<boolean> {
  return user.role === "admin" || user.role === "head" || (await isFinance(user));
}

/** Route guard for the Time Log Report endpoints. */
export async function requireTimeReportAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.user && (await canViewTimeReport(req.user))) return next();
  res.status(403).json({ error: "The Time Log Report is for admins, heads of department and Finance" });
}
