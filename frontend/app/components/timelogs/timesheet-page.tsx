import { useEffect, useMemo, useRef, useState } from "react";
import {
  LuCalendarDays,
  LuChevronLeft,
  LuChevronRight,
  LuCircleAlert,
  LuClipboardList,
  LuInfo,
  LuLoaderCircle,
  LuSave,
  LuSend,
} from "react-icons/lu";
import { useSearchParams } from "react-router";

import { EmptyState, PageHeader, QueryError } from "@/components/globals/query-states";
import { TimesheetStatusBadge } from "@/components/projects/project-badges";
import { TimeNav } from "@/components/timelogs/time-nav";
import {
  TimesheetGrid,
  TimesheetGridSkeleton,
  cellKey,
  minutesToCell,
  parseHours,
} from "@/components/timelogs/timesheet-grid";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useSaveTimesheet, useSubmitTimesheet, useTimesheetWeek } from "@/hooks/use-timesheets";
import { addDaysKey, formatLocalDate, formatMinutes, formatWeekRange, mondayOf } from "@/lib/time";
import type { TimesheetEntry, TimesheetView } from "@/types";

const MANY_TASKS = 8;
const DAY_MAX = 24 * 60;

function valuesFromView(view: TimesheetView): Record<string, string> {
  const values: Record<string, string> = {};
  for (const entry of view.timesheet.entries) {
    values[cellKey(entry.task, entry.date.slice(0, 10))] = minutesToCell(entry.minutes);
  }
  return values;
}

function isValidWeekParam(value: string | null): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

/**
 * /timesheet — my weekly grid (tasks × Mon–Sun). Save a draft, submit for
 * approval, and see the rejection reason. Read-only once submitted/approved.
 */
export function TimesheetPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const weekParam = searchParams.get("week");
  const week = mondayOf(isValidWeekParam(weekParam) ? weekParam : undefined);
  const thisWeek = mondayOf();

  const sheet = useTimesheetWeek(week);
  const save = useSaveTimesheet();
  const submit = useSubmitTimesheet();

  const view = sheet.data;
  // While another week loads, keepPreviousData shows the old sheet — hide it.
  const viewForWeek = sheet.isPlaceholderData ? undefined : view;

  const [values, setValues] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const loadedVersion = useRef("");

  // Load server values when the sheet changes (new week or fresh save), unless editing.
  const version = viewForWeek
    ? `${viewForWeek.timesheet._id}:${viewForWeek.timesheet.updatedAt}:${viewForWeek.timesheet.status}`
    : "";
  useEffect(() => {
    if (!viewForWeek || version === loadedVersion.current) return;
    const sameSheet = loadedVersion.current.startsWith(`${viewForWeek.timesheet._id}:`);
    if (sameSheet && dirty) return;
    loadedVersion.current = version;
    setValues(valuesFromView(viewForWeek));
    setDirty(false);
  }, [version, viewForWeek, dirty]);

  // Warn before closing the tab with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const readOnly = !viewForWeek?.permissions.canEdit;
  const tasks = viewForWeek?.tasks ?? [];
  const days = viewForWeek?.days ?? [];

  const invalidCells = useMemo(
    () => Object.values(values).filter((raw) => parseHours(raw) === null).length,
    [values]
  );
  const overDays = useMemo(
    () =>
      days.filter(
        (day) =>
          tasks.reduce((sum, task) => sum + (parseHours(values[cellKey(task._id, day)] ?? "") ?? 0), 0) >
          DAY_MAX
      ),
    [days, tasks, values]
  );
  const hasErrors = invalidCells > 0 || overDays.length > 0;

  const tasksWithTime = tasks.filter((task) =>
    days.some((day) => (parseHours(values[cellKey(task._id, day)] ?? "") ?? 0) > 0)
  );
  const collapsible = !readOnly && tasks.length > MANY_TASKS;
  const visibleTasks = readOnly
    ? tasksWithTime.length > 0
      ? tasksWithTime
      : tasks
    : collapsible && !showAll
      ? tasksWithTime
      : tasks;

  function entries(): TimesheetEntry[] {
    const out: TimesheetEntry[] = [];
    for (const task of tasks) {
      for (const day of days) {
        const minutes = parseHours(values[cellKey(task._id, day)] ?? "") ?? 0;
        if (minutes > 0) out.push({ task: task._id, date: day, minutes });
      }
    }
    return out;
  }

  function changeCell(key: string, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  function goToWeek(target: string) {
    if (target === week) return;
    if (dirty && !window.confirm("You have unsaved changes on this week. Discard them?")) return;
    setDirty(false);
    loadedVersion.current = "";
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        if (target === thisWeek) next.delete("week");
        else next.set("week", target);
        return next;
      },
      { preventScrollReset: true }
    );
  }

  function handleSave() {
    if (!viewForWeek || hasErrors) return;
    save.mutate(
      { id: viewForWeek.timesheet._id, entries: entries() },
      { onSuccess: () => setDirty(false) }
    );
  }

  async function handleSubmit() {
    if (!viewForWeek || hasErrors) return;
    try {
      if (dirty) {
        await save.mutateAsync({ id: viewForWeek.timesheet._id, entries: entries() });
        setDirty(false);
      }
      await submit.mutateAsync(viewForWeek.timesheet._id);
      setConfirmOpen(false);
    } catch {
      // Hooks already toast the server message; keep the dialog open to retry.
    }
  }

  const status = viewForWeek?.timesheet.status;
  const pendingAction = save.isPending || submit.isPending;
  const totalMinutes = entries().reduce((sum, entry) => sum + entry.minutes, 0);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Timesheet"
        description="Fill in your hours per task for the week, then submit for approval."
        actions={<TimeNav current="/timesheet" />}
      />

      <div className="mt-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Previous week"
                onClick={() => goToWeek(addDaysKey(week, -7))}
              >
                <LuChevronLeft aria-hidden />
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Next week"
                onClick={() => goToWeek(addDaysKey(week, 7))}
              >
                <LuChevronRight aria-hidden />
              </Button>
            </div>
            <h2 className="font-heading text-lg font-semibold tabular-nums" aria-live="polite">
              {formatWeekRange(week)}
            </h2>
            {week !== thisWeek && (
              <Button variant="ghost" size="sm" onClick={() => goToWeek(thisWeek)}>
                <LuCalendarDays aria-hidden />
                This week
              </Button>
            )}
            {status && <TimesheetStatusBadge status={status} />}
          </div>

          {viewForWeek && tasks.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {viewForWeek.permissions.canEdit && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSave}
                  disabled={!dirty || hasErrors || pendingAction}
                >
                  {save.isPending && !submit.isPending ? (
                    <LuLoaderCircle aria-hidden className="animate-spin" />
                  ) : (
                    <LuSave aria-hidden />
                  )}
                  Save draft
                </Button>
              )}
              {/* The server only allows submit once the draft has entries; an unsaved
                  dirty grid is saved first by handleSubmit. */}
              {(viewForWeek.permissions.canSubmit ||
                (viewForWeek.permissions.canEdit && dirty)) && (
                <Button
                  size="sm"
                  onClick={() => setConfirmOpen(true)}
                  disabled={hasErrors || pendingAction || totalMinutes === 0}
                  title={totalMinutes === 0 ? "Add some hours before submitting" : undefined}
                >
                  <LuSend aria-hidden />
                  Submit
                </Button>
              )}
            </div>
          )}
        </div>

        {viewForWeek?.timesheet.status === "rejected" && (
          <Alert variant="destructive">
            <LuCircleAlert aria-hidden className="size-4" />
            <AlertTitle>
              Rejected
              {viewForWeek.timesheet.reviewedBy ? ` by ${viewForWeek.timesheet.reviewedBy.name}` : ""}
            </AlertTitle>
            <AlertDescription>
              {viewForWeek.timesheet.rejectReason || "No reason given."} Update your hours and
              submit again.
            </AlertDescription>
          </Alert>
        )}
        {viewForWeek?.timesheet.status === "submitted" && (
          <Alert>
            <LuInfo aria-hidden className="size-4" />
            <AlertTitle>Waiting for approval</AlertTitle>
            <AlertDescription>
              Submitted
              {viewForWeek.timesheet.submittedAt
                ? ` on ${formatLocalDate(viewForWeek.timesheet.submittedAt)}`
                : ""}
              . The sheet is read-only until it&apos;s reviewed.
            </AlertDescription>
          </Alert>
        )}
        {viewForWeek?.timesheet.status === "approved" && (
          <Alert>
            <LuInfo aria-hidden className="size-4" />
            <AlertTitle>Approved</AlertTitle>
            <AlertDescription>
              {viewForWeek.timesheet.reviewedBy
                ? `Approved by ${viewForWeek.timesheet.reviewedBy.name}`
                : "Approved"}
              {viewForWeek.timesheet.reviewedAt
                ? ` on ${formatLocalDate(viewForWeek.timesheet.reviewedAt)}`
                : ""}
              .
            </AlertDescription>
          </Alert>
        )}

        {sheet.isPending || sheet.isPlaceholderData ? (
          <TimesheetGridSkeleton />
        ) : sheet.isError && !viewForWeek ? (
          <QueryError
            title="Couldn't load your timesheet"
            error={sheet.error}
            onRetry={() => void sheet.refetch()}
            retrying={sheet.isFetching}
          />
        ) : !viewForWeek || tasks.length === 0 ? (
          <EmptyState
            icon={LuClipboardList}
            title="No tasks to log time on"
            description="Open tasks assigned to you in active projects appear here as rows."
          />
        ) : (
          <div className="space-y-3">
            {collapsible && (
              <div className="flex items-center gap-2">
                <Switch id="timesheet-show-all" checked={showAll} onCheckedChange={setShowAll} />
                <Label htmlFor="timesheet-show-all" className="text-sm">
                  Show all {tasks.length} tasks
                </Label>
              </div>
            )}
            {visibleTasks.length === 0 ? (
              <EmptyState
                icon={LuClipboardList}
                title="No hours yet this week"
                description={`You have ${tasks.length} tasks you can log time on.`}
              >
                <Button size="sm" variant="outline" onClick={() => setShowAll(true)}>
                  Show all tasks
                </Button>
              </EmptyState>
            ) : (
              <TimesheetGrid
                tasks={visibleTasks}
                days={days}
                values={values}
                onChange={changeCell}
                readOnly={readOnly}
              />
            )}
            {!readOnly && (
              <p
                className={hasErrors ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
                role={hasErrors ? "alert" : undefined}
              >
                {invalidCells > 0
                  ? `${invalidCells} cell${invalidCells === 1 ? "" : "s"} can't be read — use hours like 1.5 or 1:30 (max 24h).`
                  : overDays.length > 0
                    ? "A day can't have more than 24 hours."
                    : dirty
                      ? "Unsaved changes."
                      : "Enter hours as 1.5 or 1:30. Empty cells count as zero."}
              </p>
            )}
          </div>
        )}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={(open) => !pendingAction && setConfirmOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Submit this timesheet?</AlertDialogTitle>
            <AlertDialogDescription>
              {formatMinutes(totalMinutes)} for {formatWeekRange(week)} goes to your approver. You
              can&apos;t edit it again unless it&apos;s rejected.
              {dirty ? " Your unsaved changes are saved first." : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendingAction}>Cancel</AlertDialogCancel>
            <Button onClick={() => void handleSubmit()} disabled={pendingAction}>
              {pendingAction ? (
                <LuLoaderCircle aria-hidden className="animate-spin" />
              ) : (
                <LuSend aria-hidden />
              )}
              Submit
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
