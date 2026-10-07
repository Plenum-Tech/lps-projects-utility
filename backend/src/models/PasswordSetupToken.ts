import mongoose, { Schema } from "mongoose";

export const PASSWORD_SETUP_LIMITS = {
  /** Validity of a set-password link. */
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  /** Users per bulk request. */
  maxBulk: 500,
  passwordMin: 8,
  passwordMax: 128,
} as const;

/**
 * One-time set-password link (same design as invitations): only the SHA-256
 * of the random token is stored. Issuing a new link revokes the user's older
 * unused ones; a link is single use and expires after 7 days.
 */
export interface IPasswordSetupToken extends mongoose.Document {
  user: mongoose.Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  usedAt?: Date | null;
  revokedAt?: Date | null;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const passwordSetupTokenSchema = new Schema<IPasswordSetupToken>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

passwordSetupTokenSchema.index({ tokenHash: 1 }, { unique: true });
passwordSetupTokenSchema.index({ user: 1, usedAt: 1, revokedAt: 1 });
// Housekeeping: links disappear 30 days after they expire.
passwordSetupTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

passwordSetupTokenSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.tokenHash;
    delete json.__v;
    return json;
  },
});

export const PasswordSetupToken = mongoose.model<IPasswordSetupToken>("PasswordSetupToken", passwordSetupTokenSchema);
