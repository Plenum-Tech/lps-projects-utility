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

/** Map of userId (string) → set of active SSE responses. */
const clients = new Map<string, Set<Response>>();

/**
 * Register an SSE client for a user. Returns a cleanup function that
 * removes the client when called (e.g. on disconnect).
 */
export function registerClient(
  userId: string,
  res: Response
): () => void {
  if (!clients.has(userId)) {
    clients.set(userId, new Set());
  }
  clients.get(userId)!.add(res);

  return () => {
    const set = clients.get(userId);
    if (set) {
      set.delete(res);
      if (set.size === 0) clients.delete(userId);
    }
  };
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
