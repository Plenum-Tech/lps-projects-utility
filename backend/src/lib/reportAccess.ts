import type { NextFunction, Request, Response } from "express";
import type { IUser } from "../models/User.js";

// ---------------------------------------------------------------------------
// Report access: Delivery Pulse and the Task Report are view-only and open to
// everyone; the Time Log Report (and timesheets) is for admins, leadership
// (treated as admin, lib/leadership.ts) and heads of department.
// ---------------------------------------------------------------------------

export async function canViewTimeReport(user: Pick<IUser, "role">): Promise<boolean> {
  return user.role === "admin" || user.role === "head";
}

/** Route guard for the Time Log Report endpoints. */
export async function requireTimeReportAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.user && (await canViewTimeReport(req.user))) return next();
  res.status(403).json({ error: "The Time Log Report is for admins, leadership and heads of department" });
}
