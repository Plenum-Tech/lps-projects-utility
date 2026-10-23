import { useEffect, useRef, useState, type FormEvent } from "react";
import { LuLoaderCircle, LuSave } from "react-icons/lu";

import { ShortCode } from "@/components/projects/project-badges";
import { validateTimeRange } from "@/components/timelogs/manual-time-log-dialog";
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
import { Textarea } from "@/components/ui/textarea";
import { useUpdateTimeLog } from "@/hooks/use-timelogs";
import { fromDateTimeInput, toDateTimeInput } from "@/lib/time";
import type { TimeLog, TimeLogUpdateInput } from "@/types";

const MEMO_MAX = 500;

/** Edit memo / start / end of a log, or move it to another task / project. A running timer only accepts its memo. */
export function EditTimeLogDialog({
  log: incoming,
  onOpenChange,
}: {
  /** The log being edited; null keeps the dialog closed. */
  log: TimeLog | null;
  onOpenChange: (open: boolean) => void;
}) {
  const updateLog = useUpdateTimeLog();
  // Keep the last log rendered while the dialog animates closed.
  const lastLog = useRef<TimeLog | null>(null);
  if (incoming) lastLog.current = incoming;
  const log = incoming ?? lastLog.current;
  const [memo, setMemo] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  // Where the time is booked: moving it to another task (or project) is part of editing.
  const [projectId, setProjectId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const open = Boolean(incoming);
  const running = Boolean(log?.isRunning);

  useEffect(() => {
    if (incoming) {
      const log = incoming;
      setMemo(log.memo ?? "");
      setStart(toDateTimeInput(log.startTime));
      setEnd(log.endTime ? toDateTimeInput(log.endTime) : "");
      setProjectId(log.project?._id ?? "");
      setTaskId(log.task?._id ?? "");
      setSubmitted(false);
    }
    // Reset only when a different log is opened (not on background refetches).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?._id, open]);

  const pending = updateLog.isPending;
  const rangeError = submitted && !running ? validateTimeRange(start, end) : null;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!log) return;
    setSubmitted(true);
    const input: TimeLogUpdateInput = {};
    if (memo.trim() !== (log.memo ?? "").trim()) input.memo = memo.trim();
    if (!running) {
      if (validateTimeRange(start, end)) return;
      if (start !== toDateTimeInput(log.startTime)) input.startTime = fromDateTimeInput(start);
      if (log.endTime && end !== toDateTimeInput(log.endTime)) {
        input.endTime = fromDateTimeInput(end);
      }
      // Moved to another task / project.
      if (taskId !== (log.task?._id ?? "") || projectId !== (log.project?._id ?? "")) {
        if (!taskId && !projectId) return;
        input.task = taskId || null;
        input.project = projectId || null;
      }
    }
    if (Object.keys(input).length === 0) {
      onOpenChange(false);
      return;
    }
    updateLog.mutate({ id: log._id, input }, { onSuccess: () => onOpenChange(false) });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit time log</DialogTitle>
          <DialogDescription>
            {running
              ? "This timer is still running — only the memo can be changed."
              : "Adjust the times or memo, or move the time to another task. Overlapping entries are rejected."}
          </DialogDescription>
        </DialogHeader>
        {log && (
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
              {log.task?.shortCode ? (
                <ShortCode code={log.task.shortCode} />
              ) : (
                log.project && <ShortCode code={log.project.code} />
              )}
              <span className="min-w-0 truncate">
                {log.task?.title ?? log.project?.name ?? "No project"}
              </span>
              <span className="ml-auto text-xs text-muted-foreground">{log.user.name}</span>
            </div>

            {!running && (
              <>
                <TimeTargetFields
                  idPrefix="edit-log"
                  projectId={projectId}
                  taskId={taskId}
                  enabled={open}
                  invalid={submitted && !projectId && !taskId}
                  onChange={(next) => {
                    setProjectId(next.projectId);
                    setTaskId(next.taskId);
                  }}
                />
                {(taskId !== (log.task?._id ?? "") || projectId !== (log.project?._id ?? "")) && (
                  <p className="-mt-2 text-xs text-muted-foreground">
                    Saving moves this time to the task chosen above (it leaves {log.task?.shortCode ?? log.project?.code ?? "where it is now"}).
                  </p>
                )}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="edit-log-start">Start</Label>
                    <Input
                      id="edit-log-start"
                      type="datetime-local"
                      value={start}
                      onChange={(event) => setStart(event.target.value)}
                      aria-invalid={Boolean(rangeError) || undefined}
                      aria-describedby={rangeError ? "edit-log-range-error" : undefined}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="edit-log-end">End</Label>
                    <Input
                      id="edit-log-end"
                      type="datetime-local"
                      value={end}
                      min={start || undefined}
                      onChange={(event) => setEnd(event.target.value)}
                      aria-invalid={Boolean(rangeError) || undefined}
                      aria-describedby={rangeError ? "edit-log-range-error" : undefined}
                    />
                  </div>
                </div>
                {rangeError && (
                  <p id="edit-log-range-error" className="-mt-2 text-xs text-destructive">
                    {rangeError}
                  </p>
                )}
              </>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="edit-log-memo">Memo</Label>
              <Textarea
                id="edit-log-memo"
                value={memo}
                onChange={(event) => setMemo(event.target.value)}
                rows={3}
                maxLength={MEMO_MAX}
                autoFocus={running}
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
                  <LuSave aria-hidden />
                )}
                Save changes
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
