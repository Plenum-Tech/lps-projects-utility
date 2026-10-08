import { useEffect, useId, useState, type FormEvent } from "react";
import { LuLoaderCircle, LuPencil, LuRotateCcw } from "react-icons/lu";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useUpdateTask } from "@/hooks/use-tasks";
import { formatDateTime } from "@/lib/format";
import { fromDateTimeInput, toDateTimeInput } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { ActualDateSource, Task, TaskPermissions } from "@/types";

// ---------------------------------------------------------------------------
// Task Actual start / Actual end: detail-sheet block (view, edit, reset to
// automatic), variance chips and the table cells.
// ---------------------------------------------------------------------------

type ActualField = "actualStartAt" | "actualEndAt";

const DAY_MS = 86_400_000;

/** Calendar days from a planned date-only value to an actual instant (local date): + late, − early. */
export function varianceDays(actual: string | null | undefined, planned: string | null | undefined): number | null {
  if (!actual || !planned) return null;
  const actualKey = toDateTimeInput(actual).slice(0, 10);
  const plannedKey = planned.slice(0, 10);
  return Math.round((Date.parse(`${actualKey}T00:00:00Z`) - Date.parse(`${plannedKey}T00:00:00Z`)) / DAY_MS);
}

/** "Started 2d late" / "Finished 1d early" / "… on time". */
export function varianceText(kind: "start" | "finish", days: number): string {
  const verb = kind === "start" ? "Started" : "Finished";
  if (days === 0) return `${verb} on time`;
  return `${verb} ${Math.abs(days)}d ${days > 0 ? "late" : "early"}`;
}

export function VarianceChip({ kind, days, className }: { kind: "start" | "finish"; days: number | null; className?: string }) {
  if (days === null) return null;
  const late = days > 0;
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-md px-1.5 text-[0.7rem] font-medium",
        late ? "bg-chart-4/15 text-foreground" : "bg-primary/10 text-primary",
        className
      )}
    >
      {varianceText(kind, days)}
    </span>
  );
}

const SOURCE_LABEL: Record<ActualDateSource, string> = { auto: "auto", manual: "edited", import: "imported" };

function SourceBadge({ source }: { source: ActualDateSource | null | undefined }) {
  if (!source) return null;
  return (
    <span
      className={cn(
        "rounded-full px-1.5 text-[0.65rem] leading-4 font-medium",
        source === "manual" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
      )}
    >
      {SOURCE_LABEL[source]}
    </span>
  );
}

/** One editable value: the date-time, its source badge, edit popover and reset-to-automatic. */
function ActualValue({
  task,
  field,
  label,
  canEdit,
}: {
  task: Task;
  field: ActualField;
  label: string;
  canEdit: boolean;
}) {
  const id = useId();
  const update = useUpdateTask();
  const value = task[field] ?? null;
  const source = field === "actualStartAt" ? task.actualStartSource : task.actualEndSource;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(value ? toDateTimeInput(value) : toDateTimeInput(new Date()));
      setError(null);
    }
  }, [open, value]);

  const text = formatDateTime(value);
  const nowInput = toDateTimeInput(new Date(Date.now() + 2 * 60_000));

  function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) {
      setError("Pick a date and time.");
      return;
    }
    const iso = fromDateTimeInput(draft);
    if (new Date(iso).getTime() > Date.now() + 2 * 60_000) {
      setError("Can't be in the future.");
      return;
    }
    const other = field === "actualStartAt" ? task.actualEndAt : task.actualStartAt;
    if (other && (field === "actualStartAt" ? iso > other : iso < other)) {
      setError(field === "actualStartAt" ? "Must be on or before the actual end." : "Must be on or after the actual start.");
      return;
    }
    update.mutate({ id: task._id, input: { [field]: iso } }, { onSuccess: () => setOpen(false) });
  }

  function reset() {
    update.mutate({ id: task._id, input: { [field]: null } });
  }

  return (
    <div className="min-w-0">
      <dt className="mb-1 flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {label}
        <SourceBadge source={value ? source : null} />
      </dt>
      <dd className="flex flex-wrap items-center gap-1.5 text-foreground">
        {canEdit ? (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-md text-left tabular-nums outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/50"
                  aria-label={`${label}: ${text}. Edit`}
                />
              }
            >
              {text}
              <LuPencil aria-hidden className="size-3 text-muted-foreground" />
            </PopoverTrigger>
            <PopoverContent align="start" className="w-auto">
              <form onSubmit={save} noValidate className="space-y-3">
                <div className="space-y-1.5">
                  <label htmlFor={`${id}-input`} className="text-sm leading-none font-medium">
                    {label}
                  </label>
                  <Input
                    id={`${id}-input`}
                    type="datetime-local"
                    value={draft}
                    max={nowInput}
                    onChange={(event) => setDraft(event.target.value)}
                    aria-invalid={Boolean(error) || undefined}
                    aria-describedby={`${id}-hint`}
                  />
                  <p id={`${id}-hint`} className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>
                    {error ?? "Saved as edited — automatic updates won't change it."}
                  </p>
                </div>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" size="sm" disabled={update.isPending}>
                    {update.isPending && <LuLoaderCircle aria-hidden className="animate-spin" />}
                    Save
                  </Button>
                </div>
              </form>
            </PopoverContent>
          </Popover>
        ) : (
          <span className="tabular-nums">{text}</span>
        )}
        {canEdit && source === "manual" && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={reset}
            disabled={update.isPending}
            title="Reset to automatic"
            aria-label={`Reset ${label.toLowerCase()} to automatic`}
          >
            <LuRotateCcw aria-hidden />
          </Button>
        )}
      </dd>
    </div>
  );
}

/** Detail sheet: "Actual" block beside the planned dates, with variance chips. */
export function ActualDatesBlock({ task, permissions }: { task: Task; permissions: TaskPermissions }) {
  const canEdit = Boolean(permissions.canEditActualDates) && !permissions.readOnly;
  const startVariance = varianceDays(task.actualStartAt, task.startDate);
  const finishVariance = varianceDays(task.actualEndAt, task.dueDate);
  return (
    <section aria-labelledby={`actual-${task._id}`} className="rounded-lg border bg-muted/20 p-3">
      <h3 id={`actual-${task._id}`} className="sr-only">
        Actual dates
      </h3>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <ActualValue task={task} field="actualStartAt" label="Actual start" canEdit={canEdit} />
        <ActualValue task={task} field="actualEndAt" label="Actual end" canEdit={canEdit} />
      </dl>
      {(startVariance !== null || finishVariance !== null) && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <VarianceChip kind="start" days={startVariance} />
          <VarianceChip kind="finish" days={finishVariance} />
        </div>
      )}
    </section>
  );
}

/** Tasks table cell: the date-time with the variance in muted text below. */
export function ActualDateCell({ task, field }: { task: Task; field: ActualField }) {
  const value = task[field] ?? null;
  if (!value) return <span className="text-muted-foreground">--</span>;
  const days = field === "actualStartAt" ? varianceDays(value, task.startDate) : varianceDays(value, task.dueDate);
  return (
    <div className="flex flex-col tabular-nums">
      <span>{formatDateTime(value)}</span>
      {days !== null && (
        <span className="text-xs text-muted-foreground">{varianceText(field === "actualStartAt" ? "start" : "finish", days)}</span>
      )}
    </div>
  );
}
