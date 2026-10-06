import { useEffect, useState, type FormEvent } from "react";
import { LuLoaderCircle, LuPlus } from "react-icons/lu";

import { TimeTargetFields } from "@/components/timelogs/time-target-fields";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentUser } from "@/hooks/use-auth";
import { useAssignableUsers } from "@/hooks/use-task-meta";
import { useCreateTimeLog } from "@/hooks/use-timelogs";
import { formatMinutes, fromDateTimeInput, toDateTimeInput } from "@/lib/time";
import type { ManualTimeLogInput } from "@/types";

const MEMO_MAX = 500;
const ME = "me";

/**
 * Start/end validation shared by the manual-entry and edit dialogs.
 * Returns an error message, or null when the range is valid.
 */
export function validateTimeRange(start: string, end: string): string | null {
  if (!start || !end) return "Enter a start and an end time.";
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return "Enter valid dates.";
  if (endMs <= startMs) return "The end must be after the start.";
  const minutes = (endMs - startMs) / 60000;
  if (minutes < 1) return "Log at least one minute.";
  if (minutes > 24 * 60) return "A single entry can't exceed 24 hours.";
  if (endMs > Date.now() + 60_000) return "Time can't be logged in the future.";
  return null;
}

function rangeMinutes(start: string, end: string): number {
  const diff = (new Date(end).getTime() - new Date(start).getTime()) / 60000;
  return Number.isFinite(diff) && diff > 0 ? diff : 0;
}

function lastHour() {
  const end = new Date();
  end.setSeconds(0, 0);
  const start = new Date(end.getTime() - 60 * 60 * 1000);
  return { start: toDateTimeInput(start), end: toDateTimeInput(end) };
}

/**
 * Manual time entry. Prefill with `defaultProjectId` / `defaultTaskId`;
 * `lockProject` / `lockTask` keep them fixed (embedded panels). Heads and
 * admins can log on behalf of someone else. Overlaps (409) and permission
 * errors are toasted by the hook with the server message.
 */
export function ManualTimeLogDialog({
  open,
  onOpenChange,
  defaultProjectId,
  defaultTaskId,
  lockProject,
  lockTask,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultProjectId?: string;
  defaultTaskId?: string;
  lockProject?: boolean;
  lockTask?: boolean;
}) {
  const { data: me } = useCurrentUser();
  const canLogForOthers = me?.role === "admin" || me?.role === "head";
  const assignable = useAssignableUsers(open && canLogForOthers);
  const createLog = useCreateTimeLog();

  const [projectId, setProjectId] = useState(defaultProjectId ?? "");
  const [taskId, setTaskId] = useState(defaultTaskId ?? "");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [memo, setMemo] = useState("");
  const [userId, setUserId] = useState(ME);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (open) {
      const range = lastHour();
      setProjectId(defaultProjectId ?? "");
      setTaskId(defaultTaskId ?? "");
      setStart(range.start);
      setEnd(range.end);
      setMemo("");
      setUserId(ME);
      setSubmitted(false);
    }
  }, [open, defaultProjectId, defaultTaskId]);

  const pending = createLog.isPending;
  const targetInvalid = submitted && !projectId && !taskId;
  const rangeError = submitted ? validateTimeRange(start, end) : null;
  const minutes = rangeMinutes(start, end);

  const userItems: Record<string, string> = { [ME]: "Myself" };
  for (const user of assignable.data ?? []) {
    if (user._id !== me?._id) userItems[user._id] = user.name;
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if ((!projectId && !taskId) || validateTimeRange(start, end)) return;
    const input: ManualTimeLogInput = {
      ...(taskId ? { task: taskId } : { project: projectId }),
      startTime: fromDateTimeInput(start),
      endTime: fromDateTimeInput(end),
      ...(memo.trim() ? { memo: memo.trim() } : {}),
      ...(userId !== ME ? { user: userId } : {}),
    };
    createLog.mutate(input, { onSuccess: () => onOpenChange(false) });
  }

  const nowInput = toDateTimeInput(new Date());

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Log time</DialogTitle>
          <DialogDescription>
            Add time you worked without the timer. Entries can&apos;t overlap your other logs.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          {canLogForOthers && (
            <div className="space-y-1.5">
              <Label htmlFor="manual-log-user">Log for</Label>
              <Select
                value={userId}
                onValueChange={(value) => setUserId(String(value ?? ME))}
                items={userItems}
              >
                <SelectTrigger id="manual-log-user" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(userItems).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {assignable.isError && (
                <p className="text-xs text-destructive">Couldn&apos;t load people.</p>
              )}
            </div>
          )}

          <TimeTargetFields
            idPrefix="manual-log"
            projectId={projectId}
            taskId={taskId}
            enabled={open}
            lockProject={lockProject}
            lockTask={lockTask}
            invalid={targetInvalid}
            onChange={(next) => {
              setProjectId(next.projectId);
              setTaskId(next.taskId);
            }}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="manual-log-start">Start</Label>
              <Input
                id="manual-log-start"
                type="datetime-local"
                value={start}
                max={nowInput}
                onChange={(event) => setStart(event.target.value)}
                aria-invalid={Boolean(rangeError) || undefined}
                aria-describedby={rangeError ? "manual-log-range-error" : "manual-log-duration"}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="manual-log-end">End</Label>
              <Input
                id="manual-log-end"
                type="datetime-local"
                value={end}
                min={start || undefined}
                max={nowInput}
                onChange={(event) => setEnd(event.target.value)}
                aria-invalid={Boolean(rangeError) || undefined}
                aria-describedby={rangeError ? "manual-log-range-error" : "manual-log-duration"}
              />
            </div>
          </div>
          {rangeError ? (
            <p id="manual-log-range-error" className="-mt-2 text-xs text-destructive">
              {rangeError}
            </p>
          ) : (
            <p id="manual-log-duration" className="-mt-2 text-xs text-muted-foreground">
              Duration: <span className="tabular-nums">{formatMinutes(minutes)}</span>
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="manual-log-memo">Memo</Label>
            <Textarea
              id="manual-log-memo"
              value={memo}
              onChange={(event) => setMemo(event.target.value)}
              rows={2}
              maxLength={MEMO_MAX}
              placeholder="What did you work on? (optional)"
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? (
                <LuLoaderCircle aria-hidden className="animate-spin" />
              ) : (
                <LuPlus aria-hidden />
              )}
              Log time
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
