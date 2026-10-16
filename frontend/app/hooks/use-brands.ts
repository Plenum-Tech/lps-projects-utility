import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { deliveryKeys } from "@/hooks/use-delivery";
import { projectKeys } from "@/hooks/use-projects";
import { SettingsFieldError } from "@/hooks/use-settings";
import { useToast } from "@/hooks/use-toast";
import { api, getErrorMessage } from "@/lib/api";
import type { Brand, BrandInput, PitchSheetRow, ScopeExtraction } from "@/types";

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
  project?: { _id: string; name: string; code: string };
  tasks?: number;
  warnings?: string[];
  pendingApproval?: string;
}

/** Creates the brand with its project, lead tasks and team (or sends it for approval). */
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
