import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import { projectKeys } from "@/hooks/use-projects";
import { taskKeys } from "@/hooks/use-tasks";
import { useToast } from "@/hooks/use-toast";
import { api, getErrorMessage } from "@/lib/api";
import { downloadFromApi } from "@/lib/download";
import type {
  ImportJob,
  ImportListResponse,
  ImportMapping,
  ImportOptions,
  ImportPreviewResponse,
  ImportType,
} from "@/types";

export const importKeys = {
  all: ["imports"] as const,
  lists: ["imports", "list"] as const,
  list: (params: ImportListParams) => ["imports", "list", params] as const,
  job: (id: string) => ["imports", "job", id] as const,
};

export interface ImportListParams {
  type?: ImportType | "";
  limit: number;
  offset: number;
  mine?: boolean;
}

/** Imported records changed — refresh the matching lists and the history. */
function refreshAfterImport(queryClient: QueryClient, type: ImportType) {
  void queryClient.invalidateQueries({ queryKey: type === "projects" ? projectKeys.all : taskKeys.all });
  // Project progress and task counts move with task imports too.
  if (type === "tasks") void queryClient.invalidateQueries({ queryKey: projectKeys.all });
  void queryClient.invalidateQueries({ queryKey: importKeys.lists });
}

// ---------------------------------------------------------------------------
// Upload / preview
// ---------------------------------------------------------------------------

export type PreviewInput =
  | { type: ImportType; file: File; sheet?: string | null; headerRow?: boolean }
  | { type: ImportType; jobId: string; sheet?: string | null; headerRow?: boolean };

/** Uploads a file (multipart) or re-reads a stored one with another sheet / header setting (JSON). */
export function usePreviewImport() {
  return useMutation({
    mutationFn: async (input: PreviewInput) => {
      if ("file" in input) {
        const form = new FormData();
        form.append("file", input.file);
        if (input.sheet) form.append("sheet", input.sheet);
        if (input.headerRow !== undefined) form.append("headerRow", String(input.headerRow));
        const { data } = await api.post<ImportPreviewResponse>(`/imports/${input.type}/preview`, form, {
          headers: { "Content-Type": "multipart/form-data" },
          timeout: 120_000,
        });
        return data;
      }
      const { data } = await api.post<ImportPreviewResponse>(
        `/imports/${input.type}/preview`,
        {
          jobId: input.jobId,
          ...(input.sheet ? { sheet: input.sheet } : {}),
          ...(input.headerRow !== undefined ? { headerRow: input.headerRow } : {}),
        },
        { timeout: 120_000 }
      );
      return data;
    },
  });
}

/** Validates every row against the mapping + options; writes nothing but the job record. */
export function useValidateImport() {
  return useMutation({
    mutationFn: async (input: { jobId: string; mapping: ImportMapping; options: ImportOptions }) => {
      const { data } = await api.post<{ job: ImportJob }>(
        `/imports/${input.jobId}/validate`,
        { mapping: input.mapping, options: input.options },
        { timeout: 120_000 }
      );
      return data.job;
    },
  });
}

/** Runs the import. `background` is true when the server answered 202 (poll the job). */
export function useRunImport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { jobId: string; mapping: ImportMapping; options: ImportOptions }) => {
      const response = await api.post<{ job: ImportJob }>(
        `/imports/${input.jobId}/run`,
        { mapping: input.mapping, options: input.options },
        { timeout: 120_000 }
      );
      return { job: response.data.job, background: response.status === 202 };
    },
    onSuccess: ({ job, background }) => {
      queryClient.setQueryData(importKeys.job(job.id), job);
      if (!background) refreshAfterImport(queryClient, job.type);
      else void queryClient.invalidateQueries({ queryKey: importKeys.lists });
    },
  });
}

/**
 * One job. Polls every second while it is running, or while a background undo
 * is still deleting (`status: "undone"` without `undoResult`).
 */
export function useImportJob(jobId: string | null | undefined, enabled = true) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: importKeys.job(jobId ?? ""),
    queryFn: async () => {
      const { data } = await api.get<{ job: ImportJob }>(`/imports/${jobId}`);
      const previous = queryClient.getQueryData<ImportJob>(importKeys.job(data.job.id));
      const settled =
        (previous?.status === "running" && data.job.status !== "running") ||
        (previous?.status === "undone" && !previous.undoResult && data.job.undoResult);
      if (settled) refreshAfterImport(queryClient, data.job.type);
      return data.job;
    },
    enabled: Boolean(jobId) && enabled,
    refetchInterval: (query) => {
      const job = query.state.data;
      if (!job) return false;
      if (job.status === "running") return 1_000;
      if (job.status === "undone" && !job.undoResult) return 1_000;
      return false;
    },
    refetchIntervalInBackground: true,
  });
}

/** Undo (24 h). 202 = deleting in the background — the job query keeps polling. */
export function useUndoImport() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (jobId: string) => {
      const response = await api.post<{ job: ImportJob }>(`/imports/${jobId}/undo`, {}, { timeout: 120_000 });
      return { job: response.data.job, background: response.status === 202 };
    },
    onSuccess: ({ job, background }) => {
      // The undo response carries no rows — keep the run results on screen.
      const previous = queryClient.getQueryData<ImportJob>(importKeys.job(job.id));
      queryClient.setQueryData(importKeys.job(job.id), { ...job, rows: job.rows ?? previous?.rows });
      if (background) {
        toast.info("Undo started — records are being removed in the background.");
        void queryClient.invalidateQueries({ queryKey: importKeys.lists });
      } else {
        refreshAfterImport(queryClient, job.type);
        const deleted = job.undoResult?.deleted ?? 0;
        const kept = job.undoResult?.skipped.length ?? 0;
        toast.success(
          kept > 0
            ? `Import undone — ${deleted} removed, ${kept} kept because they were edited.`
            : `Import undone — ${deleted} removed.`
        );
      }
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

/** Import history (admins see every import; `mine` limits it to their own). */
export function useImports(params: ImportListParams, enabled = true) {
  return useQuery({
    queryKey: importKeys.list(params),
    queryFn: async () => {
      const query: Record<string, string | number> = { limit: params.limit, offset: params.offset };
      if (params.type) query.type = params.type;
      if (params.mine) query.mine = "true";
      const { data } = await api.get<ImportListResponse>("/imports", { params: query });
      return data;
    },
    placeholderData: keepPreviousData,
    enabled,
    // Keep running rows moving in the history.
    refetchInterval: (query) =>
      query.state.data?.imports.some(
        (job) => job.status === "running" || (job.status === "undone" && !job.undoResult)
      )
        ? 3_000
        : false,
  });
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export function useDownloadImportTemplate() {
  const toast = useToast();
  return useMutation({
    mutationFn: (type: ImportType) =>
      downloadFromApi(`/imports/templates/${type}`, {}, `${type}-import-template.xlsx`),
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useDownloadImportErrors() {
  const toast = useToast();
  return useMutation({
    mutationFn: (job: Pick<ImportJob, "id" | "type">) =>
      downloadFromApi(`/imports/${job.id}/errors.xlsx`, {}, `${job.type}-import-errors.xlsx`),
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}
