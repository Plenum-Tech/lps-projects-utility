import { useMemo, useState } from "react";
import { Link } from "react-router";
import {
  LuCircleCheck,
  LuCircleDot,
  LuClipboardList,
  LuClock,
  LuPercent,
  LuTimer,
  LuTriangleAlert,
} from "react-icons/lu";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { EmptyState, PageHeader, QueryError, StatCard } from "@/components/globals/query-states";
import { FilterSelect } from "@/components/globals/filter-select";
import { ShortCode } from "@/components/projects/project-badges";
import {
  DateRangeInputs,
  DepartmentFilter,
  EmployeeFilter,
  ProjectFilter,
  RangePresets,
  ReportFilterBar,
} from "@/components/reports/report-filters";
import {
  ChartCard,
  CsvExportButton,
  ReportSkeleton,
  shortLabel,
} from "@/components/reports/report-shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTaskReport, type TaskReportParams } from "@/hooks/use-work-reports";
import { PRIORITIES, PRIORITY_META, STATUS_META, formatDateOnly, todayKey } from "@/lib/tasks";
import { addDaysKey, monthStartKey } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { Role, TaskPriority, TaskReportSummary, TaskStatus } from "@/types";

const STATUS_COLORS: Record<TaskStatus, string> = {
  todo: "var(--chart-3)",
  in_progress: "var(--chart-2)",
  in_review: "var(--chart-4)",
  completed: "var(--primary)",
  rejected: "var(--destructive)",
};

const PRIORITY_COLORS: Record<TaskPriority, string> = {
  low: "var(--chart-3)",
  medium: "var(--chart-2)",
  high: "var(--chart-4)",
  urgent: "var(--destructive)",
};

const EMPTY_FILTERS: TaskReportParams = {
  from: "",
  to: "",
  project: "",
  user: "",
  department: "",
  priority: "",
};

/** Head/admin task analytics: KPIs, charts, overdue list, per-employee table. */
export function TaskReport({ role }: { role: Role }) {
  const [filters, setFilters] = useState<TaskReportParams>(EMPTY_FILTERS);
  const report = useTaskReport(filters);
  const isAdmin = role === "admin";

  const presets = useMemo(() => {
    const today = todayKey();
    return [
      { label: "This month", from: monthStartKey(), to: today },
      { label: "Last 30 days", from: addDaysKey(today, -29), to: today },
      { label: "All time", from: "", to: "" },
    ];
  }, []);

  const set = (patch: Partial<TaskReportParams>) => setFilters((prev) => ({ ...prev, ...patch }));
  const dirty = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS);

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Task report"
        description={
          isAdmin
            ? "Task throughput, completion and overdue work across the organisation."
            : "Task throughput, completion and overdue work in your department."
        }
        actions={
          <CsvExportButton
            path="/reports/tasks/export"
            params={filters}
            filenamePrefix="task-report"
            disabled={!report.data || report.data.totals.total === 0}
          />
        }
      />

      <ReportFilterBar onReset={() => setFilters(EMPTY_FILTERS)} canReset={dirty}>
        <DateRangeInputs
          idPrefix="task-report"
          label="Task created between"
          from={filters.from}
          to={filters.to}
          onChange={set}
        />
        <RangePresets presets={presets} from={filters.from} to={filters.to} onSelect={set} />
        <ProjectFilter value={filters.project} onChange={(project) => set({ project })} />
        {isAdmin && (
          <DepartmentFilter
            value={filters.department}
            onChange={(department) => set({ department, user: "" })}
          />
        )}
        <EmployeeFilter
          value={filters.user}
          department={filters.department}
          onChange={(user) => set({ user })}
        />
        <FilterSelect
          label="Priority"
          value={filters.priority}
          onChange={(priority) => set({ priority: priority as TaskPriority | "" })}
          options={PRIORITIES.map((priority) => ({
            value: priority,
            label: PRIORITY_META[priority].label,
          }))}
          anyLabel="All priorities"
        />
      </ReportFilterBar>

      {report.isPending ? (
        <ReportSkeleton kpis={6} charts={4} />
      ) : report.isError ? (
        <QueryError
          title="Couldn't load the task report"
          error={report.error}
          onRetry={() => void report.refetch()}
          retrying={report.isFetching}
        />
      ) : report.data.totals.total === 0 ? (
        <EmptyState
          icon={LuClipboardList}
          title="No tasks match these filters"
          description="Widen the date range or clear a filter to see results."
        />
      ) : (
        <div
          className={cn("space-y-6 transition-opacity duration-200", report.isFetching && "opacity-70")}
          aria-busy={report.isFetching}
        >
          <TaskKpis totals={report.data.totals} />
          <div className="grid gap-6 lg:grid-cols-2">
            <StatusChart data={report.data.byStatus} />
            <PriorityChart data={report.data.byPriority} />
            <EmployeeChart data={report.data.byEmployee} />
            <ProjectChart data={report.data.byProject} />
          </div>
          <OverdueTable rows={report.data.overdue} />
          <EmployeeTable rows={report.data.byEmployee} />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function TaskKpis({ totals }: { totals: TaskReportSummary["totals"] }) {
  const finished = totals.onTime + totals.late;
  const onTimeRate = finished > 0 ? Math.round((totals.onTime / finished) * 100) : null;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <StatCard label="Total" value={totals.total} icon={LuClipboardList} />
      <StatCard label="Completed" value={totals.completed} icon={LuCircleCheck} tone="primary" />
      <StatCard label="Open" value={totals.open} icon={LuCircleDot} />
      <StatCard
        label="Overdue"
        value={totals.overdue}
        icon={LuTriangleAlert}
        tone={totals.overdue > 0 ? "destructive" : "default"}
      />
      <StatCard
        label="Completion rate"
        value={`${totals.completionRate}%`}
        icon={LuPercent}
        tone="primary"
      />
      <StatCard
        label="On time vs late"
        value={
          <span>
            {totals.onTime}
            <span className="text-base text-muted-foreground"> / {totals.late}</span>
          </span>
        }
        hint={onTimeRate === null ? "No completed tasks with a due date" : `${onTimeRate}% on time`}
        icon={totals.late > totals.onTime ? LuClock : LuTimer}
        tone={totals.late > totals.onTime ? "warning" : "default"}
      />
    </div>
  );
}

const countConfig = { count: { label: "Tasks", color: "var(--primary)" } } satisfies ChartConfig;

function StatusChart({ data }: { data: TaskReportSummary["byStatus"] }) {
  const rows = data.map((row) => ({
    name: STATUS_META[row.status]?.label ?? row.status,
    count: row.count,
    fill: STATUS_COLORS[row.status] ?? "var(--chart-1)",
  }));
  return (
    <ChartCard title="Tasks by status" isEmpty={rows.every((row) => row.count === 0)}>
      <ChartContainer config={countConfig} className="aspect-auto h-64 w-full">
        <BarChart data={rows} accessibilityLayer>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="name" tickLine={false} axisLine={false} tickMargin={8} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
          <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel={false} />} />
          <Bar dataKey="count" radius={[6, 6, 0, 0]} />
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}

function PriorityChart({ data }: { data: TaskReportSummary["byPriority"] }) {
  const order = new Map(PRIORITIES.map((priority, index) => [priority, index]));
  const rows = [...data]
    .sort((a, b) => (order.get(a.priority) ?? 0) - (order.get(b.priority) ?? 0))
    .map((row) => ({
      name: PRIORITY_META[row.priority]?.label ?? row.priority,
      count: row.count,
      fill: PRIORITY_COLORS[row.priority] ?? "var(--chart-1)",
    }));
  return (
    <ChartCard title="Tasks by priority" isEmpty={rows.every((row) => row.count === 0)}>
      <ChartContainer config={countConfig} className="aspect-auto h-64 w-full">
        <BarChart data={rows} accessibilityLayer>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="name" tickLine={false} axisLine={false} tickMargin={8} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
          <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
          <Bar dataKey="count" radius={[6, 6, 0, 0]} />
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}

const progressConfig = {
  completed: { label: "Completed", color: "var(--primary)" },
  open: { label: "Open (on track)", color: "var(--chart-2)" },
  overdue: { label: "Overdue", color: "var(--destructive)" },
} satisfies ChartConfig;

/** Stacked completed / open (on time) / overdue bars; horizontal when many rows. */
function StackedBreakdownChart({
  rows,
  maxRows = 15,
}: {
  rows: { name: string; completed: number; open: number; overdue: number }[];
  maxRows?: number;
}) {
  const shown = rows.slice(0, maxRows);
  const horizontal = shown.length > 6;
  if (horizontal) {
    return (
      <ChartContainer
        config={progressConfig}
        className="aspect-auto w-full"
        style={{ height: Math.max(220, shown.length * 30 + 60) }}
      >
        <BarChart data={shown} layout="vertical" accessibilityLayer margin={{ left: 8 }}>
          <CartesianGrid horizontal={false} />
          <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} />
          <YAxis
            type="category"
            dataKey="name"
            tickLine={false}
            axisLine={false}
            width={110}
            tickFormatter={(value) => shortLabel(value, 16)}
          />
          <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
          <ChartLegend content={<ChartLegendContent />} />
          <Bar dataKey="completed" stackId="a" fill="var(--color-completed)" />
          <Bar dataKey="open" stackId="a" fill="var(--color-open)" />
          <Bar dataKey="overdue" stackId="a" fill="var(--color-overdue)" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ChartContainer>
    );
  }
  return (
    <ChartContainer config={progressConfig} className="aspect-auto h-64 w-full">
      <BarChart data={shown} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="name"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickFormatter={(value) => shortLabel(value, 12)}
        />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="completed" stackId="a" fill="var(--color-completed)" />
        <Bar dataKey="open" stackId="a" fill="var(--color-open)" />
        <Bar dataKey="overdue" stackId="a" fill="var(--color-overdue)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ChartContainer>
  );
}

function breakdown(row: { total: number; completed: number; overdue: number }) {
  return {
    completed: row.completed,
    overdue: row.overdue,
    open: Math.max(0, row.total - row.completed - row.overdue),
  };
}

function EmployeeChart({ data }: { data: TaskReportSummary["byEmployee"] }) {
  const rows = [...data]
    .sort((a, b) => b.total - a.total)
    .map((row) => ({ name: row.name, ...breakdown(row) }));
  return (
    <ChartCard
      title="Tasks by employee"
      description={rows.length > 15 ? "Top 15 by task count" : "Completed, open and overdue"}
      isEmpty={rows.length === 0}
      emptyText="No assigned tasks in this range."
    >
      <StackedBreakdownChart rows={rows} />
    </ChartCard>
  );
}

function ProjectChart({ data }: { data: TaskReportSummary["byProject"] }) {
  const rows = [...data]
    .sort((a, b) => b.total - a.total)
    .map((row) => ({ name: row.code ?? row.name, ...breakdown(row) }));
  return (
    <ChartCard
      title="Tasks by project"
      description={rows.length > 15 ? "Top 15 by task count" : "Completed, open and overdue"}
      isEmpty={rows.length === 0}
    >
      <StackedBreakdownChart rows={rows} />
    </ChartCard>
  );
}

/* ------------------------------------------------------------------ */

function OverdueTable({ rows }: { rows: TaskReportSummary["overdue"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LuTriangleAlert aria-hidden className="size-4 text-destructive" />
          Overdue tasks
        </CardTitle>
        <CardDescription>
          {rows.length === 0
            ? "Nothing is overdue — nice."
            : `Most overdue first${rows.length >= 100 ? " (first 100)" : ""}.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            icon={LuCircleCheck}
            title="No overdue tasks"
            description="Every open task in this view is within its due date."
            className="py-8"
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Task</TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead>Assignees</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">Days overdue</TableHead>
                  <TableHead>Priority</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((task) => (
                  <TableRow key={task._id}>
                    <TableCell className="max-w-80">
                      <div className="flex items-center gap-2">
                        {task.shortCode && <ShortCode code={task.shortCode} />}
                        <Link
                          to={`/tasks?task=${task._id}`}
                          className="truncate font-medium text-foreground underline-offset-4 hover:underline focus-visible:underline"
                        >
                          {task.title}
                        </Link>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {task.project ? (
                        <Link
                          to={`/projects/${task.project._id}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {task.project.name}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="max-w-56 truncate text-muted-foreground">
                      {task.assignees.length
                        ? task.assignees.map((assignee) => assignee.name).join(", ")
                        : "Unassigned"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatDateOnly(task.dueDate, true)}
                    </TableCell>
                    <TableCell className="text-right font-medium text-destructive tabular-nums">
                      {task.daysOverdue}
                    </TableCell>
                    <TableCell>
                      <span className={cn("inline-flex items-center gap-1.5 text-xs", PRIORITY_META[task.priority].text)}>
                        <span aria-hidden className={cn("size-2 rounded-full", PRIORITY_META[task.priority].dot)} />
                        {PRIORITY_META[task.priority].label}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EmployeeTable({ rows }: { rows: TaskReportSummary["byEmployee"] }) {
  const sorted = [...rows].sort((a, b) => b.total - a.total);
  return (
    <Card>
      <CardHeader>
        <CardTitle>By employee</CardTitle>
        <CardDescription>Task load and delivery per assignee.</CardDescription>
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <EmptyState
            icon={LuClipboardList}
            title="No assigned tasks"
            description="None of the matching tasks have an assignee."
            className="py-8"
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Completed</TableHead>
                  <TableHead className="text-right">Overdue</TableHead>
                  <TableHead className="text-right">On time</TableHead>
                  <TableHead className="text-right">Late</TableHead>
                  <TableHead className="text-right">Completion</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((row) => {
                  const rate = row.total > 0 ? Math.round((row.completed / row.total) * 100) : 0;
                  return (
                    <TableRow key={row.userId}>
                      <TableCell>
                        <p className="font-medium text-foreground">{row.name}</p>
                        <p className="text-xs text-muted-foreground">{row.email}</p>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{row.total}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.completed}</TableCell>
                      <TableCell
                        className={cn(
                          "text-right tabular-nums",
                          row.overdue > 0 && "font-medium text-destructive"
                        )}
                      >
                        {row.overdue}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{row.onTime}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.late}</TableCell>
                      <TableCell className="text-right">
                        <Badge variant={rate >= 75 ? "secondary" : "outline"} className="tabular-nums">
                          {rate}%
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
