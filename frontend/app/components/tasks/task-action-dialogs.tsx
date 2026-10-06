import { useEffect, useState, type FormEvent } from "react";
import { LuCircleCheck, LuCircleX, LuLoaderCircle, LuSend, LuTrash2 } from "react-icons/lu";

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
import { useDeleteTask, useReviewTask, useSubmitTask } from "@/hooks/use-tasks";
import type { Task } from "@/types";

/** Assignee: submit work (with optional notes) for review. */
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
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (open) setNotes(task.submissionNotes ?? "");
  }, [open, task.submissionNotes]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    submit.mutate(
      { id: task._id, input: { submissionNotes: notes.trim() || undefined } },
      { onSuccess: () => onOpenChange(false) }
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !submit.isPending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {task.project?.requireTaskApproval === false ? "Mark as complete" : "Submit for review"}
          </DialogTitle>
          <DialogDescription>
            {task.project?.requireTaskApproval === false ? (
              <>
                &ldquo;{task.title}&rdquo; is completed straight away — this project doesn&apos;t
                require a review.
              </>
            ) : (
              <>
                &ldquo;{task.title}&rdquo; goes to {task.assignedBy?.name ?? "the creator"} for
                review.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="submission-notes">Notes for the reviewer (optional)</Label>
            <Textarea
              id="submission-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={4}
              placeholder="What did you do? Anything the reviewer should check?"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submit.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submit.isPending}>
              {submit.isPending ? (
                <LuLoaderCircle aria-hidden className="animate-spin" />
              ) : (
                <LuSend aria-hidden />
              )}
              {submit.isPending ? "Submitting…" : "Submit"}
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
  const [decision, setDecision] = useState<"approved" | "rejected" | null>(null);

  useEffect(() => {
    if (open) {
      setNotes("");
      setDecision(null);
    }
  }, [open]);

  function decide(next: "approved" | "rejected") {
    setDecision(next);
    review.mutate(
      { id: task._id, input: { decision: next, reviewNotes: notes.trim() || undefined } },
      { onSuccess: () => onOpenChange(false) }
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !review.isPending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Review submission</DialogTitle>
          <DialogDescription>
            Approve to complete &ldquo;{task.title}&rdquo;, or send it back with feedback.
          </DialogDescription>
        </DialogHeader>
        {task.submissionNotes && (
          <div className="rounded-lg bg-muted/60 p-3 text-sm">
            <p className="text-xs font-medium text-muted-foreground">Submission notes</p>
            <p className="mt-1 whitespace-pre-wrap text-foreground">{task.submissionNotes}</p>
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
          <Button onClick={() => decide("approved")} disabled={review.isPending}>
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
    <AlertDialog open={open} onOpenChange={(next) => !remove.isPending && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this task?</AlertDialogTitle>
          <AlertDialogDescription>
            &ldquo;{task.title}&rdquo; and its comments, files and history will be removed for
            everyone. This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
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
