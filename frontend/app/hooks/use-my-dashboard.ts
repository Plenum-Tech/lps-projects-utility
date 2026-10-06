import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { MyCalendarResponse, MyDashboard, WeekTimelogs } from "@/types";

export const myDashboardKeys = {
  all: ["dashboard", "me"] as const,
  summary: () => ["dashboard", "me", "summary"] as const,
  calendar: (from: string, to: string) => ["dashboard", "me", "calendar", { from, to }] as const,
  timelogs: (weekStart: string) => ["dashboard", "me", "timelogs", weekStart] as const,
};

/** Personal dashboard in one call (`GET /dashboard/me`). */
export function useMyDashboard() {
  return useQuery({
    queryKey: myDashboardKeys.summary(),
    queryFn: async () => {
      const { data } = await api.get<MyDashboard>("/dashboard/me");
      return data;
    },
    staleTime: 30_000,
  });
}

/** My calendar items between two "YYYY-MM-DD" keys (inclusive, ≤ 100 days). */
export function useMyCalendar(from: string, to: string) {
  return useQuery({
    queryKey: myDashboardKeys.calendar(from, to),
    queryFn: async () => {
      const { data } = await api.get<MyCalendarResponse>("/dashboard/me/calendar", {
        params: { from, to },
      });
      return data;
    },
    placeholderData: keepPreviousData,
  });
}

/** Per-day worked / break minutes for the Mon–Sun week containing `weekStart`. */
export function useMyWeekTimelogs(weekStart: string, enabled = true) {
  return useQuery({
    queryKey: myDashboardKeys.timelogs(weekStart),
    queryFn: async () => {
      const { data } = await api.get<WeekTimelogs>("/dashboard/me/timelogs", {
        params: { weekStart },
      });
      return data;
    },
    enabled,
    placeholderData: keepPreviousData,
  });
}
