import { useEffect, useState, type FormEvent } from "react";
import {
  LuCircleCheck,
  LuCircleX,
  LuLoaderCircle,
  LuSend,
  LuTrash2,
} from "react-icons/lu";

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
import {
  useDeleteTask,
  useReviewTask,
  useSubmitTask,
  useUploadTaskFiles,
} from "@/hooks/use-tasks";
import { ACCEPT } from "@/components/tasks/task-files";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { api, getErrorMessage } from "@/lib/api";
import { Input } from "@/components/ui/input";
import type { Task } from "@/types";

/**
 * Complete the task (or send it for review). Time spent is mandatory (entered
 * here unless already logged); the final file or link and the outcome note are optional.
 */
export function SubmitTaskDialog({
  task,
  open,
  onOpenChange,
}: {
  task: Task;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const submit = useSubmitTask();
  const upload = useUploadTaskFiles(task._id);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [notes, setNotes] = useState("");
  const [hours, setHours] = useState("");
  const [minutes, setMinutes] = useState("");
  const [logging, setLogging] = useState(false);
  const [mode, setMode] = useState<"file" | "link">("file");
  const [file, setFile] = useState<File | null>(null);
  const [link, setLink] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (open) {
      setNotes(task.submissionNotes ?? "");
      setLink(task.finalFile?.url ?? "");
      setMode(task.finalFile?.url ? "link" : "file");
      setFile(null);
      setHours("");
      setMinutes("");
      setSubmitted(false);
    }
  }, [open, task.submissionNotes, task.finalFile?.url]);

  const direct = task.project?.requireTaskApproval === false;
  // Logged time is optional for completion.
  const noTime = false;
  const linkValue = link.trim();
  const linkInvalid =
    mode === "link" && linkValue !== "" && !/^https?:\/\/\S+$/i.test(linkValue);
  const h = hours.trim() === "" ? 0 : Number(hours);
  const m = minutes.trim() === "" ? 0 : Number(minutes);
  const timeInvalid = !Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0 || m > 59 || h > 23;
  const spent = timeInvalid ? 0 : h * 60 + m;
  // Time spent is mandatory: required here unless time is already logged on the task.
  const alreadyLogged = (task.loggedMinutes ?? 0) > 0;
  const timeMissing = !alreadyLogged && spent === 0;
  const pending = submit.isPending || upload.isPending || logging;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (noTime || linkInvalid || timeInvalid || timeMissing) return;
    // Time spent is logged on the task first (ending now), then the task is completed.
    if (spent > 0) {
      setLogging(true);
      try {
        const end = new Date();
        await api.post("/timelogs", {
          task: task._id,
          project: task.project?._id,
          startTime: new Date(end.getTime() - spent * 60_000).toISOString(),
          endTime: end.toISOString(),
          memo: "Logged when completing the task",
        });
        void queryClient.invalidateQueries({ queryKey: ["timelogs"] });
        setHours("");
        setMinutes("");
      } catch (error) {
        toast.error(getErrorMessage(error));
        return;
      } finally {
        setLogging(false);
      }
    }
    let finalFileId: string | undefined;
    if (mode === "file" && file) {
      const uploaded = await upload
        .mutateAsync({ files: [file] })
        .catch(() => null);
      if (!uploaded?.[0]) return;
      finalFileId = uploaded[0]._id;
    }
    submit.mutate(
      {
        id: task._id,
        input: {
          submissionNotes: notes.trim() || undefined,
          ...(finalFileId ? { finalFileId } : {}),
          ...(mode === "link" && linkValue ? { finalUrl: linkValue } : {}),
        },
      },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {direct ? "Mark as complete" : "Submit for review"}
          </DialogTitle>
          <DialogDescription>
            {direct ? (
              <>
                &ldquo;{task.title}&rdquo; is completed straight away — this
                project doesn&apos;t require a review.
              </>
            ) : (
              <>
                &ldquo;{task.title}&rdquo; goes to{" "}
                {task.assignedBy?.name ?? "the creator"} for review.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {noTime && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              No time is logged on this task yet. Log your time (Time tab or the
              timer) before completing it.
            </p>
          )}

          <fieldset className="space-y-2 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">Final file</legend>
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                variant={mode === "file" ? "secondary" : "ghost"}
                onClick={() => setMode("file")}
              >
                Upload a file
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mode === "link" ? "secondary" : "ghost"}
                onClick={() => setMode("link")}
              >
                Paste a link
              </Button>
            </div>
            {mode === "file" ? (
              <Input
                type="file"
                accept={ACCEPT}
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                aria-label="Final file"
              />
            ) : (
              <Input
                type="url"
                value={link}
                onChange={(event) => setLink(event.target.value)}
                placeholder="https://… (Drive, SharePoint, Figma, YouTube…)"
                aria-label="Final link"
                aria-invalid={(submitted && linkInvalid) || undefined}
              />
            )}
            {(task.finalFile?.fileId || task.finalFile?.url) &&
              !file &&
              !linkValue && (
                <p className="text-xs text-muted-foreground">
                  A final deliverable is already recorded for this task.
                </p>
              )}
            {submitted && linkInvalid && (
              <p className="text-xs text-destructive">
                The link must start with http:// or https://.
              </p>
            )}
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor="submission-notes">Outcome note</Label>
            <Textarea
              id="submission-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={3}
              placeholder="What was delivered? Anything the reviewer should check?"
            />
            <p className="text-xs text-muted-foreground">
              Optional.
            </p>
          </div>

          <fieldset className="space-y-1.5">
            <legend className="mb-1.5 text-sm leading-none font-medium">
              Time spent
              {!alreadyLogged && (
                <span aria-hidden className="ml-0.5 text-destructive">
                  *
                </span>
              )}
            </legend>
            <div className="flex items-center gap-2">
              <Input
                aria-label="Hours"
                inputMode="numeric"
                value={hours}
                onChange={(event) => setHours(event.target.value)}
                placeholder="0"
                className="w-20"
              />
              <span className="text-sm text-muted-foreground">h</span>
              <Input
                aria-label="Minutes"
                inputMode="numeric"
                value={minutes}
                onChange={(event) => setMinutes(event.target.value)}
                placeholder="0"
                className="w-20"
              />
              <span className="text-sm text-muted-foreground">m</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {task.loggedMinutes
                ? `${Math.floor(task.loggedMinutes / 60)}h ${task.loggedMinutes % 60}m already logged. Add any time not logged yet.`
                : "No time logged yet. Enter the time spent; it's logged on the Time tab, ending now."}
            </p>
            {submitted && timeMissing && !timeInvalid && (
              <p className="text-xs text-destructive">Enter the time spent on this task.</p>
            )}
            {submitted && timeInvalid && (
              <p className="text-xs text-destructive">Enter whole hours (0–23) and minutes (0–59).</p>
            )}
          </fieldset>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || noTime}>
              {pending ? (
                <LuLoaderCircle aria-hidden className="animate-spin" />
              ) : (
                <LuSend aria-hidden />
              )}
              {upload.isPending
                ? "Uploading…"
                : submit.isPending
                  ? "Submitting…"
                  : direct
                    ? "Complete"
                    : "Submit"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Creator/admin: approve or reject a submission. */
export function ReviewTaskDialog({
  task,
  open,
  onOpenChange,
}: {
  task: Task;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const review = useReviewTask();
  const [notes, setNotes] = useState("");
  const [decision, setDecision] = useState<"approved" | "rejected" | null>(
    null,
  );

  useEffect(() => {
    if (open) {
      setNotes("");
      setDecision(null);
    }
  }, [open]);

  function decide(next: "approved" | "rejected") {
    setDecision(next);
    review.mutate(
      {
        id: task._id,
        input: { decision: next, reviewNotes: notes.trim() || undefined },
      },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !review.isPending && onOpenChange(next)}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Review submission</DialogTitle>
          <DialogDescription>
            Approve to complete &ldquo;{task.title}&rdquo;, or send it back with
            feedback.
          </DialogDescription>
        </DialogHeader>
        {task.submissionNotes && (
          <div className="rounded-lg bg-muted/60 p-3 text-sm">
            <p className="text-xs font-medium text-muted-foreground">
              Submission notes
            </p>
            <p className="mt-1 whitespace-pre-wrap text-foreground">
              {task.submissionNotes}
            </p>
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="review-notes">Feedback (optional)</Label>
          <Textarea
            id="review-notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={3}
            placeholder="Shared with the assignees"
          />
        </div>
        <DialogFooter>
          <Button
            variant="destructive"
            onClick={() => decide("rejected")}
            disabled={review.isPending}
          >
            {review.isPending && decision === "rejected" ? (
              <LuLoaderCircle aria-hidden className="animate-spin" />
            ) : (
              <LuCircleX aria-hidden />
            )}
            Reject
          </Button>
          <Button
            onClick={() => decide("approved")}
            disabled={review.isPending}
          >
            {review.isPending && decision === "approved" ? (
              <LuLoaderCircle aria-hidden className="animate-spin" />
            ) : (
              <LuCircleCheck aria-hidden />
            )}
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Creator/admin: permanently delete a task. */
export function DeleteTaskDialog({
  task,
  open,
  onOpenChange,
  onDeleted,
}: {
  task: Task;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const remove = useDeleteTask();

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => !remove.isPending && onOpenChange(next)}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this task?</AlertDialogTitle>
          <AlertDialogDescription>
            &ldquo;{task.title}&rdquo; and its comments, files and history will
            be removed for everyone. This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>
            Cancel
          </AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(task._id, {
                onSuccess: () => {
                  onOpenChange(false);
                  onDeleted();
                },
              })
            }
          >
            {remove.isPending ? (
              <LuLoaderCircle aria-hidden className="animate-spin" />
            ) : (
              <LuTrash2 aria-hidden />
            )}
            Delete task
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
