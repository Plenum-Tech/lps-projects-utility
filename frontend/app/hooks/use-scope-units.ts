import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useToast } from "@/hooks/use-toast";
import { api, getErrorMessage } from "@/lib/api";
import { DEFAULT_SCOPE_UNITS } from "@/lib/scope";
import type { ScopeUnitDef, ScopeUnitsResponse } from "@/types";

export const scopeUnitKeys = { all: ["settings", "scope-units"] as const };

/** Settings → Scope units (any signed-in user): the units, with how many scope rows use each, and the roles. */
export function useScopeUnitSettings(enabled = true) {
  return useQuery({
    queryKey: scopeUnitKeys.all,
    queryFn: async () => (await api.get<ScopeUnitsResponse>("/settings/scope-units")).data,
    staleTime: 5 * 60_000,
    enabled,
  });
}

/** The configured scope units (the defaults until loaded). */
export function useScopeUnits(): ScopeUnitDef[] {
  return useScopeUnitSettings().data?.units ?? DEFAULT_SCOPE_UNITS;
}

/** PUT /settings/scope-units — the whole ordered list (admins / leadership). */
export function useUpdateScopeUnits() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (units: Array<Pick<ScopeUnitDef, "name" | "roles" | "countsTowardTotal" | "hidden"> & { key?: string }>) =>
      (await api.put<ScopeUnitsResponse>("/settings/scope-units", { units })).data,
    onSuccess: (data) => {
      queryClient.setQueryData(scopeUnitKeys.all, data);
      const r = data.renamed;
      if (r) {
        const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
        const parts = [n(r.brandRows, "brand row"), n(r.projectRows, "project row"), n(r.tasks, "task")];
        if (r.requests) parts.push(n(r.requests, "pending request"));
        toast.success(`Scope units saved. Renamed: ${parts.join(", ")}`);
        // Scope rows and task names changed everywhere.
        void queryClient.invalidateQueries();
      } else toast.success("Scope units saved");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}
