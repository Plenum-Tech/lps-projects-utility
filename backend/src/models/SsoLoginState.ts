import mongoose, { Schema } from "mongoose";

/**
 * One-time Entra OIDC login state (PKCE + nonce). Documents expire via TTL
 * on `expiresAt` so abandoned starts do not accumulate.
 */
export interface ISsoLoginState extends mongoose.Document {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnPath: string;
  expiresAt: Date;
  createdAt: Date;
}

const ssoLoginStateSchema = new Schema<ISsoLoginState>(
  {
    state: { type: String, required: true, unique: true, index: true },
    nonce: { type: String, required: true },
    codeVerifier: { type: String, required: true },
    returnPath: { type: String, required: true, default: "/dashboard" },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

ssoLoginStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SsoLoginState = mongoose.model<ISsoLoginState>("SsoLoginState", ssoLoginStateSchema);
