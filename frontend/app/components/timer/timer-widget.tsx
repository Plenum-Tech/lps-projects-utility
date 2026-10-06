import { useEffect, useRef, useState } from "react";
import {
  LuLoaderCircle,
  LuPause,
  LuPlay,
  LuSave,
  LuSquare,
  LuTimer,
} from "react-icons/lu";
import { Link } from "react-router";

import { ShortCode } from "@/components/projects/project-badges";
import { StartTimerDialog } from "@/components/timer/start-timer-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentUser } from "@/hooks/use-auth";
import {
  useActiveTimer,
  usePauseTimer,
  useResumeTimer,
  useStopTimer,
  useUpdateTimeLog,
} from "@/hooks/use-timelogs";
import { formatClock, formatMinutes, formatTime, timerElapsedSeconds } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { TimeLog } from "@/types";

const MEMO_MAX = 500;

/** Live "01:02:03" that ticks every second while running, frozen while paused. */
function useElapsed(timer: TimeLog) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (timer.isPaused) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [timer.isPaused, timer._id, timer.breaks.length]);
  return timerElapsedSeconds(timer, now);
}

function timerCode(timer: TimeLog): string | null {
  return timer.task?.shortCode ?? timer.project?.code ?? null;
}

/** Announces timer state changes (not every tick) to screen readers. */
function useTimerAnnouncement(timer: TimeLog | null, ready: boolean) {
  const [message, setMessage] = useState("");
  const previous = useRef<"idle" | "running" | "paused" | null>(null);
  const state = timer ? (timer.isPaused ? "paused" : "running") : "idle";
  useEffect(() => {
    // Ignore the initial load so a reload doesn't announce "Timer started".
    if (!ready) return;
    if (previous.current !== null && previous.current !== state) {
      setMessage(
        state === "running"
          ? previous.current === "paused"
            ? "Timer resumed"
            : "Timer started"
          : state === "paused"
            ? "Timer paused"
            : "Timer stopped"
      );
    }
    previous.current = state;
  }, [state, ready]);
  return message;
}

/**
 * Global timer in the app header. Idle: a "Start timer" button. Running: a
 * pill with the live elapsed time opening a popover with details, memo,
 * pause/resume and stop. State comes from `useActiveTimer` (survives reloads)
 * and is kept in sync across tabs by `useTimeRealtime` (SSE `timer-updated`).
 */
export function TimerWidget() {
  const { data: user } = useCurrentUser();
  const active = useActiveTimer(Boolean(user));
  const timer = active.data ?? null;
  const [startOpen, setStartOpen] = useState(false);
  const announcement = useTimerAnnouncement(timer, !active.isPending);

  if (!user) return null;

  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
      {timer ? (
        <RunningTimer timer={timer} />
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setStartOpen(true)}
          disabled={active.isPending}
          aria-label="Start timer"
        >
          <LuTimer aria-hidden />
          <span className="hidden sm:inline">Start timer</span>
        </Button>
      )}
      <StartTimerDialog open={startOpen} onOpenChange={setStartOpen} />
    </>
  );
}

function RunningTimer({ timer }: { timer: TimeLog }) {
  const elapsed = useElapsed(timer);
  const code = timerCode(timer);
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className={cn(
              "gap-2 rounded-full pr-3 pl-2.5",
              timer.isPaused ? "border-chart-4/60 bg-chart-4/10" : "border-primary/40 bg-primary/5"
            )}
            aria-label={`Timer ${timer.isPaused ? "paused" : "running"}: ${formatClock(elapsed)}${
              code ? ` on ${code}` : ""
            }. Open timer details`}
          />
        }
      >
        <span aria-hidden className="relative flex size-2">
          {!timer.isPaused && (
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60 motion-reduce:hidden" />
          )}
          <span
            className={cn(
              "relative inline-flex size-2 rounded-full",
              timer.isPaused ? "bg-chart-4" : "bg-primary"
            )}
          />
        </span>
        <span aria-hidden className="font-mono text-xs font-semibold tabular-nums">
          {formatClock(elapsed)}
        </span>
        {code && (
          <span aria-hidden className="hidden max-w-24 truncate font-mono text-[0.7rem] text-muted-foreground sm:inline">
            {code}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[min(22rem,calc(100vw-2rem))] p-0">
        <TimerDetails timer={timer} elapsed={elapsed} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

function TimerDetails({
  timer,
  elapsed,
  onDone,
}: {
  timer: TimeLog;
  elapsed: number;
  onDone: () => void;
}) {
  const pause = usePauseTimer();
  const resume = useResumeTimer();
  const stop = useStopTimer();
  const updateLog = useUpdateTimeLog();
  const [memo, setMemo] = useState(timer.memo ?? "");

  // Pick up memo edits made in another tab while the popover is closed/clean.
  useEffect(() => {
    setMemo(timer.memo ?? "");
  }, [timer._id, timer.memo]);

  const memoDirty = memo.trim() !== (timer.memo ?? "").trim();
  const busy = pause.isPending || resume.isPending || stop.isPending;
  const breakMinutes = timer.breaks.reduce((sum, brk) => {
    const end = brk.endTime ? new Date(brk.endTime).getTime() : Date.now();
    return sum + Math.max(0, end - new Date(brk.startTime).getTime()) / 60000;
  }, 0);

  return (
    <div>
      <PopoverHeader className="border-b px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <PopoverTitle className="text-sm">
            {timer.isPaused ? "Timer paused" : "Timer running"}
          </PopoverTitle>
          <span className="font-mono text-lg font-semibold tabular-nums">
            {formatClock(elapsed)}
          </span>
        </div>
        <div className="mt-1 space-y-1">
          {timer.task && (
            <p className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
              {timer.task.shortCode && <ShortCode code={timer.task.shortCode} />}
              <span className="truncate">{timer.task.title}</span>
            </p>
          )}
          {timer.project && (
            <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {!timer.task && <ShortCode code={timer.project.code} />}
              <span className="truncate">{timer.project.name}</span>
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Started {formatTime(timer.startTime)}
            {breakMinutes >= 1 && ` · ${formatMinutes(breakMinutes)} on break`}
          </p>
        </div>
      </PopoverHeader>

      <div className="space-y-1.5 px-4 py-3">
        <Label htmlFor="timer-memo">Memo</Label>
        <Textarea
          id="timer-memo"
          value={memo}
          onChange={(event) => setMemo(event.target.value)}
          rows={2}
          maxLength={MEMO_MAX}
          placeholder="What are you working on?"
        />
        {memoDirty && (
          <div className="flex justify-end">
            <Button
              size="xs"
              variant="secondary"
              disabled={updateLog.isPending}
              onClick={() => updateLog.mutate({ id: timer._id, input: { memo: memo.trim() } })}
            >
              {updateLog.isPending ? (
                <LuLoaderCircle aria-hidden className="animate-spin" />
              ) : (
                <LuSave aria-hidden />
              )}
              Save memo
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
        {timer.isPaused ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => resume.mutate(undefined)}>
            {resume.isPending ? (
              <LuLoaderCircle aria-hidden className="animate-spin" />
            ) : (
              <LuPlay aria-hidden />
            )}
            Resume
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => pause.mutate(undefined)}
          >
            {pause.isPending ? (
              <LuLoaderCircle aria-hidden className="animate-spin" />
            ) : (
              <LuPause aria-hidden />
            )}
            Pause
          </Button>
        )}
        <Button
          variant="destructive"
          size="sm"
          disabled={busy}
          onClick={() =>
            stop.mutate(memoDirty ? memo.trim() : undefined, { onSuccess: onDone })
          }
        >
          {stop.isPending ? (
            <LuLoaderCircle aria-hidden className="animate-spin" />
          ) : (
            <LuSquare aria-hidden />
          )}
          Stop
        </Button>
        <Link
          to="/timelogs"
          onClick={onDone}
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "ml-auto")}
        >
          Time logs
        </Link>
      </div>
    </div>
  );
}
