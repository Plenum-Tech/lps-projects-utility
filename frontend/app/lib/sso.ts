import { API_BASE_URL, api, getErrorMessage } from "@/lib/api";
import type { User } from "@/types";

export type SsoConfig = { enabled: boolean };

export type SsoCallbackResponse = {
  user: User;
  next?: string;
};

/** Poll whether Microsoft SSO is configured on the API. */
export async function fetchSsoConfig(): Promise<SsoConfig> {
  try {
    const { data } = await api.get<SsoConfig>("/auth/sso/config");
    return { enabled: Boolean(data?.enabled) };
  } catch {
    return { enabled: false };
  }
}

/**
 * Browser navigation to start Entra login (not XHR).
 * Uses the same API base as Axios (`/api` in prod, localhost:5000/api in dev).
 */
export function entraStartUrl(next = "/dashboard"): string {
  const base = API_BASE_URL.replace(/\/$/, "");
  const path = (next || "").trim() || "/dashboard";
  return `${base}/auth/sso/entra/start?next=${encodeURIComponent(path)}`;
}

/** Exchange Entra code+state for the Utility session cookie. */
export async function completeEntraSso(code: string, state: string): Promise<SsoCallbackResponse> {
  try {
    const { data } = await api.post<SsoCallbackResponse>("/auth/sso/entra/callback", { code, state });
    return data;
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}

const RETURN_KEY = "utility.return-to";

/** Remembers the page a signed-out person opened (e.g. a shared task link), for after sign-in. */
export function rememberReturnPath(path: string): void {
  try {
    if (safeReturnPath(path) === path && path !== "/dashboard") sessionStorage.setItem(RETURN_KEY, path);
  } catch {
    /* no storage: they land on the dashboard */
  }
}

/** The remembered page (else the dashboard). It stays until clearReturnPath. */
export function returnPath(): string {
  try {
    return safeReturnPath(sessionStorage.getItem(RETURN_KEY));
  } catch {
    return "/dashboard";
  }
}

export function clearReturnPath(): void {
  try {
    sessionStorage.removeItem(RETURN_KEY);
  } catch {
    /* ignore */
  }
}

/** Same-origin return path only. */
export function safeReturnPath(raw: string | null | undefined): string {
  const n = (raw || "").trim();
  if (!n.startsWith("/") || n.startsWith("//") || n.includes("://")) return "/dashboard";
  if (n.startsWith("/auth/") || n.startsWith("/invite/") || n.startsWith("/set-password/")) {
    return "/dashboard";
  }
  return n;
}
