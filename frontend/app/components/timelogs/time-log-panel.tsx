import { useEffect, useState } from "react";
import { LuClock, LuLoaderCircle, LuPlay, LuPlus } from "react-icons/lu";

import { DataTablePagination } from "@/components/globals/data-table-pagination";
import { EmptyState, QueryError } from "@/components/globals/query-states";
import { DateRangeFields } from "@/components/timelogs/date-range-fields";
import { ManualTimeLogDialog } from "@/components/timelogs/manual-time-log-dialog";
import { TimeLogTable, TimeLogTableSkeleton } from "@/components/timelogs/time-log-table";
import { Button } from "@/components/ui/button";
import { usePagination } from "@/hooks/use-pagination";
import { useActiveTimer, useStartTimer, useTimeLogs } from "@/hooks/use-timelogs";
import { formatMinutes, formatMoney } from "@/lib/time";

const PAGE_SIZE = 10;

/**
 * Embedded time logs for a project (project detail "Time logs" tab) or a task
 * (task detail sheet "Time" tab): range filter, totals, the log table with
 * row actions, plus "Start timer" / "Log time" when the caller may log time.
 */
export function TimeLogPanel({
  projectId,
  taskId,
  canLogTime = false,
  manualAllowed = true,
}: {
  projectId?: string;
  taskId?: string;
  canLogTime?: boolean;
  manualAllowed?: boolean;
}) {
  const [range, setRange] = useState({ from: "", to: "" });
  const [manualOpen, setManualOpen] = useState(false);
  const active = useActiveTimer();
  const startTimer = useStartTimer();

  const { page, setPage, offset, setTotal } = usePagination({
    limit: PAGE_SIZE,
    resetKey: JSON.stringify({ range, projectId, taskId }),
  });

  const logs = useTimeLogs({
    scope: "team",
    project: taskId ? undefined : projectId,
    task: taskId,
    from: range.from || undefined,
    to: range.to || undefined,
    limit: PAGE_SIZE,
    offset,
  });

  useEffect(() => {
    if (logs.data) setTotal(logs.data.total);
  }, [logs.data, setTotal]);

  const timer = active.data ?? null;
  const timerHere = Boolean(
    timer && (taskId ? timer.task?._id === taskId : timer.project?._id === projectId)
  );
  const totals = logs.data?.totals;
  const filtered = Boolean(range.from || range.to);
  const target = taskId ? "task" : "project";

  return (
    <section aria-label="Time logs" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <DateRangeFields
          idPrefix={`panel-${taskId ?? projectId ?? "logs"}`}
          from={range.from}
          to={range.to}
          onChange={setRange}
          clearable
        />
        {canLogTime && (
          <div className="flex flex-wrap items-center gap-2">
            {manualAllowed && (
              <Button variant="outline" size="sm" onClick={() => setManualOpen(true)}>
                <LuPlus aria-hidden />
                Log time
              </Button>
            )}
            <Button
              size="sm"
              disabled={startTimer.isPending || Boolean(timer)}
              title={
                timerHere
                  ? `Your timer is running on this ${target}`
                  : timer
                    ? "Stop your running timer first"
                    : undefined
              }
              onClick={() =>
                startTimer.mutate(taskId ? { task: taskId } : { project: projectId })
              }
            >
              {startTimer.isPending ? (
                <LuLoaderCircle aria-hidden className="animate-spin" />
              ) : (
                <LuPlay aria-hidden />
              )}
              {timerHere ? "Timer running" : `Start timer on this ${target}`}
            </Button>
          </div>
        )}
      </div>

      {totals && (
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <TotalTile label="Logged" value={formatMinutes(totals.minutes)} />
          <TotalTile label="Entries" value={String(totals.count)} />
          {totals.earnings > 0 && (
            <TotalTile label="Earnings" value={formatMoney(totals.earnings)} />
          )}
        </dl>
      )}

      {logs.isPending ? (
        <TimeLogTableSkeleton rows={4} />
      ) : logs.isError ? (
        <QueryError
          title="Couldn't load time logs"
          error={logs.error}
          onRetry={() => void logs.refetch()}
          retrying={logs.isFetching}
        />
      ) : logs.data.logs.length === 0 ? (
        <EmptyState
          icon={LuClock}
          title={filtered ? "No time logged in this range" : "No time logged yet"}
          description={
            filtered
              ? "Try a wider date range."
              : canLogTime
                ? `Start the timer or log time manually to track work on this ${target}.`
                : `Time logged on this ${target} will show up here.`
          }
        />
      ) : (
        <div className={logs.isFetching ? "opacity-70 transition-opacity" : undefined}>
          <TimeLogTable logs={logs.data.logs} showUser compact />
          <DataTablePagination
            page={page}
            limit={PAGE_SIZE}
            total={logs.data.total}
            onPageChange={setPage}
          />
        </div>
      )}

      <ManualTimeLogDialog
        open={manualOpen}
        onOpenChange={setManualOpen}
        defaultProjectId={taskId ? undefined : projectId}
        defaultTaskId={taskId}
        lockProject={Boolean(projectId && !taskId)}
        lockTask={Boolean(taskId)}
      />
    </section>
  );
}

function TotalTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <dt className="text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="font-heading text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
