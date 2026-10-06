import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";

import { useToast } from "@/hooks/use-toast";
import { api, getErrorMessage } from "@/lib/api";
import { downloadFromApi } from "@/lib/download";
import type {
  TaskPriority,
  TaskReportSummary,
  TimeLogStatus,
  TimeReportGroupBy,
  TimeReportSummary,
  TimesheetReportResponse,
  TimesheetStatus,
} from "@/types";

/** Common work-report filters (heads are limited to their department server-side). */
export interface WorkReportFilters {
  from: string;
  to: string;
  department: string;
  user: string;
  project: string;
}

export interface TimeReportParams extends WorkReportFilters {
  groupBy: TimeReportGroupBy;
  status: TimeLogStatus | "";
}

export interface TaskReportParams extends WorkReportFilters {
  priority: TaskPriority | "";
}

export interface TimesheetReportParams {
  from: string;
  to: string;
  department: string;
  user: string;
  status: TimesheetStatus | "";
  includeEmpty: boolean;
  limit: number;
  offset: number;
}

export const workReportKeys = {
  all: ["work-reports"] as const,
  time: (params: TimeReportParams) => ["work-reports", "time", params] as const,
  tasks: (params: TaskReportParams) => ["work-reports", "tasks", params] as const,
  timesheets: (params: TimesheetReportParams) =>
    ["work-reports", "timesheets", params] as const,
};

function clean(params: object): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === "" || value === undefined || value === null || value === false) continue;
    out[key] = typeof value === "boolean" ? String(value) : (value as string | number);
  }
  return out;
}

export function useTimeReport(params: TimeReportParams) {
  return useQuery({
    queryKey: workReportKeys.time(params),
    queryFn: async () => {
      const { data } = await api.get<TimeReportSummary>("/reports/time/summary", {
        params: clean(params),
      });
      return data;
    },
    placeholderData: keepPreviousData,
  });
}

export function useTaskReport(params: TaskReportParams) {
  return useQuery({
    queryKey: workReportKeys.tasks(params),
    queryFn: async () => {
      const { data } = await api.get<TaskReportSummary>("/reports/tasks/summary", {
        params: clean(params),
      });
      return data;
    },
    placeholderData: keepPreviousData,
  });
}

export function useTimesheetReport(params: TimesheetReportParams) {
  return useQuery({
    queryKey: workReportKeys.timesheets(params),
    queryFn: async () => {
      const { data } = await api.get<TimesheetReportResponse>("/reports/timesheets", {
        params: clean(params),
      });
      return data;
    },
    placeholderData: keepPreviousData,
  });
}

/** CSV export through the authenticated API (blob download). */
export function useCsvExport() {
  const toast = useToast();
  return useMutation({
    mutationFn: async ({
      path,
      params,
      filename,
    }: {
      path: "/reports/time/export" | "/reports/tasks/export" | "/reports/timesheets/export";
      params: object;
      filename: string;
    }) => {
      const { limit: _limit, offset: _offset, groupBy: _groupBy, ...rest } = params as Record<
        string,
        unknown
      >;
      await downloadFromApi(path, clean(rest), filename);
    },
    onSuccess: () => toast.success("Export downloaded"),
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}
