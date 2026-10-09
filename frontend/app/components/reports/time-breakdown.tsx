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
import { STATUS_META, formatDateOnly } from "@/lib/tasks";
import { formatMinutes, formatMoney } from "@/lib/time";
import { cn } from "@/lib/utils";
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

function statusLabel(status: string | null): string {
  if (!status) return "—";
  return (
    (STATUS_META as Record<string, { label: string }>)[status]?.label ??
    status.replace(/_/g, " ")
  );
}

function date(value: string | null): string {
  return value ? formatDateOnly(value, true) : "—";
}

/** Employee › project › task rows with the task's details and the hours logged. */
export function TimeBreakdownTable({ data }: { data: TimeBreakdownResponse }) {
  const [collapsedEmployees, setCollapsedEmployees] = useState<Set<string>>(
    new Set(),
  );
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(
    new Set(),
  );
  const employeeKeys = data.employees.map((e) => e.key ?? "none");
  const allCollapsed =
    employeeKeys.length > 0 &&
    employeeKeys.every((k) => collapsedEmployees.has(k));

  const toggle = (
    set: Set<string>,
    key: string,
    update: (next: Set<string>) => void,
  ) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    update(next);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Employee › Project › Task</CardTitle>
          <CardDescription>
            Hours each employee logged on each task, with the task's dates and
            status. Sorted by hours.
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setCollapsedEmployees(
              allCollapsed ? new Set() : new Set(employeeKeys),
            );
            if (!allCollapsed) setCollapsedProjects(new Set());
          }}
        >
          {allCollapsed ? "Expand all" : "Collapse all"}
        </Button>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-lg border">
          <Table className="min-w-[1100px]">
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-64">Employee / Task</TableHead>
                <TableHead className="min-w-48">Project</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Start date</TableHead>
                <TableHead>Due date</TableHead>
                <TableHead>Completed on</TableHead>
                <TableHead className="text-right">Estimated</TableHead>
                <TableHead className="text-right">Hours logged</TableHead>
                <TableHead>Task status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.employees.map((emp) => {
                const eKey = emp.key ?? "none";
                const eOpen = !collapsedEmployees.has(eKey);
                return (
                  <Fragment key={eKey}>
                    <TableRow className="bg-muted/40">
                      <TableCell colSpan={7}>
                        <button
                          type="button"
                          className="flex items-center gap-2 font-semibold text-foreground"
                          onClick={() =>
                            toggle(
                              collapsedEmployees,
                              eKey,
                              setCollapsedEmployees,
                            )
                          }
                          aria-expanded={eOpen}
                        >
                          {eOpen ? (
                            <LuChevronDown aria-hidden className="size-4" />
                          ) : (
                            <LuChevronRight aria-hidden className="size-4" />
                          )}
                          {emp.label}
                          <span className="font-normal text-muted-foreground">
                            · {emp.projects.length} project
                            {emp.projects.length === 1 ? "" : "s"} · {emp.count}{" "}
                            log{emp.count === 1 ? "" : "s"}
                            {emp.earnings > 0 &&
                              ` · ${formatMoney(emp.earnings)}`}
                          </span>
                        </button>
                      </TableCell>
                      <TableCell className="text-right font-semibold whitespace-nowrap tabular-nums">
                        {formatMinutes(emp.minutes)}
                      </TableCell>
                      <TableCell />
                    </TableRow>
                    {eOpen &&
                      emp.projects.map((proj) => {
                        const pKey = `${eKey}:${proj.key ?? "none"}`;
                        const pOpen = !collapsedProjects.has(pKey);
                        return (
                          <Fragment key={pKey}>
                            <TableRow>
                              <TableCell colSpan={7} className="pl-8">
                                <button
                                  type="button"
                                  className="flex items-center gap-2 text-foreground"
                                  onClick={() =>
                                    toggle(
                                      collapsedProjects,
                                      pKey,
                                      setCollapsedProjects,
                                    )
                                  }
                                  aria-expanded={pOpen}
                                >
                                  {pOpen ? (
                                    <LuChevronDown
                                      aria-hidden
                                      className="size-3.5"
                                    />
                                  ) : (
                                    <LuChevronRight
                                      aria-hidden
                                      className="size-3.5"
                                    />
                                  )}
                                  <span className="font-medium">
                                    {proj.label}
                                  </span>
                                  {proj.sublabel && (
                                    <span className="text-xs text-muted-foreground">
                                      {proj.sublabel}
                                    </span>
                                  )}
                                  {proj.client && (
                                    <span className="text-xs text-muted-foreground">
                                      · {proj.client}
                                    </span>
                                  )}
                                  <span className="text-xs text-muted-foreground">
                                    · {proj.tasks.length} task
                                    {proj.tasks.length === 1 ? "" : "s"}
                                  </span>
                                </button>
                              </TableCell>
                              <TableCell className="text-right whitespace-nowrap tabular-nums">
                                {formatMinutes(proj.minutes)}
                              </TableCell>
                              <TableCell />
                            </TableRow>
                            {pOpen &&
                              proj.tasks.map((task, index) => (
                                <TableRow
                                  key={task.key ?? `none-${index}`}
                                  className="text-sm"
                                >
                                  <TableCell className="pl-14">
                                    <p
                                      className="max-w-80 truncate text-foreground"
                                      title={task.label}
                                    >
                                      {task.label}
                                    </p>
                                    {task.sublabel && (
                                      <p className="text-xs text-muted-foreground">
                                        {task.sublabel}
                                      </p>
                                    )}
                                  </TableCell>
                                  <TableCell
                                    className="max-w-56 truncate text-muted-foreground"
                                    title={proj.label}
                                  >
                                    {proj.label}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap text-muted-foreground">
                                    {task.client ?? "—"}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap">
                                    {date(task.startDate)}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap">
                                    {date(task.dueDate)}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap">
                                    {date(task.completedAt)}
                                  </TableCell>
                                  <TableCell className="text-right whitespace-nowrap tabular-nums">
                                    {task.estimateMinutes
                                      ? formatMinutes(task.estimateMinutes)
                                      : "—"}
                                  </TableCell>
                                  <TableCell
                                    className={cn(
                                      "text-right whitespace-nowrap tabular-nums",
                                      task.estimateMinutes &&
                                        task.minutes > task.estimateMinutes &&
                                        "text-destructive",
                                    )}
                                    title={
                                      task.estimateMinutes &&
                                      task.minutes > task.estimateMinutes
                                        ? "Over the estimate"
                                        : undefined
                                    }
                                  >
                                    {formatMinutes(task.minutes)}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap">
                                    {statusLabel(task.status)}
                                  </TableCell>
                                </TableRow>
                              ))}
                          </Fragment>
                        );
                      })}
                  </Fragment>
                );
              })}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={7} className="font-semibold">
                  Total · {data.totals.employees} employee
                  {data.totals.employees === 1 ? "" : "s"} · {data.totals.count}{" "}
                  logs
                  {data.totals.earnings > 0 &&
                    ` · ${formatMoney(data.totals.earnings)}`}
                </TableCell>
                <TableCell className="text-right font-semibold whitespace-nowrap tabular-nums">
                  {formatMinutes(data.totals.minutes)}
                </TableCell>
                <TableCell />
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
