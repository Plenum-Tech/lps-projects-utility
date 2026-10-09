import axios from "axios";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { toast } from "@/components/ui/toast";
import { meKeys } from "@/hooks/use-auth";
import { usersKeys } from "@/hooks/use-users";
import {
  api,
  getErrorCode,
  getErrorMessage,
  PASSWORD_SETUP_REQUIRED_CODE,
} from "@/lib/api";
import type {
  PasswordLinkResponse,
  PasswordLinksResponse,
  PasswordSetupGoneReason,
  PasswordSetupPreview,
  User,
  UserResponse,
  UsersListResponse,
} from "@/types";

/** Most users the bulk endpoint accepts per request. */
export const MAX_BULK_PASSWORD_LINKS = 500;

export const passwordSetupKeys = {
  preview: (token: string) => ["password-setup-preview", token] as const,
};

/** True when a login error means "this account must set a password via a link first". */
export function isPasswordSetupRequiredError(error: unknown): boolean {
  return getErrorCode(error) === PASSWORD_SETUP_REQUIRED_CODE;
}

/** Status + 410 reason of a failed preview / submit, for picking the right state card. */
export function passwordSetupFailure(error: unknown): {
  status?: number;
  reason?: PasswordSetupGoneReason;
} {
  if (!axios.isAxiosError<{ reason?: PasswordSetupGoneReason }>(error))
    return {};
  return {
    status: error.response?.status,
    reason: error.response?.data?.reason,
  };
}

/** Writes text to the clipboard; resolves false when the browser blocks it. */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Async Clipboard API missing (plain-http deployments) or refused (document not
    // focused): fall back to a selected textarea + execCommand during the click.
    return legacyCopy(text);
  }
}

function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  // Inside a modal, append to the dialog so its focus trap doesn't fight the selection.
  const host =
    document.activeElement?.closest("[role=dialog],[role=alertdialog]") ??
    document.body;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  area.style.pointerEvents = "none";
  host.appendChild(area);
  try {
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/**
 * Copies a set-password link and confirms with a toast. If the browser blocks
 * clipboard access (e.g. no user gesture after a network call), the toast
 * offers a Copy button so the next click counts as the gesture.
 */
export async function copySetupLink(url: string, name?: string): Promise<void> {
  if (await writeClipboard(url)) {
    toast.add({
      type: "success",
      title: "Set-password link copied",
      description: name
        ? `Share it with ${name}. It works once and expires in 7 days.`
        : undefined,
    });
    return;
  }
  toast.add({
    type: "warning",
    title: "Link ready — click Copy",
    description: "Your browser blocked automatic clipboard access.",
    actionProps: {
      children: "Copy link",
      onClick: () => void copySetupLink(url, name),
    },
    timeout: 20_000,
  });
}

/* ------------------------------------------------------------------ */
/* Admin                                                               */
/* ------------------------------------------------------------------ */

/**
 * Admin: issues a new set-password link for one user (older unused links stop
 * working). `sendEmail: true` emails it when SMTP is configured; the toast says
 * which happened and always offers Copy link. `sendEmail: false` = Copy link.
 */
export function useCreatePasswordLink() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      user,
      sendEmail,
    }: {
      user: Pick<User, "_id" | "name" | "email">;
      sendEmail: boolean;
    }) => {
      const { data } = await api.post<PasswordLinkResponse>(
        `/users/${user._id}/password-link`,
        { sendEmail },
      );
      return data;
    },
    onSuccess: (data, { user, sendEmail }) => {
      void queryClient.invalidateQueries({ queryKey: usersKeys.all });
      if (!sendEmail) {
        void copySetupLink(data.setupUrl, user.name);
        return;
      }
      toast.add({
        type: data.emailed ? "success" : "info",
        title: data.emailed
          ? `Set-password link emailed to ${user.name}`
          : "Link ready — email isn't configured",
        description: data.emailed
          ? `Sent to ${user.email}. You can also copy the link and share it yourself.`
          : `Copy the link and share it with ${user.name} yourself. It works once and expires in 7 days.`,
        actionProps: {
          children: "Copy link",
          onClick: () => void copySetupLink(data.setupUrl, user.name),
        },
        timeout: 15_000,
      });
    },
    onError: (error: unknown) => {
      toast.add({
        type: "error",
        title: "Couldn't create the link",
        description: getErrorMessage(error),
      });
    },
  });
}

/** One row of the bulk results dialog: the result joined with the user's name/email. */
export interface BulkPasswordLinkRow {
  userId: string;
  name: string;
  email: string;
  setupUrl?: string;
  emailed: boolean;
  failed: boolean;
}

export interface BulkPasswordLinksResult {
  rows: BulkPasswordLinkRow[];
  emailConfigured: boolean;
  /** Users needing a password that didn't fit in this request (over the 500 limit). */
  remaining: number;
}

/**
 * Admin: "Send links to all needing a password". Loads the pending users first
 * so the results can show names, then sends their ids to the bulk endpoint.
 */
export interface DefaultPasswordInput {
  password: string;
  scope: "pending" | "all" | "selected";
  /** Required when scope is "selected". */
  userIds?: string[];
  requireChange: boolean;
}

/** Admin: one default password for every pending (or every) employee. */
export function useSetDefaultPassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: DefaultPasswordInput) => {
      const { data } = await api.post<{
        updated: number;
        scope: string;
        requireChange: boolean;
      }>("/users/default-password", input);
      return data;
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: usersKeys.all });
      toast.add({
        type: "success",
        title:
          data.updated === 0
            ? "No accounts needed a password"
            : `Default password set for ${data.updated} ${data.updated === 1 ? "employee" : "employees"}`,
        description:
          data.updated === 0
            ? undefined
            : data.requireChange
              ? "They can sign in now and will be asked to choose their own password."
              : "They can sign in now.",
      });
    },
    onError: (error: unknown) => {
      toast.add({
        type: "error",
        title: "Couldn't set the default password",
        description: getErrorMessage(error),
      });
    },
  });
}

export function useBulkPasswordLinks() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<BulkPasswordLinksResult> => {
      // No `limit` = every matching user (the paginated endpoint caps pages at 200).
      const { data: list } = await api.get<UsersListResponse>("/users", {
        params: { passwordSetup: "required" },
      });
      const users = list.users.slice(0, MAX_BULK_PASSWORD_LINKS);
      if (users.length === 0)
        return { rows: [], emailConfigured: false, remaining: 0 };
      const { data } = await api.post<PasswordLinksResponse>(
        "/users/password-links",
        {
          userIds: users.map((user) => user._id),
          sendEmail: true,
        },
      );
      const byId = new Map(
        data.results.map((result) => [result.userId, result]),
      );
      const rows = users.map((user): BulkPasswordLinkRow => {
        const result = byId.get(user._id);
        const created =
          result?.status === "created" && Boolean(result.setupUrl);
        return {
          userId: user._id,
          name: user.name,
          email: user.email,
          setupUrl: created ? result?.setupUrl : undefined,
          emailed: created && result?.emailed === true,
          failed: !created,
        };
      });
      return {
        rows,
        emailConfigured: data.emailConfigured,
        remaining: list.users.length - users.length,
      };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: usersKeys.all });
    },
    onError: (error: unknown) => {
      toast.add({
        type: "error",
        title: "Couldn't create the links",
        description: getErrorMessage(error),
      });
    },
  });
}

/** CSV (name,email,link) for pasting into a spreadsheet; quotes every field. */
export function setupLinksCsv(rows: BulkPasswordLinkRow[]): string {
  const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const lines = rows
    .filter((row) => row.setupUrl)
    .map((row) =>
      [row.name, row.email, row.setupUrl ?? ""].map(cell).join(","),
    );
  return ["name,email,link", ...lines].join("\r\n");
}

/* ------------------------------------------------------------------ */
/* Public /set-password/:token                                         */
/* ------------------------------------------------------------------ */

/** Public: link preview (no retries — 404/410 are final answers). */
export function usePasswordSetupPreview(token: string) {
  return useQuery({
    queryKey: passwordSetupKeys.preview(token),
    queryFn: async () => {
      const { data } = await api.get<PasswordSetupPreview>(
        `/password-setup/${encodeURIComponent(token)}`,
      );
      return data;
    },
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

/** Public: sets the password; the backend signs the user in, so seed the `me` cache. */
export function useCompletePasswordSetup(token: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (password: string) => {
      const { data } = await api.post<UserResponse>(
        `/password-setup/${encodeURIComponent(token)}`,
        { password },
      );
      return data.user;
    },
    onSuccess: (user) => {
      // Drop anything cached for a previous session in this tab, as login does.
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== meKeys.all[0],
      });
      queryClient.setQueryData(meKeys.all, user);
    },
  });
}
