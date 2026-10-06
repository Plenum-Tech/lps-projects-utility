import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { meKeys } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { api, getErrorMessage } from "@/lib/api";
import type { EmailPreferences, User } from "@/types";

export const emailPreferenceKeys = {
  all: ["email-preferences"] as const,
};

/** Current user's email notification switches. */
export function useEmailPreferences() {
  return useQuery({
    queryKey: emailPreferenceKeys.all,
    queryFn: async () => {
      const { data } = await api.get<{ emailPreferences: EmailPreferences }>(
        "/users/me/email-preferences"
      );
      return data.emailPreferences;
    },
  });
}

/** Flips one or more switches — applied optimistically, rolled back on error. */
export function useUpdateEmailPreferences() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async (input: Partial<EmailPreferences>) => {
      const { data } = await api.patch<{ emailPreferences: EmailPreferences }>(
        "/users/me/email-preferences",
        input
      );
      return data.emailPreferences;
    },
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: emailPreferenceKeys.all });
      const previous = queryClient.getQueryData<EmailPreferences>(emailPreferenceKeys.all);
      if (previous) {
        queryClient.setQueryData<EmailPreferences>(emailPreferenceKeys.all, {
          ...previous,
          ...input,
        });
      }
      return { previous };
    },
    onError: (error: unknown, _input, context) => {
      if (context?.previous) {
        queryClient.setQueryData(emailPreferenceKeys.all, context.previous);
      }
      toast.error(getErrorMessage(error));
    },
    onSuccess: (emailPreferences) => {
      queryClient.setQueryData(emailPreferenceKeys.all, emailPreferences);
      queryClient.setQueryData<User | undefined>(meKeys.all, (user) =>
        user ? { ...user, emailPreferences } : user
      );
    },
  });
}
