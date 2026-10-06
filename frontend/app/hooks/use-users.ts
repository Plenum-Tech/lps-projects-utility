import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { meKeys } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { api, getErrorMessage } from "@/lib/api";
import type {
  CreateUserInput,
  MyProfile,
  UpdateProfileInput,
  UpdateUserInput,
  UserResponse,
  UsersListResponse,
} from "@/types";

export const usersKeys = {
  all: ["users"] as const,
  me: () => ["users", "me"] as const,
  list: (
    search: string,
    limit: number | null,
    offset: number,
    filters: { role?: string; department?: string } = {}
  ) => ["users", "list", { search, limit, offset, ...filters }] as const,
};

export interface UsersQueryParams {
  search?: string;
  /** Filter by role (admin / head / employee). */
  role?: string;
  /** Department id, or "none" for unassigned users. */
  department?: string;
  limit?: number;
  offset?: number;
}

/**
 * Admin: user roster with optional server-side search (name/email) and pagination.
 * With no params (or no `limit`) the endpoint returns ALL users — used by the
 * Manage Members dialog and department assignment.
 */
export function useUsers(params: UsersQueryParams = {}) {
  const { search = "", limit, offset = 0, role, department } = params;

  return useQuery({
    queryKey: usersKeys.list(search, limit ?? null, offset, { role, department }),
    queryFn: async () => {
      const { data } = await api.get<UsersListResponse>("/users", {
        params: {
          ...(search ? { search } : {}),
          ...(role ? { role } : {}),
          ...(department ? { department } : {}),
          ...(limit !== undefined ? { limit, offset } : {}),
        },
      });
      return data;
    },
    // Keep the previous page visible while flipping pages.
    placeholderData: (previous) => previous,
  });
}

/** Any user: own full profile incl. HR fields, department populated (`GET /users/me`). */
export function useMyProfile() {
  return useQuery({
    queryKey: usersKeys.me(),
    queryFn: async () => {
      const { data } = await api.get<{ user: MyProfile }>("/users/me");
      return data.user;
    },
  });
}

/** Admin: creates a user. */
export function useCreateUser() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async (input: CreateUserInput) => {
      const { data } = await api.post<UserResponse>("/users", input);
      return data.user;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: usersKeys.all });
      toast.success("User created successfully");
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/** Admin: updates a user's details (role, department, optional password reset). */
export function useUpdateUser() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateUserInput }) => {
      const { data } = await api.patch<UserResponse>(`/users/${id}`, input);
      return data.user;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: usersKeys.all });
      toast.success("User updated successfully");
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/** Admin: deletes a user (the admin's own account is rejected server-side). */
export function useDeleteUser() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/users/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: usersKeys.all });
      toast.success("User deleted successfully");
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/**
 * Any user: updates own name/password (`PATCH /users/me`). Seeds the `me` cache
 * with the response so the sidebar/name stay in sync instantly (the `me` query
 * is `staleTime: Infinity`).
 */
export function useUpdateProfile() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async (input: UpdateProfileInput) => {
      const { data } = await api.patch<UserResponse>("/users/me", input);
      return data.user;
    },
    onSuccess: (user) => {
      queryClient.setQueryData(meKeys.all, user);
      queryClient.invalidateQueries({ queryKey: usersKeys.all });
      toast.success("Profile updated successfully");
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}
