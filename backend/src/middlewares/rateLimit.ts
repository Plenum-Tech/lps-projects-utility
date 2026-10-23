import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../lib/jwt.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RateLimitConfig {
  /** Time window in milliseconds. */
  windowMs: number;
  /** Maximum number of requests allowed within the window. */
  max: number;
  /**
   * Function to generate the rate-limit key (default: request IP).
   * Use this to rate-limit by user ID, API key, etc.
   */
  keyGenerator?: (req: Request) => string;
  /** Custom error message returned when the limit is exceeded. */
  message?: string;
  /**
   * Only count failed requests: a response with status < 400 gives its slot
   * back (e.g. login — brute force is still limited, successful sign-ins aren't).
   */
  skipSuccessfulRequests?: boolean;
}

interface RateLimitEntry {
  count: number;
  /** Unix timestamp (ms) when the current window resets. */
  resetTime: number;
}

// ---------------------------------------------------------------------------
// Cleanup — purges expired entries from all active stores every 60 seconds
// ---------------------------------------------------------------------------

const CLEANUP_INTERVAL_MS = 60_000;

/** Weakly held set of all active stores so the timer can sweep them all. */
const allStores = new Set<Map<string, RateLimitEntry>>();

let cleanupTimer: ReturnType<typeof setInterval> | undefined;

function ensureCleanupRunning(stores: Set<Map<string, RateLimitEntry>>): void {
  if (cleanupTimer !== undefined) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const store of stores) {
      for (const [key, entry] of store) {
        if (entry.resetTime <= now) {
          store.delete(key);
        }
      }
    }
  }, CLEANUP_INTERVAL_MS);
  // Allow the Node.js process to exit even if the timer is still running.
  if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    cleanupTimer.unref();
  }
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Creates an Express middleware that limits the number of requests a client
 * can make within a sliding time window.
 *
 * Rate limit headers are set on every response:
 * - `X-RateLimit-Limit`     — max requests in the current window
 * - `X-RateLimit-Remaining` — requests left in the current window
 * - `X-RateLimit-Reset`     — UTC epoch (ms) when the window resets
 *
 * When the limit is exceeded the middleware responds with:
 *   `429 Too Many Requests` and `{ error: "Too many requests. Please try again later." }`
 */
export function rateLimit(config: RateLimitConfig): (req: Request, res: Response, next: NextFunction) => void {
  const {
    windowMs,
    max,
    keyGenerator = defaultKeyGenerator,
    message = "Too many requests. Please try again later.",
    skipSuccessfulRequests = false,
  } = config;

  // Each rate limiter gets its own store so tiers don't share counters.
  const store = new Map<string, RateLimitEntry>();
  allStores.add(store);
  ensureCleanupRunning(allStores);

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyGenerator(req);
    const now = Date.now();

    let entry = store.get(key);

    // Start a new window if the previous one has expired or doesn't exist.
    if (!entry || entry.resetTime <= now) {
      entry = { count: 0, resetTime: now + windowMs };
      store.set(key, entry);
    }

    entry.count++;

    if (skipSuccessfulRequests) {
      const counted = entry;
      res.on("finish", () => {
        // Refund within the same window only (an expired entry was replaced).
        if (res.statusCode < 400 && store.get(key) === counted && counted.count > 0) counted.count--;
      });
    }

    const remaining = Math.max(0, max - entry.count);

    // Set rate-limit headers on every response.
    res.setHeader("X-RateLimit-Limit", max);
    res.setHeader("X-RateLimit-Remaining", remaining);
    res.setHeader("X-RateLimit-Reset", entry.resetTime);

    if (entry.count > max) {
      res.setHeader("Retry-After", Math.ceil((entry.resetTime - now) / 1000));
      res.status(429).json({ error: message });
      return;
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default key generator — uses the request IP address. */
function defaultKeyGenerator(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

/**
 * Signed-in requests count per user (a whole office shares one public IP);
 * anonymous ones per IP. The token is only read here — requireAuth still
 * verifies every request properly.
 */
function userOrIpKey(req: Request): string {
  const token = (req as Request & { cookies?: Record<string, string> }).cookies?.token;
  if (token) {
    try {
      return `user:${verifyAccessToken(token).sub}`;
    } catch {
      // expired / invalid: fall back to the IP
    }
  }
  return `ip:${defaultKeyGenerator(req)}`;
}

// ---------------------------------------------------------------------------
// Pre-configured rate limiters for common tiers
// ---------------------------------------------------------------------------

/**
 * Strict — auth endpoints (e.g. login). 50 failed attempts per 15 minutes per IP
 * (successful logins aren't counted; an office of ~100 people shares one IP).
 */
export const strictRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  skipSuccessfulRequests: true,
  message: "Too many login attempts. Please try again later.",
});

/** Moderate — expensive compute operations (e.g. AI insights, reports). 5 requests per minute. */
export const moderateRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: "Too many requests to this resource. Please wait before trying again.",
});

/**
 * Standard — general API endpoints. 1500 requests per 15 minutes per user.
 * Board, project and report pages fire several queries per view (plus SSE-driven
 * refetches), so 100 was exhausted within minutes of normal use.
 */
export const standardRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1500,
  // Per signed-in user, not per IP: everyone in the office shares one address.
  keyGenerator: userOrIpKey,
});

/**
 * Public set-password link endpoints (GET preview + POST set): 10 requests per
 * 15 minutes per IP, in its own store.
 */
export const passwordSetupRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many attempts. Please wait a few minutes and try again.",
});

/**
 * Public forgot-password endpoints: 10 requests per 15 minutes per IP, one store
 * per step (request / verify / complete) so they never share a bucket.
 */
export const passwordResetRequestRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many requests. Please wait a few minutes and try again.",
});
export const passwordResetVerifyRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many attempts. Please wait a few minutes and try again.",
});
export const passwordResetCompleteRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many attempts. Please wait a few minutes and try again.",
});

/**
 * Public invitation accept endpoints (GET preview + POST accept): 10 requests per
 * 15 minutes per IP, in its own store so it never shares a bucket with login.
 */
export const inviteAcceptRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many attempts. Please wait a few minutes and try again.",
});

/**
 * AI summary score on the new-project form (POST /api/projects/summary-check,
 * one OpenAI call each): 20 checks per hour per signed-in user, in its own
 * store. Every attempt counts, failed ones too.
 */
export const summaryCheckRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: userOrIpKey,
  message: "You've checked a lot of summaries in the last hour. Try again later.",
});

/**
 * Brand flow scope reading (POST /api/brands/scope-extract — one vision model call
 * per click): 30 per hour per user.
 */
export const scopeExtractRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  keyGenerator: userOrIpKey,
  message: "You've read a lot of files in the last hour. Try again later.",
});

/**
 * Scope vs agreement similarity (POST /api/brands/scope-match — re-run, debounced, as scope
 * rows are edited; at most one model call each): 300 per hour per user.
 */
export const scopeMatchRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 300,
  keyGenerator: userOrIpKey,
  message: "The scope was compared a lot in the last hour. Try again later.",
});

/**
 * Outcome readiness on the close-task dialog (POST /api/tasks/:id/outcome-readiness —
 * at most one model call each, debounced while typing): 120 per hour per user.
 */
export const outcomeReadinessRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 120,
  keyGenerator: userOrIpKey,
  message: "You've checked a lot of outcome notes in the last hour. Try again later.",
});

/**
 * Voice task assistant (POST /api/voice/transcribe and /understand — at most one
 * OpenAI call each): 30 per minute per user, in its own store.
 */
export const voiceRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: userOrIpKey,
  message: "That's a lot of voice notes in a minute. Wait a moment and try again.",
});
