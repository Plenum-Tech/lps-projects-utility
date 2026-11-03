import { useState } from "react";
import {
  LuCheck,
  LuEllipsis,
  LuPencil,
  LuSquare,
  LuTrash2,
  LuX,
} from "react-icons/lu";

import { ReasonDialog } from "@/components/globals/reason-dialog";
import { ShortCode, TimeLogStatusBadge } from "@/components/projects/project-badges";
import { EditTimeLogDialog } from "@/components/timelogs/edit-time-log-dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useApproveTimeLog,
  useDeleteTimeLog,
  useRejectTimeLog,
  useStopOtherTimer,
} from "@/hooks/use-timelogs";
import { formatMinutes, formatMoney, formatTime } from "@/lib/time";
import { brandWithOrg } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { TimeLog, TimeLogSource } from "@/types";

const SOURCE_LABELS: Record<TimeLogSource, string> = {
  timer: "Timer",
  manual: "Manual",
  timesheet: "Timesheet",
};

/** A log that can be approved right now (pending, finished, approver). */
export function isApprovable(log: TimeLog): boolean {
  return log.permissions.canApprove && log.status === "pending" && !log.isRunning;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * Shared time-log table with per-row actions (edit, delete, approve, reject,
 * stop) gated by `log.permissions`. `selectable` adds checkboxes for bulk
 * approval; `compact` drops secondary columns for narrow containers.
 */
export function TimeLogTable({
  logs,
  showUser = false,
  compact = false,
  selectable = false,
  selected = [],
  onSelectedChange,
}: {
  logs: TimeLog[];
  showUser?: boolean;
  compact?: boolean;
  selectable?: boolean;
  selected?: string[];
  onSelectedChange?: (ids: string[]) => void;
}) {
  const [editing, setEditing] = useState<TimeLog | null>(null);
  const [rejecting, setRejecting] = useState<TimeLog | null>(null);
  const [deleting, setDeleting] = useState<TimeLog | null>(null);
  const approve = useApproveTimeLog();
  const reject = useRejectTimeLog();
  const remove = useDeleteTimeLog();
  const stop = useStopOtherTimer();

  const showEarnings = logs.some((log) => log.earnings > 0);
  const approvable = logs.filter(isApprovable).map((log) => log._id);
  const selectedSet = new Set(selected);
  const selectedHere = approvable.filter((id) => selectedSet.has(id));
  const allSelected = approvable.length > 0 && selectedHere.length === approvable.length;

  function toggle(id: string, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    onSelectedChange?.([...next]);
  }

  function toggleAll(checked: boolean) {
    const next = new Set(selected);
    for (const id of approvable) {
      if (checked) next.add(id);
      else next.delete(id);
    }
    onSelectedChange?.([...next]);
  }

  return (
    <>
      <Card className="py-0">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {selectable && (
                    <TableHead className="w-10">
                      <Checkbox
                        checked={allSelected}
                        indeterminate={selectedHere.length > 0 && !allSelected}
                        disabled={approvable.length === 0}
                        onCheckedChange={(checked) => toggleAll(Boolean(checked))}
                        aria-label="Select all approvable logs on this page"
                      />
                    </TableHead>
                  )}
                  <TableHead>Date</TableHead>
                  {showUser && <TableHead>Employee</TableHead>}
                  <TableHead className="min-w-48">Work</TableHead>
                  <TableHead>Time</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  {showEarnings && <TableHead className="text-right">Earnings</TableHead>}
                  {!compact && <TableHead className="hidden min-w-40 lg:table-cell">Memo</TableHead>}
                  {!compact && <TableHead className="hidden md:table-cell">Source</TableHead>}
                  <TableHead>Status</TableHead>
                  <TableHead className="w-10">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log) => {
                  const canSelect = isApprovable(log);
                  return (
                    <TableRow
                      key={log._id}
                      data-state={selectedSet.has(log._id) ? "selected" : undefined}
                    >
                      {selectable && (
                        <TableCell>
                          <Checkbox
                            checked={selectedSet.has(log._id)}
                            disabled={!canSelect}
                            onCheckedChange={(checked) => toggle(log._id, Boolean(checked))}
                            aria-label={`Select log of ${log.user.name} on ${shortDate(log.startTime)}`}
                          />
                        </TableCell>
                      )}
                      <TableCell className="whitespace-nowrap text-sm">
                        {shortDate(log.startTime)}
                      </TableCell>
                      {showUser && (
                        <TableCell className="max-w-40 truncate text-sm font-medium">
                          {log.user.name}
                        </TableCell>
                      )}
                      <TableCell className="max-w-72">
                        <WorkCell log={log} />
                        {compact && log.memo && (
                          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={log.memo}>
                            {log.memo}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm tabular-nums">
                        {formatTime(log.startTime)} –{" "}
                        {log.endTime ? (
                          formatTime(log.endTime)
                        ) : (
                          <RunningChip paused={log.isPaused} />
                        )}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap tabular-nums">
                        <span className="text-sm font-medium">
                          {log.isRunning ? "—" : formatMinutes(log.durationMinutes)}
                        </span>
                        {log.breakMinutes > 0 && (
                          <span className="block text-[0.7rem] text-muted-foreground">
                            {formatMinutes(log.breakMinutes)} break
                          </span>
                        )}
                      </TableCell>
                      {showEarnings && (
                        <TableCell className="text-right text-sm tabular-nums">
                          {log.earnings > 0 ? formatMoney(log.earnings) : "—"}
                        </TableCell>
                      )}
                      {!compact && (
                        <TableCell className="hidden max-w-56 lg:table-cell">
                          <p className="truncate text-sm text-muted-foreground" title={log.memo || undefined}>
                            {log.memo || "—"}
                          </p>
                        </TableCell>
                      )}
                      {!compact && (
                        <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                          {SOURCE_LABELS[log.source]}
                          {log.autoStopped && (
                            <span className="block text-[0.7rem]">Auto-stopped</span>
                          )}
                        </TableCell>
                      )}
                      <TableCell>
                        <StatusCell log={log} />
                      </TableCell>
                      <TableCell>
                        <RowActions
                          log={log}
                          onEdit={() => setEditing(log)}
                          onReject={() => setRejecting(log)}
                          onDelete={() => setDeleting(log)}
                          onApprove={() => approve.mutate(log._id)}
                          onStop={() => stop.mutate(log._id)}
                          busy={approve.isPending || stop.isPending}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <EditTimeLogDialog log={editing} onOpenChange={(open) => !open && setEditing(null)} />

      <ReasonDialog
        open={Boolean(rejecting)}
        onOpenChange={(open) => !open && setRejecting(null)}
        title="Reject time log"
        description={
          rejecting
            ? `${rejecting.user.name} will be notified with your reason.`
            : undefined
        }
        pending={reject.isPending}
        onConfirm={(reason) => {
          if (!rejecting) return;
          reject.mutate(
            { id: rejecting._id, reason },
            { onSuccess: () => setRejecting(null) }
          );
        }}
      />

      <AlertDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && !remove.isPending && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this time log?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting && !deleting.isRunning
                ? `${formatMinutes(deleting.durationMinutes)} on ${shortDate(deleting.startTime)} will be removed permanently.`
                : "The running timer will be discarded without logging any time."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => {
                if (!deleting) return;
                remove.mutate(deleting._id, { onSuccess: () => setDeleting(null) });
              }}
            >
              <LuTrash2 aria-hidden />
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function WorkCell({ log }: { log: TimeLog }) {
  if (log.task) {
    return (
      <div className="min-w-0">
        <p className="flex min-w-0 items-center gap-1.5 text-sm">
          {log.task.shortCode && <ShortCode code={log.task.shortCode} />}
          <span className="truncate font-medium">{log.task.title}</span>
        </p>
        {log.project && (
          <p className="truncate text-xs text-muted-foreground">{log.project.name}</p>
        )}
      </div>
    );
  }
  if (log.project) {
    return (
      <p className="flex min-w-0 items-center gap-1.5 text-sm">
        <ShortCode code={log.project.code} />
        <span className="truncate font-medium">{log.project.name}</span>
      </p>
    );
  }
  if (log.brand) {
    return (
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{brandWithOrg(log.brand)}</p>
        <p className="truncate text-xs text-muted-foreground">Brand time</p>
      </div>
    );
  }
  return <span className="text-sm text-muted-foreground">No project</span>;
}

function RunningChip({ paused }: { paused: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.7rem] font-medium",
        paused ? "bg-chart-4/15 text-foreground" : "bg-primary/10 text-primary"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          paused ? "bg-chart-4" : "animate-pulse bg-primary motion-reduce:animate-none"
        )}
      />
      {paused ? "Paused" : "Running"}
    </span>
  );
}

function StatusCell({ log }: { log: TimeLog }) {
  const reason = log.status === "rejected" ? log.rejectReason : undefined;
  return (
    <div className="max-w-40" title={reason ? `Rejected: ${reason}` : undefined}>
      <TimeLogStatusBadge status={log.status} />
      {reason && (
        <p className="mt-0.5 truncate text-[0.7rem] text-destructive">{reason}</p>
      )}
    </div>
  );
}

function RowActions({
  log,
  onEdit,
  onReject,
  onDelete,
  onApprove,
  onStop,
  busy,
}: {
  log: TimeLog;
  onEdit: () => void;
  onReject: () => void;
  onDelete: () => void;
  onApprove: () => void;
  onStop: () => void;
  busy: boolean;
}) {
  const { permissions } = log;
  const canEdit = permissions.canEdit && log.source !== "timesheet";
  const canDelete = permissions.canDelete && log.source !== "timesheet";
  const canStop = permissions.canStop && log.isRunning;
  const canReview = isApprovable(log);

  if (!canEdit && !canDelete && !canStop && !canReview) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for log on ${shortDate(log.startTime)}`}
          />
        }
      >
        <LuEllipsis aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuGroup>
          {canReview && (
            <DropdownMenuItem onClick={onApprove} disabled={busy}>
              <LuCheck aria-hidden />
              Approve
            </DropdownMenuItem>
          )}
          {canReview && (
            <DropdownMenuItem onClick={onReject}>
              <LuX aria-hidden />
              Reject…
            </DropdownMenuItem>
          )}
          {canStop && (
            <DropdownMenuItem onClick={onStop} disabled={busy}>
              <LuSquare aria-hidden />
              Stop timer
            </DropdownMenuItem>
          )}
          {canEdit && (
            <DropdownMenuItem onClick={onEdit}>
              <LuPencil aria-hidden />
              Edit
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
        {canDelete && (
          <>
            {(canReview || canStop || canEdit) && <DropdownMenuSeparator />}
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <LuTrash2 aria-hidden />
              Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TimeLogTableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <Card aria-busy="true" aria-label="Loading time logs" className="py-0">
      <CardContent className="space-y-4 p-4">
        {Array.from({ length: rows }).map((_, index) => (
          <div key={index} className="flex items-center gap-4">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="hidden h-4 w-28 sm:block" />
            <Skeleton className="h-4 w-14" />
            <Skeleton className="h-5 w-20" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
