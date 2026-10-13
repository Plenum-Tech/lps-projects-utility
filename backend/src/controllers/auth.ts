import { canViewTimeReport } from "../lib/reportAccess.js";
import type { Request, Response } from "express";
import { logActivity } from "../lib/activityLog.js";
import { expiresInToMs, signAccessToken, TOKEN_COOKIE, verifyAccessToken } from "../lib/jwt.js";
import type { IUser } from "../models/User.js";
import { User } from "../models/User.js";
import { applyLeadership, isLeadershipUser } from "../lib/leadership.js";

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

/** Authenticates credentials and sets the JWT as an httpOnly cookie to maintain the session. */
export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = (req.body ?? {}) as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  const user = await User.findOne({ email: email.trim().toLowerCase() }).select("+password");

  // Imported accounts have no usable password until the user opens a set-password link.
  if (user?.passwordSetupRequired) {
    logActivity({
      action: "login_failed",
      actorEmail: email.trim().toLowerCase(),
      details: { reason: "password_setup_required" },
      ip: req.ip,
    });
    res.status(403).json({
      error: "Your account needs a password — use the link from your administrator.",
      code: "password_setup_required",
    });
    return;
  }

  if (!user || !(await user.comparePassword(password))) {
    // Audit failed attempts — actor is unknown, so snapshot the attempted email.
    logActivity({
      action: "login_failed",
      actorEmail: email.trim().toLowerCase(),
      details: { reason: "invalid_credentials" },
      ip: req.ip,
    });
    res.status(401).json({ error: "Invalid email or password" });
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
    user: { ...user.toJSON(), leadership: isLeadershipUser(user), access: { timeReport: await canViewTimeReport(user) } },
  });
}
