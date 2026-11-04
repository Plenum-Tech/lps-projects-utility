import type { Request, Response } from "express";
import { logActivity } from "../lib/activityLog.js";
import { canCreateBrand, canRenameBrand } from "../lib/brandAccess.js";
import {
  buildAuthorizeUrl,
  exchangeCode,
  getEntraSsoConfig,
  pkcePair,
  randomUrlToken,
  safeReturnPath,
  ssoStateExpiresAt,
  verifyIdToken,
} from "../lib/entraSso.js";
import { applyLeadership, isLeadershipUser } from "../lib/leadership.js";
import { canViewTimeReport } from "../lib/reportAccess.js";
import type { IUser } from "../models/User.js";
import { User } from "../models/User.js";
import { SsoLoginState } from "../models/SsoLoginState.js";
import { issueSessionCookie } from "./auth.js";

/** GET /api/auth/sso/config — show/hide the Microsoft button. */
export async function ssoConfig(_req: Request, res: Response): Promise<void> {
  res.json({ enabled: Boolean(getEntraSsoConfig()) });
}

/** GET /api/auth/sso/entra/start — browser navigation; 302 to Entra. */
export async function ssoStart(req: Request, res: Response): Promise<void> {
  const cfg = getEntraSsoConfig();
  if (!cfg) {
    res.status(404).json({ error: "Microsoft sign-in is not enabled" });
    return;
  }

  const state = randomUrlToken();
  const nonce = randomUrlToken();
  const { verifier, challenge } = pkcePair();
  const returnPath = safeReturnPath(typeof req.query.next === "string" ? req.query.next : undefined);

  await SsoLoginState.create({
    state,
    nonce,
    codeVerifier: verifier,
    returnPath,
    expiresAt: ssoStateExpiresAt(),
  });

  const authUrl = buildAuthorizeUrl(cfg, state, nonce, challenge);
  res.setHeader("Cache-Control", "no-store");
  res.redirect(302, authUrl);
}

/**
 * POST /api/auth/sso/entra/callback — { code, state }.
 * Invite-only: existing Utility users matched by entraOid then email.
 * Password login is unchanged; this only issues the same session cookie.
 */
export async function ssoCallback(req: Request, res: Response): Promise<void> {
  const cfg = getEntraSsoConfig();
  if (!cfg) {
    res.status(404).json({ error: "Microsoft sign-in is not enabled" });
    return;
  }

  const body = (req.body ?? {}) as { code?: unknown; state?: unknown };
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const state = typeof body.state === "string" ? body.state.trim() : "";
  if (!code || !state) {
    res.status(400).json({ error: "code and state required" });
    return;
  }

  const saved = await SsoLoginState.findOneAndDelete({ state }).lean();
  if (!saved) {
    res.status(401).json({ error: "Invalid or expired sign-in state" });
    return;
  }
  if (saved.expiresAt.getTime() < Date.now()) {
    res.status(401).json({ error: "Sign-in expired, try again" });
    return;
  }

  let idToken: string;
  try {
    ({ idToken } = await exchangeCode(cfg, code, saved.codeVerifier));
  } catch (err) {
    console.warn("auth.sso_exchange_failed", err instanceof Error ? err.message : err);
    res.status(401).json({ error: "Microsoft sign-in failed" });
    return;
  }

  let claims;
  try {
    claims = await verifyIdToken(cfg, idToken, saved.nonce);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "verify_failed";
    console.warn("auth.sso_verify_failed", reason);
    if (reason === "tenant_denied") {
      res.status(403).json({ error: "Your organisation is not enabled for Utility SSO" });
      return;
    }
    if (reason === "domain_denied") {
      res.status(403).json({ error: "Your email domain is not enabled for Utility SSO" });
      return;
    }
    if (reason === "no_email") {
      res.status(403).json({ error: "Microsoft account has no email we can use" });
      return;
    }
    res.status(401).json({ error: "Microsoft sign-in failed" });
    return;
  }

  const user = await findUserForEntra(claims.oid, claims.email);
  if (!user) {
    logActivity({
      action: "login_failed",
      actorEmail: claims.email,
      details: { reason: "sso_no_user", method: "entra" },
      ip: req.ip,
    });
    // Same invite-only rule as Pearity: never create accounts via SSO.
    res.status(401).json({
      error: "No Utility account for this Microsoft login. Ask an admin to invite you.",
    });
    return;
  }

  if (user.guestRevokedAt) {
    logActivity({
      action: "login_failed",
      actorEmail: user.email,
      details: { reason: "guest_access_removed", method: "entra" },
      ip: req.ip,
    });
    res.status(401).json({ error: "Your guest access has been removed" });
    return;
  }

  if (user.entraOid && user.entraOid !== claims.oid) {
    res.status(409).json({ error: "This email is linked to a different Microsoft account" });
    return;
  }

  try {
    await linkEntraIdentity(user, claims.oid, claims.tid);
  } catch (err) {
    console.error("auth.sso_link_failed", err);
    res.status(500).json({ error: "Microsoft sign-in failed" });
    return;
  }

  logActivity({
    action: "login",
    actor: user,
    details: { method: "entra", tid: claims.tid, oid: claims.oid },
    ip: req.ip,
  });

  issueSessionCookie(res, {
    id: String(user._id),
    role: user.role,
    tokenVersion: user.tokenVersion,
  });
  await applyLeadership(user);
  res.json({
    next: safeReturnPath(saved.returnPath),
    user: {
      ...user.toJSON(),
      leadership: isLeadershipUser(user),
      access: {
        timeReport: await canViewTimeReport(user),
        brandCreator: canCreateBrand(user),
        brandRename: canRenameBrand(user),
      },
    },
  });
}

async function findUserForEntra(oid: string, email: string): Promise<IUser | null> {
  if (oid) {
    const byOid = await User.findOne({ entraOid: oid });
    if (byOid) return byOid;
  }
  if (!email) return null;
  return User.findOne({ email: email.toLowerCase() });
}

async function linkEntraIdentity(user: IUser, oid: string, tid: string): Promise<void> {
  if (user.entraOid === oid) {
    if (!user.entraTid && tid) {
      user.entraTid = tid;
      await user.save();
    }
    return;
  }
  // Only set when empty — never steal another account's oid (unique index).
  user.entraOid = oid;
  user.entraTid = tid;
  if (!user.authProvider || user.authProvider === "local") {
    user.authProvider = "both";
  }
  await user.save();
}
