import { LuTimer } from "react-icons/lu";

import { useTimeLogs } from "@/hooks/use-timelogs";
import { formatDate, formatTimeOfDay } from "@/lib/format";
import { formatEffort } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { TimeLog } from "@/types";

const STATUS: Record<string, { label: string; dot: string }> = {
  approved: { label: "Approved", dot: "bg-primary" },
  pending: { label: "Pending", dot: "bg-amber-500" },
  rejected: { label: "Rejected", dot: "bg-destructive" },
};

function statusOf(log: TimeLog) {
  if (log.isRunning || !log.endTime) return { label: "Running", dot: "bg-primary animate-pulse" };
  return STATUS[log.status] ?? { label: log.status, dot: "bg-muted-foreground" };
}

/**
 * Task page, under Actual start / end: every time entry on the task, one row
 * each (date, person, from – to, duration, status), oldest first.
 */
export function TaskTimeEntries({ taskId }: { taskId: string }) {
  const logs = useTimeLogs({ scope: "team", task: taskId, limit: 100, offset: 0 });
  const entries = [...(logs.data?.logs ?? [])].sort((a, b) => a.startTime.localeCompare(b.startTime));
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, log) => sum + (log.endTime ? log.durationMinutes : 0), 0);

  return (
    <section aria-labelledby="task-time-entries-heading" className="space-y-2 rounded-lg border bg-muted/20 p-3 sm:p-4">
      <h3
        id="task-time-entries-heading"
        className="flex flex-wrap items-center gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase"
      >
        <LuTimer aria-hidden className="size-4" />
        Time entries
        <span className="font-normal tracking-normal normal-case">
          · {entries.length} {entries.length === 1 ? "entry" : "entries"} · {formatEffort(total)}
        </span>
      </h3>
      <ul className="divide-y text-sm">
        {entries.map((log) => {
          const status = statusOf(log);
          return (
            <li
              key={log._id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 py-2 sm:grid-cols-[7.5rem_minmax(0,1fr)_10rem_4.5rem_6rem]"
            >
              <span className="text-muted-foreground tabular-nums">{formatDate(log.startTime)}</span>
              <span className="truncate font-medium text-foreground sm:order-none">{log.user.name}</span>
              <span className="tabular-nums text-muted-foreground">
                {formatTimeOfDay(log.startTime)} – {log.endTime ? formatTimeOfDay(log.endTime) : "now"}
              </span>
              <span className="text-right tabular-nums font-medium">{log.endTime ? formatEffort(log.durationMinutes) : "—"}</span>
              <span className="inline-flex items-center justify-end gap-1.5 text-xs text-muted-foreground">
                <span aria-hidden className={cn("size-2 rounded-full", status.dot)} />
                {status.label}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
