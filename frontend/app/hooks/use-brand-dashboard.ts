import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { brandKeys } from "@/hooks/use-brands";
import { deliveryKeys } from "@/hooks/use-delivery";
import { manpowerKeys } from "@/hooks/use-manpower";
import { projectKeys } from "@/hooks/use-projects";
import { useToast } from "@/hooks/use-toast";
import { api, getErrorMessage } from "@/lib/api";
import { downloadFromApi } from "@/lib/download";
import type { Brand, BrandDetailResponse, BrandOverviewResponse, PitchesResponse, PitchRow, PitchStepKey } from "@/types";

// Brands section (/brands): overview + allocation, the brand page, split, leads, documents.

export const brandDashboardKeys = {
  overview: (month: string) => ["brands", "overview", month] as const,
  detail: (id: string, month: string) => ["brands", "detail", id, month] as const,
  pitches: (quarter: string) => ["brands", "pitches", quarter] as const,
};

const MONTH = /^\d{4}-\d{2}$/;

/** Every brand with its checks, plan lines, team and current projects (one call). */
export function useBrandOverview(month: string) {
  return useQuery({
    queryKey: brandDashboardKeys.overview(month),
    queryFn: async () => (await api.get<BrandOverviewResponse>("/brands/overview", { params: { month } })).data,
    enabled: MONTH.test(month),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

/** Brands → Pitches: the quarter's pitch projects with their automatic status. */
export function usePitches(quarter: string) {
  return useQuery({
    queryKey: brandDashboardKeys.pitches(quarter),
    queryFn: async () => (await api.get<PitchesResponse>("/brands/pitches", { params: { quarter } })).data,
    enabled: /^\d{4}-Q[1-4]$/.test(quarter),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

/** The Pitch plan (.xlsx) for a quarter. */
export function usePitchesExport() {
  const toast = useToast();
  return useMutation({
    mutationFn: async (quarter: string) =>
      downloadFromApi("/brands/pitches/export", { quarter }, `Pitch_plan_${quarter.slice(5)}_${quarter.slice(0, 4)}.xlsx`),
    onSuccess: () => toast.success("Excel downloaded"),
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

/** A Pitch plan edit failed: the message, and the task to open when a task rule refused it. */
export class PitchEditError extends Error {
  constructor(
    message: string,
    readonly taskId: string | null = null,
  ) {
    super(message);
  }
}

export type PitchEdit =
  | { kind: "step"; row: PitchRow; step: PitchStepKey; date: string | null; held: boolean }
  | { kind: "revenue"; row: PitchRow; revenue: number | null; tbc: boolean }
  | { kind: "leads"; row: PitchRow; leads: string[] }
  | { kind: "deadline"; row: PitchRow; deadline: string | null };

type PitchPatchResult = { row: PitchRow | null; message?: string };

/**
 * In-place edits of the Pitch plan. Task changes go through the task API (its rules
 * apply: e.g. closing a task asks for time, a link and an outcome note); the
 * project side (pitch dates, revenue, manager, end date) through PATCH /brands/pitches/:id.
 */
export function usePitchEdit(quarter: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const patch = async (row: PitchRow, body: object) => (await api.patch<PitchPatchResult>(`/brands/pitches/${row.id}`, body)).data;
  const task = async (taskId: string, path: string, body: object) => {
    try {
      await api.patch(`/tasks/${taskId}${path}`, body);
    } catch (error) {
      throw new PitchEditError(getErrorMessage(error), taskId);
    }
  };
  return useMutation({
    mutationFn: async (edit: PitchEdit): Promise<string[]> => {
      const messages: string[] = [];
      const { row } = edit;
      if (edit.kind === "step") {
        let step = row.steps.find((s) => s.key === edit.step);
        if (edit.date !== (step?.due ?? null)) {
          if (step?.taskId) await task(step.taskId, "", { dueDate: edit.date });
          const result = await patch(row, { step: edit.step, date: edit.date });
          if (result.message) messages.push(result.message);
          step = result.row?.steps.find((s) => s.key === edit.step) ?? step;
        }
        if (step?.taskId && edit.held !== step.done) {
          await task(step.taskId, "/status", { status: edit.held ? "completed" : "in_progress" });
        } else if (edit.held && !step?.taskId) {
          throw new PitchEditError("Add the date first: it creates the task to mark as held.");
        }
      } else if (edit.kind === "revenue") {
        await patch(row, { revenue: edit.revenue, revenueTbc: edit.tbc });
      } else if (edit.kind === "leads") {
        const result = await patch(row, { leads: edit.leads });
        if (result.message) messages.push(result.message);
        for (const s of row.steps) {
          const same = s.assignees.length === edit.leads.length && edit.leads.every((id) => s.assignees.includes(id));
          if (s.taskId && !same) await task(s.taskId, "", { assignees: edit.leads });
        }
      } else {
        const result = await patch(row, { deadline: edit.deadline });
        if (result.message) messages.push(result.message);
      }
      return messages;
    },
    onSuccess: (messages) => {
      if (messages.length) messages.forEach((m) => toast.success(m));
      else toast.success("Pitch updated");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: brandDashboardKeys.pitches(quarter) });
      void queryClient.invalidateQueries({ queryKey: projectKeys.all });
    },
  });
}

/** The brand page: brand, team, utilisation, projects and documents for a month. */
export function useBrandDetail(id: string, month: string) {
  return useQuery({
    queryKey: brandDashboardKeys.detail(id, month),
    queryFn: async () => (await api.get<BrandDetailResponse>(`/brands/${id}/detail`, { params: { month } })).data,
    enabled: Boolean(id) && MONTH.test(month),
    placeholderData: keepPreviousData,
    retry: (count, error) => (error as { response?: { status?: number } })?.response?.status !== 404 && count < 2,
  });
}

function useInvalidateAll() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: brandKeys.all });
    void queryClient.invalidateQueries({ queryKey: projectKeys.all });
    void queryClient.invalidateQueries({ queryKey: manpowerKeys.all });
    void queryClient.invalidateQueries({ queryKey: deliveryKeys.all });
  };
}

/** Leads / organisation (creators and leadership; applied at once) or scope (leadership; others → approval). */
export function usePatchBrand() {
  const invalidate = useInvalidateAll();
  const toast = useToast();
  return useMutation({
    mutationFn: async ({ id, ...body }: { id: string; leads?: string[]; organisation?: string; scopeItems?: unknown[]; monthlyRetainer?: boolean }) =>
      (await api.patch<{ brand: Brand; changed: string[]; pendingApproval?: string }>(`/brands/${id}`, body)).data,
    onSuccess: (data) => {
      invalidate();
      toast.success(data.pendingApproval ?? (data.changed.length ? "Brand updated" : "No changes"));
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });
}

export interface BrandSplitResult {
  brand: Brand;
  pendingApproval?: string;
  moved?: number;
  plans?: Array<{ month: string; version: number; pendingApproval?: string }>;
  notes?: string[];
}

/** Split: a new brand gets the ticked projects (and their plan lines). */
export function useSplitBrand() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: async ({ id, ...body }: { id: string; name: string; projectIds: string[]; organisation?: string }) =>
      (await api.post<BrandSplitResult>(`/brands/${id}/split`, body)).data,
    onSuccess: () => invalidate(),
  });
}

/** Attach scope documents to the brand. */
export function useUploadBrandFiles() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: async ({ id, files }: { id: string; files: File[] }) => {
      const body = new FormData();
      for (const file of files) body.append("files", file);
      return (await api.post(`/brands/${id}/files`, body, { headers: { "Content-Type": "multipart/form-data" }, timeout: 120_000 })).data;
    },
    onSuccess: () => invalidate(),
  });
}

export function useDeleteBrandFile() {
  const invalidate = useInvalidateAll();
  const toast = useToast();
  return useMutation({
    mutationFn: async ({ id, fileId }: { id: string; fileId: string }) => (await api.delete(`/brands/${id}/files/${fileId}`)).data,
    onSuccess: () => {
      invalidate();
      toast.success("Document removed");
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });
}
