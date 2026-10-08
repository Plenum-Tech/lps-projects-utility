import { useMemo, useState } from "react";
import { LuChevronLeft, LuChevronRight, LuClock3, LuLoaderCircle } from "react-icons/lu";

import { DashboardCard } from "@/components/dashboard/my-dashboard/dashboard-card";
import { QueryError } from "@/components/globals/query-states";
import { Button } from "@/components/ui/button";
import { useMyWeekTimelogs } from "@/hooks/use-my-dashboard";
import { weekStartsOn, weekdayOrder } from "@/lib/format";
import { addDaysKey, formatMinutes, formatWeekRange, mondayOf, parseDateKey } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { WeekTimelogs as WeekTimelogsData } from "@/types";

const DAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** First day (per Settings → App → Week starts on) of the week containing `key`. */
function displayWeekStart(key: string): string {
  if (weekStartsOn() === 1) return mondayOf(key);
  return addDaysKey(key, -parseDateKey(key).getDay());
}

/**
 * Day pills for the configured week (Mon–Sun or Sun–Sat) with prev/next week;
 * the selected day's worked minutes vs breaks as a bar. The server groups by
 * Monday-based weeks, so a Sunday-first week stitches two server weeks
 * together. The current server week comes embedded in /dashboard/me.
 */
export function WeekTimelogs({
  initial,
  today,
  periodMinutes,
  periodCaption,
}: {
  initial: WeekTimelogsData;
  today: string;
  /** Minutes logged in the dashboard period (the week navigation is independent of it). */
  periodMinutes: number;
  /** "last 30 days" / "all time". */
  periodCaption: string;
}) {
  const currentWeek = displayWeekStart(today);
  const [weekStart, setWeekStart] = useState(currentWeek);
  const [selected, setSelected] = useState(today);
  const isCurrent = weekStart === currentWeek;
  const weekEnd = addDaysKey(weekStart, 6);

  // Server (Monday-based) weeks that cover the displayed days — one or two.
  const serverA = mondayOf(weekStart);
  const serverB = mondayOf(weekEnd);
  const queryA = useMyWeekTimelogs(serverA, serverA !== initial.weekStart);
  const queryB = useMyWeekTimelogs(serverB, serverB !== serverA && serverB !== initial.weekStart);
  const dataA = serverA === initial.weekStart ? initial : queryA.data;
  const dataB = serverB === serverA ? dataA : serverB === initial.weekStart ? initial : queryB.data;
  const remote = [serverA === initial.weekStart ? null : queryA, serverB === serverA || serverB === initial.weekStart ? null : queryB].filter(
    (query): query is typeof queryA => query !== null
  );
  const failed = remote.find((query) => query.isError);
  const fetching = remote.some((query) => query.isFetching);
  const loaded = Boolean(dataA && dataB) && !remote.some((query) => query.isPlaceholderData);

  const days = useMemo(() => {
    const byDate = new Map<string, WeekTimelogsData["days"][number]>();
    for (const source of [dataA, dataB]) {
      for (const item of source?.days ?? []) {
        if (item.date >= weekStart && item.date <= weekEnd) byDate.set(item.date, item);
      }
    }
    return byDate;
  }, [dataA, dataB, weekStart, weekEnd]);
  const totalMinutes = Array.from(days.values()).reduce((sum, item) => sum + item.minutes, 0);
  const data = loaded ? { days: Array.from(days.values()), totalMinutes } : undefined;
  const query = { isFetching: fetching, isError: Boolean(failed), error: failed?.error, isRefetching: failed?.isRefetching ?? false, refetch: () => failed?.refetch() };
  const labels = weekdayOrder(DAY_LABELS);

  function moveWeek(direction: 1 | -1) {
    const next = addDaysKey(weekStart, direction * 7);
    setWeekStart(next);
    // Keep the same weekday selected; land on today when returning to this week.
    setSelected(next === currentWeek ? today : addDaysKey(selected, direction * 7));
  }

  const day = days.get(selected) ?? days.get(weekStart);
  const worked = day?.minutes ?? 0;
  const breaks = day?.breakMinutes ?? 0;
  const span = worked + breaks;
  const workedPct = span > 0 ? (worked / span) * 100 : 0;

  return (
    <DashboardCard
      title="Week time logs"
      icon={LuClock3}
      badge={data ? `${formatMinutes(data.totalMinutes)} ${isCurrent ? "this week" : "total"}` : undefined}
      headerExtra={
        <span className="text-xs text-muted-foreground" title={`Logged in the ${periodCaption}`}>
          <span className="font-medium text-foreground tabular-nums">{formatMinutes(periodMinutes)}</span> logged ·{" "}
          {periodCaption}
        </span>
      }
      viewAll={{ to: "/timelogs", label: "Time logs" }}
    >
      <div className="space-y-4 p-4">
        <div className="flex items-center justify-between gap-2">
          <Button variant="outline" size="icon-sm" onClick={() => moveWeek(-1)} aria-label="Previous week">
            <LuChevronLeft aria-hidden />
          </Button>
          <p aria-live="polite" className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            {formatWeekRange(weekStart)}
            {query.isFetching && (
              <LuLoaderCircle aria-label="Loading" className="size-3.5 animate-spin" />
            )}
          </p>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => moveWeek(1)}
            disabled={weekStart >= currentWeek}
            aria-label="Next week"
          >
            <LuChevronRight aria-hidden />
          </Button>
        </div>

        {query.isError ? (
          <QueryError
            title="Couldn't load this week"
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isRefetching}
          />
        ) : (
          <>
            <div role="radiogroup" aria-label="Day" className="grid grid-cols-7 gap-1">
              {labels.map((label, index) => {
                const key = addDaysKey(weekStart, index);
                const minutes = days.get(key)?.minutes ?? 0;
                const active = key === selected;
                const isToday = key === today;
                return (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-label={`${parseDateKey(key).toLocaleDateString("en-US", {
                      weekday: "long",
                      month: "short",
                      day: "numeric",
                    })}: ${formatMinutes(minutes)}${isToday ? " (today)" : ""}`}
                    onClick={() => setSelected(key)}
                    className={cn(
                      "relative flex h-9 flex-col items-center justify-center rounded-full text-xs font-semibold outline-none transition-colors duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring/50",
                      active
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:text-foreground",
                      isToday && !active && "ring-1 ring-primary text-primary"
                    )}
                  >
                    {label}
                    <span
                      aria-hidden
                      className={cn(
                        "absolute bottom-1 size-1 rounded-full",
                        minutes > 0 ? (active ? "bg-primary-foreground" : "bg-primary") : "bg-transparent"
                      )}
                    />
                  </button>
                );
              })}
            </div>

            <div className={cn("space-y-2 transition-opacity duration-150", !data && "opacity-60")}>
              <div
                className="flex h-2.5 overflow-hidden rounded-full bg-muted"
                role="img"
                aria-label={`Worked ${formatMinutes(worked)}, break ${formatMinutes(breaks)}`}
              >
                {span > 0 && (
                  <>
                    <div className="h-full bg-primary transition-[width] duration-200 ease-out" style={{ width: `${workedPct}%` }} />
                    <div className="h-full flex-1 bg-chart-4" />
                  </>
                )}
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <span aria-hidden className="size-2 rounded-full bg-primary" />
                  Duration: <span className="font-medium text-foreground tabular-nums">{formatMinutes(worked)}</span>
                </span>
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <span aria-hidden className="size-2 rounded-full bg-chart-4" />
                  Break: <span className="font-medium text-foreground tabular-nums">{formatMinutes(breaks)}</span>
                </span>
              </div>
            </div>
          </>
        )}
      </div>
    </DashboardCard>
  );
}
