import { isDuplicateKeyError } from "./errors.js";
import { LOGIN_LOCK_LIMITS, LoginLock } from "../models/LoginLock.js";

// ---------------------------------------------------------------------------
// Per-email sign-in lock (models/LoginLock.ts): 10 failed sign-ins within 15
// minutes lock that email for 15 minutes, on every replica. Fails open — a
// database problem here is logged and never blocks a sign-in (the per-IP
// limit in middlewares/rateLimit.ts still applies).
// ---------------------------------------------------------------------------

/** Lock key: the normalised email, capped so an oversized body can't make an oversized key. */
function lockKey(email: string): string {
  return email.trim().toLowerCase().slice(0, 320);
}

function logFailure(step: string, error: unknown): void {
  console.error(`[login-lock] ${step} failed:`, error instanceof Error ? error.message : error);
}

/** Milliseconds left on the email's lock; 0 when it isn't locked. */
export async function loginLockRemainingMs(email: string): Promise<number> {
  try {
    const doc = await LoginLock.findById(lockKey(email)).select("lockedUntil").lean();
    return Math.max(0, (doc?.lockedUntil?.getTime() ?? 0) - Date.now());
  } catch (error) {
    logFailure("check", error);
    return 0;
  }
}

/**
 * Counts one failed sign-in for the email. Returns the lock's remaining
 * milliseconds when this failure locked it (or it already was), else 0.
 */
export async function recordLoginFailure(email: string): Promise<number> {
  const { maxFailures, windowMs, lockMs } = LOGIN_LOCK_LIMITS;
  const key = lockKey(email);
  const now = new Date();
  const windowFloor = new Date(now.getTime() - windowMs);
  const countInWindow = () =>
    LoginLock.findOneAndUpdate(
      { _id: key, windowStartedAt: { $gt: windowFloor } },
      { $inc: { failures: 1 } },
      { returnDocument: "after" }
    ).lean();
  try {
    // Count it in the email's current window…
    let doc = await countInWindow();
    if (!doc) {
      // …or start a new window (first failure, or the last window is over).
      // If a parallel failure starts it first, the upsert hits the unique _id: join that window.
      try {
        doc = await LoginLock.findOneAndUpdate(
          { _id: key, $or: [{ windowStartedAt: { $lte: windowFloor } }, { windowStartedAt: null }] },
          { $set: { failures: 1, windowStartedAt: now }, $max: { expiresAt: new Date(now.getTime() + windowMs) } },
          { upsert: true, returnDocument: "after" }
        ).lean();
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        doc = await countInWindow();
      }
    }
    if (!doc || doc.failures < maxFailures) return 0;

    // Limit reached: lock now, unless a parallel failure already did.
    const until = new Date(now.getTime() + lockMs);
    await LoginLock.updateOne(
      { _id: key, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
      { $set: { lockedUntil: until }, $max: { expiresAt: until } }
    );
    return await loginLockRemainingMs(email);
  } catch (error) {
    logFailure("count", error);
    return 0;
  }
}

/** Starts the count over: a successful sign-in, a password reset / set-password link, an admin-set password. */
export async function clearLoginFailures(...emails: string[]): Promise<void> {
  if (emails.length === 0) return;
  try {
    await LoginLock.deleteMany({ _id: { $in: emails.map(lockKey) } });
  } catch (error) {
    logFailure("clear", error);
  }
}
