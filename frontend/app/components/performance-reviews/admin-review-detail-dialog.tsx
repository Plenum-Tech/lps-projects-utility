import { useEffect, useState } from "react";
import { LuCircleCheck, LuLoaderCircle, LuLock, LuPencil, LuSend } from "react-icons/lu";

import { formatDate } from "@/lib/format";
import { ConfirmDialog } from "@/components/globals/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCurrentUser } from "@/hooks/use-auth";
import { useUpdateGoal, useUpdateReview } from "@/hooks/use-performance-reviews";
import { getErrorMessage } from "@/lib/api";
import type { GoalStatus, PerformanceReview, UpdateReviewInput } from "@/types";
import { ReviewBadges, ReviewContent } from "./review-content";
import { ReviewForm, reviewToFormValues, type ReviewFormValues } from "./review-form";

const GOAL_STATUS_ITEMS: Record<GoalStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  completed: "Completed",
};

/** Only the fields that differ from the saved review. */
function changedFields(review: PerformanceReview, values: ReviewFormValues): UpdateReviewInput {
  const before = reviewToFormValues(review);
  const input: UpdateReviewInput = {};
  if (JSON.stringify(before.ratings) !== JSON.stringify(values.ratings)) {
    input.ratings = values.ratings;
  }
  if (JSON.stringify(before.goals) !== JSON.stringify(values.goals)) {
    input.goals = values.goals;
  }
  if (before.summary !== values.summary) input.summary = values.summary;
  if (before.strengths !== values.strengths) input.strengths = values.strengths;
  if (before.improvements !== values.improvements) input.improvements = values.improvements;
  return input;
}

/**
 * Admin/head review detail. The reviewer (or an admin) can edit a draft,
 * send it to the employee — after which the content is locked — and track
 * goals and completion.
 */
export function AdminReviewDetailDialog({
  review: initialReview,
  onOpenChange,
}: {
  review: PerformanceReview | null;
  onOpenChange: (open: boolean) => void;
}) {
  const open = initialReview !== null;
  const me = useCurrentUser().data;
  const updateReview = useUpdateReview();
  const updateGoalMut = useUpdateGoal();
  const [review, setReview] = useState<PerformanceReview | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);

  // Reset local state when a different review is opened.
  useEffect(() => {
    setReview(initialReview);
    setEditing(false);
    setConfirmSend(false);
    updateReview.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialReview?._id]);

  if (!review) return null;

  const canManage = me?.role === "admin" || review.reviewer._id === me?._id;
  const canEdit = canManage && review.status === "draft";

  function handleStatus(status: UpdateReviewInput["status"], onDone?: () => void) {
    updateReview.mutate(
      { id: review!._id, input: { status } },
      {
        onSuccess: (res) => {
          setReview(res.review);
          onDone?.();
        },
      }
    );
  }

  function handleSave(values: ReviewFormValues) {
    const input = changedFields(review!, values);
    if (Object.keys(input).length === 0) {
      setEditing(false);
      return;
    }
    updateReview.mutate(
      { id: review!._id, input },
      {
        onSuccess: (res) => {
          setReview(res.review);
          setEditing(false);
        },
      }
    );
  }

  function handleGoalUpdate(goalIndex: number, status: GoalStatus) {
    updateGoalMut.mutate(
      { reviewId: review!._id, goalIndex, input: { status } },
      { onSuccess: (res) => setReview(res.review) }
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <ReviewBadges review={review} />
          </div>
          <DialogTitle>
            {editing ? "Edit review — " : ""}
            {review.employee.name} · {review.period}
          </DialogTitle>
          <DialogDescription>
            Reviewed by {review.reviewer.name} · created{" "}
            {formatDate(review.createdAt)}
          </DialogDescription>
        </DialogHeader>

        {editing ? (
          <ReviewForm
            mode="edit"
            review={review}
            pending={updateReview.isPending}
            error={updateReview.isError ? getErrorMessage(updateReview.error) : undefined}
            onSubmit={handleSave}
            onCancel={() => {
              updateReview.reset();
              setEditing(false);
            }}
          />
        ) : (
          <>
            {review.status !== "draft" && canManage && (
              <p className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                <LuLock aria-hidden className="size-3.5 shrink-0" />
                Sent to the employee — the content is locked. Goal progress can still be updated.
              </p>
            )}

            <ReviewContent
              review={review}
              goalAction={(goal, idx) =>
                canManage ? (
                  <Select
                    value={goal.status}
                    onValueChange={(value) => value && handleGoalUpdate(idx, value as GoalStatus)}
                    items={GOAL_STATUS_ITEMS}
                    disabled={updateGoalMut.isPending}
                  >
                    <SelectTrigger className="w-36" aria-label={`Status of goal: ${goal.title}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(GOAL_STATUS_ITEMS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {GOAL_STATUS_ITEMS[goal.status]}
                  </span>
                )
              }
            />

            {review.employeeComments && (
              <section className="space-y-2 border-t pt-4">
                <h4 className="text-sm font-medium text-foreground">Employee&apos;s comments</h4>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                  {review.employeeComments}
                </p>
              </section>
            )}
            {review.acknowledgedAt && (
              <p className="text-xs text-muted-foreground">
                Acknowledged on {formatDate(review.acknowledgedAt)}
              </p>
            )}

            {canManage && (canEdit || review.status === "acknowledged") && (
              <div className="flex flex-wrap gap-2 border-t pt-4">
                {canEdit && (
                  <>
                    <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                      <LuPencil />
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => setConfirmSend(true)}
                      disabled={updateReview.isPending}
                    >
                      <LuSend />
                      Send to employee
                    </Button>
                  </>
                )}
                {review.status === "acknowledged" && (
                  <Button
                    size="sm"
                    onClick={() => handleStatus("completed")}
                    disabled={updateReview.isPending}
                  >
                    {updateReview.isPending ? (
                      <LuLoaderCircle aria-hidden className="animate-spin" />
                    ) : (
                      <LuCircleCheck />
                    )}
                    Mark as completed
                  </Button>
                )}
              </div>
            )}
          </>
        )}

        {!editing && (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </DialogFooter>
        )}
      </DialogContent>

      <ConfirmDialog
        open={confirmSend}
        onOpenChange={setConfirmSend}
        title="Send review to employee?"
        description={
          <>
            {review.employee.name} will be notified and can read and acknowledge
            the review. After sending, its content can no longer be edited.
          </>
        }
        confirmLabel="Send review"
        icon={<LuSend />}
        pending={updateReview.isPending}
        onConfirm={() => handleStatus("pending_acknowledgment", () => setConfirmSend(false))}
      />
    </Dialog>
  );
}
