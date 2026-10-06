import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import axios from "axios";

import { toast as toastManager } from "@/components/ui/toast";
import { projectKeys } from "@/hooks/use-projects";
import { taskKeys } from "@/hooks/use-tasks";
import { useSSE } from "@/hooks/use-sse";
import { useToast } from "@/hooks/use-toast";
import { api, getErrorMessage } from "@/lib/api";
import type {
  ManualTimeLogInput,
  TimeLog,
  TimeLogListResponse,
  TimeLogScope,
  TimeLogStatus,
  TimeLogUpdateInput,
  TimerStartInput,
  TimerUpdatedEvent,
} from "@/types";

export interface TimeLogFilters {
  scope: TimeLogScope;
  user?: string;
  project?: string;
  task?: string;
  status?: TimeLogStatus | "";
  from?: string;
  to?: string;
}

export interface TimeLogListParams extends TimeLogFilters {
  limit?: number;
  offset?: number;
}

export const timeLogKeys = {
  all: ["timelogs"] as const,
  lists: ["timelogs", "list"] as const,
  list: (params: TimeLogListParams) => ["timelogs", "list", params] as const,
  active: ["timelogs", "active"] as const,
};

function cleanParams(params: TimeLogListParams): Record<string, string | number> {
  const out: Record<string, string | number> = { scope: params.scope };
  for (const key of ["user", "project", "task", "status", "from", "to"] as const) {
    const value = params[key];
    if (value) out[key] = value;
  }
  if (params.limit !== undefined) {
    out.limit = params.limit;
    out.offset = params.offset ?? 0;
  }
  return out;
}

/** After any change: refresh lists, the timer, project stats and timesheets. */
function refreshAll(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: timeLogKeys.lists });
  void queryClient.invalidateQueries({ queryKey: projectKeys.all });
  void queryClient.invalidateQueries({ queryKey: ["timesheets"] });
  void queryClient.invalidateQueries({ queryKey: ["work-reports"] });
  // "Hours logged" on the task tables.
  void queryClient.invalidateQueries({ queryKey: taskKeys.lists });
}

// ---------------------------------------------------------------------------
// Real-time
// ---------------------------------------------------------------------------

/**
 * Mount once (app shell): syncs the running timer across tabs from
 * `timer-updated` and refreshes log lists on `timelog-updated`.
 */
export function useTimeRealtime() {
  const queryClient = useQueryClient();

  useSSE({
    event: "timer-updated",
    onEvent: (event) => {
      const payload = event.data as TimerUpdatedEvent | undefined;
      if (payload && "timer" in payload) {
        queryClient.setQueryData(timeLogKeys.active, payload.timer ?? null);
      } else {
        void queryClient.invalidateQueries({ queryKey: timeLogKeys.active });
      }
      refreshAll(queryClient);
    },
  });

  useSSE({
    event: "timelog-updated",
    onEvent: () => refreshAll(queryClient),
  });

  useSSE({
    event: "timesheet-updated",
    onEvent: () => {
      void queryClient.invalidateQueries({ queryKey: ["timesheets"] });
      void queryClient.invalidateQueries({ queryKey: ["work-reports"] });
      void queryClient.invalidateQueries({ queryKey: timeLogKeys.lists });
    },
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useActiveTimer(enabled = true) {
  return useQuery({
    queryKey: timeLogKeys.active,
    queryFn: async () => {
      const { data } = await api.get<{ timer: TimeLog | null }>("/timelogs/active");
      return data.timer;
    },
    enabled,
    // SSE keeps it fresh; a slow poll is the fallback.
    refetchInterval: 120_000,
  });
}

export function useTimeLogs(params: TimeLogListParams, enabled = true) {
  return useQuery({
    queryKey: timeLogKeys.list(params),
    queryFn: async () => {
      const { data } = await api.get<TimeLogListResponse>("/timelogs", {
        params: cleanParams(params),
      });
      return data;
    },
    placeholderData: keepPreviousData,
    enabled,
  });
}

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------

function useTimerMutation<V>(
  fn: (variables: V) => Promise<TimeLog | null>,
  message?: string
) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (timer) => {
      queryClient.setQueryData(timeLogKeys.active, timer);
      refreshAll(queryClient);
      if (message) toast.success(message);
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
      void queryClient.invalidateQueries({ queryKey: timeLogKeys.active });
    },
  });
}

export function useStartTimer() {
  return useTimerMutation(async (input: TimerStartInput) => {
    const { data } = await api.post<{ timer: TimeLog }>("/timelogs/timer/start", input);
    return data.timer;
  }, "Timer started");
}

/** "PEAR-12", the task title or the project name of a running timer. */
export function timerTargetLabel(timer: Pick<TimeLog, "task" | "project">): string {
  return timer.task?.shortCode ?? timer.task?.title ?? timer.project?.name ?? "another item";
}

/**
 * One-click timer on a task (tables). When another timer is running the API
 * answers 409 with that timer: the toast names it and offers "Stop & start".
 */
export function useStartTaskTimer() {
  const queryClient = useQueryClient();
  const toast = useToast();

  const mutation = useMutation({
    mutationFn: async ({ taskId, stopRunning }: { taskId: string; stopRunning?: boolean }) => {
      if (stopRunning) await api.post("/timelogs/timer/stop", {});
      const { data } = await api.post<{ timer: TimeLog }>("/timelogs/timer/start", {
        task: taskId,
      });
      return data.timer;
    },
    onSuccess: (timer) => {
      queryClient.setQueryData(timeLogKeys.active, timer);
      refreshAll(queryClient);
      toast.success(`Timer started on ${timerTargetLabel(timer)}`);
    },
    onError: (error: unknown, { taskId }) => {
      void queryClient.invalidateQueries({ queryKey: timeLogKeys.active });
      const running =
        axios.isAxiosError<{ timer?: TimeLog | null }>(error) && error.response?.status === 409
          ? error.response.data?.timer
          : null;
      if (running) {
        queryClient.setQueryData(timeLogKeys.active, running);
        const toastId = toastManager.add({
          type: "warning",
          title: `Stop your running timer on ${timerTargetLabel(running)} first`,
          description: "Only one timer can run at a time.",
          timeout: 10_000,
          actionProps: {
            children: "Stop & start",
            onClick: () => {
              toastManager.close(toastId);
              mutation.mutate({ taskId, stopRunning: true });
            },
          },
        });
        return;
      }
      toast.error(getErrorMessage(error));
    },
  });
  return mutation;
}

export function usePauseTimer() {
  return useTimerMutation(async (reason?: string) => {
    const { data } = await api.post<{ timer: TimeLog }>(
      "/timelogs/timer/pause",
      reason ? { reason } : {}
    );
    return data.timer;
  });
}

export function useResumeTimer() {
  return useTimerMutation(async () => {
    const { data } = await api.post<{ timer: TimeLog }>("/timelogs/timer/resume");
    return data.timer;
  });
}

export function useStopTimer() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (memo?: string) => {
      const { data } = await api.post<{ log: TimeLog }>(
        "/timelogs/timer/stop",
        memo !== undefined ? { memo } : {}
      );
      return data.log;
    },
    onSuccess: (log) => {
      queryClient.setQueryData(timeLogKeys.active, null);
      refreshAll(queryClient);
      toast.success(`Logged ${Math.round(log.durationMinutes)} min`);
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
      void queryClient.invalidateQueries({ queryKey: timeLogKeys.active });
    },
  });
}

/** Manager/admin: stop someone else's running timer. */
export function useStopOtherTimer() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.post<{ log: TimeLog }>(`/timelogs/${id}/stop`);
      return data.log;
    },
    onSuccess: () => {
      refreshAll(queryClient);
      void queryClient.invalidateQueries({ queryKey: timeLogKeys.active });
      toast.success("Timer stopped");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

/** Manual entry. 409 overlap errors carry `conflict` — surfaced as the toast message. */
export function useCreateTimeLog() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (input: ManualTimeLogInput) => {
      const { data } = await api.post<{ log: TimeLog }>("/timelogs", input);
      return data.log;
    },
    onSuccess: () => {
      refreshAll(queryClient);
      toast.success("Time logged");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useUpdateTimeLog() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: TimeLogUpdateInput }) => {
      const { data } = await api.patch<{ log: TimeLog }>(`/timelogs/${id}`, input);
      return data.log;
    },
    onSuccess: (log) => {
      if (log.isRunning) queryClient.setQueryData(timeLogKeys.active, log);
      refreshAll(queryClient);
      toast.success("Time log updated");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useDeleteTimeLog() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/timelogs/${id}`);
      return id;
    },
    onSuccess: (id) => {
      const active = queryClient.getQueryData<TimeLog | null>(timeLogKeys.active);
      if (active?._id === id) queryClient.setQueryData(timeLogKeys.active, null);
      refreshAll(queryClient);
      toast.success("Time log deleted");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useApproveTimeLog() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.post<{ log: TimeLog }>(`/timelogs/${id}/approve`);
      return data.log;
    },
    onSuccess: () => {
      refreshAll(queryClient);
      toast.success("Time log approved");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useRejectTimeLog() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { data } = await api.post<{ log: TimeLog }>(`/timelogs/${id}/reject`, { reason });
      return data.log;
    },
    onSuccess: () => {
      refreshAll(queryClient);
      toast.success("Time log rejected");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useBulkApproveTimeLogs() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const { data } = await api.post<{
        approved: string[];
        skipped: { id: string; reason: string }[];
      }>("/timelogs/bulk-approve", { ids });
      return data;
    },
    onSuccess: (data) => {
      refreshAll(queryClient);
      const skipped = data.skipped.length;
      toast.success(
        `${data.approved.length} approved${skipped ? `, ${skipped} skipped` : ""}`
      );
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}
