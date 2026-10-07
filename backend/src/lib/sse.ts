import type { Response } from "express";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All event types that can be pushed via SSE. */
export type SSEEventType =
  | "notification"
  | "task-updated"
  | "leave-updated"
  | "attendance-updated"
  | "announcement-new"
  | "review-updated"
  | "insight-ready"
  | "review-ready"
  | "project-updated"
  | "timer-updated"
  | "timelog-updated"
  | "timesheet-updated";

/** The shape of every SSE event pushed to clients. */
export interface SSEEvent {
  type: SSEEventType;
  data: unknown;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Connection manager
// ---------------------------------------------------------------------------

/** Map of userId (string) → set of active SSE responses (insertion order = oldest first). */
const clients = new Map<string, Set<Response>>();

/**
 * Max concurrent streams per user. The SPA shares one EventSource per browser
 * (see frontend use-sse.ts), so 5 covers several browsers/devices; past that
 * the oldest stream is closed (the browser that owned it reconnects on demand).
 */
const MAX_STREAMS_PER_USER = Number(process.env.SSE_MAX_PER_USER) || 5;
/** Comment heartbeat — well under the ~240 s ACA/Envoy idle timeout and typical proxy limits. */
const HEARTBEAT_MS = 25_000;

let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

function ensureHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    for (const set of clients.values()) {
      for (const res of set) res.write(":heartbeat\n\n");
    }
  }, HEARTBEAT_MS);
  heartbeatTimer.unref?.();
}

/**
 * Register an SSE client for a user. Returns a cleanup function that
 * removes the client when called (e.g. on disconnect).
 */
export function registerClient(
  userId: string,
  res: Response
): () => void {
  ensureHeartbeat();
  let set = clients.get(userId);
  if (!set) {
    set = new Set();
    clients.set(userId, set);
  }
  // Enforce the per-user cap: close the oldest streams first.
  while (set.size >= MAX_STREAMS_PER_USER) {
    const oldest = set.values().next().value as Response | undefined;
    if (!oldest) break;
    set.delete(oldest);
    oldest.end();
  }
  set.add(res);

  return () => {
    const current = clients.get(userId);
    if (current) {
      current.delete(res);
      if (current.size === 0) clients.delete(userId);
    }
  };
}

/**
 * Graceful shutdown: tells every client to reconnect after `retryMs` (to the
 * next revision/replica) and ends the streams so the server can close.
 */
export function closeAllClients(retryMs = 3_000): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
  for (const set of clients.values()) {
    for (const res of set) {
      try {
        res.write(`retry: ${retryMs}\n\n`);
        res.end();
      } catch {
        // Socket already gone.
      }
    }
  }
  clients.clear();
}

/** Push an event to all connected SSE clients for a given user. */
export function pushToClient(userId: string, event: SSEEvent): void {
  const set = clients.get(userId);
  if (!set || set.size === 0) return;

  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of set) {
    res.write(payload);
  }
}

/** Push an event to multiple users. */
export function pushToUsers(userIds: string[], event: SSEEvent): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  const sent = new Set<Response>();

  for (const userId of userIds) {
    const set = clients.get(userId);
    if (!set) continue;
    for (const res of set) {
      if (!sent.has(res)) {
        res.write(payload);
        sent.add(res);
      }
    }
  }
}

/** Push an event to ALL connected SSE clients (broadcast). */
export function pushToAll(event: SSEEvent): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const set of clients.values()) {
    for (const res of set) {
      res.write(payload);
    }
  }
}

/** Return the total number of connected SSE clients (for diagnostics). */
export function getClientCount(): number {
  let count = 0;
  for (const set of clients.values()) {
    count += set.size;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Helper to create an SSEEvent with timestamp
// ---------------------------------------------------------------------------

export function createEvent(
  type: SSEEventType,
  data: unknown
): SSEEvent {
  return { type, data, timestamp: Date.now() };
}
