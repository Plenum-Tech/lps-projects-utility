import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCurrentUser } from "@/hooks/use-auth";
import { useCreateReview, useReviewConfig } from "@/hooks/use-performance-reviews";
import { useAssignableUsers } from "@/hooks/use-task-meta";
import { getErrorMessage } from "@/lib/api";
import { ReviewForm, type ReviewFormValues } from "./review-form";

/**
 * Create a review. Manual by default; "Draft with AI" is offered only when
 * the server reports AI drafting is enabled.
 */
export function CreateReviewDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateReview();
  const me = useCurrentUser().data;
  const users = useAssignableUsers(open);
  const config = useReviewConfig(open);
  const aiDraftsEnabled = config.data?.aiDraftsEnabled === true;

  // You can't review yourself.
  const employees = users.data?.filter((u) => u._id !== me?._id);

  function handleSubmit(values: ReviewFormValues) {
    create.mutate(
      {
        employeeId: values.employeeId,
        period: values.period,
        ratings: values.ratings,
        goals: values.goals.map(({ title, description, dueDate }) => ({
          title,
          description,
          dueDate,
        })),
        ...(values.summary ? { summary: values.summary } : {}),
        ...(values.strengths ? { strengths: values.strengths } : {}),
        ...(values.improvements ? { improvements: values.improvements } : {}),
        ...(values.aiDraft ? { aiDraft: true } : {}),
      },
      { onSuccess: () => onOpenChange(false) }
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) create.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create performance review</DialogTitle>
          <DialogDescription>
            The review is saved as a draft. You can keep editing it until you send
            it to the employee.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <ReviewForm
            mode="create"
            employees={employees}
            employeesLoading={users.isPending}
            employeesError={users.isError}
            aiDraftsEnabled={aiDraftsEnabled}
            pending={create.isPending}
            error={create.isError ? getErrorMessage(create.error) : undefined}
            onSubmit={handleSubmit}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
