import { useMemo, useState } from "react";
import {
  LuBriefcase,
  LuCalendarDays,
  LuClock,
  LuHourglass,
  LuListChecks,
  LuNetwork,
  LuUser,
  LuWallet,
} from "react-icons/lu";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import type { IconType } from "react-icons";

import { FilterSelect } from "@/components/globals/filter-select";
import {
  EmptyState,
  PageHeader,
  QueryError,
  StatCard,
} from "@/components/globals/query-states";
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
  ExcelExportButton,
  ReportSkeleton,
  shortLabel,
} from "@/components/reports/report-shared";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  TimeBreakdownChart,
  TimeBreakdownTable,
} from "@/components/reports/time-breakdown";
import {
  useTimeBreakdown,
  useTimeReport,
  type TimeReportParams,
} from "@/hooks/use-work-reports";
import { todayKey } from "@/lib/tasks";
import {
  TIMELOG_STATUS_META,
  addDaysKey,
  formatDayLabel,
  formatMinutes,
  formatMoney,
  monthStartKey,
} from "@/lib/time";
import { cn } from "@/lib/utils";
import type {
  Role,
  TimeLogStatus,
  TimeReportGroupBy,
  TimeReportRow,
} from "@/types";

const GROUPS: {
  value: TimeReportGroupBy;
  label: string;
  icon: IconType;
  column: string;
}[] = [
  { value: "user", label: "Employee", icon: LuUser, column: "Employee" },
  { value: "project", label: "Project", icon: LuBriefcase, column: "Project" },
  { value: "task", label: "Task", icon: LuListChecks, column: "Task" },
  { value: "day", label: "Day", icon: LuCalendarDays, column: "Date" },
  {
    value: "breakdown",
    label: "Breakdown",
    icon: LuNetwork,
    column: "Employee",
  },
];

const STATUSES: TimeLogStatus[] = ["pending", "approved", "rejected"];

function defaultFilters(): TimeReportParams {
  return {
    groupBy: "user",
    from: monthStartKey(),
    to: todayKey(),
    user: "",
    project: "",
    department: "",
    status: "",
  };
}

const MAX_CHART_ROWS = 20;

/** Head/admin time-log analytics grouped by employee, project, task or day. */
export function TimeReport({ role }: { role: Role }) {
  const initial = useMemo(defaultFilters, []);
  const [filters, setFilters] = useState<TimeReportParams>(initial);
  const isBreakdown = filters.groupBy === "breakdown";
  // The summary (grouped by employee in breakdown mode) drives the stat cards.
  const report = useTimeReport(
    isBreakdown ? { ...filters, groupBy: "user" } : filters,
  );
  const isAdmin = role === "admin";

  const set = (patch: Partial<TimeReportParams>) =>
    setFilters((prev) => ({ ...prev, ...patch }));
  const { groupBy: _groupBy, ...filterPart } = filters;
  const { groupBy: _initialGroup, ...initialPart } = initial;
  const breakdown = useTimeBreakdown(filterPart, isBreakdown);
  const dirty = JSON.stringify(filterPart) !== JSON.stringify(initialPart);

  const presets = useMemo(() => {
    const today = todayKey();
    return [
      { label: "This month", from: monthStartKey(), to: today },
      { label: "Last 7 days", from: addDaysKey(today, -6), to: today },
      { label: "Last 30 days", from: addDaysKey(today, -29), to: today },
    ];
  }, []);

  const group =
    GROUPS.find((item) => item.value === filters.groupBy) ?? GROUPS[0];

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Time log report"
        description={
          isAdmin
            ? "Hours and earnings logged across the organisation."
            : "Hours and earnings logged in your department."
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <ExcelExportButton
              params={filters}
              filenamePrefix="time-report"
              disabled={!report.data || report.data.totals.count === 0}
            />
            <CsvExportButton
              path="/reports/time/export"
              params={filters}
              label="Export all logs"
              filenamePrefix="time-logs"
              disabled={!report.data || report.data.totals.count === 0}
            />
          </div>
        }
      />

      <ReportFilterBar
        onReset={() =>
          setFilters((prev) => ({ ...defaultFilters(), groupBy: prev.groupBy }))
        }
        canReset={dirty}
      >
        <DateRangeInputs
          idPrefix="time-report"
          label="Logged between"
          from={filters.from}
          to={filters.to}
          onChange={set}
        />
        <RangePresets
          presets={presets}
          from={filters.from}
          to={filters.to}
          onSelect={set}
        />
        <ProjectFilter
          value={filters.project}
          onChange={(project) => set({ project })}
        />
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
          label="Status"
          value={filters.status}
          onChange={(status) => set({ status: status as TimeLogStatus | "" })}
          options={STATUSES.map((status) => ({
            value: status,
            label: TIMELOG_STATUS_META[status].label,
          }))}
          anyLabel="Pending + approved"
        />
      </ReportFilterBar>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            id="group-by-label"
            className="text-sm font-medium text-muted-foreground"
          >
            Group by
          </span>
          <ToggleGroup
            aria-labelledby="group-by-label"
            variant="outline"
            size="sm"
            spacing={0}
            value={[filters.groupBy]}
            onValueChange={(values) => {
              const next = values[0] as TimeReportGroupBy | undefined;
              if (next) set({ groupBy: next });
            }}
          >
            {GROUPS.map(({ value, label, icon: Icon }) => (
              <ToggleGroupItem
                key={value}
                value={value}
                aria-label={`Group by ${label}`}
              >
                <Icon aria-hidden />
                {label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>

      {report.isPending ? (
        <ReportSkeleton kpis={3} charts={1} />
      ) : report.isError ? (
        <QueryError
          title="Couldn't load the time report"
          error={report.error}
          onRetry={() => void report.refetch()}
          retrying={report.isFetching}
        />
      ) : report.data.rows.length === 0 ? (
        <EmptyState
          icon={LuHourglass}
          title="No time logged"
          description="No time logs match these filters. Try a wider date range or another status."
        />
      ) : (
        <div
          className={cn(
            "space-y-6 transition-opacity duration-200",
            report.isFetching && "opacity-70",
          )}
          aria-busy={report.isFetching}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard
              label="Total time"
              value={formatMinutes(report.data.totals.minutes)}
              hint={`${report.data.totals.hours} hours`}
              icon={LuClock}
              tone="primary"
            />
            <StatCard
              label="Earnings"
              value={formatMoney(report.data.totals.earnings)}
              icon={LuWallet}
            />
            <StatCard
              label="Time logs"
              value={report.data.totals.count}
              hint={`${report.data.rows.length} employee${report.data.rows.length === 1 ? "" : "s"}${
                isBreakdown
                  ? ""
                  : group.value === "user"
                    ? ""
                    : ` · by ${group.label.toLowerCase()}`
              }`}
              icon={LuListChecks}
            />
          </div>

          {isBreakdown ? (
            breakdown.data ? (
              <>
                <TimeBreakdownChart employees={breakdown.data.employees} />
                <TimeBreakdownTable data={breakdown.data} />
              </>
            ) : breakdown.isError ? (
              <QueryError
                title="Couldn't load the breakdown"
                error={breakdown.error}
                onRetry={() => void breakdown.refetch()}
                retrying={breakdown.isFetching}
              />
            ) : (
              <ReportSkeleton kpis={0} charts={1} />
            )
          ) : (
            <>
              <HoursChart
                rows={report.data.rows}
                groupBy={report.data.groupBy as TimeReportGroupBy}
              />
              <TimeTable
                rows={report.data.rows}
                totals={report.data.totals}
                column={
                  (
                    GROUPS.find((item) => item.value === report.data.groupBy) ??
                    group
                  ).column
                }
                groupBy={report.data.groupBy as TimeReportGroupBy}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

const hoursConfig = {
  hours: { label: "Hours", color: "var(--chart-1)" },
} satisfies ChartConfig;

function dayLabel(key: string | null, fallback: string) {
  if (!key || !/^\d{4}-\d{2}-\d{2}/.test(key)) return fallback;
  return formatDayLabel(key).day;
}

function HoursChart({
  rows,
  groupBy,
}: {
  rows: TimeReportRow[];
  groupBy: TimeReportGroupBy;
}) {
  const isDay = groupBy === "day";
  const shown = isDay ? rows : rows.slice(0, MAX_CHART_ROWS);
  const data = shown.map((row) => ({
    name: isDay ? dayLabel(row.key ?? row.label, row.label) : row.label,
    hours: Number(row.hours.toFixed(2)),
  }));
  const horizontal = !isDay && data.length > 8;

  return (
    <ChartCard
      title="Hours"
      description={
        isDay
          ? "Hours logged per day"
          : rows.length > MAX_CHART_ROWS
            ? `Top ${MAX_CHART_ROWS} of ${rows.length} by hours`
            : "Hours logged per row"
      }
      isEmpty={data.every((row) => row.hours === 0)}
    >
      {horizontal ? (
        <ChartContainer
          config={hoursConfig}
          className="aspect-auto w-full"
          style={{ height: Math.max(240, data.length * 28 + 40) }}
        >
          <BarChart
            data={data}
            layout="vertical"
            accessibilityLayer
            margin={{ left: 8 }}
          >
            <CartesianGrid horizontal={false} />
            <XAxis type="number" tickLine={false} axisLine={false} />
            <YAxis
              type="category"
              dataKey="name"
              tickLine={false}
              axisLine={false}
              width={130}
              tickFormatter={(value) => shortLabel(value, 18)}
            />
            <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
            <Bar
              dataKey="hours"
              fill="var(--color-hours)"
              radius={[0, 4, 4, 0]}
            />
          </BarChart>
        </ChartContainer>
      ) : (
        <ChartContainer
          config={hoursConfig}
          className="aspect-auto h-72 w-full"
        >
          <BarChart data={data} accessibilityLayer>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="name"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={8}
              tickFormatter={(value) => shortLabel(value, 12)}
            />
            <YAxis tickLine={false} axisLine={false} width={36} />
            <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
            <Bar
              dataKey="hours"
              fill="var(--color-hours)"
              radius={[4, 4, 0, 0]}
            />
          </BarChart>
        </ChartContainer>
      )}
    </ChartCard>
  );
}

function TimeTable({
  rows,
  totals,
  column,
  groupBy,
}: {
  rows: TimeReportRow[];
  totals: { minutes: number; hours: number; earnings: number; count: number };
  column: string;
  groupBy: TimeReportGroupBy;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Breakdown</CardTitle>
        <CardDescription>
          {groupBy === "day" ? "Chronological" : "Sorted by time logged"}. The
          “Export all logs” lists every individual log.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{column}</TableHead>
                <TableHead className="text-right">Hours</TableHead>
                <TableHead className="text-right">Earnings</TableHead>
                <TableHead className="text-right">Logs</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, index) => (
                <TableRow key={row.key ?? `none-${index}`}>
                  <TableCell className="max-w-96">
                    <p className="truncate font-medium text-foreground">
                      {groupBy === "day" && row.key
                        ? `${formatDayLabel(row.key).weekday}, ${formatDayLabel(row.key).day}`
                        : row.label}
                    </p>
                    {row.sublabel && (
                      <p className="truncate text-xs text-muted-foreground">
                        {row.sublabel}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">
                    {formatMinutes(row.minutes)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(row.earnings)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.count}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="font-semibold">Total</TableCell>
                <TableCell className="text-right font-semibold whitespace-nowrap tabular-nums">
                  {formatMinutes(totals.minutes)}
                </TableCell>
                <TableCell className="text-right font-semibold tabular-nums">
                  {formatMoney(totals.earnings)}
                </TableCell>
                <TableCell className="text-right font-semibold tabular-nums">
                  {totals.count}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
