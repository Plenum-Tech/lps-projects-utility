import mongoose, { Schema } from "mongoose";

export const PASSWORD_RESET_LIMITS = {
  /** Validity of an emailed code. */
  codeTtlMs: 10 * 60 * 1000,
  /** Wrong guesses allowed per code before it locks. */
  maxAttempts: 5,
  /** Minimum gap between two codes for the same email. */
  resendCooldownMs: 60 * 1000,
  /** Codes per email per rolling hour. */
  maxPerHour: 5,
  /** Validity of the reset token returned by a correct code. */
  resetTokenTtlMs: 15 * 60 * 1000,
  passwordMin: 8,
  passwordMax: 128,
} as const;

/**
 * One forgot-password attempt: a 6-digit code emailed to the user and, once
 * the code is verified, a short-lived reset token. Only HMAC/SHA-256 hashes are
 * stored. Requesting a new code revokes the user's older records.
 */
export interface IPasswordResetCode extends mongoose.Document {
  user: mongoose.Types.ObjectId;
  emailLower: string;
  codeHash: string;
  /** Code expiry (10 min). Documents are purged by a TTL index a day later. */
  expiresAt: Date;
  /** Wrong + right guesses so far; locked at PASSWORD_RESET_LIMITS.maxAttempts. */
  attempts: number;
  /** Set when the code was verified (codes are single use). */
  usedAt?: Date | null;
  /** Set when a newer code was requested or the password was reset. */
  revokedAt?: Date | null;
  resetTokenHash?: string | null;
  resetTokenExpiresAt?: Date | null;
  resetTokenUsedAt?: Date | null;
  ip?: string;
  createdAt: Date;
  updatedAt: Date;
}

const passwordResetCodeSchema = new Schema<IPasswordResetCode>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    emailLower: { type: String, required: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    usedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    resetTokenHash: { type: String, default: null },
    resetTokenExpiresAt: { type: Date, default: null },
    resetTokenUsedAt: { type: Date, default: null },
    ip: { type: String },
  },
  { timestamps: true }
);

passwordResetCodeSchema.index({ emailLower: 1, createdAt: -1 });
passwordResetCodeSchema.index({ user: 1, revokedAt: 1 });
passwordResetCodeSchema.index(
  { resetTokenHash: 1 },
  { unique: true, partialFilterExpression: { resetTokenHash: { $type: "string" } } }
);
// Housekeeping: kept a day past expiry so the hourly cap still sees them, then purged.
passwordResetCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

passwordResetCodeSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.codeHash;
    delete json.resetTokenHash;
    delete json.__v;
    return json;
  },
});

export const PasswordResetCode = mongoose.model<IPasswordResetCode>("PasswordResetCode", passwordResetCodeSchema);
