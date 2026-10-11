import { useState } from "react";
import { LuCircleCheck, LuCircleX, LuClock, LuLoaderCircle, LuSend } from "react-icons/lu";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { useDecideProjectApproval, useRequestProjectApproval } from "@/hooks/use-project-approval";
import { formatDateTime } from "@/lib/format";
import type { Project, ProjectPermissions } from "@/types";

/** Pending / rejected badge for headers and lists (nothing once approved). */
export function ProjectApprovalBadge({ project }: { project: Pick<Project, "approval"> }) {
  const status = project.approval?.status;
  if (status === "pending") {
    return (
      <Badge variant="outline" className="gap-1 border-chart-4/60 bg-chart-4/10">
        <LuClock aria-hidden className="size-3" />
        Awaiting approval
      </Badge>
    );
  }
  if (status === "rejected") {
    return (
      <Badge variant="destructive" className="gap-1">
        <LuCircleX aria-hidden className="size-3" />
        Rejected
      </Badge>
    );
  }
  return null;
}

/** "Reject" needs a reason. */
export function RejectDialog({
  open,
  onOpenChange,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const error = !reason.trim() ? "Say why, so the team can fix it." : null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setReason("");
          setSubmitted(false);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reject project</DialogTitle>
          <DialogDescription>The creator and the project manager get your reason by email.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(true);
            if (!error) onConfirm(reason.trim());
          }}
          className="space-y-3"
          noValidate
        >
          <div className="space-y-1.5">
            <Label htmlFor="reject-reason">Reason</Label>
            <Textarea
              id="reject-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              rows={3}
              aria-invalid={submitted && Boolean(error)}
            />
            {submitted && error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending && <LuLoaderCircle aria-hidden className="animate-spin" />}
              Reject
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Banner on the project page while a project awaits approval or was rejected. */
export function ProjectApprovalBanner({ project, permissions }: { project: Project; permissions: ProjectPermissions }) {
  const decide = useDecideProjectApproval();
  const request = useRequestProjectApproval();
  const [rejecting, setRejecting] = useState(false);
  const approval = project.approval;
  if (!approval || approval.status === "approved") return null;
  const requestedBy = typeof approval.requestedBy === "object" ? approval.requestedBy?.name : null;
  const decidedBy = typeof approval.decidedBy === "object" ? approval.decidedBy?.name : null;

  if (approval.status === "pending") {
    return (
      <Alert className="mt-4 border-chart-4/60 bg-chart-4/10">
        <LuClock aria-hidden className="size-4" />
        <AlertTitle>Awaiting approval</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>
            {requestedBy ? `${requestedBy} sent this project for approval ${formatDateTime(approval.requestedAt)}. ` : ""}
            Tasks can be added once it&apos;s approved.
          </p>
          {permissions.canApprove && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => decide.mutate({ id: project._id, decision: "approve" })} disabled={decide.isPending}>
                {decide.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuCircleCheck aria-hidden />}
                Approve
              </Button>
              <Button size="sm" variant="outline" onClick={() => setRejecting(true)} disabled={decide.isPending}>
                <LuCircleX aria-hidden />
                Reject
              </Button>
            </div>
          )}
          {!permissions.canApprove && permissions.canEdit && (
            <Button size="sm" variant="outline" onClick={() => request.mutate(project._id)} disabled={request.isPending}>
              {request.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuSend aria-hidden />}
              Resend approval email
            </Button>
          )}
        </AlertDescription>
        <RejectDialog
          open={rejecting}
          onOpenChange={setRejecting}
          pending={decide.isPending}
          onConfirm={(reason) =>
            decide.mutate({ id: project._id, decision: "reject", reason }, { onSuccess: () => setRejecting(false) })
          }
        />
      </Alert>
    );
  }

  return (
    <Alert variant="destructive" className="mt-4">
      <LuCircleX aria-hidden className="size-4" />
      <AlertTitle>Rejected{decidedBy ? ` by ${decidedBy}` : ""}</AlertTitle>
      <AlertDescription className="space-y-2">
        {approval.reason && <p>“{approval.reason}”</p>}
        <p>Fix the project details, then send it for approval again. Tasks can&apos;t be added until it&apos;s approved.</p>
        {permissions.canEdit && (
          <Button size="sm" variant="outline" onClick={() => request.mutate(project._id)} disabled={request.isPending}>
            {request.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuSend aria-hidden />}
            Request approval again
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
