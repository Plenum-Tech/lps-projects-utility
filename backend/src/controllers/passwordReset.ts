import crypto from "node:crypto";
import type { Request, Response } from "express";
import type mongoose from "mongoose";
import { logActivity } from "../lib/activityLog.js";
import { appTimeZone } from "../lib/appTime.js";
import { emailConfigured, passwordChangedTemplate, passwordResetCodeTemplate, sendEmail } from "../lib/email.js";
import { isProduction } from "../lib/env.js";
import { PASSWORD_RESET_LIMITS, PasswordResetCode } from "../models/PasswordResetCode.js";
import { PasswordSetupToken } from "../models/PasswordSetupToken.js";
import { User } from "../models/User.js";
import { issueSessionCookie } from "./auth.js";

// ---------------------------------------------------------------------------
// Forgot password with an emailed 6-digit code (public, IP rate-limited in
// server.ts). Codes and reset tokens travel only in POST bodies and are never
// logged — except the dev-only console line when SMTP is off outside production.
// ---------------------------------------------------------------------------

const GENERIC_MESSAGE = "If an account exists for that email, we've sent a 6-digit code.";
/** Every /request answer takes at least this long so known and unknown emails look alike. */
const REQUEST_MIN_MS = 700;
const EMAIL_RE = /^\S+@\S+\.\S+$/;

let codeKey: Buffer | undefined;

/** HMAC key for codes, derived from JWT_SECRET (never the secret itself). */
function codeHmacKey(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");
  codeKey ??= crypto.createHmac("sha256", secret).update("password-reset-code:v1").digest();
  return codeKey;
}

/** HMAC-SHA256 of the code, bound to the email so a hash is useless for another account. */
function hashCode(emailLower: string, code: string): string {
  return crypto.createHmac("sha256", codeHmacKey()).update(`${emailLower}:${code}`).digest("hex");
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length > 0 && email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function formatWhen(date: Date): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: appTimeZone(),
      timeZoneName: "short",
    }).format(date);
  } catch {
    return date.toUTCString();
  }
}

function firstNameOf(name: string): string {
  return name.split(/\s+/)[0] || name;
}

/**
 * Creates and emails a code for `emailLower` when an account exists and the
 * per-email throttles allow it. Returns nothing: the caller always answers generically.
 */
async function issueCode(emailLower: string, ip: string | undefined): Promise<void> {
  const user = await User.findOne({ email: emailLower });
  if (!user) {
    hashCode(emailLower, "000000"); // comparable work for unknown emails
    return;
  }

  const now = Date.now();
  const latest = await PasswordResetCode.findOne({ emailLower }).sort({ createdAt: -1 }).select("createdAt").lean();
  if (latest && now - latest.createdAt.getTime() < PASSWORD_RESET_LIMITS.resendCooldownMs) {
    if (!isProduction()) console.log("[password-reset] request ignored: resend cooldown");
    return;
  }
  const lastHour = await PasswordResetCode.countDocuments({ emailLower, createdAt: { $gte: new Date(now - 3_600_000) } });
  if (lastHour >= PASSWORD_RESET_LIMITS.maxPerHour) {
    if (!isProduction()) console.log("[password-reset] request ignored: hourly cap reached");
    return;
  }

  // A new code replaces every older code / reset token of this user.
  await PasswordResetCode.updateMany({ user: user._id, revokedAt: null }, { $set: { revokedAt: new Date(now) } });

  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  await PasswordResetCode.create({
    user: user._id,
    emailLower,
    codeHash: hashCode(emailLower, code),
    expiresAt: new Date(now + PASSWORD_RESET_LIMITS.codeTtlMs),
    ip,
  });

  if (emailConfigured()) {
    // Fire-and-forget: a mail failure must not change the (generic) response.
    void sendEmail({
      to: user.email,
      subject: "Your password reset code",
      html: passwordResetCodeTemplate({ firstName: firstNameOf(user.name), code }),
      text: `Your password reset code is ${code}. It expires in 10 minutes. If you didn't request this, ignore this email.`,
    }).catch(() => undefined);
  } else if (!isProduction()) {
    // Development aid only (SMTP off): never reached in production.
    console.log(`[password-reset] DEV ONLY (SMTP not configured) code for ${emailLower}: ${code}`);
  }
}

/** Public: POST /api/auth/password-reset/request `{ email }` → always 200 with a generic message. */
export async function requestPasswordReset(req: Request, res: Response): Promise<void> {
  const started = Date.now();
  const emailLower = normalizeEmail((req.body as { email?: unknown } | undefined)?.email);
  if (!emailLower) {
    res.status(400).json({ error: "Enter a valid email address" });
    return;
  }
  try {
    await issueCode(emailLower, req.ip);
  } catch (err) {
    // Never reveal failures that could differ between known and unknown emails.
    console.error("[password-reset] request failed:", err instanceof Error ? err.message : err);
  }
  const elapsed = Date.now() - started;
  await sleep(Math.max(0, REQUEST_MIN_MS - elapsed) + crypto.randomInt(0, 100));
  res.json({ message: GENERIC_MESSAGE, resendAfterSeconds: PASSWORD_RESET_LIMITS.resendCooldownMs / 1000 });
}

const INVALID_CODE = "Invalid or expired code";
const LOCKED = "Too many attempts — request a new code";

/** Public: POST /api/auth/password-reset/verify `{ email, code }` → `{ resetToken, expiresInSeconds }`. */
export async function verifyPasswordReset(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { email?: unknown; code?: unknown };
  const emailLower = normalizeEmail(body.email);
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!emailLower || !/^\d{6}$/.test(code)) {
    res.status(400).json({ error: INVALID_CODE, attemptsLeft: null });
    return;
  }

  const now = new Date();
  const record = await PasswordResetCode.findOne({ emailLower, revokedAt: null, usedAt: null }).sort({ createdAt: -1 });
  if (!record || record.expiresAt.getTime() <= now.getTime()) {
    res.status(400).json({ error: INVALID_CODE, attemptsLeft: 0, reason: "expired" });
    return;
  }

  // Count the guess atomically before comparing, so parallel guesses can't exceed the limit.
  const counted = await PasswordResetCode.findOneAndUpdate(
    { _id: record._id, usedAt: null, revokedAt: null, attempts: { $lt: PASSWORD_RESET_LIMITS.maxAttempts } },
    { $inc: { attempts: 1 } },
    { returnDocument: "after" }
  );
  if (!counted) {
    res.status(429).json({ error: LOCKED, attemptsLeft: 0, reason: "locked" });
    return;
  }

  if (!sameHash(counted.codeHash, hashCode(emailLower, code))) {
    const attemptsLeft = Math.max(0, PASSWORD_RESET_LIMITS.maxAttempts - counted.attempts);
    if (attemptsLeft === 0) {
      res.status(429).json({ error: LOCKED, attemptsLeft: 0, reason: "locked" });
      return;
    }
    res.status(400).json({ error: INVALID_CODE, attemptsLeft });
    return;
  }

  const resetToken = crypto.randomBytes(32).toString("base64url");
  const claimed = await PasswordResetCode.findOneAndUpdate(
    { _id: counted._id, usedAt: null, revokedAt: null },
    {
      $set: {
        usedAt: now,
        resetTokenHash: hashToken(resetToken),
        resetTokenExpiresAt: new Date(now.getTime() + PASSWORD_RESET_LIMITS.resetTokenTtlMs),
      },
    },
    { returnDocument: "after" }
  );
  if (!claimed) {
    res.status(400).json({ error: INVALID_CODE, attemptsLeft: 0, reason: "expired" });
    return;
  }
  res.json({ resetToken, expiresInSeconds: PASSWORD_RESET_LIMITS.resetTokenTtlMs / 1000 });
}

const RESET_GONE = "Your reset session has expired — request a new code.";

/** Public: POST /api/auth/password-reset/complete `{ resetToken, password, confirmPassword }` → signs in. */
export async function completePasswordReset(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { resetToken?: unknown; password?: unknown; confirmPassword?: unknown };
  const { resetToken, password, confirmPassword } = body;
  if (typeof resetToken !== "string" || resetToken.length < 20 || resetToken.length > 128) {
    res.status(410).json({ error: RESET_GONE, reason: "expired" });
    return;
  }
  if (typeof password !== "string" || password.length < PASSWORD_RESET_LIMITS.passwordMin || !password.trim()) {
    res.status(400).json({ error: `Password must be at least ${PASSWORD_RESET_LIMITS.passwordMin} characters`, reason: "weak" });
    return;
  }
  if (password.length > PASSWORD_RESET_LIMITS.passwordMax) {
    res.status(400).json({ error: `Password must be at most ${PASSWORD_RESET_LIMITS.passwordMax} characters`, reason: "weak" });
    return;
  }
  if (password !== confirmPassword) {
    res.status(400).json({ error: "Passwords don't match", reason: "mismatch" });
    return;
  }

  const now = new Date();
  const record = await PasswordResetCode.findOne({ resetTokenHash: hashToken(resetToken) });
  if (
    !record ||
    record.revokedAt ||
    record.resetTokenUsedAt ||
    !record.resetTokenExpiresAt ||
    record.resetTokenExpiresAt.getTime() <= now.getTime()
  ) {
    res.status(410).json({ error: RESET_GONE, reason: "expired" });
    return;
  }

  const user = await User.findById(record.user).select("+password");
  if (!user) {
    res.status(410).json({ error: RESET_GONE, reason: "expired" });
    return;
  }
  if (!user.passwordSetupRequired && (await user.comparePassword(password))) {
    res.status(400).json({ error: "Choose a password different from your current one", reason: "same" });
    return;
  }

  // Claim the token atomically so it can't be used twice in parallel.
  const claimed = await PasswordResetCode.findOneAndUpdate(
    { _id: record._id, revokedAt: null, resetTokenUsedAt: null, resetTokenExpiresAt: { $gt: now } },
    { $set: { resetTokenUsedAt: now } },
    { returnDocument: "after" }
  );
  if (!claimed) {
    res.status(410).json({ error: RESET_GONE, reason: "expired" });
    return;
  }

  user.password = password; // hashed by the model's pre-save hook
  user.passwordSetupRequired = false;
  user.tokenVersion = (user.tokenVersion ?? 0) + 1; // signs out every other session
  await user.save();

  await Promise.all([
    PasswordResetCode.updateMany({ user: user._id, revokedAt: null }, { $set: { revokedAt: now } }),
    PasswordSetupToken.updateMany({ user: user._id, usedAt: null, revokedAt: null }, { $set: { revokedAt: now } }),
  ]);

  logActivity({
    action: "password_reset",
    actor: user,
    targetType: "user",
    targetId: user._id as mongoose.Types.ObjectId,
    targetName: user.name,
    details: { via: "email_code" },
    ip: req.ip,
  });

  if (emailConfigured()) {
    void sendEmail({
      to: user.email,
      subject: "Your password was changed",
      html: passwordChangedTemplate({ firstName: firstNameOf(user.name), when: formatWhen(now), ip: req.ip }),
    }).catch(() => undefined);
  }

  issueSessionCookie(res, user);
  res.json({ user: user.toJSON() });
}
