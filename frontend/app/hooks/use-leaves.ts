import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useToast } from "@/hooks/use-toast";
import { useSSE } from "@/hooks/use-sse";
import { api, getErrorMessage } from "@/lib/api";
import type {
  LeaveBalanceResponse,
  LeaveBalancesResponse,
  LeaveInput,
  LeaveListResponse,
  LeavePolicyListResponse,
  LeavePolicyResponse,
  LeaveResponse,
  LeaveStatusFilter,
  LeaveType,
} from "@/types";

/** All leave-related keys share the `["leaves"]` prefix so one invalidation refreshes everything. */
export const leaveKeys = {
  all: ["leaves"] as const,
  mine: (search: string, limit: number | null, offset: number) =>
    ["leaves", "mine", { search, limit, offset }] as const,
  balance: ["leaves", "balance"] as const,
  list: (status: LeaveStatusFilter, search: string, limit: number | null, offset: number) =>
    ["leaves", "list", status, { search, limit, offset }] as const,
  balances: (search: string, limit: number | null, offset: number) =>
    ["leaves", "balances", { search, limit, offset }] as const,
};

export const leavePolicyKeys = {
  all: ["leave-policies"] as const,
};

export interface LeaveQueryParams {
  status?: LeaveStatusFilter;
  search?: string;
  limit?: number;
  offset?: number;
}

/** Any user: their own leave requests, newest first, with optional search + pagination. */
export function useMyLeaves(params: LeaveQueryParams = {}) {
  const { search = "", limit, offset = 0 } = params;
  const queryClient = useQueryClient();

  // Real-time: invalidate leave queries when any leave-updated event arrives.
  useSSE({
    event: "leave-updated",
    onEvent: () => {
      void queryClient.invalidateQueries({ queryKey: leaveKeys.all });
    },
  });

  return useQuery({
    queryKey: leaveKeys.mine(search, limit ?? null, offset),
    queryFn: async () => {
      const { data } = await api.get<LeaveListResponse>("/leaves/mine", {
        params: {
          ...(search ? { search } : {}),
          ...(limit !== undefined ? { limit, offset } : {}),
        },
      });
      return data;
    },
    // Keep the previous page visible while flipping pages.
    placeholderData: (previous) => previous,
  });
}

/** Any user: their current-year leave balance. */
export function useMyLeaveBalance() {
  return useQuery({
    queryKey: leaveKeys.balance,
    queryFn: async () => {
      const { data } = await api.get<LeaveBalanceResponse>("/leaves/balance");
      return data.balance;
    },
  });
}

/** Admin: all leave requests; head: their department's employees (API-scoped). Optional status/search/pagination. */
export function useLeaves(params: LeaveQueryParams = {}) {
  const { status = "all", search = "", limit, offset = 0 } = params;

  return useQuery({
    queryKey: leaveKeys.list(status, search, limit ?? null, offset),
    queryFn: async () => {
      const { data } = await api.get<LeaveListResponse>("/leaves", {
        params: {
          ...(status !== "all" ? { status } : {}),
          ...(search ? { search } : {}),
          ...(limit !== undefined ? { limit, offset } : {}),
        },
      });
      return data;
    },
    // Keep the previous page visible while flipping pages.
    placeholderData: (previous) => previous,
  });
}

/** Admin: users with their current-year leave balances, optional search + pagination. */
export function useLeaveBalances(params: Omit<LeaveQueryParams, "status"> = {}) {
  const { search = "", limit, offset = 0 } = params;

  return useQuery({
    queryKey: leaveKeys.balances(search, limit ?? null, offset),
    queryFn: async () => {
      const { data } = await api.get<LeaveBalancesResponse>("/leaves/balances", {
        params: {
          ...(search ? { search } : {}),
          ...(limit !== undefined ? { limit, offset } : {}),
        },
      });
      return data;
    },
    // Keep the previous page visible while flipping pages.
    placeholderData: (previous) => previous,
  });
}

/** Admin: per-type leave policies. */
export function useLeavePolicies() {
  return useQuery({
    queryKey: leavePolicyKeys.all,
    queryFn: async () => {
      const { data } = await api.get<LeavePolicyListResponse>("/leave-policies");
      return data.policies;
    },
  });
}

/** Any user: applies for leave. */
export function useCreateLeave() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async (input: LeaveInput) => {
      const { data } = await api.post<LeaveResponse>("/leaves", input);
      return data.leave;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["leaves"] });
      toast.success("Leave request submitted");
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/** Any user: cancels their own pending or approved request. */
export function useCancelLeave() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.patch<LeaveResponse>(`/leaves/${id}/cancel`);
      return data.leave;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["leaves"] });
      toast.success("Leave request cancelled");
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/** Admin, or the head of the requester's department: approves or rejects a pending request. */
export function useDecideLeave() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async ({
      id,
      decision,
      note,
    }: {
      id: string;
      decision: "approved" | "rejected";
      note?: string;
    }) => {
      const { data } = await api.patch<LeaveResponse>(`/leaves/${id}/decide`, {
        decision,
        note,
      });
      return data.leave;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["leaves"] });
      toast.success("Leave request processed");
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/** Admin: sets a user's remaining days for a tracked leave type this year. */
export function useAdjustLeaveBalance() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async ({
      userId,
      leaveType,
      days,
    }: {
      userId: string;
      leaveType: "annual" | "sick" | "personal";
      days: number;
    }) => {
      const { data } = await api.patch<LeaveBalanceResponse>(
        `/leaves/balances/${userId}`,
        { leaveType, days }
      );
      return data.balance;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["leaves"] });
      toast.success("Leave balance updated");
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/** Admin: updates a leave type's limits. */
export function useUpdateLeavePolicy() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async ({
      leaveType,
      input,
    }: {
      leaveType: LeaveType;
      input: { maxDaysPerRequest?: number; maxDaysPerYear?: number };
    }) => {
      const { data } = await api.patch<LeavePolicyResponse>(
        `/leave-policies/${leaveType}`,
        input
      );
      return data.policy;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: leavePolicyKeys.all });
      toast.success("Leave policy updated");
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}
