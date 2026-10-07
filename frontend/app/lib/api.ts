import axios from "axios";

/**
 * Base URL of the Express API. Override in frontend/.env (or .env.local) with
 * `VITE_API_URL` — defaults to the local backend in development.
 */
export const API_BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:5000/api";

/**
 * Shared Axios instance for all backend calls.
 *
 * Auth is cookie-based: the backend sets an httpOnly JWT cookie on login, so we
 * must send credentials on every request and never store the token in
 * localStorage. React Router owns routing; this client owns server communication.
 */
export const api = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
  timeout: 15_000,
  headers: {
    "Content-Type": "application/json",
  },
});

/** Machine-readable `code` from a backend JSON error (e.g. "password_setup_required"). */
export function getErrorCode(error: unknown): string | undefined {
  if (!axios.isAxiosError<{ code?: unknown }>(error)) return undefined;
  const code = error.response?.data?.code;
  return typeof code === "string" ? code : undefined;
}

/** Login 403 `code` for imported accounts that must set a password via a link first. */
export const PASSWORD_SETUP_REQUIRED_CODE = "password_setup_required";

/**
 * Pulls a readable message out of any thrown error:
 * - backend JSON errors (`{ error: string }`)
 * - HTTP status codes
 * - network failures (backend not running, CORS, DNS, ...)
 * - anything else
 */
export function getErrorMessage(error: unknown): string {
  if (axios.isAxiosError<{ error?: string }>(error)) {
    const serverMessage = error.response?.data?.error;
    if (serverMessage) return serverMessage;
    if (error.code === "ERR_NETWORK") {
      return "Cannot reach the API server. Make sure the backend is running.";
    }
    if (error.response) {
      return `Request failed with status ${error.response.status}.`;
    }
    return error.message || "Network error";
  }
  return error instanceof Error ? error.message : "Something went wrong";
}
