import type { Request, Response } from "express";
import { logActivity } from "../lib/activityLog.js";
import { expiresInToMs, signAccessToken, TOKEN_COOKIE, verifyAccessToken } from "../lib/jwt.js";
import type { IUser } from "../models/User.js";
import { User } from "../models/User.js";

const DEFAULT_EXPIRES_IN = "7d";

/** Authenticates credentials and sets the JWT as an httpOnly cookie to maintain the session. */
export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = (req.body ?? {}) as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  const user = await User.findOne({ email: email.trim().toLowerCase() }).select("+password");

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
  res.json({ user: user.toJSON() });
}

/**
 * Signs a JWT for `user` and sets it as the httpOnly session cookie. Shared by
 * login and invitation acceptance so both sessions are identical.
 */
export function issueSessionCookie(res: Response, user: Parameters<typeof signAccessToken>[0]): void {
  const token = signAccessToken(user);
  const expiresIn = process.env.JWT_EXPIRES_IN ?? DEFAULT_EXPIRES_IN;

  // In production (cross-origin Vercel) we need SameSite=None so the browser
  // sends the cookie on cross-origin AJAX requests (axios fetch calls).
  // SameSite=None requires Secure, which is already true in production.
  const isProd = process.env.NODE_ENV === "production";
  res.cookie(TOKEN_COOKIE, token, {
    httpOnly: true,
    sameSite: isProd ? "none" : "lax",
    secure: isProd,
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

  const isProd = process.env.NODE_ENV === "production";
  res.clearCookie(TOKEN_COOKIE, {
    path: "/",
    sameSite: isProd ? "none" : "lax",
    secure: isProd,
  });
  res.json({ message: "Logged out" });
}

/** Returns the authenticated user (requireAuth guarantees req.user is present). */
export async function me(req: Request, res: Response): Promise<void> {
  res.json({ user: req.user!.toJSON() });
}
