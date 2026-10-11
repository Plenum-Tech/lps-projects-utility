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
import { Input } from "@/components/ui/input";
import type { Task } from "@/types";

/**
 * Assignee: complete the task (or send it for review). The final deliverable sits
 * at the top — upload a file or paste a link — and is required unless an outcome
 * note is written. Time must be logged first.
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
  const [notes, setNotes] = useState("");
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
      setSubmitted(false);
    }
  }, [open, task.submissionNotes, task.finalFile?.url]);

  const direct = task.project?.requireTaskApproval === false;
  // Logged time is optional for completion.
  const noTime = false;
  const linkValue = link.trim();
  const linkInvalid =
    mode === "link" && linkValue !== "" && !/^https?:\/\/\S+$/i.test(linkValue);
  const hasFinal =
    (mode === "file" && Boolean(file)) ||
    (mode === "link" && linkValue !== "" && !linkInvalid);
  const missingFinal =
    !hasFinal &&
    !notes.trim() &&
    !task.finalFile?.fileId &&
    !task.finalFile?.url;
  const pending = submit.isPending || upload.isPending;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (noTime || missingFinal || linkInvalid) return;
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
              Required when there is no final file or link.
            </p>
          </div>
          {submitted && missingFinal && (
            <p className="text-xs text-destructive">
              Add the final file or link, or write an outcome note.
            </p>
          )}

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
