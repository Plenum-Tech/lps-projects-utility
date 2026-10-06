import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import type { SortDir } from "@/hooks/use-table-state";
import { taskKeys, toastBulkResult, toastExportResult } from "@/hooks/use-tasks";
import { useSSE } from "@/hooks/use-sse";
import { useToast } from "@/hooks/use-toast";
import { api, getErrorMessage } from "@/lib/api";
import { downloadCsvExport, saveBlob } from "@/lib/download";
import type {
  BulkResult,
  ProjectBulkAction,
  Milestone,
  MilestoneInput,
  MilestoneStatus,
  Paginated,
  ProjectActivity,
  ProjectAssignableUser,
  ProjectDetailResponse,
  ProjectDuplicateInput,
  ProjectFile,
  ProjectInput,
  ProjectListResponse,
  ProjectNote,
  ProjectNoteInput,
  ProjectUpdateInput,
  ProjectUpdatedEvent,
} from "@/types";

// ---------------------------------------------------------------------------
// Filters & keys
// ---------------------------------------------------------------------------

export type ProjectTab = "active" | "archived" | "pinned";

export interface ProjectFilters {
  tab: ProjectTab;
  search: string;
  status: string;
  category: string;
  department: string;
  manager: string;
  deadline: "" | "overdue";
  /** Member user id. */
  member?: string;
  /** Start→deadline overlaps this range ("YYYY-MM-DD"). */
  from?: string;
  to?: string;
  /** Comma-joined buckets, e.g. "0-20,81-100". */
  progress?: string;
}

/** Server-side sort fields of GET /api/projects. */
export type ProjectSortField =
  | "createdAt"
  | "code"
  | "name"
  | "startDate"
  | "deadline"
  | "progress"
  | "status";

export interface ProjectListParams extends ProjectFilters {
  limit?: number;
  offset?: number;
  sort?: ProjectSortField | "";
  dir?: SortDir;
}

export const projectKeys = {
  all: ["projects"] as const,
  lists: ["projects", "list"] as const,
  list: (params: ProjectListParams | Record<string, unknown>) =>
    ["projects", "list", params] as const,
  detail: (id: string) => ["projects", "detail", id] as const,
  milestones: (id: string) => ["projects", "milestones", id] as const,
  notes: (id: string) => ["projects", "notes", id] as const,
  files: (id: string) => ["projects", "files", id] as const,
  activity: (id: string, limit: number) => ["projects", "activity", id, limit] as const,
  activityAll: (id: string) => ["projects", "activity", id] as const,
  assignable: (id: string) => ["projects", "assignable", id] as const,
};

/** Filters + sort as GET /api/projects query params (also used by the export). */
export function projectQueryParams(
  params: Omit<ProjectListParams, "limit" | "offset">
): Record<string, string> {
  const out: Record<string, string> = {};
  if (params.tab === "archived") out.archived = "true";
  if (params.tab === "pinned") out.pinned = "true";
  for (const key of [
    "search",
    "status",
    "category",
    "department",
    "manager",
    "deadline",
    "member",
    "from",
    "to",
    "progress",
  ] as const) {
    const value = params[key];
    if (value) out[key] = value;
  }
  if (params.sort) {
    out.sort = params.sort;
    out.dir = params.dir ?? "asc";
  }
  return out;
}

function listParams(params: ProjectListParams): Record<string, string | number> {
  const out: Record<string, string | number> = projectQueryParams(params);
  if (params.limit !== undefined) {
    out.limit = params.limit;
    out.offset = params.offset ?? 0;
  }
  return out;
}

/** Cache a fresh detail and refresh project lists. */
function applyDetail(queryClient: QueryClient, data: ProjectDetailResponse) {
  queryClient.setQueryData(projectKeys.detail(data.project._id), data);
  void queryClient.invalidateQueries({ queryKey: projectKeys.lists });
  void queryClient.invalidateQueries({ queryKey: projectKeys.activityAll(data.project._id) });
}

// ---------------------------------------------------------------------------
// Real-time
// ---------------------------------------------------------------------------

/** Keeps project queries fresh from `project-updated` SSE events. */
export function useProjectRealtime() {
  const queryClient = useQueryClient();
  useSSE({
    event: "project-updated",
    onEvent: (event) => {
      const payload = event.data as ProjectUpdatedEvent | undefined;
      if (payload?.action === "deleted" && payload.projectId) {
        queryClient.removeQueries({ queryKey: projectKeys.detail(payload.projectId) });
      }
      void queryClient.invalidateQueries({ queryKey: projectKeys.all });
      if (payload?.action === "archived" || payload?.action === "restored") {
        void queryClient.invalidateQueries({ queryKey: taskKeys.all });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useProjects(params: ProjectListParams, enabled = true) {
  return useQuery({
    queryKey: projectKeys.list(params),
    queryFn: async () => {
      const { data } = await api.get<ProjectListResponse>("/projects", {
        params: listParams(params),
      });
      return data;
    },
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** Every non-archived project the caller can see (pickers & filters). */
export function useProjectOptions(enabled = true) {
  return useQuery({
    queryKey: projectKeys.list({ options: true }),
    queryFn: async () => {
      const { data } = await api.get<ProjectListResponse>("/projects");
      return data.projects;
    },
    staleTime: 60_000,
    enabled,
  });
}

export function useProject(id: string | null | undefined) {
  return useQuery({
    queryKey: projectKeys.detail(id ?? ""),
    queryFn: async () => {
      const { data } = await api.get<ProjectDetailResponse>(`/projects/${id}`);
      return data;
    },
    enabled: Boolean(id),
    retry: (count, error) => {
      const status = (error as { response?: { status?: number } }).response?.status;
      return status !== 403 && status !== 404 && count < 2;
    },
  });
}

export function useProjectAssignable(id: string, enabled = true) {
  return useQuery({
    queryKey: projectKeys.assignable(id),
    queryFn: async () => {
      const { data } = await api.get<Paginated<"users", ProjectAssignableUser>>(
        `/projects/${id}/members/assignable`
      );
      return data.users;
    },
    enabled: enabled && Boolean(id),
    staleTime: 30_000,
  });
}

export function useMilestones(projectId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: projectKeys.milestones(projectId ?? ""),
    queryFn: async () => {
      const { data } = await api.get<Paginated<"milestones", Milestone>>(
        `/projects/${projectId}/milestones`
      );
      return data.milestones;
    },
    enabled: enabled && Boolean(projectId),
  });
}

export function useProjectNotes(projectId: string) {
  return useQuery({
    queryKey: projectKeys.notes(projectId),
    queryFn: async () => {
      const { data } = await api.get<Paginated<"notes", ProjectNote>>(
        `/projects/${projectId}/notes`
      );
      return data.notes;
    },
  });
}

export function useProjectFiles(projectId: string) {
  return useQuery({
    queryKey: projectKeys.files(projectId),
    queryFn: async () => {
      const { data } = await api.get<Paginated<"files", ProjectFile>>(
        `/projects/${projectId}/files`
      );
      return data.files;
    },
  });
}

export function useProjectActivity(projectId: string, limit = 30) {
  return useQuery({
    queryKey: projectKeys.activity(projectId, limit),
    queryFn: async () => {
      const { data } = await api.get<Paginated<"activity", ProjectActivity>>(
        `/projects/${projectId}/activity`,
        { params: { limit, offset: 0 } }
      );
      return data;
    },
    placeholderData: keepPreviousData,
  });
}

// ---------------------------------------------------------------------------
// Project mutations
// ---------------------------------------------------------------------------

/** Shared shape for mutations returning a ProjectDetail. */
function useDetailMutation<V>(
  fn: (variables: V) => Promise<ProjectDetailResponse>,
  successMessage?: string | ((data: ProjectDetailResponse, variables: V) => string)
) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data, variables) => {
      applyDetail(queryClient, data);
      if (successMessage) {
        toast.success(
          typeof successMessage === "function" ? successMessage(data, variables) : successMessage
        );
      }
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useCreateProject() {
  return useDetailMutation(async (input: ProjectInput) => {
    const { data } = await api.post<ProjectDetailResponse>("/projects", input);
    return data;
  }, "Project created");
}

export function useUpdateProject() {
  return useDetailMutation(async ({ id, input }: { id: string; input: ProjectUpdateInput }) => {
    const { data } = await api.patch<ProjectDetailResponse>(`/projects/${id}`, input);
    return data;
  }, "Project updated");
}

export function useChangeProjectStatus() {
  return useDetailMutation(
    async ({ id, status }: { id: string; status: string }) => {
      const { data } = await api.patch<ProjectDetailResponse>(`/projects/${id}/status`, {
        status,
      });
      return data;
    },
    (data) => `Status changed to ${data.project.status.name}`
  );
}

export function useArchiveProject() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async ({ id, archive }: { id: string; archive: boolean }) => {
      const { data } = await api.post<ProjectDetailResponse>(
        `/projects/${id}/${archive ? "archive" : "restore"}`
      );
      return data;
    },
    onSuccess: (data, { archive }) => {
      applyDetail(queryClient, data);
      void queryClient.invalidateQueries({ queryKey: taskKeys.all });
      toast.success(archive ? "Project archived" : "Project restored");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useDuplicateProject() {
  return useDetailMutation(
    async ({ id, input }: { id: string; input: ProjectDuplicateInput }) => {
      const { data } = await api.post<ProjectDetailResponse>(`/projects/${id}/duplicate`, input);
      return data;
    },
    (data) => `Created ${data.project.name}`
  );
}

export function useDeleteProject() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.delete<{
        success: true;
        deleted: { tasks: number; timeLogs: number; files: number };
      }>(`/projects/${id}`);
      return data;
    },
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: projectKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: projectKeys.lists });
      void queryClient.invalidateQueries({ queryKey: taskKeys.all });
      toast.success("Project deleted permanently");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

/** Pin / unpin — optimistic on the cached detail and lists. */
export function useTogglePin() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async ({ id, pinned }: { id: string; pinned: boolean }) => {
      if (pinned) await api.put(`/projects/${id}/pin`);
      else await api.delete(`/projects/${id}/pin`);
      return pinned;
    },
    onMutate: async ({ id, pinned }) => {
      const previous = queryClient.getQueryData<ProjectDetailResponse>(projectKeys.detail(id));
      if (previous) {
        queryClient.setQueryData<ProjectDetailResponse>(projectKeys.detail(id), {
          ...previous,
          project: { ...previous.project, pinned },
        });
      }
      return { previous };
    },
    onError: (error: unknown, { id }, context) => {
      if (context?.previous) queryClient.setQueryData(projectKeys.detail(id), context.previous);
      toast.error(getErrorMessage(error));
    },
    onSuccess: (pinned) => toast.success(pinned ? "Project pinned" : "Project unpinned"),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: projectKeys.lists }),
  });
}

/** Bulk status / archive / restore / delete with per-item permission checks. */
export function useBulkProjects() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (input: { ids: string[]; action: ProjectBulkAction; status?: string }) => {
      const { data } = await api.post<BulkResult>("/projects/bulk", input);
      return data;
    },
    onSuccess: (result, input) => {
      for (const id of result.updatedIds) {
        if (input.action === "delete") queryClient.removeQueries({ queryKey: projectKeys.detail(id) });
        else void queryClient.invalidateQueries({ queryKey: projectKeys.detail(id) });
      }
      void queryClient.invalidateQueries({ queryKey: projectKeys.lists });
      if (input.action !== "status") void queryClient.invalidateQueries({ queryKey: taskKeys.all });
      toastBulkResult(result, "projects");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

/** CSV of the current filters (or `ids`) — downloads `projects-YYYY-MM-DD.csv`. */
export function useExportProjects() {
  const toast = useToast();
  return useMutation({
    mutationFn: (params: Record<string, string>) =>
      downloadCsvExport("/projects/export", params, "projects.csv"),
    onSuccess: (result) => toastExportResult(result, result.rows === 1 ? "project" : "projects"),
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export function useAddProjectMembers(projectId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (input: { userIds: string[]; hourlyRate?: number }) => {
      const { data } = await api.post<ProjectDetailResponse>(
        `/projects/${projectId}/members`,
        input
      );
      return data;
    },
    onSuccess: (data, input) => {
      applyDetail(queryClient, data);
      void queryClient.invalidateQueries({ queryKey: projectKeys.assignable(projectId) });
      toast.success(
        input.userIds.length === 1 ? "Member added" : `${input.userIds.length} members added`
      );
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useUpdateMemberRate(projectId: string) {
  return useDetailMutation(async ({ userId, hourlyRate }: { userId: string; hourlyRate: number }) => {
    const { data } = await api.patch<ProjectDetailResponse>(
      `/projects/${projectId}/members/${userId}`,
      { hourlyRate }
    );
    return data;
  }, "Hourly rate updated");
}

/**
 * Remove a member. A 409 with `openTasks` is surfaced to the caller (via
 * `onError`) so the UI can offer a forced removal instead of a toast.
 */
export function useRemoveProjectMember(projectId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async ({ userId, force }: { userId: string; force?: boolean }) => {
      const { data } = await api.delete<ProjectDetailResponse>(
        `/projects/${projectId}/members/${userId}`,
        { params: force ? { force: "true" } : {} }
      );
      return data;
    },
    onSuccess: (data) => {
      applyDetail(queryClient, data);
      void queryClient.invalidateQueries({ queryKey: projectKeys.assignable(projectId) });
      void queryClient.invalidateQueries({ queryKey: taskKeys.all });
      toast.success("Member removed");
    },
    onError: (error: unknown) => {
      if (openTasksFromError(error) === null) toast.error(getErrorMessage(error));
    },
  });
}

/** `openTasks` from a 409 member-removal error, or null. */
export function openTasksFromError(error: unknown): number | null {
  const response = (error as { response?: { status?: number; data?: { openTasks?: number } } })
    .response;
  if (response?.status === 409 && typeof response.data?.openTasks === "number") {
    return response.data.openTasks;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

function refreshMilestones(queryClient: QueryClient, projectId: string) {
  void queryClient.invalidateQueries({ queryKey: projectKeys.milestones(projectId) });
  void queryClient.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
  void queryClient.invalidateQueries({ queryKey: projectKeys.activityAll(projectId) });
}

export function useSaveMilestone(projectId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async ({ id, input }: { id?: string; input: MilestoneInput }) => {
      const { data } = id
        ? await api.patch<{ milestone: Milestone }>(
            `/projects/${projectId}/milestones/${id}`,
            input
          )
        : await api.post<{ milestone: Milestone }>(`/projects/${projectId}/milestones`, input);
      return data.milestone;
    },
    onSuccess: (_data, { id }) => {
      refreshMilestones(queryClient, projectId);
      toast.success(id ? "Milestone updated" : "Milestone created");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useSetMilestoneStatus(projectId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: MilestoneStatus }) => {
      const { data } = await api.patch<{ milestone: Milestone }>(
        `/projects/${projectId}/milestones/${id}/status`,
        { status }
      );
      return data.milestone;
    },
    onSuccess: (milestone) => {
      refreshMilestones(queryClient, projectId);
      toast.success(milestone.status === "complete" ? "Milestone completed" : "Milestone reopened");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useDeleteMilestone(projectId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.delete<{ success: true; tasksUpdated: number }>(
        `/projects/${projectId}/milestones/${id}`
      );
      return data;
    },
    onSuccess: () => {
      refreshMilestones(queryClient, projectId);
      void queryClient.invalidateQueries({ queryKey: taskKeys.all });
      toast.success("Milestone deleted");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export function useSaveProjectNote(projectId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async ({ id, input }: { id?: string; input: ProjectNoteInput }) => {
      const { data } = id
        ? await api.patch<{ note: ProjectNote }>(`/projects/${projectId}/notes/${id}`, input)
        : await api.post<{ note: ProjectNote }>(`/projects/${projectId}/notes`, input);
      return data.note;
    },
    onSuccess: (_data, { id }) => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.notes(projectId) });
      void queryClient.invalidateQueries({ queryKey: projectKeys.activityAll(projectId) });
      toast.success(id ? "Note updated" : "Note added");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useDeleteProjectNote(projectId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/projects/${projectId}/notes/${id}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.notes(projectId) });
      void queryClient.invalidateQueries({ queryKey: projectKeys.activityAll(projectId) });
      toast.success("Note deleted");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export function useUploadProjectFiles(projectId: string) {
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
      const { data } = await api.post<{ files: ProjectFile[] }>(
        `/projects/${projectId}/files`,
        form,
        {
          headers: { "Content-Type": "multipart/form-data" },
          timeout: 120_000,
          onUploadProgress: (event) => {
            if (event.total) onProgress?.(Math.round((event.loaded / event.total) * 100));
          },
        }
      );
      return data.files;
    },
    onSuccess: (files) => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.files(projectId) });
      void queryClient.invalidateQueries({ queryKey: projectKeys.activityAll(projectId) });
      toast.success(files.length === 1 ? "File uploaded" : `${files.length} files uploaded`);
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useDeleteProjectFile(projectId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (fileId: string) => {
      await api.delete(`/projects/${projectId}/files/${fileId}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.files(projectId) });
      void queryClient.invalidateQueries({ queryKey: projectKeys.activityAll(projectId) });
      toast.success("File removed");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export async function downloadProjectFile(projectId: string, file: ProjectFile): Promise<void> {
  const response = await api.get<Blob>(`/projects/${projectId}/files/${file._id}`, {
    responseType: "blob",
    timeout: 120_000,
  });
  saveBlob(response.data, file.filename);
}
