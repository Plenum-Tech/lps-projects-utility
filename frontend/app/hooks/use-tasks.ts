import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useCurrentUser } from "@/hooks/use-auth";
import { useSSE } from "@/hooks/use-sse";
import { useToast } from "@/hooks/use-toast";
import { toast as toastManager } from "@/components/ui/toast";
import type { SortDir } from "@/hooks/use-table-state";
import { api, getErrorMessage } from "@/lib/api";
import { downloadCsvExport, type ExportResult } from "@/lib/download";
import type {
  BulkResult,
  TaskApprovalsCount,
  TaskBulkAction,
  TaskCalendarResponse,
  MentionableUsersResponse,
  MySubtasksResponse,
  TaskNote,
  TaskNoteInput,
  TaskNoteListResponse,
  SubtaskInput,
  SubtaskUpdateInput,
  Task,
  TaskBoardResponse,
  TaskCommentListResponse,
  TaskComment,
  TaskDetailResponse,
  TaskDueFilter,
  TaskFile,
  TaskFileListResponse,
  TaskHistoryResponse,
  TaskInput,
  TaskListResponse,
  TaskPriority,
  TaskReviewInput,
  TaskScope,
  TaskStatus,
  TaskStatusFilter,
  TaskSubmitInput,
  TaskUpdatedEvent,
  TaskUpdateInput,
} from "@/types";

// ---------------------------------------------------------------------------
// Filters & query keys
// ---------------------------------------------------------------------------

/** Filters shared by the list and board views of GET /api/tasks. */
export interface TaskFilters {
  scope: TaskScope;
  search: string;
  priority: TaskPriority | "";
  label: string;
  category: string;
  assignee: string;
  due: TaskDueFilter | "";
  /** Project id — lists every task of that project (when the caller can view it). */
  project?: string;
  /** Milestone id, or "none" for tasks without a milestone. */
  milestone?: string;
  /** Admin: department id. */
  department?: string;
  /** Due-date range "YYYY-MM-DD" (inclusive). */
  from?: string;
  to?: string;
  /** Only tasks the caller pinned. */
  pinned?: boolean;
  /** Only recurring parents (items carry `copyCount`). */
  recurring?: boolean;
  /** Copies generated from this recurring task. */
  recurringParent?: string;
  /** Due before today and not completed. */
  overdue?: boolean;
  /** Any of these statuses, comma-joined (My dashboard links). */
  statusIn?: string;
  /** Created (app-timezone day) or due within this "YYYY-MM-DD" range (inclusive). */
  createdOrDueFrom?: string;
  createdOrDueTo?: string;
  /** Completed (completedAt day) within this "YYYY-MM-DD" range (inclusive). */
  completedFrom?: string;
  completedTo?: string;
  /** Pearity tag: "has" / "none". */
  pearityTag?: "has" | "none" | "";
}

/** Server-side sort fields of GET /api/tasks. */
export type TaskSortField =
  | "createdAt"
  | "code"
  | "title"
  | "startDate"
  | "dueDate"
  | "actualStartAt"
  | "actualEndAt"
  | "estimate"
  | "loggedMinutes"
  | "status"
  | "priority";

export interface TaskListParams extends TaskFilters {
  status: TaskStatusFilter;
  limit: number;
  offset: number;
  sort?: TaskSortField | "";
  dir?: SortDir;
}

export const taskKeys = {
  all: ["tasks"] as const,
  lists: ["tasks", "list"] as const,
  list: (params: TaskListParams) => ["tasks", "list", params] as const,
  boards: ["tasks", "board"] as const,
  board: (filters: TaskFilters) => ["tasks", "board", filters] as const,
  detail: (id: string) => ["tasks", "detail", id] as const,
  comments: (id: string) => ["tasks", "comments", id] as const,
  files: (id: string) => ["tasks", "files", id] as const,
  history: (id: string, limit: number) => ["tasks", "history", id, limit] as const,
  historyAll: (id: string) => ["tasks", "history", id] as const,
  mentionable: (id: string) => ["tasks", "mentionable", id] as const,
  notes: (id: string) => ["tasks", "notes", id] as const,
  subtaskAssignees: (id: string) => ["tasks", "subtask-assignees", id] as const,
  mySubtasks: ["tasks", "subtasks", "mine"] as const,
  calendars: ["tasks", "calendar"] as const,
  calendar: (params: Record<string, unknown>) => ["tasks", "calendar", params] as const,
  approvalsCount: ["tasks", "approvals-count"] as const,
};

/** Drops empty filters so the query string stays clean. */
function filterParams(filters: TaskFilters): Record<string, string> {
  const params: Record<string, string> = { scope: filters.scope };
  if (filters.search) params.search = filters.search;
  if (filters.priority) params.priority = filters.priority;
  if (filters.label) params.label = filters.label;
  if (filters.category) params.category = filters.category;
  if (filters.assignee) params.assignee = filters.assignee;
  if (filters.due) params.due = filters.due;
  if (filters.project) params.project = filters.project;
  if (filters.milestone) params.milestone = filters.milestone;
  if (filters.department) params.department = filters.department;
  if (filters.from) params.from = filters.from;
  if (filters.to) params.to = filters.to;
  if (filters.pinned) params.pinned = "true";
  if (filters.recurring) params.recurring = "true";
  if (filters.recurringParent) params.recurringParent = filters.recurringParent;
  if (filters.overdue) params.overdue = "true";
  if (filters.statusIn) params.statusIn = filters.statusIn;
  if (filters.createdOrDueFrom) params.createdOrDueFrom = filters.createdOrDueFrom;
  if (filters.createdOrDueTo) params.createdOrDueTo = filters.createdOrDueTo;
  if (filters.completedFrom) params.completedFrom = filters.completedFrom;
  if (filters.completedTo) params.completedTo = filters.completedTo;
  if (filters.pearityTag) params.pearityTag = filters.pearityTag;
  return params;
}

/** Filters + status + sort as GET /api/tasks query params (also used by the export). */
export function taskQueryParams(
  params: TaskFilters & { status?: TaskStatusFilter; sort?: TaskSortField | ""; dir?: SortDir }
): Record<string, string> {
  const out = filterParams(params);
  if (params.status && params.status !== "all") out.status = params.status;
  if (params.sort) {
    out.sort = params.sort;
    out.dir = params.dir ?? "asc";
  }
  return out;
}

/** Shows "8 updated, 2 skipped" with the distinct skip reasons. */
export function toastBulkResult(result: BulkResult, noun = "items") {
  const skipped = result.skipped.length;
  const reasons = [...new Set(result.skipped.map((item) => item.reason))];
  const shown = reasons.slice(0, 3);
  toastManager.add({
    type: result.updated === 0 && skipped > 0 ? "warning" : "success",
    title: `${result.updated} updated, ${skipped} skipped`,
    description:
      skipped > 0
        ? `Skipped ${noun}: ${shown.join(" · ")}${reasons.length > shown.length ? " …" : ""}`
        : undefined,
  });
}

/** Toast for a finished CSV export (notes the 5000-row cap). */
export function toastExportResult(result: ExportResult, noun: string) {
  toastManager.add({
    type: result.truncated ? "warning" : "success",
    title: `Exported ${result.rows} ${noun}`,
    description: result.truncated
      ? `Capped at 5000 rows — ${result.total} matched. Narrow the filters to export the rest.`
      : result.filename,
  });
}

/** After any mutation: cache the fresh detail and refresh lists/boards. */
function applyDetail(queryClient: QueryClient, data: TaskDetailResponse) {
  queryClient.setQueryData(taskKeys.detail(data.task._id), data);
  invalidateTaskCollections(queryClient);
  void queryClient.invalidateQueries({ queryKey: taskKeys.historyAll(data.task._id) });
  void queryClient.invalidateQueries({ queryKey: taskKeys.mySubtasks });
}

/** Lists, boards, calendars and the approvals badge. */
export function invalidateTaskCollections(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: taskKeys.lists });
  void queryClient.invalidateQueries({ queryKey: taskKeys.boards });
  void queryClient.invalidateQueries({ queryKey: taskKeys.calendars });
  void queryClient.invalidateQueries({ queryKey: taskKeys.approvalsCount });
}

// ---------------------------------------------------------------------------
// Real-time
// ---------------------------------------------------------------------------

/**
 * Keeps every task query fresh from the `task-updated` SSE event. Mount once
 * per page that shows tasks. A board move by the current user is skipped —
 * the optimistic update + its own refetch already cover it.
 */
/** Bulk work (imports, bulk actions) emits one event per task — refetch at most this often. */
const REALTIME_REFRESH_MS = 2_000;

export function useTaskRealtime() {
  const queryClient = useQueryClient();
  const { data: me } = useCurrentUser();
  const lastRefresh = useRef(0);
  const trailing = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (trailing.current) clearTimeout(trailing.current);
    },
    []
  );

  // Leading refresh right away, then one trailing refresh per window.
  function refresh() {
    const wait = lastRefresh.current + REALTIME_REFRESH_MS - Date.now();
    if (wait <= 0) {
      lastRefresh.current = Date.now();
      void queryClient.invalidateQueries({ queryKey: taskKeys.all });
      return;
    }
    if (trailing.current) return;
    trailing.current = setTimeout(() => {
      trailing.current = null;
      lastRefresh.current = Date.now();
      void queryClient.invalidateQueries({ queryKey: taskKeys.all });
    }, wait);
  }

  useSSE({
    event: "task-updated",
    onEvent: (event) => {
      const payload = event.data as TaskUpdatedEvent | undefined;
      if (payload?.action === "moved" && payload.actorId && payload.actorId === me?._id) return;
      if (payload?.action === "deleted" && payload.taskId) {
        queryClient.removeQueries({ queryKey: taskKeys.detail(payload.taskId) });
      }
      refresh();
    },
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Paginated list view (scoped by role server-side). */
export function useTaskList(params: TaskListParams, enabled = true) {
  return useQuery({
    queryKey: taskKeys.list(params),
    queryFn: async () => {
      const { data } = await api.get<TaskListResponse>("/tasks", {
        params: {
          ...taskQueryParams(params),
          limit: params.limit,
          offset: params.offset,
        },
      });
      return data;
    },
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** Kanban view: all columns ordered by position. */
export function useTaskBoard(filters: TaskFilters, enabled = true) {
  return useQuery({
    queryKey: taskKeys.board(filters),
    queryFn: async () => {
      const { data } = await api.get<TaskBoardResponse>("/tasks", {
        params: { ...filterParams(filters), view: "board" },
      });
      return data;
    },
    placeholderData: keepPreviousData,
    enabled,
  });
}

/**
 * Calendar view: lean tasks overlapping `from`..`to` (at most 100 days, capped at
 * 500). Every list filter applies; `from`/`to` here mean overlap, not a due range.
 */
export function useTaskCalendar(
  filters: TaskFilters & { status?: TaskStatusFilter },
  range: { from: string; to: string },
  enabled = true
) {
  const params = {
    ...taskQueryParams({ ...filters, from: undefined, to: undefined }),
    from: range.from,
    to: range.to,
  };
  return useQuery({
    queryKey: taskKeys.calendar(params),
    queryFn: async () => {
      const { data } = await api.get<TaskCalendarResponse>("/tasks/calendar", { params });
      return data;
    },
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** Badge for the "Waiting approval" view (+ whether to show it at all). */
export function useTaskApprovalsCount(enabled = true) {
  return useQuery({
    queryKey: taskKeys.approvalsCount,
    queryFn: async () => {
      const { data } = await api.get<TaskApprovalsCount>("/tasks/approvals/count");
      return data;
    },
    enabled,
    staleTime: 30_000,
  });
}

/** Task detail + what the current user may do with it. */
export function useTask(id: string | null, enabled = true) {
  return useQuery({
    queryKey: taskKeys.detail(id ?? ""),
    queryFn: async () => {
      const { data } = await api.get<TaskDetailResponse>(`/tasks/${id}`);
      return data;
    },
    enabled: Boolean(id) && enabled,
    retry: (count, error) => {
      const status = (error as { response?: { status?: number } }).response?.status;
      return status !== 403 && status !== 404 && count < 2;
    },
  });
}

export function useTaskComments(id: string | null) {
  return useQuery({
    queryKey: taskKeys.comments(id ?? ""),
    queryFn: async () => {
      const { data } = await api.get<TaskCommentListResponse>(`/tasks/${id}/comments`);
      return data;
    },
    enabled: Boolean(id),
  });
}

export function useTaskFiles(id: string | null) {
  return useQuery({
    queryKey: taskKeys.files(id ?? ""),
    queryFn: async () => {
      const { data } = await api.get<TaskFileListResponse>(`/tasks/${id}/files`);
      return data;
    },
    enabled: Boolean(id),
  });
}

export function useTaskHistory(id: string | null, limit = 30) {
  return useQuery({
    queryKey: taskKeys.history(id ?? "", limit),
    queryFn: async () => {
      const { data } = await api.get<TaskHistoryResponse>(`/tasks/${id}/history`, {
        params: { limit, offset: 0 },
      });
      return data;
    },
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
  });
}

/** Users who can be @mentioned on a task (everyone who can view it). */
export function useMentionableUsers(id: string | null) {
  return useQuery({
    queryKey: taskKeys.mentionable(id ?? ""),
    queryFn: async () => {
      const { data } = await api.get<MentionableUsersResponse>(
        `/tasks/${id}/mentionable-users`
      );
      return data.users;
    },
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

/** Options for the subtask "Assigned to" picker (server applies the assignee rule). */
export function useSubtaskAssignees(id: string | null, enabled = true) {
  return useQuery({
    queryKey: taskKeys.subtaskAssignees(id ?? ""),
    queryFn: async () => {
      const { data } = await api.get<MentionableUsersResponse>(`/tasks/${id}/subtask-assignees`);
      return data.users;
    },
    enabled: Boolean(id) && enabled,
    staleTime: 60_000,
  });
}

/** Open subtasks assigned to me on tasks I'm not assigned to ("My subtasks" strip). */
export function useMySubtasks(enabled = true) {
  return useQuery({
    queryKey: taskKeys.mySubtasks,
    queryFn: async () => {
      const { data } = await api.get<MySubtasksResponse>("/tasks/subtasks/mine");
      return data.subtasks;
    },
    enabled,
  });
}

export function useTaskNotes(id: string | null) {
  return useQuery({
    queryKey: taskKeys.notes(id ?? ""),
    queryFn: async () => {
      const { data } = await api.get<TaskNoteListResponse>(`/tasks/${id}/notes`);
      return data.notes;
    },
    enabled: Boolean(id),
  });
}

// ---------------------------------------------------------------------------
// Task mutations
// ---------------------------------------------------------------------------

/** Head/admin: create and assign a task. */
export function useCreateTask() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async (input: TaskInput) => {
      const { data } = await api.post<TaskDetailResponse>("/tasks", input);
      return data;
    },
    onSuccess: (data) => {
      applyDetail(queryClient, data);
      if (data.task.project) {
        void queryClient.invalidateQueries({ queryKey: ["projects"] });
      }
      toast.success(data.task.shortCode ? `Task ${data.task.shortCode} created` : "Task created");
      data.warnings?.forEach((warning) => toast.warning(warning));
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

/** Creator/admin: edit task fields. */
export function useUpdateTask() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: TaskUpdateInput }) => {
      const { data } = await api.patch<TaskDetailResponse>(`/tasks/${id}`, input);
      return data;
    },
    onSuccess: (data) => {
      applyDetail(queryClient, data);
      toast.success("Task updated");
      data.warnings?.forEach((warning) => toast.warning(warning));
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

/** Change status (same transition rules as the board). */
export function useUpdateTaskStatus() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: TaskStatus }) => {
      const { data } = await api.patch<TaskDetailResponse>(`/tasks/${id}/status`, { status });
      return data;
    },
    onSuccess: (data) => {
      applyDetail(queryClient, data);
      toast.success("Status updated");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

interface MoveTaskVariables {
  task: Task;
  status: TaskStatus;
  /** Index within the target column (after removing the task). */
  index: number;
  position?: number;
}

/**
 * Board drag: optimistic reorder/move across every cached board, rolled back
 * with a toast if the server refuses the move.
 */
export function useMoveTask() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async ({ task, status, position }: MoveTaskVariables) => {
      const { data } = await api.patch<TaskDetailResponse>(`/tasks/${task._id}/move`, {
        status,
        ...(position !== undefined ? { position } : {}),
      });
      return data;
    },
    onMutate: async ({ task, status, index, position }) => {
      await queryClient.cancelQueries({ queryKey: taskKeys.boards });
      const snapshots = queryClient.getQueriesData<TaskBoardResponse>({
        queryKey: taskKeys.boards,
      });

      queryClient.setQueriesData<TaskBoardResponse>({ queryKey: taskKeys.boards }, (board) => {
        if (!board) return board;
        const columns = { ...board.columns };
        const totals = { ...board.totals };
        const from = task.status;
        const inSource = columns[from].some((item) => item._id === task._id);
        if (!inSource) return board;

        columns[from] = columns[from].filter((item) => item._id !== task._id);
        const moved: Task = {
          ...task,
          status,
          position: position ?? task.position,
        };
        const target = [...(from === status ? columns[from] : columns[status])];
        target.splice(Math.min(index, target.length), 0, moved);
        columns[status] = target;
        if (from !== status) {
          totals[from] = Math.max(0, totals[from] - 1);
          totals[status] = totals[status] + 1;
        }
        return { ...board, columns, totals };
      });

      return { snapshots };
    },
    onError: (error: unknown, _variables, context) => {
      context?.snapshots.forEach(([key, data]) => queryClient.setQueryData(key, data));
      toast.error(getErrorMessage(error));
    },
    onSuccess: (data) => {
      queryClient.setQueryData(taskKeys.detail(data.task._id), data);
    },
    onSettled: (_data, _error, variables) => {
      // The server may re-normalise positions — always refetch.
      void queryClient.invalidateQueries({ queryKey: taskKeys.boards });
      void queryClient.invalidateQueries({ queryKey: taskKeys.lists });
      void queryClient.invalidateQueries({ queryKey: taskKeys.historyAll(variables.task._id) });
    },
  });
}

/** Assignee: submit work for review. */
export function useSubmitTask() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: TaskSubmitInput }) => {
      const { data } = await api.post<TaskDetailResponse>(`/tasks/${id}/submit`, input);
      return data;
    },
    onSuccess: (data) => {
      applyDetail(queryClient, data);
      toast.success(
        data.task.status === "completed" ? "Task completed" : "Task submitted for review"
      );
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

/** Creator/admin: approve or reject a submission. */
export function useReviewTask() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: TaskReviewInput }) => {
      const { data } = await api.post<TaskDetailResponse>(`/tasks/${id}/review`, input);
      return data;
    },
    onSuccess: (data, { input }) => {
      applyDetail(queryClient, data);
      toast.success(input.decision === "approved" ? "Task approved" : "Task sent back");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

/** Creator/admin: nudge assignees (server rate-limits to once per hour). */
export function useRemindTask() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.post<{ success: true; remindedAt: string }>(
        `/tasks/${id}/remind`
      );
      return data;
    },
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: taskKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: taskKeys.historyAll(id) });
      toast.success("Reminder sent to the assignees");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

/** Creator/admin: delete a task (comments, files and history go with it). */
export function useDeleteTask() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/tasks/${id}`);
    },
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: taskKeys.detail(id) });
      invalidateTaskCollections(queryClient);
      toast.success("Task deleted");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

/** Stop repeating (null) or change the schedule of a recurring task. */
export function useSetTaskRecurrence() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async ({
      id,
      recurrence,
    }: {
      id: string;
      recurrence: TaskUpdateInput["recurrence"];
    }) => {
      const { data } = await api.patch<TaskDetailResponse>(`/tasks/${id}`, { recurrence });
      return data;
    },
    onSuccess: (data, { recurrence }) => {
      applyDetail(queryClient, data);
      toast.success(
        recurrence ? "Schedule updated" : "Stopped repeating — existing copies are kept"
      );
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

/** Copy a task (new number / short code, subtasks reset, no comments/files/history). */
export function useDuplicateTask() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.post<TaskDetailResponse>(`/tasks/${id}/duplicate`);
      return data;
    },
    onSuccess: (data) => {
      applyDetail(queryClient, data);
      if (data.task.project) void queryClient.invalidateQueries({ queryKey: ["projects"] });
      const code = data.task.shortCode ?? (data.task.number ? `#${data.task.number}` : "");
      toast.success(code ? `Duplicated as ${code}` : "Task duplicated");
      data.warnings?.forEach((warning) => toast.warning(warning));
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

/** Pin / unpin — optimistic on cached lists and the detail. */
export function useToggleTaskPin() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async ({ id, pinned }: { id: string; pinned: boolean }) => {
      if (pinned) await api.put(`/tasks/${id}/pin`);
      else await api.delete(`/tasks/${id}/pin`);
      return pinned;
    },
    onMutate: async ({ id, pinned }) => {
      await queryClient.cancelQueries({ queryKey: taskKeys.lists });
      const lists = queryClient.getQueriesData<TaskListResponse>({ queryKey: taskKeys.lists });
      queryClient.setQueriesData<TaskListResponse>({ queryKey: taskKeys.lists }, (data) =>
        data?.tasks
          ? {
              ...data,
              tasks: data.tasks.map((task) => (task._id === id ? { ...task, pinned } : task)),
            }
          : data
      );
      const detail = queryClient.getQueryData<TaskDetailResponse>(taskKeys.detail(id));
      if (detail) {
        queryClient.setQueryData<TaskDetailResponse>(taskKeys.detail(id), {
          ...detail,
          task: { ...detail.task, pinned },
        });
      }
      return { lists, detail };
    },
    onError: (error: unknown, { id }, context) => {
      context?.lists.forEach(([key, data]) => queryClient.setQueryData(key, data));
      if (context?.detail) queryClient.setQueryData(taskKeys.detail(id), context.detail);
      toast.error(getErrorMessage(error));
    },
    onSuccess: (pinned) => toast.success(pinned ? "Task pinned" : "Task unpinned"),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: taskKeys.lists }),
  });
}

export interface TaskBulkInput {
  ids: string[];
  action: TaskBulkAction;
  status?: TaskStatus;
  assignees?: string[];
}

/** Bulk status / assign / delete — every item is checked like the single endpoints. */
export function useBulkTasks() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async (input: TaskBulkInput) => {
      const { data } = await api.post<BulkResult>("/tasks/bulk", input);
      return data;
    },
    onSuccess: (result, input) => {
      for (const id of result.updatedIds) {
        if (input.action === "delete") queryClient.removeQueries({ queryKey: taskKeys.detail(id) });
        else void queryClient.invalidateQueries({ queryKey: taskKeys.detail(id) });
      }
      invalidateTaskCollections(queryClient);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      toastBulkResult(result, "tasks");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

/** CSV of the current filters (or `ids`) — downloads `tasks-YYYY-MM-DD.csv`. */
export function useExportTasks() {
  const toast = useToast();
  return useMutation({
    mutationFn: (params: Record<string, string>) =>
      downloadCsvExport("/tasks/export", params, "tasks.csv"),
    onSuccess: (result) => toastExportResult(result, result.rows === 1 ? "task" : "tasks"),
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

// ---------------------------------------------------------------------------
// Subtasks
// ---------------------------------------------------------------------------

export function useAddSubtask(taskId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async (input: SubtaskInput) => {
      const { data } = await api.post<TaskDetailResponse>(`/tasks/${taskId}/subtasks`, input);
      return data;
    },
    onSuccess: (data) => applyDetail(queryClient, data),
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

/** Toggle/rename/reassign a subtask — `done` toggles are applied optimistically. */
export function useUpdateSubtask(taskId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async ({ subId, input }: { subId: string; input: SubtaskUpdateInput }) => {
      const { data } = await api.patch<TaskDetailResponse>(
        `/tasks/${taskId}/subtasks/${subId}`,
        input
      );
      return data;
    },
    onMutate: async ({ subId, input }) => {
      if (input.done === undefined) return {};
      await queryClient.cancelQueries({ queryKey: taskKeys.detail(taskId) });
      const previous = queryClient.getQueryData<TaskDetailResponse>(taskKeys.detail(taskId));
      if (previous) {
        queryClient.setQueryData<TaskDetailResponse>(taskKeys.detail(taskId), {
          ...previous,
          task: {
            ...previous.task,
            subtasks: previous.task.subtasks.map((sub) =>
              sub._id === subId ? { ...sub, done: Boolean(input.done) } : sub
            ),
          },
        });
      }
      return { previous };
    },
    onError: (error: unknown, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(taskKeys.detail(taskId), context.previous);
      }
      toast.error(getErrorMessage(error));
    },
    onSuccess: (data) => applyDetail(queryClient, data),
  });
}

export function useDeleteSubtask(taskId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async (subId: string) => {
      const { data } = await api.delete<TaskDetailResponse>(
        `/tasks/${taskId}/subtasks/${subId}`
      );
      return data;
    },
    onSuccess: (data) => applyDetail(queryClient, data),
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

/**
 * Uploads files to one subtask (multipart field `files`, 1-10 per request).
 * No toasts — the subtask form reports per-file failures itself.
 */
export function useUploadSubtaskFiles(taskId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ subId, files }: { subId: string; files: File[] }) => {
      const form = new FormData();
      files.forEach((file) => form.append("files", file));
      const { data } = await api.post<{ files: TaskFile[] }>(
        `/tasks/${taskId}/subtasks/${subId}/files`,
        form,
        { headers: { "Content-Type": "multipart/form-data" }, timeout: 120_000 }
      );
      return data.files;
    },
    onSettled: () => refreshAfterFile(queryClient, taskId),
  });
}

/** Releases notifications held back with `deferNotifications` (best effort). */
export async function sendDeferredSubtaskNotifications(taskId: string, subId: string) {
  try {
    await api.post(`/tasks/${taskId}/subtasks/${subId}/notify`);
  } catch {
    // The subtask itself is saved either way.
  }
}

/**
 * Creates the subtasks drafted in the New task dialog, in order, once the task
 * exists: add (notifications deferred when there are files) → upload files one
 * by one → release notifications, so emails carry the real attachment count.
 * Keeps going past failures and reports them; the caller refreshes queries.
 */
export async function createSubtasksFromDrafts(
  taskId: string,
  drafts: Array<{
    title: string;
    description: string;
    startDate: string;
    dueDate: string;
    /** ISO date-times (empty = none). */
    actualStartAt?: string;
    actualEndAt?: string;
    assignee: { _id: string } | null;
    files: File[];
  }>
): Promise<{ failedSubtasks: string[]; failedFiles: string[] }> {
  const failedSubtasks: string[] = [];
  const failedFiles: string[] = [];
  for (const draft of drafts) {
    const hasFiles = draft.files.length > 0;
    let subId: string | undefined;
    try {
      const { data } = await api.post<TaskDetailResponse & { subtaskId?: string }>(
        `/tasks/${taskId}/subtasks`,
        {
          title: draft.title,
          description: draft.description || undefined,
          startDate: draft.startDate || null,
          dueDate: draft.dueDate || null,
          ...(draft.actualStartAt ? { actualStartAt: draft.actualStartAt } : {}),
          ...(draft.actualEndAt ? { actualEndAt: draft.actualEndAt } : {}),
          assignee: draft.assignee?._id ?? null,
          ...(hasFiles ? { deferNotifications: true } : {}),
        } satisfies SubtaskInput
      );
      subId = data.subtaskId ?? data.task.subtasks[data.task.subtasks.length - 1]?._id;
    } catch {
      failedSubtasks.push(draft.title);
      continue;
    }
    if (!subId || !hasFiles) continue;
    for (const file of draft.files) {
      const form = new FormData();
      form.append("files", file);
      try {
        await api.post(`/tasks/${taskId}/subtasks/${subId}/files`, form, {
          headers: { "Content-Type": "multipart/form-data" },
          timeout: 120_000,
        });
      } catch {
        failedFiles.push(`${draft.title}: ${file.name}`);
      }
    }
    await sendDeferredSubtaskNotifications(taskId, subId);
  }
  return { failedSubtasks, failedFiles };
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

function refreshAfterNote(queryClient: QueryClient, taskId: string) {
  void queryClient.invalidateQueries({ queryKey: taskKeys.notes(taskId) });
  void queryClient.invalidateQueries({ queryKey: taskKeys.historyAll(taskId) });
}

export function useAddTaskNote(taskId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async (input: TaskNoteInput) => {
      const { data } = await api.post<{ note: TaskNote }>(`/tasks/${taskId}/notes`, input);
      return data.note;
    },
    onSuccess: () => {
      refreshAfterNote(queryClient, taskId);
      toast.success("Note added");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useUpdateTaskNote(taskId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async ({ noteId, input }: { noteId: string; input: TaskNoteInput }) => {
      const { data } = await api.patch<{ note: TaskNote }>(
        `/tasks/${taskId}/notes/${noteId}`,
        input
      );
      return data.note;
    },
    onSuccess: () => refreshAfterNote(queryClient, taskId),
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useDeleteTaskNote(taskId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async (noteId: string) => {
      await api.delete(`/tasks/${taskId}/notes/${noteId}`);
    },
    onSuccess: () => {
      refreshAfterNote(queryClient, taskId);
      toast.success("Note deleted");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

function refreshAfterComment(queryClient: QueryClient, taskId: string) {
  void queryClient.invalidateQueries({ queryKey: taskKeys.comments(taskId) });
  void queryClient.invalidateQueries({ queryKey: taskKeys.detail(taskId) });
  void queryClient.invalidateQueries({ queryKey: taskKeys.historyAll(taskId) });
  void queryClient.invalidateQueries({ queryKey: taskKeys.lists });
  void queryClient.invalidateQueries({ queryKey: taskKeys.boards });
}

export function useAddComment(taskId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async (body: string) => {
      const { data } = await api.post<{ comment: TaskComment }>(
        `/tasks/${taskId}/comments`,
        { body }
      );
      return data.comment;
    },
    onSuccess: () => refreshAfterComment(queryClient, taskId),
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useUpdateComment(taskId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async ({ commentId, body }: { commentId: string; body: string }) => {
      const { data } = await api.patch<{ comment: TaskComment }>(
        `/tasks/${taskId}/comments/${commentId}`,
        { body }
      );
      return data.comment;
    },
    onSuccess: () => refreshAfterComment(queryClient, taskId),
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useDeleteComment(taskId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async (commentId: string) => {
      await api.delete(`/tasks/${taskId}/comments/${commentId}`);
    },
    onSuccess: () => refreshAfterComment(queryClient, taskId),
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function refreshAfterFile(queryClient: QueryClient, taskId: string) {
  void queryClient.invalidateQueries({ queryKey: taskKeys.files(taskId) });
  void queryClient.invalidateQueries({ queryKey: taskKeys.detail(taskId) });
  void queryClient.invalidateQueries({ queryKey: taskKeys.historyAll(taskId) });
  void queryClient.invalidateQueries({ queryKey: taskKeys.lists });
  void queryClient.invalidateQueries({ queryKey: taskKeys.boards });
}

/** Multipart upload (field `files`, 1-10 per request). */
export function useUploadTaskFiles(taskId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async ({
      files,
      onProgress,
    }: {
      files: File[];
      onProgress?: (percent: number) => void;
    }) => {
      const form = new FormData();
      files.forEach((file) => form.append("files", file));
      const { data } = await api.post<{ files: TaskFile[] }>(`/tasks/${taskId}/files`, form, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 120_000,
        onUploadProgress: (event) => {
          if (event.total) onProgress?.(Math.round((event.loaded / event.total) * 100));
        },
      });
      return data.files;
    },
    onSuccess: (files) => {
      refreshAfterFile(queryClient, taskId);
      toast.success(files.length === 1 ? "File uploaded" : `${files.length} files uploaded`);
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useDeleteTaskFile(taskId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async (fileId: string) => {
      await api.delete(`/tasks/${taskId}/files/${fileId}`);
    },
    onSuccess: () => {
      refreshAfterFile(queryClient, taskId);
      toast.success("File removed");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

/** Downloads an attachment through the authenticated API (cookie auth). */
export async function downloadTaskFile(taskId: string, file: TaskFile): Promise<void> {
  const response = await api.get<Blob>(`/tasks/${taskId}/files/${file._id}`, {
    responseType: "blob",
    timeout: 120_000,
  });
  const url = URL.createObjectURL(response.data);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
