import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { deliveryKeys } from "@/hooks/use-delivery";
import { projectKeys } from "@/hooks/use-projects";
import { SettingsFieldError } from "@/hooks/use-settings";
import { useToast } from "@/hooks/use-toast";
import { api, getErrorMessage } from "@/lib/api";
import type { Brand, BrandInput } from "@/types";

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
