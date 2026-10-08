import crypto from "node:crypto";
import { ApiKey } from "../models/ApiKey.js";
import type { IApiKey } from "../models/ApiKey.js";

// ---------------------------------------------------------------------------
// Server-to-server API keys: "pty_" + 40 random base62 characters. Only the
// SHA-256 hash is stored; the first 12 characters ("pty_AbCd1234") are kept as
// a display/lookup prefix. Comparison is constant-time. Keys are never logged.
// ---------------------------------------------------------------------------

const KEY_PREFIX = "pty_";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const API_KEY_DISPLAY_PREFIX_LENGTH = 12;
const KEY_REGEX = /^pty_[0-9A-Za-z]{40}$/;

export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key, "utf8").digest("hex");
}

/** A new random key with its display prefix and hash (the key itself is returned once). */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  let body = "";
  for (let i = 0; i < 40; i += 1) body += BASE62[crypto.randomInt(BASE62.length)];
  const key = `${KEY_PREFIX}${body}`;
  return { key, prefix: key.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH), hash: hashApiKey(key) };
}

export type ApiKeyCheck =
  | { ok: true; key: IApiKey }
  | { ok: false; reason: "invalid" | "revoked" };

/** Looks the key up by prefix and compares hashes in constant time. */
export async function verifyApiKey(presented: string): Promise<ApiKeyCheck> {
  // Hash even malformed input so timing doesn't reveal the format check.
  const presentedHash = Buffer.from(hashApiKey(presented), "hex");
  if (!KEY_REGEX.test(presented)) return { ok: false, reason: "invalid" };
  const candidates = await ApiKey.find({ prefix: presented.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH) }).limit(5);
  for (const candidate of candidates) {
    const stored = Buffer.from(candidate.hash, "hex");
    if (stored.length === presentedHash.length && crypto.timingSafeEqual(stored, presentedHash)) {
      return candidate.revokedAt ? { ok: false, reason: "revoked" } : { ok: true, key: candidate };
    }
  }
  return { ok: false, reason: "invalid" };
}

/** Marks the key used (at most once a minute per key to keep writes low). Fire-and-forget. */
export function touchApiKey(key: IApiKey, ip: string | undefined): void {
  const now = Date.now();
  if (key.lastUsedAt && now - key.lastUsedAt.getTime() < 60_000) return;
  void ApiKey.updateOne({ _id: key._id }, { $set: { lastUsedAt: new Date(now), lastUsedIp: ip ?? null } }).catch(
    () => undefined
  );
}
