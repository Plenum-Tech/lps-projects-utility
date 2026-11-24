import { Fragment, useMemo, useState } from "react";
import { LuChevronDown, LuChevronRight, LuGauge, LuSettings2 } from "react-icons/lu";
import { Link } from "react-router";

import { FilterSelect } from "@/components/globals/filter-select";
import { EmptyState, PageHeader, QueryError } from "@/components/globals/query-states";
import { DateRangeInputs, DepartmentFilter, RangePresets, ReportFilterBar } from "@/components/reports/report-filters";
import { ReportSkeleton } from "@/components/reports/report-shared";
import { TimeNav } from "@/components/timelogs/time-nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useBrands } from "@/hooks/use-brands";
import { useTimesheetPerformance, useUpdatePerformanceSettings, type TimesheetPerformanceParams } from "@/hooks/use-work-reports";
import { STATUS_META, brandWithOrg, todayKey } from "@/lib/tasks";
import { addDaysKey, formatMinutes, mondayOf, monthStartKey } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { TimesheetPerformance } from "@/types";

// ---------------------------------------------------------------------------
// Timesheet performance (leadership): estimated time against the time actually logged, per
// person and per task, the time each rework took, and brand hours. Live from the time logs.
// ---------------------------------------------------------------------------

type View = "people" | "tasks" | "brands";
type Settings = TimesheetPerformance["settings"];

const signed = (n: number) => `${n > 0 ? "+" : ""}${n}%`;

/** Deviation: green within 5%, amber up to the red line, red beyond it. */
function DeviationPill({ value, redAt }: { value: number | null; redAt: number }) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap tabular-nums",
        value > redAt ? "bg-critical/10 text-critical" : value > 5 ? "bg-warn/10 text-warn" : "bg-good/10 text-good",
      )}
    >
      {signed(value)}
    </span>
  );
}

/** Estimate (grey) with the actual on top (green within it, red over it), on a shared scale. */
function EstimateBar({ estimate, actual, max }: { estimate: number; actual: number; max: number }) {
  const width = (n: number) => `${max > 0 ? Math.min(100, (n / max) * 100) : 0}%`;
  return (
    <span className="relative inline-block h-2 w-36 overflow-hidden rounded-full bg-muted align-middle" aria-hidden>
      <span className="absolute inset-y-0 left-0 rounded-full bg-foreground/20" style={{ width: width(estimate) }} />
      <span className={cn("absolute top-0.5 bottom-0.5 left-0 rounded-full", actual > estimate ? "bg-critical" : "bg-good")} style={{ width: width(actual) }} />
    </span>
  );
}

function Tile({ label, value, note, tone }: { label: string; value: string; note: string; tone?: "warn" | "bad" | "good" }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className={cn("mt-1 font-heading text-2xl font-semibold tracking-tight tabular-nums", tone === "warn" && "text-warn", tone === "bad" && "text-critical", tone === "good" && "text-good")}>{value}</p>
      <p className="text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

function TaskLink({ id, code, title }: { id: string; code: string; title: string }) {
  return (
    <Link to={`/tasks?task=${id}`} className="hover:underline">
      {code && <span className="mr-1.5 rounded border px-1 font-mono text-[11px] text-muted-foreground">{code}</span>}
      {title}
    </Link>
  );
}

const statusLabel = (status: keyof typeof STATUS_META) => STATUS_META[status]?.label ?? status;
const th = "px-3 py-2 text-left text-xs font-semibold tracking-wide whitespace-nowrap text-muted-foreground uppercase";
const td = "px-3 py-2 align-middle";
const num = "px-3 py-2 text-right align-middle whitespace-nowrap tabular-nums";

function PeopleTable({ data }: { data: TimesheetPerformance }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const max = Math.max(1, ...data.people.map((p) => Math.max(p.estimatedMinutes, p.actualMinutes)));
  const redAt = data.settings.overEstimatePct;
  if (data.people.length === 0) return <EmptyState icon={LuGauge} title="No task time in this period" description="Nobody logged time on a task between these dates." className="py-10" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1000px] text-sm">
        <thead className="border-y bg-muted/40">
          <tr>
            <th className={th}>Person</th>
            <th className={cn(th, "text-right")}>Tasks</th>
            <th className={cn(th, "text-right")}>Estimated</th>
            <th className={cn(th, "text-right")}>Actual</th>
            <th className={th}>Estimate vs actual</th>
            <th className={cn(th, "text-right")}>Deviation</th>
            <th className={cn(th, "text-right")}>Over estimate</th>
            <th className={cn(th, "text-right")}>Rework time</th>
            <th className={cn(th, "text-right")} title="Original = 1; each rework adds one">Avg iterations</th>
            <th className={cn(th, "text-right")} title="Completed tasks with a due date that finished on or before it">On time</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {data.people.map((p) => {
            const isOpen = open.has(p.user._id);
            return (
              <Fragment key={p.user._id}>
                <tr
                  className={cn("cursor-pointer hover:bg-muted/40", isOpen && "bg-good/5")}
                  onClick={() => setOpen((prev) => {
                    const next = new Set(prev);
                    if (!next.delete(p.user._id)) next.add(p.user._id);
                    return next;
                  })}
                >
                  <td className={td}>
                    <span className="flex items-center gap-1.5">
                      {isOpen ? <LuChevronDown aria-hidden className="size-4 text-muted-foreground" /> : <LuChevronRight aria-hidden className="size-4 text-muted-foreground" />}
                      <span>
                        <span className="font-medium">{p.user.name}</span>
                        <span className="block text-xs text-muted-foreground">{p.user.department || "No department"}</span>
                      </span>
                    </span>
                  </td>
                  <td className={num}>
                    {p.tasks}
                    {p.noEstimate > 0 && <span className="block text-xs text-muted-foreground">{p.noEstimate} no estimate</span>}
                  </td>
                  <td className={num}>{p.comparedTasks ? formatMinutes(p.estimatedMinutes) : "—"}</td>
                  <td className={num}>{p.comparedTasks ? formatMinutes(p.actualMinutes) : "—"}</td>
                  <td className={td}>{p.comparedTasks ? <EstimateBar estimate={p.estimatedMinutes} actual={p.actualMinutes} max={max} /> : <span className="text-xs text-muted-foreground">no estimates</span>}</td>
                  <td className={num}><DeviationPill value={p.deviationPct} redAt={redAt} /></td>
                  <td className={num}>
                    {p.comparedTasks ? (
                      <>
                        {p.overEstimate} <span className="text-xs text-muted-foreground">of {p.comparedTasks}</span>
                      </>
                    ) : "—"}
                  </td>
                  <td className={num}>
                    {formatMinutes(p.reworkMinutes)}{" "}
                    <span className="text-xs text-muted-foreground">{p.periodMinutes > 0 ? Math.round((p.reworkMinutes / p.periodMinutes) * 100) : 0}%</span>
                  </td>
                  <td className={num}>{p.avgIterations?.toFixed(1) ?? "—"}</td>
                  <td className={num}>
                    {p.onTimePct === null ? (
                      "—"
                    ) : (
                      <span
                        className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-semibold", p.onTimePct >= 85 ? "bg-good/10 text-good" : p.onTimePct >= 75 ? "bg-warn/10 text-warn" : "bg-critical/10 text-critical")}
                        title={`${p.completedWithDue} completed tasks with a due date`}
                      >
                        {p.onTimePct}%
                      </span>
                    )}
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={10} className="bg-muted/20 px-4 py-3">
                      <p className="mb-2 text-xs font-medium">
                        {p.user.name} — tasks with time in the period{p.tasks > p.taskRows.length ? ` (first ${p.taskRows.length} of ${p.tasks})` : ""}, their share of each estimate against their own time
                      </p>
                      <table className="w-full text-sm">
                        <thead>
                          <tr>
                            <th className={th}>Task</th>
                            <th className={th}>Brand</th>
                            <th className={cn(th, "text-right")}>Estimated</th>
                            <th className={cn(th, "text-right")}>Actual</th>
                            <th className={cn(th, "text-right")}>Deviation</th>
                            <th className={cn(th, "text-right")}>Iterations</th>
                            <th className={th}>Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {p.taskRows.map((t) => (
                            <tr key={t.id}>
                              <td className={td}>
                                <TaskLink id={t.id} code={t.code} title={t.title} />
                                {t.rework && <span className="ml-1.5 rounded bg-warn/10 px-1.5 py-0.5 text-[11px] font-medium text-warn">Rework</span>}
                              </td>
                              <td className={cn(td, "text-xs text-muted-foreground")}>{t.brand || "—"}</td>
                              <td className={num}>{t.estimate === null ? <span className="text-xs text-muted-foreground">no estimate</span> : formatMinutes(t.estimate)}</td>
                              <td className={num}>{formatMinutes(t.actual)}</td>
                              <td className={num}><DeviationPill value={t.deviationPct} redAt={redAt} /></td>
                              <td className={num}>{t.iterations}</td>
                              <td className={cn(td, "text-xs text-muted-foreground")}>{statusLabel(t.status)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TasksTable({ data }: { data: TimesheetPerformance }) {
  const redAt = data.settings.overEstimatePct;
  if (data.tasks.length === 0) return <EmptyState icon={LuGauge} title="No task time in this period" description="Nobody logged time on a task between these dates." className="py-10" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1000px] text-sm">
        <thead className="border-y bg-muted/40">
          <tr>
            <th className={th}>Task</th>
            <th className={th}>Done by</th>
            <th className={cn(th, "text-right")} title="The original task's estimate">Estimated</th>
            <th className={cn(th, "text-right")} title="All the time logged on the task and its reworks">Actual</th>
            <th className={cn(th, "text-right")}>Deviation</th>
            <th className={th}>Time per iteration</th>
            <th className={th}>Status</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {data.tasks.map((t) => (
            <tr key={t.id}>
              <td className={cn(td, "max-w-96")}>
                <TaskLink id={t.id} code={t.code} title={t.title} />
                {t.brand && <span className="block text-xs text-muted-foreground">{t.brand}</span>}
              </td>
              <td className={cn(td, "max-w-48 text-xs text-muted-foreground")}>{t.doers.join(", ") || "—"}</td>
              <td className={num}>{t.estimateMinutes === null ? <span className="text-xs text-muted-foreground">no estimate</span> : formatMinutes(t.estimateMinutes)}</td>
              <td className={num}>{formatMinutes(t.actualMinutes)}</td>
              <td className={num}><DeviationPill value={t.deviationPct} redAt={redAt} /></td>
              <td className={td}>
                <span className="flex flex-wrap gap-1">
                  {t.iterations.map((it, i) => (
                    <Link
                      key={it.id}
                      to={`/tasks?task=${it.id}`}
                      className={cn("rounded px-1.5 py-0.5 text-[11.5px] whitespace-nowrap tabular-nums hover:underline", i === 0 ? "bg-muted text-foreground/80" : "bg-warn/10 text-warn")}
                    >
                      {it.label} {formatMinutes(it.minutes)}
                    </Link>
                  ))}
                </span>
              </td>
              <td className={cn(td, "text-xs whitespace-nowrap text-muted-foreground")}>{statusLabel(t.status)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.taskCount > data.tasks.length && <p className="px-4 py-2 text-xs text-muted-foreground">Showing the first {data.tasks.length} of {data.taskCount} tasks, worst deviation first.</p>}
    </div>
  );
}

function BrandHoursTable({ data }: { data: TimesheetPerformance }) {
  if (data.brandHours.length === 0) return <EmptyState icon={LuGauge} title="No brand hours in this period" description="Nobody logged hours on a brand between these dates." className="py-10" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[800px] text-sm">
        <thead className="border-y bg-muted/40">
          <tr>
            <th className={th}>Person</th>
            <th className={cn(th, "text-right")}>Hours</th>
            <th className={th}>Brands (hours)</th>
            <th className={th} title="Brands allocated to them in the manpower plan with no hours logged in the period">Allocated brands with no hours</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {data.brandHours.map((row) => (
            <tr key={row.user._id} className="align-top">
              <td className={td}>
                <span className="font-medium">{row.user.name}</span>
                <span className="block text-xs text-muted-foreground">{row.user.department || "No department"}</span>
              </td>
              <td className={num}>{formatMinutes(row.minutes)}</td>
              <td className={td}>
                <span className="flex flex-wrap gap-1">
                  {row.brands.map((b) => (
                    <span key={b.name} className="rounded bg-muted px-1.5 py-0.5 text-[11.5px] whitespace-nowrap tabular-nums">
                      {b.name} {formatMinutes(b.minutes)}
                    </span>
                  ))}
                </span>
              </td>
              <td className={td}>
                {row.allocatedWithoutHours.length === 0 ? (
                  <span className="inline-flex rounded-full bg-good/10 px-2 py-0.5 text-xs font-semibold text-good">0</span>
                ) : (
                  <span className="flex flex-wrap items-center gap-1">
                    <span className="inline-flex rounded-full bg-warn/10 px-2 py-0.5 text-xs font-semibold text-warn">{row.allocatedWithoutHours.length}</span>
                    <span className="text-xs text-muted-foreground">{row.allocatedWithoutHours.join(", ")}</span>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The two thresholds (leadership sets them for everyone). */
function Thresholds({ settings }: { settings: Settings }) {
  const [open, setOpen] = useState(false);
  const [pct, setPct] = useState(String(settings.overEstimatePct));
  const [iterations, setIterations] = useState(String(settings.iterationFlag));
  const update = useUpdatePerformanceSettings();
  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          setPct(String(settings.overEstimatePct));
          setIterations(String(settings.iterationFlag));
          setOpen(true);
        }}
      >
        <LuSettings2 aria-hidden />
        Thresholds: over {settings.overEstimatePct}% · {settings.iterationFlag}+ iterations
      </Button>
    );
  }
  const pctNumber = Number(pct);
  const iterationsNumber = Number(iterations);
  const valid = Number.isInteger(pctNumber) && pctNumber >= 1 && pctNumber <= 500 && Number.isInteger(iterationsNumber) && iterationsNumber >= 2 && iterationsNumber <= 10;
  return (
    <form
      className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) update.mutate({ overEstimatePct: pctNumber, iterationFlag: iterationsNumber }, { onSuccess: () => setOpen(false) });
      }}
    >
      <label className="flex items-center gap-1.5">
        Red when over estimate by more than
        <Input type="number" min={1} max={500} value={pct} onChange={(e) => setPct(e.target.value)} className="h-7 w-16" aria-label="Over-estimate threshold (%)" />%
      </label>
      <label className="flex items-center gap-1.5">
        Flag a task on iteration
        <Input type="number" min={2} max={10} value={iterations} onChange={(e) => setIterations(e.target.value)} className="h-7 w-14" aria-label="Iteration threshold" />
        or later
      </label>
      <Button type="submit" size="sm" disabled={!valid || update.isPending}>
        Save
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  );
}

function Flags({ data }: { data: TimesheetPerformance }) {
  const { flags, settings } = data;
  const box = "rounded-lg border p-3";
  return (
    <div className="grid gap-3 p-4 pt-0 md:grid-cols-3">
      <div className={box}>
        <p className={cn("text-sm font-semibold", flags.overEstimate.count > 0 ? "text-critical" : "text-good")}>
          {flags.overEstimate.count} task{flags.overEstimate.count === 1 ? "" : "s"} more than {settings.overEstimatePct}% over estimate
        </p>
        <ul className="mt-1.5 space-y-1 text-sm">
          {flags.overEstimate.top.map((t) => (
            <li key={t.id}>
              <TaskLink id={t.id} code={t.code} title={t.title} />
              <span className="block text-xs text-muted-foreground">
                {t.brand ? `${t.brand} · ` : ""}est {formatMinutes(t.estimateMinutes)}, actual {formatMinutes(t.actualMinutes)}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className={box}>
        <p className={cn("text-sm font-semibold", flags.noEstimate.count > 0 ? "text-warn" : "text-good")}>
          {flags.noEstimate.count} task{flags.noEstimate.count === 1 ? "" : "s"} with time but no estimate
        </p>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {flags.noEstimate.count > 0 ? `${formatMinutes(flags.noEstimate.minutes)} logged on them can't be compared.` : "Every task with time has an estimate."}
        </p>
        {flags.noEstimate.people.length > 0 && <p className="mt-1 text-sm">Most: {flags.noEstimate.people.map((p) => `${p.name} (${p.tasks})`).join(", ")}</p>}
      </div>
      <div className={box}>
        <p className={cn("text-sm font-semibold", flags.iterations.count > 0 ? "text-warn" : "text-good")}>
          {flags.iterations.count} task{flags.iterations.count === 1 ? "" : "s"} on iteration {settings.iterationFlag} or later
        </p>
        <ul className="mt-1.5 space-y-1 text-sm">
          {flags.iterations.top.map((t) => (
            <li key={t.id}>
              <TaskLink id={t.id} code={t.code} title={t.title} />
              <span className="block text-xs text-muted-foreground">
                {t.brand ? `${t.brand} · ` : ""}
                {t.iterations} iterations, {formatMinutes(t.reworkMinutes)} rework
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function TimesheetPerformancePage() {
  const initial: TimesheetPerformanceParams = useMemo(() => ({ from: monthStartKey(), to: todayKey(), department: "", brand: "" }), []);
  const [filters, setFilters] = useState<TimesheetPerformanceParams>(initial);
  const [view, setView] = useState<View>("people");
  const report = useTimesheetPerformance(filters);
  const brands = useBrands();
  const brandOptions = useMemo(
    () => (brands.data ?? []).map((b) => ({ value: b._id, label: brandWithOrg(b) })).sort((a, b) => a.label.localeCompare(b.label)),
    [brands.data],
  );
  const presets = useMemo(() => {
    const today = todayKey();
    return [
      { label: "This week", from: mondayOf(), to: today },
      { label: "This month", from: monthStartKey(), to: today },
      { label: "Last 30 days", from: addDaysKey(today, -29), to: today },
    ];
  }, []);
  const data = report.data;
  const t = data?.totals;

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-4 px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Timesheet performance"
        description="Estimated time against the time actually logged, by person and by task, with the time each rework took. Updated as time is logged."
        actions={<TimeNav current="/timesheet/performance" />}
      />

      <ReportFilterBar onReset={() => setFilters(initial)} canReset={JSON.stringify(filters) !== JSON.stringify(initial)}>
        <DateRangeInputs idPrefix="performance" from={filters.from} to={filters.to} onChange={(range) => setFilters((f) => ({ ...f, ...range }))} />
        <RangePresets presets={presets} from={filters.from} to={filters.to} onSelect={(range) => setFilters((f) => ({ ...f, ...range }))} />
        <DepartmentFilter value={filters.department} onChange={(department) => setFilters((f) => ({ ...f, department }))} />
        <FilterSelect label="Brand" value={filters.brand} onChange={(brand) => setFilters((f) => ({ ...f, brand }))} options={brandOptions} anyLabel="All brands" className="max-w-56" searchable searchPlaceholder="Search brands…" />
      </ReportFilterBar>

      {report.isError && !data ? (
        <QueryError title="Couldn't load the performance view" error={report.error} onRetry={() => void report.refetch()} />
      ) : !data || !t ? (
        <ReportSkeleton />
      ) : (
        <div className={cn("space-y-4 transition-opacity", report.isPlaceholderData && "opacity-60")}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Tile label="Estimated" value={formatMinutes(t.estimatedMinutes)} note={`on ${t.tasksWithEstimate} of ${t.tasks} tasks (the rest have no estimate)`} />
            <Tile label="Actual logged" value={formatMinutes(t.actualMinutes)} note="on the same tasks, all time logged so far" />
            <Tile
              label="Deviation"
              value={t.deviationPct === null ? "—" : signed(t.deviationPct)}
              note={t.deviationPct === null ? "no estimates to compare" : `${formatMinutes(Math.abs(t.actualMinutes - t.estimatedMinutes))} ${t.actualMinutes >= t.estimatedMinutes ? "over" : "under"} the estimates`}
              tone={t.deviationPct === null ? undefined : t.deviationPct > data.settings.overEstimatePct ? "bad" : t.deviationPct > 5 ? "warn" : "good"}
            />
            <Tile
              label="Rework time"
              value={formatMinutes(t.reworkMinutes)}
              note={`${t.periodMinutes > 0 ? Math.round((t.reworkMinutes / t.periodMinutes) * 100) : 0}% of task time in the period · ${t.reworkTasks} rework task${t.reworkTasks === 1 ? "" : "s"}`}
            />
            <Tile
              label="Tasks over estimate"
              value={String(t.tasksOverEstimate)}
              note={`${t.tasksWithEstimate > 0 ? Math.round((t.tasksOverEstimate / t.tasksWithEstimate) * 100) : 0}% of estimated tasks · ${t.tasksWayOver} by more than ${data.settings.overEstimatePct}%`}
              tone={t.tasksWayOver > 0 ? "bad" : undefined}
            />
          </div>

          <section className="overflow-hidden rounded-xl border bg-card">
            <div className="flex flex-wrap items-center gap-3 p-4">
              <span className="inline-flex overflow-hidden rounded-md border" role="group" aria-label="View">
                {(
                  [
                    ["people", "By person"],
                    ["tasks", "By task"],
                    ["brands", "Brand hours"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={view === value}
                    onClick={() => setView(value)}
                    className={cn("px-3 py-1 text-xs", view === value ? "bg-foreground text-background" : "bg-background hover:bg-muted")}
                  >
                    {label}
                  </button>
                ))}
              </span>
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                {view === "people"
                  ? "Tasks each person logged time on in the period. A task's estimate is shared by the people who logged on it, in proportion to their time. Deviation = (actual − estimated) ÷ estimated. Click a row for the tasks."
                  : view === "tasks"
                    ? "Each task with its reworks as one row: the original estimate against all the time spent, worst deviation first."
                    : "Program, community and brand leads log hours per brand, not per task, so there is no estimate to compare."}
              </p>
              <Thresholds settings={data.settings} />
            </div>
            {view === "people" ? <PeopleTable data={data} /> : view === "tasks" ? <TasksTable data={data} /> : <BrandHoursTable data={data} />}
          </section>

          <section className="rounded-xl border bg-card">
            <h2 className="p-4 pb-3 text-sm font-semibold">Needs attention</h2>
            <Flags data={data} />
          </section>
        </div>
      )}
    </div>
  );
}
