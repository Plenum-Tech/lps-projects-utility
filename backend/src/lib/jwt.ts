import { createSecretKey, type KeyObject } from "node:crypto";
import jwt from "jsonwebtoken";

/** Name of the httpOnly cookie that carries the access token. */
export const TOKEN_COOKIE = "token";

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = (process.env.JWT_EXPIRES_IN ?? "7d") as unknown as jwt.SignOptions["expiresIn"];

export interface AccessTokenPayload {
  sub: string;
  role: "admin" | "employee" | "head";
  /**
   * The user's `tokenVersion` when the token was signed. Tokens issued before
   * this claim existed carry none and count as version 0 (the user default).
   */
  tv: number;
}

let secretKey: KeyObject | undefined;

/**
 * The HMAC key as a KeyObject, built once: given a string, jsonwebtoken builds
 * a new KeyObject on every sign/verify (measurable CPU on every API request).
 */
function requireSecret(): KeyObject {
  if (!JWT_SECRET) {
    throw new Error("JWT_SECRET is not set. Add it to backend/.env (see backend/.env.example).");
  }
  secretKey ??= createSecretKey(Buffer.from(JWT_SECRET, "utf8"));
  return secretKey;
}

/** Signs an access token for the given user. */
export function signAccessToken(user: {
  id: string;
  role: "admin" | "employee" | "head";
  tokenVersion?: number | null;
}): string {
  return jwt.sign({ sub: user.id, role: user.role, tv: user.tokenVersion ?? 0 }, requireSecret(), {
    expiresIn: JWT_EXPIRES_IN,
  });
}

/** Verifies a token and returns its payload. Throws on invalid or expired tokens. */
export function verifyAccessToken(token: string): AccessTokenPayload {
  const payload = jwt.verify(token, requireSecret());
  if (typeof payload === "string" || typeof payload.sub !== "string") {
    throw new jwt.JsonWebTokenError("Invalid token payload");
  }
  const tv = typeof payload.tv === "number" && Number.isInteger(payload.tv) ? payload.tv : 0;
  return { sub: payload.sub, role: payload.role as AccessTokenPayload["role"], tv };
}

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Converts a ms-style duration ("7d", "2h", "30m") to milliseconds (for the cookie maxAge). */
export function expiresInToMs(expiresIn: string): number {
  const match = /^(\d+)\s*(s|m|h|d|w)?$/.exec(expiresIn.trim());
  if (!match) {
    throw new Error(`Invalid JWT_EXPIRES_IN value: "${expiresIn}" (use e.g. 7d, 2h, 30m)`);
  }
  const value = Number(match[1]);
  const unit = match[2] ?? "s";
  return value * (UNIT_MS[unit] ?? 1_000);
}
