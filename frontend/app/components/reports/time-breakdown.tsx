import { Fragment, useMemo, useState } from "react";
import { LuChevronDown, LuChevronRight } from "react-icons/lu";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { ChartCard } from "@/components/reports/report-shared";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateOnly } from "@/lib/tasks";
import { formatMinutes } from "@/lib/time";
import type { TimeBreakdownEmployee, TimeBreakdownResponse } from "@/types";

const MAX_EMPLOYEES = 20;
const MAX_PROJECT_SERIES = 8;
const OTHER = "__other";

function shortLabel(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Hours per employee, stacked by project (top projects as series, the rest as "Other"). */
export function TimeBreakdownChart({
  employees,
}: {
  employees: TimeBreakdownEmployee[];
}) {
  const { data, config, series } = useMemo(() => {
    const projectMinutes = new Map<
      string,
      { label: string; minutes: number }
    >();
    for (const emp of employees) {
      for (const proj of emp.projects) {
        const key = proj.key ?? "none";
        const entry = projectMinutes.get(key) ?? {
          label: proj.label,
          minutes: 0,
        };
        entry.minutes += proj.minutes;
        projectMinutes.set(key, entry);
      }
    }
    const top = [...projectMinutes.entries()]
      .sort((a, b) => b[1].minutes - a[1].minutes)
      .slice(0, MAX_PROJECT_SERIES);
    const topKeys = new Set(top.map(([key]) => key));
    const series = top.map(([key]) => key);
    const hasOther = projectMinutes.size > top.length;
    if (hasOther) series.push(OTHER);

    const config: ChartConfig = {};
    top.forEach(([key, value], index) => {
      config[key] = {
        label: value.label,
        color: `var(--chart-${(index % 5) + 1})`,
      };
    });
    if (hasOther)
      config[OTHER] = {
        label: "Other projects",
        color: "var(--muted-foreground)",
      };

    const data = employees.slice(0, MAX_EMPLOYEES).map((emp) => {
      const row: Record<string, string | number> = { name: emp.label };
      for (const key of series) row[key] = 0;
      for (const proj of emp.projects) {
        const key = proj.key ?? "none";
        const bucket = topKeys.has(key) ? key : OTHER;
        row[bucket] = Number(
          ((row[bucket] as number) + proj.minutes / 60).toFixed(2),
        );
      }
      return row;
    });
    return { data, config, series };
  }, [employees]);

  return (
    <ChartCard
      title="Hours by employee and project"
      description={
        employees.length > MAX_EMPLOYEES
          ? `Top ${MAX_EMPLOYEES} of ${employees.length} employees · each colour is a project`
          : "Each colour is a project"
      }
      isEmpty={data.length === 0}
    >
      <ChartContainer
        config={config}
        className="aspect-auto w-full"
        style={{ height: Math.max(260, data.length * 30 + 70) }}
      >
        <BarChart
          data={data}
          layout="vertical"
          accessibilityLayer
          margin={{ left: 8 }}
        >
          <CartesianGrid horizontal={false} />
          <XAxis type="number" tickLine={false} axisLine={false} unit="h" />
          <YAxis
            type="category"
            dataKey="name"
            tickLine={false}
            axisLine={false}
            width={130}
            tickFormatter={(value) => shortLabel(String(value), 18)}
          />
          <ChartTooltip content={<ChartTooltipContent />} />
          <ChartLegend content={<ChartLegendContent />} />
          {series.map((key, index) => (
            <Bar
              key={key}
              dataKey={key}
              stackId="hours"
              fill={`var(--color-${key})`}
              radius={index === series.length - 1 ? [0, 4, 4, 0] : 0}
            />
          ))}
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}

function date(value: string | null): string {
  return value ? formatDateOnly(value, true) : "—";
}

/**
 * One row per employee × brand × project × task: Employee, Brand, Project, Task,
 * first and last day logged in the period, and the hours. Brand time (weekly
 * timesheet hours on a brand, no project or task) has its own rows.
 */
export function TimeBreakdownTable({ data }: { data: TimeBreakdownResponse }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const employeeKeys = data.employees.map((e) => e.key ?? "none");
  const allCollapsed =
    employeeKeys.length > 0 && employeeKeys.every((k) => collapsed.has(k));

  const toggle = (key: string) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsed(next);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Breakdown</CardTitle>
          <CardDescription>
            Hours per employee, brand, project and task — brand time included.
            Start and end are the first and last day logged in the period.
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            setCollapsed(allCollapsed ? new Set() : new Set(employeeKeys))
          }
        >
          {allCollapsed ? "Expand all" : "Collapse all"}
        </Button>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-lg border">
          <Table className="min-w-[1000px]">
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-44">Employee Name</TableHead>
                <TableHead className="min-w-40">Brand Name</TableHead>
                <TableHead className="min-w-56">Project Name</TableHead>
                <TableHead className="min-w-64">Task Name</TableHead>
                <TableHead>Start Date</TableHead>
                <TableHead>End Date</TableHead>
                <TableHead className="text-right">Total Hours</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.employees.map((emp) => {
                const eKey = emp.key ?? "none";
                const open = !collapsed.has(eKey);
                const rows = emp.projects.flatMap((proj) =>
                  proj.tasks.map((task, index) => ({ proj, task, index })),
                );
                return (
                  <Fragment key={eKey}>
                    <TableRow className="bg-muted/40">
                      <TableCell colSpan={6}>
                        <button
                          type="button"
                          className="flex items-center gap-2 font-semibold text-foreground"
                          onClick={() => toggle(eKey)}
                          aria-expanded={open}
                        >
                          {open ? (
                            <LuChevronDown aria-hidden className="size-4" />
                          ) : (
                            <LuChevronRight aria-hidden className="size-4" />
                          )}
                          {emp.label}
                          <span className="font-normal text-muted-foreground">
                            · {rows.length} row{rows.length === 1 ? "" : "s"}
                          </span>
                        </button>
                      </TableCell>
                      <TableCell className="text-right font-semibold whitespace-nowrap tabular-nums">
                        {formatMinutes(emp.minutes)}
                      </TableCell>
                    </TableRow>
                    {open &&
                      rows.map(({ proj, task, index }) => (
                        <TableRow
                          key={`${proj.key ?? "none"}:${task.key ?? `none-${index}`}`}
                          className="text-sm"
                        >
                          <TableCell className="pl-8 text-muted-foreground">
                            {emp.label}
                          </TableCell>
                          <TableCell
                            className="max-w-56 truncate"
                            title={proj.brand ?? undefined}
                          >
                            {proj.brand ?? "—"}
                          </TableCell>
                          <TableCell
                            className="max-w-72 truncate"
                            title={proj.brandTime ? undefined : proj.label}
                          >
                            {proj.brandTime ? (
                              <span className="text-muted-foreground">
                                — Brand time
                              </span>
                            ) : (
                              proj.label
                            )}
                          </TableCell>
                          <TableCell
                            className="max-w-80 truncate"
                            title={proj.brandTime ? undefined : task.label}
                          >
                            {proj.brandTime ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <>
                                {task.sublabel && (
                                  <span className="mr-1.5 text-xs text-muted-foreground">
                                    {task.sublabel}
                                  </span>
                                )}
                                {task.label}
                              </>
                            )}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {date(task.firstLog)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {date(task.lastLog)}
                          </TableCell>
                          <TableCell className="text-right whitespace-nowrap tabular-nums">
                            {formatMinutes(task.minutes)}
                          </TableCell>
                        </TableRow>
                      ))}
                  </Fragment>
                );
              })}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={6} className="font-semibold">
                  Total · {data.totals.employees} employee
                  {data.totals.employees === 1 ? "" : "s"} · {data.totals.count}{" "}
                  logs
                </TableCell>
                <TableCell className="text-right font-semibold whitespace-nowrap tabular-nums">
                  {formatMinutes(data.totals.minutes)}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
