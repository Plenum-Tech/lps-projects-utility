import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSSE } from "@/hooks/use-sse";
import { api } from "@/lib/api";
import type {
  Notification,
  NotificationListResponse,
  NotificationReadResponse,
  UnreadCountResponse,
} from "@/types";

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const notificationKeys = {
  all: ["notifications"] as const,
  list: (limit: number | null, offset: number) =>
    ["notifications", "list", { limit, offset }] as const,
  unreadCount: ["notifications", "unread-count"] as const,
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Current user's notifications (newest first, paginated). */
export function useNotifications(params: { limit?: number; offset?: number } = {}) {
  const { limit, offset = 0 } = params;

  return useQuery({
    queryKey: notificationKeys.list(limit ?? null, offset),
    queryFn: async () => {
      const { data } = await api.get<NotificationListResponse>("/notifications", {
        params: {
          ...(limit !== undefined ? { limit, offset } : {}),
        },
      });
      return data;
    },
    placeholderData: (previous) => previous,
  });
}

/** Unread notification count — used for the badge. Polls every 30s as fallback. */
export function useUnreadCount() {
  return useQuery({
    queryKey: notificationKeys.unreadCount,
    queryFn: async () => {
      const { data } = await api.get<UnreadCountResponse>("/notifications/unread-count");
      return data;
    },
    refetchInterval: 30_000, // Poll every 30s as SSE fallback
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Mark a single notification as read. */
export function useMarkAsRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.patch<NotificationReadResponse>(`/notifications/${id}/read`);
      return data.notification;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}

/** Mark all notifications as read. */
export function useMarkAllAsRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      await api.post("/notifications/read-all");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}

// ---------------------------------------------------------------------------
// SSE hook — real-time push notifications
// ---------------------------------------------------------------------------

/**
 * Refreshes the notification queries whenever a `notification` event arrives.
 *
 * Rides on the shared SSE connection from `useSSE` — it used to open its own
 * EventSource, so every tab held two long-lived connections and a few tabs
 * exhausted the browser's 6-connections-per-host limit (other requests then
 * queued until they timed out). Returns the connection status.
 */
export function useNotificationSSE() {
  const queryClient = useQueryClient();
  return useSSE({
    event: "notification",
    onEvent: () => {
      void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}
