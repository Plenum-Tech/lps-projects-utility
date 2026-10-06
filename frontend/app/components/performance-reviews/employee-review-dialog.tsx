import { useEffect, useId, useState, type FormEvent } from "react";
import { LuCircleAlert, LuCircleCheck, LuLoaderCircle } from "react-icons/lu";

import { formatDate } from "@/lib/format";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { useAcknowledgeReview } from "@/hooks/use-performance-reviews";
import { getErrorMessage } from "@/lib/api";
import type { GoalStatus, PerformanceReview } from "@/types";
import { ReviewBadges, ReviewContent } from "./review-content";

const GOAL_BADGE: Record<GoalStatus, { label: string; variant: "default" | "secondary" | "outline" }> = {
  completed: { label: "Completed", variant: "default" },
  in_progress: { label: "In progress", variant: "secondary" },
  not_started: { label: "Not started", variant: "outline" },
};

/** Employee's read-only view of a review, with the acknowledge form when pending. */
export function EmployeeReviewDialog({
  review,
  onOpenChange,
}: {
  review: PerformanceReview | null;
  onOpenChange: (open: boolean) => void;
}) {
  const open = review !== null;
  const acknowledge = useAcknowledgeReview();
  const [comments, setComments] = useState("");
  const commentsId = useId();

  useEffect(() => {
    if (open) {
      setComments("");
      acknowledge.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!review) return null;

  function handleAcknowledge(e: FormEvent) {
    e.preventDefault();
    acknowledge.mutate(
      { id: review!._id, input: { comments: comments.trim() || undefined } },
      { onSuccess: () => onOpenChange(false) }
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <ReviewBadges review={review} />
          </div>
          <DialogTitle>{review.period} performance review</DialogTitle>
          <DialogDescription>
            Reviewed by {review.reviewer.name} ·{" "}
            {formatDate(review.createdAt)}
          </DialogDescription>
        </DialogHeader>

        <ReviewContent
          review={review}
          goalAction={(goal) => (
            <Badge variant={GOAL_BADGE[goal.status].variant}>{GOAL_BADGE[goal.status].label}</Badge>
          )}
        />

        {review.employeeComments && (
          <section className="space-y-2 border-t pt-4">
            <h4 className="text-sm font-medium text-foreground">Your comments</h4>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
              {review.employeeComments}
            </p>
          </section>
        )}
        {review.acknowledgedAt && (
          <p className="text-xs text-muted-foreground">
            You acknowledged this review on {formatDate(review.acknowledgedAt)}.
          </p>
        )}

        {review.status === "pending_acknowledgment" && (
          <form onSubmit={handleAcknowledge} className="space-y-3 border-t pt-4">
            <h4 className="text-sm font-medium text-foreground">Acknowledge this review</h4>
            <p className="text-xs text-muted-foreground">
              Acknowledging confirms you&apos;ve read the feedback above. You can add a comment
              for your reviewer.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor={commentsId}>Comments (optional)</Label>
              <Textarea
                id={commentsId}
                value={comments}
                onChange={(e) => setComments(e.target.value)}
                placeholder="Anything you'd like your reviewer to know…"
                maxLength={5000}
                rows={3}
              />
            </div>
            {acknowledge.isError && (
              <Alert variant="destructive">
                <LuCircleAlert aria-hidden className="size-4" />
                <AlertDescription>{getErrorMessage(acknowledge.error)}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" disabled={acknowledge.isPending}>
              {acknowledge.isPending ? (
                <LuLoaderCircle aria-hidden className="animate-spin" />
              ) : (
                <LuCircleCheck />
              )}
              {acknowledge.isPending ? "Acknowledging…" : "Acknowledge review"}
            </Button>
          </form>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
