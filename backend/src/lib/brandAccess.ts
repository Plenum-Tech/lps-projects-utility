import type { NextFunction, Request, Response } from "express";
import type { IUser } from "../models/User.js";
import { isLeadershipUser } from "./leadership.js";

// ---------------------------------------------------------------------------
// Who may create brands: the people in BRAND_CREATOR_EMAILS (Nazeer by
// default). Leadership approves them (their brands go "pending" unless the
// creator is leadership too). Brand leads and scope files: creators and
// leadership.
// ---------------------------------------------------------------------------

function creatorEmails(): Set<string> {
  return new Set(
    (process.env.BRAND_CREATOR_EMAILS ?? "nazeer@lps-me.com")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

const CREATORS = creatorEmails();

/** True for the people who may create (and split) brands. */
export function canCreateBrand(user: Pick<IUser, "email">): boolean {
  return CREATORS.has(String(user.email ?? "").toLowerCase());
}

/** Brand creators and leadership (must run after requireAuth, which marks leadership). */
export function canManageBrand(user: IUser): boolean {
  return canCreateBrand(user) || isLeadershipUser(user);
}

/**
 * Who may rename a brand (applied at once, no approval): every admin, Nazeer included;
 * leadership counts too (requireAuth marks them admin).
 */
export function canRenameBrand(user: IUser): boolean {
  return isLeadershipUser(user) || user.role === "admin";
}

export function requireBrandRenamer(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || !canRenameBrand(req.user)) {
    res.status(403).json({ error: "Only an admin can rename a brand" });
    return;
  }
  next();
}

export function requireBrandCreator(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || !canCreateBrand(req.user)) {
    res.status(403).json({ error: "Only Nazeer can create brands. Ask him to add it; leadership approves it." });
    return;
  }
  next();
}

export function requireBrandManager(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || !canManageBrand(req.user)) {
    res.status(403).json({ error: "Only leadership and Nazeer can change this on a brand" });
    return;
  }
  next();
}
