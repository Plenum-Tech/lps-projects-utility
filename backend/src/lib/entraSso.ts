import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/** Multi-tenant Entra endpoints (organizations). */
export const ENTRA_AUTHORIZE = "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize";
export const ENTRA_TOKEN = "https://login.microsoftonline.com/organizations/oauth2/v2.0/token";
export const ENTRA_JWKS = "https://login.microsoftonline.com/organizations/discovery/v2.0/keys";
export const ENTRA_ISSUER_BASE = "https://login.microsoftonline.com";

const SSO_STATE_TTL_MS = 10 * 60 * 1000;

export interface EntraSsoConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  allowedTenants: string[];
  allowedDomains: string[];
}

export interface EntraClaims {
  oid: string;
  tid: string;
  email: string;
  name: string;
  nonce: string;
}

let cached: EntraSsoConfig | null | undefined;
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function csvList(raw: string | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const item = part.trim().toLowerCase();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** Reads SSO env once. Disabled when ENTRA_SSO_ENABLED is not true. */
export function getEntraSsoConfig(): EntraSsoConfig | null {
  if (cached !== undefined) return cached;
  if (process.env.ENTRA_SSO_ENABLED?.trim().toLowerCase() !== "true") {
    cached = null;
    return cached;
  }
  const clientId = process.env.ENTRA_SSO_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.ENTRA_SSO_CLIENT_SECRET?.trim() ?? "";
  const redirectUri =
    process.env.ENTRA_SSO_REDIRECT_URI?.trim() ||
    `${(process.env.APP_URL ?? "").replace(/\/$/, "")}/auth/sso/callback`;
  const allowedTenants = csvList(process.env.ENTRA_SSO_ALLOWED_TENANT_IDS);
  const allowedDomains = csvList(process.env.ENTRA_SSO_ALLOWED_DOMAINS);

  if (!clientId || !clientSecret || !redirectUri || allowedTenants.length === 0) {
    console.warn(
      "⚠️  ENTRA_SSO_ENABLED=true but client id/secret/redirect/tenants are incomplete — SSO stays off."
    );
    cached = null;
    return cached;
  }

  cached = {
    enabled: true,
    clientId,
    clientSecret,
    redirectUri,
    allowedTenants,
    allowedDomains,
  };
  return cached;
}

/** For tests / hot reload after env changes in dev. */
export function resetEntraSsoConfigCache(): void {
  cached = undefined;
}

export function ssoStateExpiresAt(): Date {
  return new Date(Date.now() + SSO_STATE_TTL_MS);
}

export function randomUrlToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Same-origin path only (blocks open redirects). */
export function safeReturnPath(raw: string | null | undefined): string {
  const n = (raw ?? "").trim();
  if (!n.startsWith("/") || n.startsWith("//") || n.includes("://")) return "/dashboard";
  if (n.startsWith("/auth/") || n.startsWith("/invite/") || n.startsWith("/set-password/")) {
    return "/dashboard";
  }
  return n;
}

export function buildAuthorizeUrl(cfg: EntraSsoConfig, state: string, nonce: string, challenge: string): string {
  const url = new URL(ENTRA_AUTHORIZE);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("response_mode", "query");
  return url.toString();
}

export async function exchangeCode(
  cfg: EntraSsoConfig,
  code: string,
  codeVerifier: string
): Promise<{ idToken: string }> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: codeVerifier,
  });
  const res = await fetch(ENTRA_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`token_exchange_failed:${res.status}:${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { id_token?: string };
  if (!json.id_token) throw new Error("token_exchange_missing_id_token");
  return { idToken: json.id_token };
}

function jwksSet() {
  jwks ??= createRemoteJWKSet(new URL(ENTRA_JWKS));
  return jwks;
}

function pickEmail(...candidates: Array<unknown>): string {
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const email = c.trim().toLowerCase();
    if (!email || email.includes("#ext#")) continue;
    if (email.split("@").length === 2) return email;
  }
  return "";
}

function emailDomain(email: string): string {
  const i = email.lastIndexOf("@");
  return i >= 0 ? email.slice(i + 1).toLowerCase() : "";
}

function issuerMatchesTenant(iss: unknown, tid: string): boolean {
  if (typeof iss !== "string" || !tid) return false;
  const want = `${ENTRA_ISSUER_BASE}/${tid}/v2.0`.toLowerCase();
  return iss.replace(/\/$/, "").toLowerCase() === want;
}

/**
 * Verifies the Entra id_token and returns normalized claims, or throws with a
 * short machine reason (mapped to HTTP by the controller).
 */
export async function verifyIdToken(
  cfg: EntraSsoConfig,
  idToken: string,
  expectedNonce: string
): Promise<EntraClaims> {
  // Multi-tenant: iss is https://login.microsoftonline.com/{tid}/v2.0 —
  // validate iss ourselves against tid (do not pass issuer here).
  const { payload } = await jwtVerify(idToken, jwksSet(), {
    audience: cfg.clientId,
  });

  const tid = String(payload.tid ?? "").trim().toLowerCase();
  const oid = String(payload.oid ?? "").trim();
  if (!tid || !oid) throw new Error("missing_oid_tid");
  if (!issuerMatchesTenant(payload.iss, tid)) throw new Error("issuer_mismatch");
  if (!cfg.allowedTenants.includes(tid)) throw new Error("tenant_denied");

  const nonce = String(payload.nonce ?? "");
  if (!nonce || !safeEqual(nonce, expectedNonce)) {
    throw new Error("nonce_mismatch");
  }

  const email = pickEmail(
    payload.email,
    (payload as JWTPayload & { preferred_username?: string }).preferred_username,
    (payload as JWTPayload & { upn?: string }).upn
  );
  if (!email) throw new Error("no_email");
  if (cfg.allowedDomains.length > 0 && !cfg.allowedDomains.includes(emailDomain(email))) {
    throw new Error("domain_denied");
  }

  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  return { oid, tid, email, name, nonce };
}

/** Safe compare that tolerates unequal lengths. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
