import { useCallback, useEffect } from "react";
import { useSearchParams } from "react-router";

import { SegmentedControl, type SegmentedOption } from "@/components/globals/segmented-control";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import type { DeliveryDelta, MyDashboard, MyDashboardPeriod } from "@/types";

// ---------------------------------------------------------------------------
// My dashboard period (prompts/my-dashboard-period.md): last N days ending
// today, or all time (the default). Kept in the URL (?period=30d) and in localStorage.
// ---------------------------------------------------------------------------

export const MY_PERIODS: (SegmentedOption<MyDashboardPeriod> & { caption: string; days: number | null })[] = [
  { value: "7d", label: "7d", title: "Last 7 days", caption: "last 7 days", days: 7 },
  { value: "30d", label: "30d", title: "Last 30 days", caption: "last 30 days", days: 30 },
  { value: "90d", label: "90d", title: "Last 90 days", caption: "last 90 days", days: 90 },
  { value: "120d", label: "120d", title: "Last 120 days", caption: "last 120 days", days: 120 },
  { value: "365d", label: "1y", title: "Last year (365 days)", caption: "last year", days: 365 },
  { value: "all", label: "All", title: "All time", caption: "all time", days: null },
];

export const DEFAULT_MY_PERIOD: MyDashboardPeriod = "all";
const STORAGE_KEY = "ems.myDashboard.period";

export function isMyPeriod(value: string | null | undefined): value is MyDashboardPeriod {
  return MY_PERIODS.some((period) => period.value === value);
}

/** "last 30 days" / "all time". */
export function periodCaption(period: MyDashboardPeriod): string {
  return MY_PERIODS.find((option) => option.value === period)?.caption ?? "";
}

/** Length in days (null for all time). */
export function periodDays(period: MyDashboardPeriod): number | null {
  return MY_PERIODS.find((option) => option.value === period)?.days ?? null;
}

function readStored(): MyDashboardPeriod | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isMyPeriod(value) ? value : null;
  } catch {
    return null;
  }
}

function store(period: MyDashboardPeriod) {
  try {
    window.localStorage.setItem(STORAGE_KEY, period);
  } catch {
    // Storage unavailable — the URL still carries the choice.
  }
}

/**
 * The selected period: `?period=` wins, then the remembered choice, then all time.
 * Choosing one writes both. The ?task / other params are left untouched.
 */
export function useMyDashboardPeriod() {
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get("period");
  const period: MyDashboardPeriod = isMyPeriod(fromUrl) ? fromUrl : (readStored() ?? DEFAULT_MY_PERIOD);

  // A shared link (?period=90d) also becomes the remembered choice.
  useEffect(() => {
    if (isMyPeriod(fromUrl)) store(fromUrl);
  }, [fromUrl]);

  const setPeriod = useCallback(
    (next: MyDashboardPeriod) => {
      store(next);
      setParams(
        (previous) => {
          const out = new URLSearchParams(previous);
          out.set("period", next);
          return out;
        },
        { replace: true, preventScrollReset: true }
      );
    },
    [setParams]
  );

  return [period, setPeriod] as const;
}

/** Segmented control (≥ sm) / select (mobile) for the period. */
export function MyPeriodPicker({
  value,
  onChange,
  className,
}: {
  value: MyDashboardPeriod;
  onChange: (value: MyDashboardPeriod) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center", className)}>
      <SegmentedControl
        label="Dashboard period"
        value={value}
        onChange={onChange}
        options={MY_PERIODS}
        className="hidden sm:inline-flex"
      />
      <NativeSelect
        aria-label="Dashboard period"
        size="sm"
        className="w-40 sm:hidden"
        value={value}
        onChange={(event) => {
          if (isMyPeriod(event.target.value)) onChange(event.target.value);
        }}
      >
        {MY_PERIODS.map((option) => (
          <NativeSelectOption key={option.value} value={option.value}>
            {option.title}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}

/** Count change vs the previous period in the Delivery Pulse delta shape (higher is better). */
export function countDelta(current: number, previous: number | null): DeliveryDelta | null {
  if (previous === null) return null;
  const change = current - previous;
  const direction = change > 0 ? "up" : change < 0 ? "down" : "flat";
  return {
    current,
    previous,
    change,
    direction,
    good: direction === "flat" ? null : direction === "up",
    betterWhen: "higher",
    noPreviousData: false,
  };
}

// --- Project list links (/projects URL filters) ------------------------------

function projectsHref(userId: string, params: Record<string, string | null>): string {
  // memberOnly: on the team (members[].user) — Worksuite doesn't count manager-only projects.
  const query = new URLSearchParams({ memberOnly: userId });
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  return `/projects?${query.toString()}`;
}

/** Links to /projects filtered exactly like each My dashboard project number (Worksuite definitions). */
export function projectLinks(period: PeriodRange, userId: string) {
  const ranged = Boolean(period.from);
  return {
    /** Profile → Projects / Projects → In progress: member, progress < 100 %, active in the period. */
    inProgress: projectsHref(userId, {
      active: "1",
      activeFrom: ranged ? period.from : null,
      activeTo: ranged ? period.to : null,
    }),
    /** Member, progress < 100 %, deadline on or before today (inside the period). */
    overdue: projectsHref(userId, { active: "1", deadlineFrom: period.from, deadlineTo: period.to }),
    /** Member projects moved to a completed status in the period. */
    completed: projectsHref(userId, {
      completed: "1",
      completedFrom: period.from,
      completedTo: ranged ? period.to : null,
    }),
  };
}

// --- Task list links (/tasks URL filters) -------------------------------------

/** Every status but completed (Worksuite "pending"). */
const OPEN_STATUSES = "todo,in_progress,in_review,rejected";

type PeriodRange = MyDashboard["period"];

function tasksHref(params: Record<string, string | null>): string {
  const query = new URLSearchParams({ mine: "on" });
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  return `/tasks?${query.toString()}`;
}

/** Links to /tasks filtered exactly like each My dashboard number. */
export function taskLinks(period: PeriodRange) {
  const createdOrDue = { createdOrDueFrom: period.from, createdOrDueTo: period.from ? period.to : null };
  return {
    /** Profile → Open tasks / Tasks → Pending / My tasks "View all": not completed, created or due in the period. */
    open: tasksHref({ statusIn: OPEN_STATUSES, ...createdOrDue }),
    pending: tasksHref({ statusIn: OPEN_STATUSES, ...createdOrDue }),
    /** Due before today (the API's `overdue`), due date inside the period. */
    overdue: tasksHref({ overdue: "on", from: period.from, to: period.from ? period.to : null }),
    completed: tasksHref({
      status: "completed",
      completedFrom: period.from,
      completedTo: period.from ? period.to : null,
    }),
  };
}
