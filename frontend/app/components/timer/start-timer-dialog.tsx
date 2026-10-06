import { useEffect, useState, type FormEvent } from "react";
import { LuLoaderCircle, LuPlay } from "react-icons/lu";

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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useStartTimer } from "@/hooks/use-timelogs";

const MEMO_MAX = 500;

/**
 * Start the global timer on a project and/or task with an optional memo.
 * The server decides whether a project or a task is required (`logTimeFor`)
 * and its 400/409 messages surface as toasts.
 */
export function StartTimerDialog({
  open,
  onOpenChange,
  defaultProjectId,
  defaultTaskId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultProjectId?: string;
  defaultTaskId?: string;
}) {
  const startTimer = useStartTimer();
  const [projectId, setProjectId] = useState(defaultProjectId ?? "");
  const [taskId, setTaskId] = useState(defaultTaskId ?? "");
  const [memo, setMemo] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (open) {
      setProjectId(defaultProjectId ?? "");
      setTaskId(defaultTaskId ?? "");
      setMemo("");
      setSubmitted(false);
    }
  }, [open, defaultProjectId, defaultTaskId]);

  const targetInvalid = submitted && !projectId && !taskId;
  const pending = startTimer.isPending;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!projectId && !taskId) return;
    startTimer.mutate(
      {
        ...(taskId ? { task: taskId } : { project: projectId }),
        ...(memo.trim() ? { memo: memo.trim() } : {}),
      },
      { onSuccess: () => onOpenChange(false) }
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Start timer</DialogTitle>
          <DialogDescription>
            Pick what you&apos;re working on. The timer keeps running across tabs and reloads.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <TimeTargetFields
            idPrefix="start-timer"
            projectId={projectId}
            taskId={taskId}
            enabled={open}
            invalid={targetInvalid}
            onChange={(next) => {
              setProjectId(next.projectId);
              setTaskId(next.taskId);
            }}
          />
          <div className="space-y-1.5">
            <Label htmlFor="start-timer-memo">Memo</Label>
            <Textarea
              id="start-timer-memo"
              value={memo}
              onChange={(event) => setMemo(event.target.value)}
              rows={2}
              maxLength={MEMO_MAX}
              placeholder="What are you working on? (optional)"
            />
            <p className="text-right text-xs text-muted-foreground tabular-nums">
              {memo.length}/{MEMO_MAX}
            </p>
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
                <LuPlay aria-hidden />
              )}
              Start timer
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
