import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useToast } from "@/hooks/use-toast";
import { api, getErrorMessage } from "@/lib/api";
import type { LoginInput, UserResponse } from "@/types";

export const meKeys = {
  all: ["me"] as const,
};

/**
 * Current session user — the single source of truth for "who am I?".
 *
 * Returns `data: User | undefined`. A 401 (no/invalid cookie) resolves to
 * `error` rather than retrying, which the UI treats as "signed out".
 */
export function useCurrentUser() {
  return useQuery({
    queryKey: meKeys.all,
    queryFn: async () => {
      const { data } = await api.get<UserResponse>("/auth/me");
      return data.user;
    },
    retry: false, // 401 means "not signed in" — do not retry
    staleTime: Infinity, // session only changes through login/logout mutations, so never auto-revalidate.
    // NOTE: server-side role changes are picked up on the next login; the backend re-checks roles
    // on every request (requireRole), so this is purely a UI-staleness tradeoff.
  });
}

/** Signs in with email + password. On success the returned user seeds the `me` cache. */
export function useLogin() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async (input: LoginInput) => {
      const { data } = await api.post<UserResponse>("/auth/login", input);
      return data.user;
    },
    onSuccess: (user) => {
      // Drop everything cached for a previous session in this tab (dashboard,
      // documents, lists…) so a different user never sees stale data.
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== meKeys.all[0] });
      queryClient.setQueryData(meKeys.all, user);
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/** Signs out and resets the session so the UI flips to signed-out immediately. */
export function useLogout() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      await api.post("/auth/logout");
    },
    onSuccess: () => {
      // Reset + refetch `me` rather than removing it: removeQueries never
      // notifies already-mounted observers, so the profile would linger on
      // screen until a reload. Resetting drops the cached user and the
      // follow-up fetch 401s (cookie is already cleared), which the UI reads
      // as "signed out".
      void queryClient.resetQueries({ queryKey: meKeys.all });
    },
  });
}
