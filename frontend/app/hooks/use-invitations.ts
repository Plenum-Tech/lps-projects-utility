import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { toast } from "@/components/ui/toast";
import { meKeys } from "@/hooks/use-auth";
import { usersKeys } from "@/hooks/use-users";
import { useToast } from "@/hooks/use-toast";
import { api, getErrorMessage } from "@/lib/api";
import type {
  AcceptInvitationResponse,
  CreateInvitationsInput,
  InvitationListResponse,
  InvitationPreview,
  InvitationSendResponse,
  InvitationState,
  InviteResult,
} from "@/types";

export const invitationKeys = {
  all: ["invitations"] as const,
  list: (params: InvitationListParams) => ["invitations", "list", params] as const,
  preview: (token: string) => ["invitation-preview", token] as const,
};

export interface InvitationListParams {
  status?: InvitationState | "all";
  search?: string;
  limit?: number;
  offset?: number;
}

/** Copies text to the clipboard and confirms with a toast. */
export async function copyInviteLink(url: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    toast.add({ type: "success", title: "Invite link copied" });
  } catch {
    toast.add({
      type: "error",
      title: "Couldn't copy the link",
      description: "Your browser blocked clipboard access.",
    });
  }
}

/** Admin: invitation list with status filter, email search, pagination and per-status counts. */
export function useInvitations(params: InvitationListParams) {
  return useQuery({
    queryKey: invitationKeys.list(params),
    queryFn: async () => {
      const { status, search, limit, offset } = params;
      const { data } = await api.get<InvitationListResponse>("/invitations", {
        params: {
          ...(status && status !== "all" ? { status } : {}),
          ...(search ? { search } : {}),
          ...(limit !== undefined ? { limit, offset: offset ?? 0 } : {}),
        },
      });
      return data;
    },
    placeholderData: keepPreviousData,
  });
}

/** Admin: invites up to 50 emails; the caller renders the per-email results step. */
export function useCreateInvitations() {
  const queryClient = useQueryClient();
  const notify = useToast();

  return useMutation({
    mutationFn: async (input: CreateInvitationsInput) => {
      const { data } = await api.post<{ results: InviteResult[] }>("/invitations", input);
      return data.results;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: invitationKeys.all });
    },
    onError: (error: unknown) => {
      notify.error(getErrorMessage(error));
    },
  });
}

/** Admin: re-sends an invite (new link, +7 days) and offers a Copy link toast action. */
export function useResendInvitation() {
  const queryClient = useQueryClient();
  const notify = useToast();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.post<InvitationSendResponse>(`/invitations/${id}/resend`);
      return data;
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: invitationKeys.all });
      toast.add({
        type: "success",
        title: "Invitation re-sent",
        description: `A new link was emailed to ${data.invitation.email}. The old link no longer works.`,
        actionProps: {
          children: "Copy link",
          onClick: () => void copyInviteLink(data.acceptUrl),
        },
        timeout: 10_000,
      });
    },
    onError: (error: unknown) => {
      notify.error(getErrorMessage(error));
    },
  });
}

/** Admin: revokes a pending invite (its link stops working immediately). */
export function useRevokeInvitation() {
  const queryClient = useQueryClient();
  const notify = useToast();

  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/invitations/${id}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: invitationKeys.all });
      notify.success("Invitation revoked");
    },
    onError: (error: unknown) => {
      notify.error(getErrorMessage(error));
    },
  });
}

/** Public: invite preview for /invite/:token (no retries — 404/410 are final answers). */
export function useInvitationPreview(token: string) {
  return useQuery({
    queryKey: invitationKeys.preview(token),
    queryFn: async () => {
      const { data } = await api.get<InvitationPreview>(`/invitations/accept/${encodeURIComponent(token)}`);
      return data;
    },
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

/** Public: creates the account and signs in; seeds the `me` cache with the new user. */
export function useAcceptInvitation(token: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { name: string; password: string }) => {
      const { data } = await api.post<AcceptInvitationResponse>(
        `/invitations/accept/${encodeURIComponent(token)}`,
        input
      );
      return data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(meKeys.all, data.user);
      void queryClient.invalidateQueries({ queryKey: usersKeys.all });
    },
  });
}
