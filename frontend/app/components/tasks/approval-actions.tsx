import { useState } from "react";
import { LuCheck, LuLoaderCircle, LuX } from "react-icons/lu";

import { ReasonDialog } from "@/components/globals/reason-dialog";
import { Button } from "@/components/ui/button";
import { useReviewTask } from "@/hooks/use-tasks";
import type { Task } from "@/types";

/** Inline Approve / Reject for the "Waiting approval" view. Reject asks for a reason. */
export function ApprovalActions({ task }: { task: Pick<Task, "_id" | "title" | "shortCode"> }) {
  const review = useReviewTask();
  const [rejectOpen, setRejectOpen] = useState(false);
  const [decision, setDecision] = useState<"approved" | "rejected" | null>(null);
  const name = task.shortCode ?? task.title;

  return (
    <div className="flex items-center gap-1.5">
      <Button
        size="xs"
        onClick={() => {
          setDecision("approved");
          review.mutate({ id: task._id, input: { decision: "approved" } });
        }}
        disabled={review.isPending}
        aria-label={`Approve ${name}`}
      >
        {review.isPending && decision === "approved" ? (
          <LuLoaderCircle aria-hidden className="animate-spin" />
        ) : (
          <LuCheck aria-hidden />
        )}
        Approve
      </Button>
      <Button
        size="xs"
        variant="destructive"
        onClick={() => setRejectOpen(true)}
        disabled={review.isPending}
        aria-label={`Reject ${name}`}
      >
        <LuX aria-hidden />
        Reject
      </Button>
      <ReasonDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        title={`Reject “${task.title}”?`}
        description="The task goes back to the assignees with your reason."
        confirmLabel="Reject"
        pending={review.isPending}
        maxLength={2000}
        onConfirm={(reason) => {
          setDecision("rejected");
          review.mutate(
            { id: task._id, input: { decision: "rejected", reviewNotes: reason } },
            { onSuccess: () => setRejectOpen(false) }
          );
        }}
      />
    </div>
  );
}
