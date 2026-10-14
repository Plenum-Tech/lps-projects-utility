import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

/** How many of the month's projects each person is on (project team step). */
export function useTeamLoad(month: string, enabled = true) {
  return useQuery({
    queryKey: ["projects", "team-load", month] as const,
    queryFn: async () =>
      (await api.get<{ month: string; max: number; load: Record<string, number> }>("/projects/team-load", { params: { month } })).data,
    enabled: enabled && /^\d{4}-\d{2}$/.test(month),
    staleTime: 30_000,
  });
}
