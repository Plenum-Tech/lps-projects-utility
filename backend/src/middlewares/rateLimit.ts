import type { NextFunction, Request, Response } from "express";

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

// ---------------------------------------------------------------------------
// Pre-configured rate limiters for common tiers
// ---------------------------------------------------------------------------

/** Strict — auth endpoints (e.g. login). 10 failed attempts per 15 minutes (successful logins aren't counted). */
export const strictRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
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
 * Standard — general API endpoints. 1000 requests per 15 minutes.
 * Board, project and report pages fire several queries per view (plus SSE-driven
 * refetches), so 100 was exhausted within minutes of normal use.
 */
export const standardRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
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
