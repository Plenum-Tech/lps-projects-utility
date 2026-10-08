import axios from "axios";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { meKeys } from "@/hooks/use-auth";
import { api } from "@/lib/api";
import type { PasswordResetRequestResponse, PasswordResetVerifyResponse, UserResponse } from "@/types";

/** Status, `reason` and `attemptsLeft` of a failed forgot-password call, for picking the right message. */
export function passwordResetFailure(error: unknown): {
  status?: number;
  reason?: string;
  attemptsLeft?: number | null;
} {
  if (!axios.isAxiosError<{ reason?: string; attemptsLeft?: number | null }>(error)) return {};
  return {
    status: error.response?.status,
    reason: error.response?.data?.reason,
    attemptsLeft: error.response?.data?.attemptsLeft,
  };
}

/** Step 1: asks for a code. The answer is always generic (no account enumeration). */
export function useRequestPasswordReset() {
  return useMutation({
    mutationFn: async (email: string) => {
      const { data } = await api.post<PasswordResetRequestResponse>("/auth/password-reset/request", { email });
      return data;
    },
  });
}

/** Step 2: exchanges the emailed code for a short-lived reset token. */
export function useVerifyPasswordReset() {
  return useMutation({
    mutationFn: async (input: { email: string; code: string }) => {
      const { data } = await api.post<PasswordResetVerifyResponse>("/auth/password-reset/verify", input);
      return data;
    },
  });
}

/** Step 3: sets the new password; the backend signs the user in, so seed the `me` cache. */
export function useCompletePasswordReset() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { resetToken: string; password: string; confirmPassword: string }) => {
      const { data } = await api.post<UserResponse>("/auth/password-reset/complete", input);
      return data.user;
    },
    onSuccess: (user) => {
      // Drop anything cached for a previous session in this tab, as login does.
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== meKeys.all[0] });
      queryClient.setQueryData(meKeys.all, user);
    },
  });
}
