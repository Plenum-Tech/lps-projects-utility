import type { NextFunction, Request, Response } from "express";
import type { IUser } from "../models/User.js";
import { isLeadershipUser } from "./leadership.js";

// ---------------------------------------------------------------------------
// Who may change the manpower plan: leadership (Aasim, Rania — the approvers
// in Settings → Projects) and the people in MANPOWER_EDITOR_EMAILS (Nazeer by
// default). Other admins and heads can read it.
// ---------------------------------------------------------------------------

const EDITOR_EMAILS = new Set(
  (process.env.MANPOWER_EDITOR_EMAILS ?? "nazeer@lps-me.com")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

/** Must run after requireAuth (which marks leadership). */
export function canEditManpower(user: IUser): boolean {
  return isLeadershipUser(user) || EDITOR_EMAILS.has(user.email.toLowerCase());
}

export function requireManpowerEditor(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || !canEditManpower(req.user)) {
    res.status(403).json({ error: "Only leadership and Nazeer can change the manpower plan" });
    return;
  }
  next();
}
