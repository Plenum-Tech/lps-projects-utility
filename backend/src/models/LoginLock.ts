import mongoose, { Schema } from "mongoose";

export const LOGIN_LOCK_LIMITS = {
  /** Failed sign-ins per email within `windowMs` that lock the email. */
  maxFailures: 10,
  windowMs: 15 * 60 * 1000,
  /** How long a locked email is refused — even with the right password. */
  lockMs: 15 * 60 * 1000,
} as const;

/**
 * Failed sign-ins of one normalised email, shared by every replica (the per-IP
 * login limit is per process). Counted whether or not an account has the
 * email, so a lock reveals nothing. A successful sign-in, a password reset or
 * a set-password link removes the document; otherwise a TTL index purges it
 * once its window and lock are over. Attempts are counted before their
 * password is checked (lib/loginLock.ts), so `failures` includes attempts
 * still in progress.
 */
export interface ILoginLock {
  /** The normalised (trimmed, lower-case) email. */
  _id: string;
  failures: number;
  windowStartedAt: Date;
  lockedUntil: Date | null;
  /** End of the window or of the lock, whichever is later (TTL). */
  expiresAt: Date;
}

const loginLockSchema = new Schema<ILoginLock>(
  {
    _id: { type: String, required: true },
    failures: { type: Number, default: 0 },
    windowStartedAt: { type: Date, required: true },
    lockedUntil: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

// Housekeeping only: every check compares the dates, so a late purge changes nothing.
loginLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const LoginLock = mongoose.model<ILoginLock>("LoginLock", loginLockSchema);
