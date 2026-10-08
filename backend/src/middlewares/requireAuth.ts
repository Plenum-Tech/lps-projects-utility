import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import type { AccessTokenPayload } from "../lib/jwt.js";
import { verifyAccessToken } from "../lib/jwt.js";
import { cached } from "../lib/refCache.js";
import { User } from "../models/User.js";

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

async function loadUser(id: string): Promise<InstanceType<typeof User> | null> {
  if (!mongoose.isValidObjectId(id)) return null;
  const bytes = await cached(`user:${id}`, USER_CACHE_MS, async () => {
    const raw = await User.findById(id).lean();
    return raw ? BSON.serialize(raw) : null;
  });
  return bytes ? User.hydrate(BSON.deserialize(bytes)) : null;
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

  // Re-load the user (briefly cached, see above) so deleted/disabled users lose access.
  // DB errors intentionally propagate to the global error handler (500), not a 401.
  const user = await loadUser(payload.sub);

  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  // A password reset bumps tokenVersion: sessions signed before it are rejected.
  // Users and tokens from before the field existed both count as version 0.
  if (payload.tv !== (user.tokenVersion ?? 0)) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  req.user = user;
  next();
}
