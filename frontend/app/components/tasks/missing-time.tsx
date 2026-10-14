import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { LuClockAlert, LuLoaderCircle } from "react-icons/lu";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCreateTimeLog } from "@/hooks/use-timelogs";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { fromDateTimeInput, toDateTimeInput } from "@/lib/time";
import type { Task } from "@/types";

interface MissingTimeResponse {
  total: number;
  tasks: Array<{
    _id: string;
    title: string;
    shortCode: string | null;
    project: { _id: string; name: string } | null;
    completedAt: string | null;
  }>;
}

/** My completed tasks (since the move to Utility) with no time logged. */
export function useMissingTimeTasks(enabled = true) {
  return useQuery({
    queryKey: ["tasks", "missing-time"] as const,
    queryFn: async () => (await api.get<MissingTimeResponse>("/tasks/missing-time")).data,
    enabled,
    staleTime: 60_000,
  });
}

/** Actual start + time taken → one time entry (split per working day by the server). */
function AddMissingTimeDialog({ task, open, onOpenChange }: { task: Task; open: boolean; onOpenChange: (open: boolean) => void }) {
  const createLog = useCreateTimeLog();
  const [start, setStart] = useState("");
  const [hours, setHours] = useState("");
  const [minutes, setMinutes] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStart(toDateTimeInput(task.actualStartAt ?? task.startDate ?? task.createdAt));
    setHours("");
    setMinutes("");
    setSubmitted(false);
  }, [open, task]);

  const total = (Number(hours) || 0) * 60 + (Number(minutes) || 0);
  const startDate = start ? new Date(fromDateTimeInput(start)) : null;
  const startError = !startDate || Number.isNaN(startDate.getTime())
    ? "Enter when you started."
    : startDate.getTime() > Date.now()
      ? "The start can't be in the future."
      : null;
  const timeError =
    !Number.isInteger(Number(hours || 0)) || !Number.isInteger(Number(minutes || 0)) || Number(minutes || 0) > 59 || total <= 0
      ? "Enter the time taken (hours and minutes)."
      : null;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (startError || timeError || !startDate) return;
    createLog.mutate(
      {
        task: task._id,
        startTime: startDate.toISOString(),
        endTime: new Date(startDate.getTime() + total * 60_000).toISOString(),
        memo: "Added after completion",
        completion: true,
      },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !createLog.isPending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add the time for this task</DialogTitle>
          <DialogDescription>
            It was completed without any time. Enter when you actually started and how long it took.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="missing-time-start">Actual start</Label>
            <Input
              id="missing-time-start"
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              aria-invalid={(submitted && Boolean(startError)) || undefined}
            />
            {submitted && startError && <p className="text-xs text-destructive">{startError}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="missing-time-hours">Time taken</Label>
            <div className="flex items-center gap-2">
              <Input
                id="missing-time-hours"
                type="number"
                min={0}
                inputMode="numeric"
                placeholder="0"
                className="w-24"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                aria-label="Hours"
              />
              <span className="text-sm text-muted-foreground">h</span>
              <Input
                type="number"
                min={0}
                max={59}
                inputMode="numeric"
                placeholder="0"
                className="w-24"
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                aria-label="Minutes"
              />
              <span className="text-sm text-muted-foreground">min</span>
            </div>
            {submitted && timeError && <p className="text-xs text-destructive">{timeError}</p>}
            <p className="text-xs text-muted-foreground">More than 8 hours is spread over the following working days.</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={createLog.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={createLog.isPending}>
              {createLog.isPending && <LuLoaderCircle aria-hidden className="animate-spin" />}
              Save time
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Task page: shown to the assignee of a completed task with no time logged. */
export function MissingTimePrompt({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);
  if (!task.needsTimeEntry) return null;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <p className="flex items-start gap-2 text-foreground">
        <LuClockAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-600" />
        <span>
          <span className="font-medium">This task was completed without any time.</span>{" "}
          Add when you actually started and how long it took.
        </span>
      </p>
      <Button size="sm" onClick={() => setOpen(true)}>
        Add time
      </Button>
      <AddMissingTimeDialog task={task} open={open} onOpenChange={setOpen} />
    </div>
  );
}

/** My dashboard: my completed tasks still missing their time. Hidden when there are none. */
export function MissingTimeCard({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const query = useMissingTimeTasks();
  const data = query.data;
  if (!data || data.total === 0) return null;
  return (
    <section
      aria-labelledby="missing-time-heading"
      className="mt-6 space-y-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4"
    >
      <h2 id="missing-time-heading" className="flex items-center gap-2 text-sm font-medium text-foreground">
        <LuClockAlert aria-hidden className="size-4 text-amber-600" />
        {data.total} completed task{data.total === 1 ? "" : "s"} without time
      </h2>
      <p className="text-xs text-muted-foreground">Open each one and add when you started and how long it took.</p>
      <ul className="divide-y text-sm">
        {data.tasks.slice(0, 8).map((t) => (
          <li key={t._id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <button
              type="button"
              onClick={() => onOpenTask(t._id)}
              className="min-w-0 truncate text-left text-foreground hover:underline"
            >
              {t.shortCode && <span className="mr-2 font-mono text-xs text-muted-foreground">{t.shortCode}</span>}
              {t.title}
            </button>
            <span className="text-xs text-muted-foreground">
              {t.project?.name ? `${t.project.name} · ` : ""}completed {formatDate(t.completedAt)}
            </span>
          </li>
        ))}
      </ul>
      {data.total > 8 && (
        <Link to="/tasks" className="text-xs text-primary underline underline-offset-2">
          {data.total - 8} more in your tasks
        </Link>
      )}
    </section>
  );
}
