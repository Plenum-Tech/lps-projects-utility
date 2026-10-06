import { useEffect, useMemo, useState } from "react";
import {
  LuBanknote,
  LuCheckCheck,
  LuClock,
  LuHourglass,
  LuListChecks,
  LuLoaderCircle,
  LuPlus,
} from "react-icons/lu";
import { useSearchParams } from "react-router";

import { DataTablePagination } from "@/components/globals/data-table-pagination";
import { FilterSelect } from "@/components/globals/filter-select";
import { EmptyState, PageHeader, QueryError, StatCard } from "@/components/globals/query-states";
import { DateRangeFields } from "@/components/timelogs/date-range-fields";
import { ManualTimeLogDialog } from "@/components/timelogs/manual-time-log-dialog";
import { TimeLogTable, TimeLogTableSkeleton } from "@/components/timelogs/time-log-table";
import { TimeNav } from "@/components/timelogs/time-nav";
import { usePickerTasks } from "@/components/timelogs/time-target-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCurrentUser } from "@/hooks/use-auth";
import { usePagination } from "@/hooks/use-pagination";
import { useProjectOptions } from "@/hooks/use-projects";
import { useAssignableUsers } from "@/hooks/use-task-meta";
import { useBulkApproveTimeLogs, useTimeLogs } from "@/hooks/use-timelogs";
import { dateKey, formatMinutes, formatMoney, monthStartKey } from "@/lib/time";
import type { TimeLogScope, TimeLogStatus } from "@/types";

const PAGE_SIZE = 20;

type TabKey = "mine" | "team" | "pending";

const TAB_SCOPE: Record<TabKey, TimeLogScope> = {
  mine: "mine",
  team: "team",
  pending: "approvals",
};

const STATUS_OPTIONS: { value: TimeLogStatus; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
];

function parseTab(value: string | null): TabKey {
  return value === "team" || value === "pending" ? value : "mine";
}

/**
 * /timelogs — my logs, the team's logs (head/admin) and the approval queue
 * (head/admin and project managers with pending logs), synced to `?tab=`.
 */
export function TimeLogsPage() {
  const { data: user } = useCurrentUser();
  const isManager = user?.role === "admin" || user?.role === "head";

  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = parseTab(searchParams.get("tab"));

  // Probe the approval queue so project managers (any role) see the tab.
  const approvalsProbe = useTimeLogs(
    { scope: "approvals", limit: 1, offset: 0 },
    Boolean(user)
  );
  const pendingCount = approvalsProbe.data?.total ?? 0;
  const showPending = isManager || pendingCount > 0 || requestedTab === "pending";
  const showTeam = isManager;

  const tab: TabKey =
    requestedTab === "team" && !showTeam ? "mine" : requestedTab;

  const [range, setRange] = useState({ from: monthStartKey(), to: dateKey(new Date()) });
  const [project, setProject] = useState("");
  const [task, setTask] = useState("");
  const [status, setStatus] = useState<TimeLogStatus | "">("");
  const [person, setPerson] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [manualOpen, setManualOpen] = useState(false);

  const projects = useProjectOptions();
  const projectTasks = usePickerTasks(project, { enabled: Boolean(project), openOnly: false });
  const people = useAssignableUsers(isManager && tab !== "mine");
  const bulkApprove = useBulkApproveTimeLogs();

  const filters = useMemo(
    () => ({
      scope: TAB_SCOPE[tab],
      // The approval queue shows everything waiting, regardless of dates.
      from: tab === "pending" ? undefined : range.from || undefined,
      to: tab === "pending" ? undefined : range.to || undefined,
      project: project || undefined,
      task: task || undefined,
      status: tab === "pending" ? undefined : status || undefined,
      user: tab !== "mine" ? person || undefined : undefined,
    }),
    [tab, range, project, task, status, person]
  );

  const { page, setPage, offset, setTotal } = usePagination({
    limit: PAGE_SIZE,
    resetKey: JSON.stringify(filters),
  });

  const logs = useTimeLogs({ ...filters, limit: PAGE_SIZE, offset }, Boolean(user));

  useEffect(() => {
    if (logs.data) setTotal(logs.data.total);
  }, [logs.data, setTotal]);

  // Selection only makes sense within the current filter set.
  useEffect(() => {
    setSelected([]);
  }, [filters]);

  function changeTab(next: TabKey) {
    setSearchParams(
      (params) => {
        const updated = new URLSearchParams(params);
        if (next === "mine") updated.delete("tab");
        else updated.set("tab", next);
        return updated;
      },
      { preventScrollReset: true }
    );
  }

  const projectOptions = (projects.data ?? []).map((item) => ({
    value: item._id,
    label: `${item.code} · ${item.name}`,
  }));
  const taskOptions = projectTasks.tasks.map((item) => ({
    value: item._id,
    label: item.shortCode ? `${item.shortCode} · ${item.title}` : item.title,
  }));
  const personOptions = (people.data ?? []).map((item) => ({ value: item._id, label: item.name }));

  const totals = logs.data?.totals;
  const hasFilters = Boolean(project || task || status || person);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Time logs"
        description="Tracked and manual time, with approvals for your team."
        actions={
          <>
            <TimeNav current="/timelogs" />
            <Button size="sm" onClick={() => setManualOpen(true)}>
              <LuPlus aria-hidden />
              Log time
            </Button>
          </>
        }
      />

      <div className="mt-6 space-y-5">
        <Tabs value={tab} onValueChange={(value) => changeTab(parseTab(String(value)))}>
          <TabsList className="w-full sm:w-fit">
            <TabsTrigger value="mine">Mine</TabsTrigger>
            {showTeam && <TabsTrigger value="team">Team</TabsTrigger>}
            {showPending && (
              <TabsTrigger value="pending">
                Pending approval
                {pendingCount > 0 && (
                  <Badge variant="secondary" className="h-4 min-w-4 px-1 text-[0.65rem] tabular-nums">
                    {pendingCount}
                  </Badge>
                )}
              </TabsTrigger>
            )}
          </TabsList>
        </Tabs>

        <div className="flex flex-wrap items-end gap-2">
          {tab !== "pending" && (
            <DateRangeFields
              idPrefix="timelogs"
              from={range.from}
              to={range.to}
              onChange={setRange}
              clearable
            />
          )}
          <FilterSelect
            label="Project"
            value={project}
            onChange={(value) => {
              setProject(value);
              setTask("");
            }}
            options={projectOptions}
          />
          {project && (
            <FilterSelect label="Task" value={task} onChange={setTask} options={taskOptions} />
          )}
          {tab !== "pending" && (
            <FilterSelect
              label="Status"
              value={status}
              onChange={(value) => setStatus(value as TimeLogStatus | "")}
              options={STATUS_OPTIONS}
            />
          )}
          {isManager && tab !== "mine" && (
            <FilterSelect
              label="Employee"
              value={person}
              onChange={setPerson}
              options={personOptions}
            />
          )}
          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setProject("");
                setTask("");
                setStatus("");
                setPerson("");
              }}
            >
              Reset filters
            </Button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <StatCard
            label="Total time"
            icon={LuClock}
            tone="primary"
            value={totals ? formatMinutes(totals.minutes) : "—"}
            hint={tab === "pending" ? "Awaiting approval" : "Finished logs in range"}
          />
          <StatCard
            label="Entries"
            icon={LuListChecks}
            value={totals ? totals.count : "—"}
          />
          {totals && totals.earnings > 0 ? (
            <StatCard
              label="Earnings"
              icon={LuBanknote}
              value={formatMoney(totals.earnings)}
              className="col-span-2 lg:col-span-1"
            />
          ) : (
            <StatCard
              label="Pending approval"
              icon={LuHourglass}
              tone="warning"
              value={showPending ? pendingCount : "—"}
              className="col-span-2 lg:col-span-1"
            />
          )}
        </div>

        {tab === "pending" && selected.length > 0 && (
          <div
            role="region"
            aria-label="Bulk actions"
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2"
          >
            <p className="text-sm">
              <span className="font-medium tabular-nums">{selected.length}</span> selected
            </p>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setSelected([])}>
                Clear
              </Button>
              <Button
                size="sm"
                disabled={bulkApprove.isPending}
                onClick={() =>
                  bulkApprove.mutate(selected, { onSuccess: () => setSelected([]) })
                }
              >
                {bulkApprove.isPending ? (
                  <LuLoaderCircle aria-hidden className="animate-spin" />
                ) : (
                  <LuCheckCheck aria-hidden />
                )}
                Approve selected
              </Button>
            </div>
          </div>
        )}

        {logs.isPending ? (
          <TimeLogTableSkeleton />
        ) : logs.isError ? (
          <QueryError
            title="Couldn't load time logs"
            error={logs.error}
            onRetry={() => void logs.refetch()}
            retrying={logs.isFetching}
          />
        ) : logs.data.logs.length === 0 ? (
          <EmptyState
            icon={tab === "pending" ? LuCheckCheck : LuClock}
            title={
              tab === "pending"
                ? "Nothing waiting for approval"
                : hasFilters
                  ? "No logs match these filters"
                  : "No time logged in this range"
            }
            description={
              tab === "pending"
                ? "Pending logs from your team appear here."
                : tab === "mine"
                  ? "Start the timer from the header or log time manually."
                  : "Try a wider date range or different filters."
            }
          >
            {tab === "mine" && (
              <Button size="sm" variant="outline" onClick={() => setManualOpen(true)}>
                <LuPlus aria-hidden />
                Log time
              </Button>
            )}
          </EmptyState>
        ) : (
          <div className={logs.isFetching ? "opacity-70 transition-opacity" : undefined}>
            <TimeLogTable
              logs={logs.data.logs}
              showUser={tab !== "mine"}
              selectable={tab === "pending"}
              selected={selected}
              onSelectedChange={setSelected}
            />
            <DataTablePagination
              page={page}
              limit={PAGE_SIZE}
              total={logs.data.total}
              onPageChange={setPage}
            />
          </div>
        )}
      </div>

      <ManualTimeLogDialog open={manualOpen} onOpenChange={setManualOpen} />
    </div>
  );
}
