import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import type { AccessTokenPayload } from "../lib/jwt.js";
import { verifyAccessToken } from "../lib/jwt.js";
import { isGuestUser } from "../lib/guests.js";
import { applyLeadership } from "../lib/leadership.js";
import { cached, invalidate } from "../lib/refCache.js";
import { User } from "../models/User.js";
import { guestMayCall } from "./guestAccess.js";

const { BSON } = mongoose.mongo;

/**
 * The signed-in user is re-read at most every USER_CACHE_MS (it was one query
 * per API request). Any user write in this process drops the cache at once
 * (models/User.ts → invalidateOnWrite), so a deleted/demoted user loses access
 * immediately on this replica and within USER_CACHE_MS on others.
 * The cached value is the BSON bytes of the document: every request hydrates
 * its own copy, so handlers can mutate/save `req.user` safely.
 */
const USER_CACHE_MS = 10_000;
/** Fields the default user query leaves out (schema `select: false`). */
const UNSELECTED = Object.fromEntries(
  Object.entries(User.schema.paths)
    .filter(([, path]) => (path.options as { select?: unknown }).select === false)
    .map(([name]) => [name, 0])
);

async function loadUser(id: string, fresh = false): Promise<InstanceType<typeof User> | null> {
  if (!mongoose.isValidObjectId(id)) return null;
  if (fresh) invalidate(`user:${id}`);
  const bytes = await cached(`user:${id}`, USER_CACHE_MS, async () => {
    const raw = await User.findById(id).lean();
    return raw ? BSON.serialize(raw) : null;
  });
  // The lean read leaves out `select: false` fields (the password hash): tell
  // mongoose they weren't loaded so saving req.user doesn't fail "required".
  return bytes ? User.hydrate(BSON.deserialize(bytes), UNSELECTED) : null;
}

/**
 * The user behind a session token, or null when that session has ended: the
 * user is gone, or a password change or reset bumped tokenVersion since it was signed.
 */
async function sessionUser(payload: Pick<AccessTokenPayload, "sub" | "tv">) {
  let user = await loadUser(payload.sub);
  // A token newer than the cached copy was issued after a password change on
  // another replica (the new session cookie): re-read rather than refuse it for up to USER_CACHE_MS.
  if (user && payload.tv > (user.tokenVersion ?? 0)) user = await loadUser(payload.sub, true);
  // Sessions signed before the bump are rejected.
  // Users and tokens from before the field existed both count as version 0.
  if (!user || payload.tv !== (user.tokenVersion ?? 0)) return null;
  // A guest whose access an admin removed is signed out everywhere.
  if (isGuestUser(user) && user.guestRevokedAt) return null;
  return user;
}

/**
 * For connections authenticated once and kept open (the SSE stream, lib/sse.ts):
 * is the session they were opened with still signed in?
 */
export async function isSessionCurrent(userId: string, tokenVersion: number): Promise<boolean> {
  return (await sessionUser({ sub: userId, tv: tokenVersion })) !== null;
}

/** Reads the JWT from the httpOnly cookie, verifies it, and attaches the current user to the request. */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies.token as string | undefined;

  if (!token) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  let payload: AccessTokenPayload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    // Invalid or expired token — treat as unauthenticated
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  // Re-load the user (briefly cached, see above) so deleted/disabled users lose access,
  // and sessions signed out by a password change or reset (tokenVersion) are rejected.
  // DB errors intentionally propagate to the global error handler (500), not a 401.
  const user = await sessionUser(payload);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  // Outside guests: only the endpoints in middlewares/guestAccess.ts (deny by default).
  // They never get leadership powers, whatever lists they end up on.
  if (isGuestUser(user)) {
    if (!guestMayCall(req)) {
      res.status(403).json({ error: "Guests can only open the tasks they were invited to" });
      return;
    }
    req.user = user;
    next();
    return;
  }

  // Leadership acts as admin everywhere (lib/leadership.ts).
  await applyLeadership(user);
  req.user = user;
  next();
}
