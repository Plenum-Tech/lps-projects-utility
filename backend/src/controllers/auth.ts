import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { canViewTimeReport } from "../lib/reportAccess.js";
import type { Request, Response } from "express";
import { logActivity } from "../lib/activityLog.js";
import { expiresInToMs, signAccessToken, TOKEN_COOKIE, verifyAccessToken } from "../lib/jwt.js";
import { loginAttemptFailed, loginSucceeded, startLoginAttempt } from "../lib/loginLock.js";
import type { IUser } from "../models/User.js";
import { User } from "../models/User.js";
import { applyLeadership, isLeadershipUser } from "../lib/leadership.js";
import { canCreateBrand, canRenameBrand } from "../lib/brandAccess.js";

const DEFAULT_EXPIRES_IN = "7d";

/**
 * Session cookie flags.
 * - Development: SameSite=Lax, not Secure (Vite on :5173 → API on :5000 is same-site).
 * - Production, same origin (the container serves the SPA and /api): SameSite=Lax; Secure.
 * - Production, UI and API on different sites (e.g. the old Vercel split):
 *   CROSS_SITE_COOKIES=true → SameSite=None; Secure so cross-site XHR sends the cookie.
 */
function cookieFlags(): { sameSite: "lax" | "none"; secure: boolean } {
  const isProd = process.env.NODE_ENV === "production";
  const crossSite = process.env.CROSS_SITE_COOKIES?.trim().toLowerCase() === "true";
  return { sameSite: isProd && crossSite ? "none" : "lax", secure: isProd };
}

/**
 * The one answer for an unknown email, a wrong password and an account that has
 * no password yet, so sign-in never reveals which emails have accounts. Forgot
 * password also sets a first password (it only needs the emailed code).
 */
const INVALID_LOGIN = "Invalid email or password. First time here or forgot it? Use Forgot password.";

/**
 * Hash of a random throwaway password at the cost real hashes use (10): compared
 * against when an email has no usable password, so every failed sign-in costs
 * one bcrypt compare and response times don't tell accounts apart.
 */
const dummyHash = bcrypt.hash(crypto.randomBytes(16).toString("base64url"), 10);

/** 429 for an email locked by repeated failed sign-ins (lib/loginLock.ts). */
function sendSignInLocked(res: Response, ms: number): void {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  res.setHeader("Retry-After", Math.ceil(ms / 1000));
  res.status(429).json({
    error: `Too many sign-in attempts. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}, or reset your password.`,
  });
}

/** Audits and refuses a sign-in to a locked email. */
function refuseLockedSignIn(req: Request, res: Response, emailLower: string, ms: number): void {
  logActivity({ action: "login_failed", actorEmail: emailLower, details: { reason: "too_many_attempts" }, ip: req.ip });
  sendSignInLocked(res, ms);
}

/** Authenticates credentials and sets the JWT as an httpOnly cookie to maintain the session. */
export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = (req.body ?? {}) as { email?: unknown; password?: unknown };

  if (typeof email !== "string" || typeof password !== "string" || !email.trim() || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }
  const emailLower = email.trim().toLowerCase();

  // Per-email lock after repeated failures (every replica): refused even with the right password.
  // Counted before the password check (so parallel guesses can't outrun the limit), and for
  // every email, account or not, so the lock reveals nothing either.
  const attempt = await startLoginAttempt(emailLower);
  if (attempt.lockedMs > 0) {
    refuseLockedSignIn(req, res, emailLower, attempt.lockedMs);
    return;
  }

  const account = await User.findOne({ email: emailLower }).select("+password");

  // Imported accounts have no usable password until the user sets one (set-password
  // link or Forgot password): they fail exactly like a wrong password.
  const user = account && !account.passwordSetupRequired ? account : null;
  const passwordOk = user
    ? await user.comparePassword(password)
    : await bcrypt.compare(password, await dummyHash);

  if (!user || !passwordOk) {
    // Audit failed attempts — actor is unknown, so snapshot the attempted email.
    // The real reason stays in the (admin-only) log, never in the response.
    logActivity({
      action: "login_failed",
      actorEmail: emailLower,
      details: { reason: account?.passwordSetupRequired ? "password_setup_required" : "invalid_credentials" },
      ip: req.ip,
    });
    const nowLockedMs = await loginAttemptFailed(emailLower, attempt);
    if (nowLockedMs > 0) {
      sendSignInLocked(res, nowLockedMs);
      return;
    }
    res.status(401).json({ error: INVALID_LOGIN });
    return;
  }

  // Locked by parallel guesses while this password was checked: refused like a wrong one.
  const lockedMs = await loginSucceeded(emailLower);
  if (lockedMs > 0) {
    refuseLockedSignIn(req, res, emailLower, lockedMs);
    return;
  }

  logActivity({ action: "login", actor: user, ip: req.ip });

  issueSessionCookie(res, user);
  const leadership = await applyLeadership(user);
  res.json({ user: { ...user.toJSON(), leadership } });
}

/**
 * Signs a JWT for `user` and sets it as the httpOnly session cookie. Shared by
 * login and invitation acceptance so both sessions are identical.
 */
export function issueSessionCookie(res: Response, user: Parameters<typeof signAccessToken>[0]): void {
  const token = signAccessToken(user);
  const expiresIn = process.env.JWT_EXPIRES_IN ?? DEFAULT_EXPIRES_IN;

  res.cookie(TOKEN_COOKIE, token, {
    httpOnly: true,
    ...cookieFlags(),
    maxAge: expiresInToMs(expiresIn),
    path: "/",
  });
}

/**
 * Clears the auth cookie.
 *
 * Intentionally NOT behind `requireAuth` so a user with an expired cookie can
 * still sign out. The actor is captured best-effort by re-verifying the cookie.
 */
export async function logout(req: Request, res: Response): Promise<void> {
  const token = req.cookies.token as string | undefined;
  let actor: IUser | undefined;
  if (token) {
    try {
      const payload = verifyAccessToken(token);
      const user = await User.findById(payload.sub);
      if (user) actor = user;
    } catch {
      // Invalid/expired token — log without an actor.
    }
  }
  logActivity({ action: "logout", actor, ip: req.ip });

  res.clearCookie(TOKEN_COOKIE, { path: "/", ...cookieFlags() });
  res.json({ message: "Logged out" });
}

/** Returns the authenticated user (requireAuth guarantees req.user is present). */
export async function me(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  // What the menus may show (computed server-side).
  res.json({
    user: { ...user.toJSON(), leadership: isLeadershipUser(user), access: { timeReport: await canViewTimeReport(user), brandCreator: canCreateBrand(user), brandRename: canRenameBrand(user) } },
  });
}
