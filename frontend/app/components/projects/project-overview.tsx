import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  LuCircleAlert,
  LuClipboardList,
  LuClock,
  LuFlag,
  LuHourglass,
  LuUsers,
  LuWallet,
} from "react-icons/lu";

import { StatCard } from "@/components/globals/query-states";
import { ProgressBar } from "@/components/projects/project-badges";
import { Badge } from "@/components/ui/badge";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { PROGRESS_MODE_META } from "@/lib/projects";
import { STATUS_META, TASK_STATUSES, formatDateOnly } from "@/lib/tasks";
import { formatMinutes, formatMoney } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { ProjectDetailResponse } from "@/types";

const chartConfig = {
  count: { label: "Tasks" },
  todo: { label: STATUS_META.todo.label, color: "var(--chart-5)" },
  in_progress: { label: STATUS_META.in_progress.label, color: "var(--chart-2)" },
  in_review: { label: STATUS_META.in_review.label, color: "var(--chart-4)" },
  completed: { label: STATUS_META.completed.label, color: "var(--chart-1)" },
  rejected: { label: STATUS_META.rejected.label, color: "var(--destructive)" },
} satisfies ChartConfig;

function Panel({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-xl border bg-card p-4 text-card-foreground sm:p-5", className)}>
      <h2 className="font-heading text-base font-semibold">{title}</h2>
      {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  );
}

/** Overview tab: KPIs, hours, task chart, milestones and details. */
export function ProjectOverview({ detail }: { detail: ProjectDetailResponse }) {
  const { project, permissions, stats } = detail;
  const counts = stats.taskCounts;

  const allocated = stats.allocatedMinutes;
  const hoursPercent = allocated ? (stats.loggedMinutes / allocated) * 100 : 0;
  const hoursTone = hoursPercent >= 100 ? "destructive" : hoursPercent >= 90 ? "warning" : "default";

  const chartData = TASK_STATUSES.map((status) => ({
    status,
    label: STATUS_META[status].label,
    count: counts[status] ?? 0,
    fill: `var(--color-${status})`,
  }));

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Tasks"
          value={counts.total}
          hint={`${counts.open} open · ${counts.completed} completed`}
          icon={LuClipboardList}
          tone="primary"
        />
        <StatCard
          label="Overdue tasks"
          value={stats.overdueTasks}
          hint={stats.overdueTasks > 0 ? "Past their due date" : "Nothing overdue"}
          icon={LuCircleAlert}
          tone={stats.overdueTasks > 0 ? "destructive" : "default"}
        />
        <StatCard
          label="Time approved"
          value={formatMinutes(stats.approvedMinutes)}
          hint={`${formatMinutes(stats.pendingMinutes)} pending approval`}
          icon={LuClock}
        />
        {permissions.canViewRates ? (
          <StatCard
            label="Earnings"
            value={formatMoney(stats.earnings)}
            hint={
              project.budget !== null && project.budget !== undefined
                ? `Budget ${formatMoney(project.budget)}`
                : "No budget set"
            }
            icon={LuWallet}
            tone={
              project.budget && stats.earnings !== null && stats.earnings > project.budget
                ? "destructive"
                : "default"
            }
          />
        ) : (
          <StatCard
            label="Members"
            value={stats.memberCount}
            hint={project.manager ? `Managed by ${project.manager.name}` : "No manager"}
            icon={LuUsers}
          />
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Panel
          title="Hours"
          description="Logged time (approved + pending) against the allocation."
          className="lg:col-span-1"
        >
          <div className="space-y-3">
            <div className="flex items-baseline justify-between gap-2">
              <p className="font-heading text-2xl font-semibold tabular-nums">
                {formatMinutes(stats.loggedMinutes)}
              </p>
              <p className="text-sm text-muted-foreground">
                {allocated ? `of ${formatMinutes(allocated)}` : "No limit"}
              </p>
            </div>
            {allocated ? (
              <>
                <ProgressBar value={hoursPercent} tone={hoursTone} className="h-2" />
                <p
                  className={cn(
                    "text-xs",
                    hoursTone === "destructive" ? "text-destructive" : "text-muted-foreground"
                  )}
                >
                  {Math.round(hoursPercent)}% used
                  {hoursTone === "destructive"
                    ? " — the allocation is exhausted"
                    : hoursTone === "warning"
                      ? " — close to the limit"
                      : ""}
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                Set allocated hours to track usage against a limit.
              </p>
            )}
            {permissions.canViewRates && (
              <div className="flex items-center justify-between border-t pt-3 text-sm">
                <span className="text-muted-foreground">Members</span>
                <span className="font-medium tabular-nums">{stats.memberCount}</span>
              </div>
            )}
          </div>
        </Panel>

        <Panel title="Tasks by status" className="lg:col-span-2">
          {counts.total === 0 ? (
            <p className="flex h-48 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
              No tasks yet — the chart fills in as work is added.
            </p>
          ) : (
            <ChartContainer config={chartConfig} className="aspect-auto h-56 w-full">
              <BarChart data={chartData} margin={{ left: -16, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={40} />
                <ChartTooltip
                  cursor={false}
                  content={<ChartTooltipContent hideLabel nameKey="status" />}
                />
                <Bar dataKey="count" radius={6} />
              </BarChart>
            </ChartContainer>
          )}
        </Panel>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel
          title="Milestones"
          description={
            stats.milestones.total > 0
              ? `${stats.milestones.completed} of ${stats.milestones.total} completed`
              : undefined
          }
        >
          {stats.milestones.items.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LuFlag aria-hidden className="size-4" />
              No milestones yet.
            </p>
          ) : (
            <ul className="space-y-3">
              {stats.milestones.items.map((milestone) => (
                <li key={milestone._id} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate font-medium">{milestone.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {milestone.status === "complete" ? (
                        <Badge variant="secondary">Complete</Badge>
                      ) : (
                        <>
                          {milestone.completedTaskCount}/{milestone.taskCount} tasks
                          {milestone.endDate && ` · ${formatDateOnly(milestone.endDate)}`}
                        </>
                      )}
                    </span>
                  </div>
                  <ProgressBar value={milestone.progress} />
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Details">
          {project.summary ? (
            <p className="mb-4 text-sm whitespace-pre-wrap text-foreground">{project.summary}</p>
          ) : (
            <p className="mb-4 text-sm text-muted-foreground">No summary.</p>
          )}
          {(project.scopeItems?.length ?? 0) > 0 && (
            <div className="mb-4 rounded-lg border">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="px-3 py-1.5 text-left font-medium">Scope</th>
                    <th className="px-3 py-1.5 text-right font-medium">Qty × Lang × Sizes</th>
                    <th className="px-3 py-1.5 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {project.scopeItems!.map((row, index) => (
                    <tr key={index} className="border-b last:border-0">
                      <td className="px-3 py-1.5">{row.unit}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                        {row.quantity} × {row.languageList?.length ? `${row.languages} (${row.languageList.join(", ")})` : row.languages} × {row.sizes}
                      </td>
                      <td className="px-3 py-1.5 text-right font-medium tabular-nums">{row.quantity * row.languages * row.sizes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Fact label="Start date">{formatDateOnly(project.startDate, true)}</Fact>
            <Fact label="Deadline">
              <span className={cn(project.isOverdue && "font-medium text-destructive")}>
                {project.deadline ? formatDateOnly(project.deadline, true) : "None"}
                {project.isOverdue && " (overdue)"}
              </span>
            </Fact>
            <Fact label="Category">{project.category?.name ?? "None"}</Fact>
            <Fact label="Departments">
              {project.departments.length > 0
                ? project.departments.map((department) => department.name).join(", ")
                : "None"}
            </Fact>
            <Fact label="Progress">
              {PROGRESS_MODE_META[project.progressMode].label}
              <span className="block text-xs text-muted-foreground">
                {PROGRESS_MODE_META[project.progressMode].description}
              </span>
            </Fact>
            <Fact label="Hours allocated">
              <span className="inline-flex items-center gap-1">
                <LuHourglass aria-hidden className="size-3.5 text-muted-foreground" />
                {project.hoursAllocated !== null ? `${project.hoursAllocated}h` : "No limit"}
              </span>
            </Fact>
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            <Badge variant="outline">{project.isPublic ? "Public" : "Members only"}</Badge>
            <Badge variant="outline">
              {project.manualTimeLogs ? "Manual time logs allowed" : "Timer only"}
            </Badge>
            <Badge variant="outline">
              {project.requireTaskApproval ? "Task approval required" : "No task approval"}
            </Badge>
          </div>
        </Panel>
      </div>
    </div>
  );
}
