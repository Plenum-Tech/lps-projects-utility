import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { brandKeys } from "@/hooks/use-brands";
import { deliveryKeys } from "@/hooks/use-delivery";
import { useToast } from "@/hooks/use-toast";
import { api, getErrorMessage } from "@/lib/api";
import type {
  ManpowerMonthsResponse,
  ManpowerPlanResponse,
  ManpowerSaveInput,
  ManpowerTeamSuggestion,
} from "@/types";

export const manpowerKeys = {
  all: ["manpower"] as const,
  months: () => ["manpower", "months"] as const,
  plan: (month: string, version: number | null) => ["manpower", "plan", month, version] as const,
  suggest: (params: Record<string, string>) => ["manpower", "suggest", params] as const,
};

/** Months that have a plan (newest first) and the role columns. Heads and admins. */
export function useManpowerMonths(enabled = true) {
  return useQuery({
    queryKey: manpowerKeys.months(),
    queryFn: async () => (await api.get<ManpowerMonthsResponse>("/manpower")).data,
    enabled,
    staleTime: 30_000,
  });
}

/** One version of a month's plan (latest when `version` is null). 404 = no plan yet. */
export function useManpowerPlan(month: string, version: number | null, enabled = true) {
  return useQuery({
    queryKey: manpowerKeys.plan(month, version),
    queryFn: async () =>
      (
        await api.get<ManpowerPlanResponse>(`/manpower/${month}`, {
          params: version ? { version } : {},
        })
      ).data,
    enabled: enabled && /^\d{4}-\d{2}$/.test(month),
    placeholderData: keepPreviousData,
    retry: (count, error) =>
      (error as { response?: { status?: number } })?.response?.status !== 404 && count < 2,
  });
}

/** Admins: save the plan as the next version. */
export function useSaveManpowerPlan() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async ({ month, ...body }: ManpowerSaveInput) =>
      (await api.post<{ month: string; version: number; pendingApproval?: string }>(`/manpower/${month}`, body)).data,
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: manpowerKeys.all });
      void queryClient.invalidateQueries({ queryKey: deliveryKeys.all });
      // Brands → Overview / Allocation / brand pages read the latest plan version.
      void queryClient.invalidateQueries({ queryKey: brandKeys.all });
      toast.success(data.pendingApproval ?? `Saved as version ${data.version}`);
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });
}

/** The plan row a project matches (brand + month + type + name), as a team by role. */
export function useManpowerTeamSuggestion(
  params: { brand: string; month: string; type: string; title: string; row?: string },
  enabled: boolean,
) {
  const query: Record<string, string> = { brand: params.brand, month: params.month, type: params.type, title: params.title };
  if (params.row) query.row = params.row;
  return useQuery({
    queryKey: manpowerKeys.suggest(query),
    queryFn: async () => (await api.get<ManpowerTeamSuggestion>("/manpower/suggest", { params: query })).data,
    enabled: enabled && Boolean(params.brand || params.row) && /^\d{4}-\d{2}$/.test(params.month),
    staleTime: 30_000,
  });
}

export interface ManpowerPlanRowRef {
  key: string;
  name: string;
  type: string | null;
  section: string;
  brand: { _id: string; name: string } | null;
}

/** The rows of a month's latest plan (project form "Manpower plan line" picker). */
export function useManpowerRows(month: string, enabled: boolean) {
  return useQuery({
    queryKey: ["manpower", "rows", month] as const,
    queryFn: async () =>
      (await api.get<{ month: string; version: number | null; rows: ManpowerPlanRowRef[] }>("/manpower/rows", { params: { month } })).data,
    enabled: enabled && /^\d{4}-\d{2}$/.test(month),
    staleTime: 30_000,
  });
}
