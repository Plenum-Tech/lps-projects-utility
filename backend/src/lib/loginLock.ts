import { isDuplicateKeyError } from "./errors.js";
import { LOGIN_LOCK_LIMITS, LoginLock } from "../models/LoginLock.js";

// ---------------------------------------------------------------------------
// Per-email sign-in lock (models/LoginLock.ts): 10 failed sign-ins within 15
// minutes lock that email for 15 minutes, on every replica. Fails open — a
// database problem here is logged and never blocks a sign-in (the per-IP
// limit in middlewares/rateLimit.ts still applies).
//
// An attempt is counted BEFORE its password is checked (startLoginAttempt),
// so a burst of parallel guesses can't all be checked before the first
// failure is recorded; a correct password starts the count over
// (loginSucceeded). Once the email is locked every answer is the same 429,
// right password or wrong — also for guesses that were already being checked.
// ---------------------------------------------------------------------------

/** Lock key: the normalised email, capped so an oversized body can't make an oversized key. */
function lockKey(email: string): string {
  return email.trim().toLowerCase().slice(0, 320);
}

function logFailure(step: string, error: unknown): void {
  console.error(`[login-lock] ${step} failed:`, error instanceof Error ? error.message : error);
}

/** Filter: no lock, or the lock is over. */
function notLocked(now: Date) {
  return { $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] };
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

/** Locks the email now, unless it already is (a parallel attempt got there first). */
async function lockEmail(key: string): Promise<void> {
  const now = new Date();
  const until = new Date(now.getTime() + LOGIN_LOCK_LIMITS.lockMs);
  await LoginLock.updateOne({ _id: key, ...notLocked(now) }, { $set: { lockedUntil: until }, $max: { expiresAt: until } });
}

/** Counts one attempt in the email's current window (or starts one); returns its number in the window. */
async function countAttempt(key: string): Promise<number> {
  const now = new Date();
  const windowFloor = new Date(now.getTime() - LOGIN_LOCK_LIMITS.windowMs);
  const countInWindow = () =>
    LoginLock.findOneAndUpdate(
      { _id: key, windowStartedAt: { $gt: windowFloor } },
      { $inc: { failures: 1 } },
      { returnDocument: "after" }
    ).lean();
  // Count it in the email's current window…
  let doc = await countInWindow();
  if (!doc) {
    // …or start a new window (first attempt, or the last window is over).
    // If a parallel attempt starts it first, the upsert hits the unique _id: join that window.
    try {
      doc = await LoginLock.findOneAndUpdate(
        { _id: key, $or: [{ windowStartedAt: { $lte: windowFloor } }, { windowStartedAt: null }] },
        {
          $set: { failures: 1, windowStartedAt: now },
          $max: { expiresAt: new Date(now.getTime() + LOGIN_LOCK_LIMITS.windowMs) },
        },
        { upsert: true, returnDocument: "after" }
      ).lean();
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      doc = await countInWindow();
    }
  }
  return doc?.failures ?? 0;
}

export interface LoginAttempt {
  /** This attempt's number in the email's window (0 when it couldn't be counted). */
  number: number;
  /** > 0: the email is locked — refuse the sign-in without checking the password. */
  lockedMs: number;
}

/**
 * Starts a sign-in: refused while the email is locked, otherwise counted as a
 * failure up front. An attempt past the limit (parallel guesses) locks the
 * email and is refused unchecked, so at most `maxFailures` passwords are ever
 * checked per window.
 */
export async function startLoginAttempt(email: string): Promise<LoginAttempt> {
  const lockedMs = await loginLockRemainingMs(email);
  if (lockedMs > 0) return { number: 0, lockedMs };
  const key = lockKey(email);
  try {
    const number = await countAttempt(key);
    if (number <= LOGIN_LOCK_LIMITS.maxFailures) return { number, lockedMs: 0 };
    await lockEmail(key);
  } catch (error) {
    logFailure("count", error);
    return { number: 0, lockedMs: 0 };
  }
  return { number: 0, lockedMs: await loginLockRemainingMs(email) };
}

/**
 * A wrong password (or no account) — already counted by startLoginAttempt; the
 * limit's last attempt locks the email. Returns the lock's remaining
 * milliseconds when the email is locked by now (this attempt or a parallel
 * one), else 0.
 */
export async function loginAttemptFailed(email: string, attempt: LoginAttempt): Promise<number> {
  if (attempt.number >= LOGIN_LOCK_LIMITS.maxFailures) {
    try {
      await lockEmail(lockKey(email));
    } catch (error) {
      logFailure("lock", error);
    }
  }
  return loginLockRemainingMs(email);
}

/**
 * A correct password: starts the email's count over and returns 0 — unless
 * parallel attempts locked the email while this password was being checked:
 * then it's refused like every other attempt during the lock (the lock's
 * remaining milliseconds), so the answer doesn't tell a right guess from a wrong one.
 */
export async function loginSucceeded(email: string): Promise<number> {
  try {
    // Atomic: removes the count only if the email isn't locked.
    const { deletedCount } = await LoginLock.deleteOne({ _id: lockKey(email), ...notLocked(new Date()) });
    if (deletedCount > 0) return 0;
  } catch (error) {
    logFailure("clear", error);
    return 0;
  }
  return loginLockRemainingMs(email);
}

/** Starts the count over: a password reset / set-password link, an admin-set password. */
export async function clearLoginFailures(...emails: string[]): Promise<void> {
  if (emails.length === 0) return;
  try {
    await LoginLock.deleteMany({ _id: { $in: emails.map(lockKey) } });
  } catch (error) {
    logFailure("clear", error);
  }
}
