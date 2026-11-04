import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { timeLogKeys } from "@/hooks/use-timelogs";
import { useToast } from "@/hooks/use-toast";
import { api, getErrorMessage } from "@/lib/api";
import type { PendingTimesheet, TimesheetEntry, TimesheetMonthView, TimesheetView } from "@/types";

export const timesheetKeys = {
  all: ["timesheets"] as const,
  week: (weekStart: string) => ["timesheets", "week", weekStart] as const,
  detail: (id: string) => ["timesheets", "detail", id] as const,
  pending: ["timesheets", "pending"] as const,
  month: ["timesheets", "month"] as const,
};

/** My timesheet for the week containing `weekStart` (a draft is created lazily). */
export function useTimesheetWeek(weekStart: string) {
  return useQuery({
    queryKey: timesheetKeys.week(weekStart),
    queryFn: async () => {
      const { data } = await api.get<TimesheetView>("/timesheets/week", {
        params: { weekStart },
      });
      return data;
    },
    placeholderData: keepPreviousData,
  });
}

export function useTimesheet(id: string | null) {
  return useQuery({
    queryKey: timesheetKeys.detail(id ?? ""),
    queryFn: async () => {
      const { data } = await api.get<TimesheetView>(`/timesheets/${id}`);
      return data;
    },
    enabled: Boolean(id),
  });
}

export function usePendingTimesheets(enabled = true) {
  return useQuery({
    queryKey: timesheetKeys.pending,
    queryFn: async () => {
      const { data } = await api.get<{ timesheets: PendingTimesheet[]; total: number }>(
        "/timesheets/pending"
      );
      return data;
    },
    enabled,
  });
}

function useTimesheetMutation<V>(
  fn: (variables: V) => Promise<TimesheetView>,
  message: string
) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (view) => {
      queryClient.setQueryData(timesheetKeys.week(view.timesheet.weekStartKey), view);
      queryClient.setQueryData(timesheetKeys.detail(view.timesheet._id), view);
      void queryClient.invalidateQueries({ queryKey: timesheetKeys.pending });
      void queryClient.invalidateQueries({ queryKey: ["work-reports"] });
      void queryClient.invalidateQueries({ queryKey: timeLogKeys.lists });
      toast.success(message);
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useSaveTimesheet() {
  return useTimesheetMutation(
    async ({ id, entries }: { id: string; entries: TimesheetEntry[] }) => {
      const { data } = await api.put<TimesheetView>(`/timesheets/${id}/entries`, { entries });
      return data;
    },
    "Draft saved"
  );
}

export function useSubmitTimesheet() {
  return useTimesheetMutation(async (id: string) => {
    const { data } = await api.post<TimesheetView>(`/timesheets/${id}/submit`);
    return data;
  }, "Timesheet submitted for approval");
}

/** The previous month's hours per task / brand (the month that can be logged in one go). */
export function useTimesheetMonth(enabled: boolean) {
  return useQuery({
    queryKey: timesheetKeys.month,
    queryFn: async () => {
      const { data } = await api.get<TimesheetMonthView>("/timesheets/month");
      return data;
    },
    enabled,
  });
}

export interface MonthRowInput {
  task?: string;
  brand?: string;
  minutes: number;
  note?: string;
}

/** Spreads each row's month total over the month's working days; `submit` submits the ended weeks. */
export function useSaveTimesheetMonth() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (input: { month: string; rows: MonthRowInput[]; submit: boolean }) => {
      const { data } = await api.put<TimesheetMonthView>("/timesheets/month", input);
      return data;
    },
    onSuccess: (view, input) => {
      queryClient.setQueryData(timesheetKeys.month, view);
      void queryClient.invalidateQueries({ queryKey: ["timesheets", "week"] });
      void queryClient.invalidateQueries({ queryKey: timesheetKeys.pending });
      void queryClient.invalidateQueries({ queryKey: ["work-reports"] });
      void queryClient.invalidateQueries({ queryKey: timeLogKeys.lists });
      const weeks = view.submittedWeeks ?? 0;
      toast.success(
        input.submit
          ? `${view.label} submitted (${weeks} week${weeks === 1 ? "" : "s"})`
          : `${view.label} saved as drafts`
      );
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useApproveTimesheet() {
  return useTimesheetMutation(async (id: string) => {
    const { data } = await api.post<TimesheetView>(`/timesheets/${id}/approve`);
    return data;
  }, "Timesheet approved");
}

export function useRejectTimesheet() {
  return useTimesheetMutation(async ({ id, reason }: { id: string; reason: string }) => {
    const { data } = await api.post<TimesheetView>(`/timesheets/${id}/reject`, { reason });
    return data;
  }, "Timesheet rejected");
}
