import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { deliveryKeys } from "@/hooks/use-delivery";
import { projectKeys } from "@/hooks/use-projects";
import { SettingsFieldError } from "@/hooks/use-settings";
import { useToast } from "@/hooks/use-toast";
import { api, getErrorMessage } from "@/lib/api";
import type { Brand, BrandInput, MonthMigrationPreview, MonthMigrationResult, PitchImportResult, PitchImportRow, PitchSheetRow, ScopeExtraction } from "@/types";

export const brandKeys = {
  all: ["brands"] as const,
  list: (activeOnly: boolean) => ["brands", "list", { activeOnly }] as const,
};

/** Brands sorted by name (any signed-in user). `activeOnly` hides deactivated ones. */
export function useBrands(activeOnly = false, enabled = true) {
  return useQuery({
    queryKey: brandKeys.list(activeOnly),
    queryFn: async () => {
      const { data } = await api.get<{ brands: Brand[]; total: number }>("/brands", {
        params: activeOnly ? { active: "true" } : {},
      });
      return data.brands;
    },
    staleTime: 60_000,
    enabled,
  });
}

export type BrandNotReadyReason = "no_scope" | "not_in_plan" | "no_lead";
export interface BrandReadinessResponse {
  /** The current month ("YYYY-MM"): the plan line must be in its latest approved plan. */
  month: string;
  brands: Record<string, { ready: boolean; reasons: BrandNotReadyReason[] }>;
}

/** Which brands can get a NEW non-pitch project: a scope, a line in the current month's approved plan, a lead. */
export function useBrandReadiness(enabled = true) {
  return useQuery({
    queryKey: [...brandKeys.all, "readiness"] as const,
    queryFn: async () => (await api.get<BrandReadinessResponse>("/brands/readiness")).data,
    staleTime: 30_000,
    enabled,
  });
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "no scope", "not in October's plan", "no lead". */
export function readinessReasonText(reason: BrandNotReadyReason, month: string): string {
  return reason === "no_scope" ? "no scope" : reason === "not_in_plan" ? `not in ${MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? month}'s plan` : "no lead";
}

function toFieldError(error: unknown): SettingsFieldError {
  const field = (error as { response?: { data?: { field?: unknown } } })?.response?.data?.field ?? null;
  return new SettingsFieldError(getErrorMessage(error), typeof field === "string" ? field : null);
}

function useInvalidateBrands() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: brandKeys.all });
    void queryClient.invalidateQueries({ queryKey: projectKeys.all });
    void queryClient.invalidateQueries({ queryKey: deliveryKeys.all });
  };
}

export function useCreateBrand() {
  const invalidate = useInvalidateBrands();
  const toast = useToast();
  return useMutation({
    mutationFn: async (input: BrandInput & { name: string }) => {
      try {
        const { data } = await api.post<{ brand: Brand }>("/brands", input);
        return data.brand;
      } catch (error) {
        throw toFieldError(error);
      }
    },
    onSuccess: (brand) => {
      invalidate();
      if (brand.status === "pending") {
        toast.success(`Brand “${brand.name}” sent to leadership for approval. You can use it once it's approved.`);
      } else {
        toast.success(`Brand “${brand.name}” added`);
      }
    },
  });
}

export function useUpdateBrand() {
  const invalidate = useInvalidateBrands();
  const toast = useToast();
  return useMutation({
    mutationFn: async ({ id, ...input }: BrandInput & { id: string }) => {
      try {
        const { data } = await api.patch<{ brand: Brand; changed: string[]; pendingApproval?: string }>(`/brands/${id}`, input);
        return data;
      } catch (error) {
        throw toFieldError(error);
      }
    },
    onSuccess: (data) => {
      invalidate();
      // Non-leadership edits wait for leadership approval.
      toast.success(data.pendingApproval ?? "Brand updated");
    },
  });
}

/** 409 when projects use the brand — the error message says to deactivate instead. */
export function useDeleteBrand() {
  const invalidate = useInvalidateBrands();
  const toast = useToast();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/brands/${id}`);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Brand deleted");
    },
  });
}

// ---------------------------------------------------------------------------
// Brand flow (Brands → New brand)
// ---------------------------------------------------------------------------

/** Reads the scope from files / typed text (AI when the server has a key). */
export function useExtractBrandScope() {
  return useMutation({
    mutationFn: async ({ files, text }: { files: File[]; text: string }) => {
      const body = new FormData();
      for (const file of files) body.append("files", file);
      body.append("text", text);
      const { data } = await api.post<ScopeExtraction>("/brands/scope-extract", body, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 120_000,
      });
      return data;
    },
  });
}

/** Reads the pitch tracker (.xlsx) into rows. */
export function useReadPitchSheet() {
  return useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData();
      body.append("files", file);
      const { data } = await api.post<{ rows: PitchSheetRow[] }>("/brands/pitch-sheet", body, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return data.rows;
    },
  });
}

export interface BrandFlowResult {
  brand: Brand;
  /** Pitches only: the Pitch project (a brand gets no project). */
  project?: { _id: string; name: string; code: string };
  /** Brands (not pitches): the brand's line in the month's manpower plan; null when it couldn't be added (see warnings). */
  planLine?: { month: string; name: string; pendingApproval?: string } | null;
  tasks?: number;
  warnings?: string[];
  pendingApproval?: string;
}

/** Creates the brand and its team's plan line — a pitch also its project and lead tasks (or sends it for approval). */
export function useCreateBrandFlow() {
  const invalidate = useInvalidateBrands();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ data, files }: { data: Record<string, unknown>; files: File[] }) => {
      const body = new FormData();
      for (const file of files) body.append("files", file);
      body.append("data", JSON.stringify(data));
      const { data: result } = await api.post<BrandFlowResult>("/brands/flow", body, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 120_000,
      });
      return result;
    },
    onSuccess: () => {
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      void queryClient.invalidateQueries({ queryKey: ["manpower"] });
    },
  });
}

/** Pitch tracker import, step 1: what each row of the sheet will create. */
export function usePreviewPitchImport() {
  return useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData();
      body.append("files", file);
      const { data } = await api.post<{ rows: PitchImportRow[]; canCreateBrands: boolean }>("/brands/pitch-import/preview", body, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return data;
    },
  });
}

/** Pitch tracker import, step 2: create the confirmed rows. */
export function useRunPitchImport() {
  const invalidate = useInvalidateBrands();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (rows: Array<Record<string, unknown>>) =>
      (await api.post<{ results: PitchImportResult[] }>("/brands/pitch-import", { rows }, { timeout: 300_000 })).data.results,
    onSuccess: () => {
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

/** Brands → Migrate to next month: what would roll over from `from` to `to`. */
export function useMonthMigrationPreview(from: string, to: string, enabled: boolean) {
  return useQuery({
    queryKey: ["brands", "month-migration", from, to],
    queryFn: async () => (await api.get<MonthMigrationPreview>("/brands/month-migration", { params: { from, to } })).data,
    enabled,
  });
}

/** Runs the migration for the picked brands up to `to`, month by month (plan lines + projects, approved at once). */
export function useRunMonthMigration() {
  const invalidate = useInvalidateBrands();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { from: string; to: string; brandIds: string[] }) =>
      (await api.post<{ steps: MonthMigrationResult[] }>("/brands/month-migration", input, { timeout: 600_000 })).data,
    onSuccess: () => {
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ["manpower"] });
    },
  });
}
