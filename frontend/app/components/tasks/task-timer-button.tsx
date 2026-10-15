import { LuLoaderCircle, LuPlay, LuSquare } from "react-icons/lu";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTimeLogSettings } from "@/hooks/use-project-meta";
import { useActiveTimer, useStartTaskTimer, useStopTimer } from "@/hooks/use-timelogs";
import { taskCode } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { ProjectSettings, Role, Task } from "@/types";

/**
 * Why time can't be logged on this task (client-side mirror of the server's
 * rules; the server re-checks and its message is toasted). Null = allowed.
 */
export function timerBlockedReason(
  task: Task,
  me: { _id: string; role: Role },
  logTimeFor?: ProjectSettings["logTimeFor"]
): string | null {
  if (task.status === "completed") return "Completed tasks can't take time";
  if (task.project?.archivedAt) return "This project is archived";
  if (logTimeFor === "project" && !task.project) {
    return "Time is logged against projects — add this task to a project to track time";
  }
  if (me.role === "admin" || me.role === "head") return null;
  const involved =
    task.assignees.some((user) => user._id === me._id) || task.assignedBy?._id === me._id;
  // Project members may log on any task of the project — the server knows.
  if (involved || task.project) return null;
  return "Only assignees can log time on this task";
}

/**
 * ▶ starts a timer on the task, ■ stops it when your running timer is on this
 * task. A 409 (another timer running) offers "Stop & start" in the toast.
 */
export function TaskTimerButton({
  task,
  me,
  className,
}: {
  task: Task;
  me: { _id: string; role: Role };
  className?: string;
}) {
  const active = useActiveTimer();
  const start = useStartTaskTimer();
  const stop = useStopTimer();
  const timeSettings = useTimeLogSettings();

  const runningHere = Boolean(active.data && active.data.task?._id === task._id);
  // Archived projects and view-only rows (another person's task) are read-only:
  // no timer button at all (unless one is somehow running here).
  if ((task.project?.archivedAt || task.access === "read") && !runningHere) return null;
  const blocked = runningHere ? null : timerBlockedReason(task, me, timeSettings.data?.logTimeFor);
  const pending = start.isPending || stop.isPending;
  const code = taskCode(task) || task.title;
  const label = runningHere
    ? `Stop the timer on ${code}`
    : blocked
      ? `Can't start a timer: ${blocked}`
      : `Start a timer on ${code}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={runningHere}
            aria-disabled={Boolean(blocked) || pending || undefined}
            onClick={() => {
              if (blocked || pending) return;
              if (runningHere) stop.mutate(undefined);
              else start.mutate({ taskId: task._id });
            }}
            className={cn(
              "inline-flex size-6 items-center justify-center rounded-full border transition-colors duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              runningHere
                ? "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20"
                : "border-primary/30 bg-primary/10 text-primary hover:bg-primary/20",
              (blocked || pending) && "cursor-not-allowed opacity-45 hover:bg-primary/10",
              className
            )}
          />
        }
      >
        {pending ? (
          <LuLoaderCircle aria-hidden className="size-3 animate-spin" />
        ) : runningHere ? (
          <LuSquare aria-hidden className="size-2.5 fill-current" />
        ) : (
          <LuPlay aria-hidden className="ml-px size-3 fill-current" />
        )}
      </TooltipTrigger>
      <TooltipContent>{runningHere ? "Stop timer" : (blocked ?? "Start timer")}</TooltipContent>
    </Tooltip>
  );
}

/** Task page header: a labelled Start timer / Stop timer button for this task. */
export function TaskTimerAction({ task, me }: { task: Task; me: { _id: string; role: Role } }) {
  const active = useActiveTimer();
  const start = useStartTaskTimer();
  const stop = useStopTimer();
  const timeSettings = useTimeLogSettings();
  const runningHere = Boolean(active.data && active.data.task?._id === task._id);
  if (task.project?.archivedAt && !runningHere) return null;
  const blocked = runningHere ? null : timerBlockedReason(task, me, timeSettings.data?.logTimeFor);
  if (blocked) return null;
  const pending = start.isPending || stop.isPending;
  return (
    <Button
      size="sm"
      variant={runningHere ? "destructive" : "outline"}
      disabled={pending}
      onClick={() => (runningHere ? stop.mutate(undefined) : start.mutate({ taskId: task._id }))}
    >
      {pending ? (
        <LuLoaderCircle aria-hidden className="animate-spin" />
      ) : runningHere ? (
        <LuSquare aria-hidden />
      ) : (
        <LuPlay aria-hidden />
      )}
      {runningHere ? "Stop timer" : "Start timer"}
    </Button>
  );
}
