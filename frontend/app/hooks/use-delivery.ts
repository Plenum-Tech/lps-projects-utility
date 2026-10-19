import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { SettingsFieldError } from "@/hooks/use-settings";
import { useToast } from "@/hooks/use-toast";
import { api, getErrorMessage } from "@/lib/api";
import { downloadCsvExport } from "@/lib/download";
import type {
  DeliveryBrandsResponse,
  DeliveryBriefsResponse,
  DeliveryDelayedResponse,
  DeliveryFilters,
  DeliveryPeopleResponse,
  DeliveryPersonResponse,
  DeliverySettingsInput,
  DeliverySettingsResponse,
  DeliverySummaryResponse,
  DeliveryBrandStructureResponse,
  DeliveryTeamMapResponse,
  DeliveryTrafficResponse,
  DeliveryTeamsResponse,
  DeliveryWeeklyResponse,
} from "@/types";

type Endpoint =
  | "summary"
  | "weekly"
  | "teams"
  | "brands"
  | "delayed"
  | "briefs"
  | "people"
  | "team-map"
  | "traffic"
  | "brand-structure";

export const deliveryKeys = {
  all: ["delivery"] as const,
  endpoint: (endpoint: string, params: Record<string, string>) =>
    ["delivery", endpoint, params] as const,
  settings: ["delivery-settings"] as const,
};

/** Filters as query params (empty values dropped; `period` always sent). */
export function deliveryParams(
  filters: DeliveryFilters,
  extra: Record<string, string> = {},
) {
  const out: Record<string, string> = { period: filters.period };
  if (filters.period === "custom") {
    if (filters.from) out.from = filters.from;
    if (filters.to) out.to = filters.to;
  }
  if (filters.team) out.team = filters.team;
  if (filters.brand) out.brand = filters.brand;
  if (filters.person) out.person = filters.person;
  return { ...out, ...extra };
}

function useDeliveryQuery<T>(
  endpoint: Endpoint | `people/${string}`,
  params: Record<string, string>,
  enabled = true,
) {
  return useQuery({
    queryKey: deliveryKeys.endpoint(endpoint, params),
    queryFn: async () => {
      const { data } = await api.get<T>(`/analytics/delivery/${endpoint}`, {
        params,
      });
      return data;
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    enabled,
  });
}

export const useDeliverySummary = (f: DeliveryFilters) =>
  useDeliveryQuery<DeliverySummaryResponse>("summary", deliveryParams(f));
export const useDeliveryWeekly = (f: DeliveryFilters) =>
  useDeliveryQuery<DeliveryWeeklyResponse>("weekly", deliveryParams(f));
export const useDeliveryTeams = (f: DeliveryFilters) =>
  useDeliveryQuery<DeliveryTeamsResponse>("teams", deliveryParams(f));
export const useDeliveryBrands = (f: DeliveryFilters) =>
  useDeliveryQuery<DeliveryBrandsResponse>("brands", deliveryParams(f));
export const useDeliveryDelayed = (f: DeliveryFilters, stale: boolean) =>
  useDeliveryQuery<DeliveryDelayedResponse>(
    "delayed",
    deliveryParams(f, { stale: stale ? "1" : "0" }),
  );
export const useDeliveryBriefs = (f: DeliveryFilters) =>
  useDeliveryQuery<DeliveryBriefsResponse>("briefs", deliveryParams(f));
export const useDeliveryPeople = (f: DeliveryFilters) =>
  useDeliveryQuery<DeliveryPeopleResponse>("people", deliveryParams(f));
export const useDeliveryTeamMap = (f: DeliveryFilters) =>
  useDeliveryQuery<DeliveryTeamMapResponse>("team-map", deliveryParams(f));
export const useDeliveryTraffic = (f: DeliveryFilters) =>
  useDeliveryQuery<DeliveryTrafficResponse>("traffic", deliveryParams(f));
export const useDeliveryBrandStructure = (f: DeliveryFilters) =>
  useDeliveryQuery<DeliveryBrandStructureResponse>(
    "brand-structure",
    deliveryParams(f),
  );

/** Drawer data for one doer (the `person` filter is forced to `id` server-side). */
export function useDeliveryPerson(id: string | null, f: DeliveryFilters) {
  const { person: _person, ...rest } = f;
  return useDeliveryQuery<DeliveryPersonResponse>(
    `people/${id ?? ""}`,
    deliveryParams({ ...rest, person: "" }),
    Boolean(id),
  );
}

/** Team filter options: every configured dashboard team (+ "Other"), independent of filters. */
export function useDeliveryTeamOptions() {
  const query = useDeliveryQuery<DeliveryTeamsResponse>("teams", {
    period: "30d",
  });
  return {
    ...query,
    options: (query.data?.rows ?? []).map((row) => ({
      value: row.team.id,
      label: row.team.name,
    })),
  };
}

export type DeliveryCsvTable = "delayed" | "teams" | "brands" | "people";

export function useDeliveryCsv() {
  const toast = useToast();
  return useMutation({
    mutationFn: ({
      table,
      params,
    }: {
      table: DeliveryCsvTable;
      params: Record<string, string>;
    }) =>
      downloadCsvExport(
        `/analytics/delivery/${table}`,
        { ...params, format: "csv" },
        `delivery-${table}.xlsx`,
      ),
    onSuccess: (result) =>
      toast.success(
        result.truncated
          ? `Exported ${result.rows} of ${result.total} rows (limit reached)`
          : `Exported ${result.rows} row${result.rows === 1 ? "" : "s"}`,
      ),
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

// ---------------------------------------------------------------------------
// Settings → Delivery (admin)
// ---------------------------------------------------------------------------

export function useDeliverySettings(enabled = true) {
  return useQuery({
    queryKey: deliveryKeys.settings,
    queryFn: async () => {
      const { data } =
        await api.get<DeliverySettingsResponse>("/settings/delivery");
      return data;
    },
    enabled,
  });
}

export function useUpdateDeliverySettings() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (input: DeliverySettingsInput) => {
      try {
        const { data } = await api.patch<DeliverySettingsResponse>(
          "/settings/delivery",
          input,
        );
        return data;
      } catch (error) {
        const field = (error as { response?: { data?: { field?: unknown } } })
          ?.response?.data?.field;
        throw new SettingsFieldError(
          getErrorMessage(error),
          typeof field === "string" ? field : null,
        );
      }
    },
    onSuccess: (data) => {
      queryClient.setQueryData(deliveryKeys.settings, data);
      void queryClient.invalidateQueries({ queryKey: deliveryKeys.all });
      toast.success("Delivery settings saved");
    },
  });
}
