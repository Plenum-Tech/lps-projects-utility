import { useEffect, useRef, useState } from "react";

import { API_BASE_URL } from "@/lib/api";
import type { SSEEvent, SSEEventType } from "@/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SSEStatus = "connecting" | "connected" | "disconnected";

interface UseSSEOptions {
  /** Filter to a specific event type. If omitted, all events are received. */
  event?: SSEEventType;
  /** Callback invoked when a matching event is received. */
  onEvent?: (event: SSEEvent) => void;
  /** Set to false to disable the connection. Default: true. */
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Shared connection manager
// ---------------------------------------------------------------------------

/**
 * One EventSource per **browser**, not per tab. Browsers allow only ~6
 * HTTP/1.1 connections per host; a long-lived stream in every tab quickly
 * starves normal API requests (they queue until they time out).
 *
 * Tabs elect a leader with the Web Locks API: the tab holding the lock opens
 * the EventSource and relays every event (and its connection status) to the
 * other tabs over a BroadcastChannel. When the leader tab closes, the browser
 * releases the lock and the next waiting tab takes over automatically.
 * Without Web Locks/BroadcastChannel, each tab simply opens its own stream.
 *
 * Within a tab, all `useSSE` hooks share it via the listeners set.
 */
const LOCK_NAME = "ems-sse-leader";
const CHANNEL_NAME = "ems-sse";

type ChannelMessage =
  | { kind: "event"; event: SSEEvent }
  | { kind: "status"; status: SSEStatus }
  | { kind: "status-request" };

let active = false; // something in this tab is listening
let isLeader = false;
let channel: BroadcastChannel | null = null;
let lockAbort: AbortController | null = null;
let releaseLock: (() => void) | null = null;

let sharedEventSource: EventSource | null = null;
let sharedStatus: SSEStatus = "disconnected";
let retryCount = 0;
let retryTimeout: ReturnType<typeof setTimeout> | null = null;

type Listener = (event: SSEEvent) => void;
const listeners = new Set<Listener>();

function canShareAcrossTabs(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "locks" in navigator &&
    typeof BroadcastChannel !== "undefined"
  );
}

function dispatch(event: SSEEvent): void {
  for (const listener of listeners) {
    listener(event);
  }
}

function setStatus(status: SSEStatus): void {
  sharedStatus = status;
  notifyStatusListeners();
  if (isLeader) channel?.postMessage({ kind: "status", status } satisfies ChannelMessage);
}

function openEventSource(): void {
  if (sharedEventSource || !active) return;

  setStatus("connecting");

  const es = new EventSource(`${API_BASE_URL}/notifications/stream`, {
    withCredentials: true,
  });
  sharedEventSource = es;

  es.onopen = () => {
    retryCount = 0;
    setStatus("connected");
  };

  es.onmessage = (msg) => {
    let event: SSEEvent;
    try {
      event = JSON.parse(msg.data) as SSEEvent;
    } catch {
      return; // Ignore malformed messages (heartbeats, etc.)
    }
    dispatch(event);
    if (isLeader) channel?.postMessage({ kind: "event", event } satisfies ChannelMessage);
  };

  es.onerror = () => {
    es.close();
    sharedEventSource = null;
    setStatus("disconnected");
    if (!active) return;

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s max.
    const delay = Math.min(1000 * 2 ** retryCount, 30_000);
    retryCount += 1;

    retryTimeout = setTimeout(() => {
      retryTimeout = null;
      openEventSource();
    }, delay);
  };
}

function closeEventSource(): void {
  if (retryTimeout) {
    clearTimeout(retryTimeout);
    retryTimeout = null;
  }
  if (sharedEventSource) {
    sharedEventSource.close();
    sharedEventSource = null;
  }
  retryCount = 0;
}

function connect(): void {
  if (active) return;
  active = true;

  if (!canShareAcrossTabs()) {
    openEventSource();
    return;
  }

  sharedStatus = "connecting";
  notifyStatusListeners();

  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (message: MessageEvent<ChannelMessage>) => {
    const data = message.data;
    if (data.kind === "event" && !isLeader) {
      dispatch(data.event);
    } else if (data.kind === "status" && !isLeader) {
      sharedStatus = data.status;
      notifyStatusListeners();
    } else if (data.kind === "status-request" && isLeader) {
      channel?.postMessage({ kind: "status", status: sharedStatus } satisfies ChannelMessage);
    }
  };
  // Ask an existing leader (if any) for its current status.
  channel.postMessage({ kind: "status-request" } satisfies ChannelMessage);

  const abort = new AbortController();
  lockAbort = abort;
  navigator.locks
    .request(LOCK_NAME, { signal: abort.signal }, () => {
      // This tab is now the leader: open the stream and hold the lock until
      // disconnect() resolves the promise (or the tab closes).
      lockAbort = null;
      if (!active) return;
      isLeader = true;
      openEventSource();
      return new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
    })
    .catch(() => {
      // Aborted while waiting for the lock (this tab stopped listening).
    });
}

function disconnect(): void {
  if (!active) return;
  active = false;

  closeEventSource();
  lockAbort?.abort();
  lockAbort = null;
  releaseLock?.();
  releaseLock = null;
  isLeader = false;
  channel?.close();
  channel = null;

  sharedStatus = "disconnected";
}

// ---------------------------------------------------------------------------
// Status listeners (for the useSSEStatus hook)
// ---------------------------------------------------------------------------

type StatusListener = (status: SSEStatus) => void;
const statusListeners = new Set<StatusListener>();

function notifyStatusListeners(): void {
  for (const listener of statusListeners) {
    listener(sharedStatus);
  }
}

// ---------------------------------------------------------------------------
// useSSE — general-purpose event hook
// ---------------------------------------------------------------------------

/**
 * Listens for SSE events from the shared connection.
 *
 * ```ts
 * useSSE({
 *   event: "task-updated",
 *   onEvent: (e) => console.log("Task updated:", e.data),
 * });
 * ```
 */
export function useSSE(options: UseSSEOptions = {}): { status: SSEStatus } {
  const { event, onEvent, enabled = true } = options;
  const onEventRef = useRef(onEvent);
  const [status, setStatus] = useState<SSEStatus>(sharedStatus);

  // Keep the callback ref fresh without re-triggering the effect.
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled) return;

    // Subscribe with optional event-type filter.
    const listener: Listener = (sseEvent) => {
      if (event && sseEvent.type !== event) return;
      onEventRef.current?.(sseEvent);
    };
    listeners.add(listener);

    // Ensure the shared connection is open.
    connect();

    // Track connection status.
    const statusListener: StatusListener = (s) => setStatus(s);
    statusListeners.add(statusListener);
    setStatus(sharedStatus);

    return () => {
      listeners.delete(listener);
      statusListeners.delete(statusListener);

      // Tear down the shared connection when no one is listening.
      if (listeners.size === 0) {
        disconnect();
      }
    };
  }, [event, enabled]);

  return { status };
}

// ---------------------------------------------------------------------------
// useSSEStatus — connection status only (no event handling)
// ---------------------------------------------------------------------------

/**
 * Returns the current SSE connection status without subscribing to events.
 * Useful for showing a connection indicator in the UI.
 */
export function useSSEStatus(): { status: SSEStatus } {
  const [status, setStatus] = useState<SSEStatus>(sharedStatus);

  useEffect(() => {
    const listener: StatusListener = (s) => setStatus(s);
    statusListeners.add(listener);
    setStatus(sharedStatus);

    return () => {
      statusListeners.delete(listener);
    };
  }, []);

  return { status };
}
