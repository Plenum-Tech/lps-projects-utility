import { useEffect, useState, type FormEvent } from "react";
import {
  LuCalendar,
  LuCircleCheck,
  LuFlag,
  LuLoaderCircle,
  LuPencil,
  LuPlus,
  LuRotateCcw,
  LuSave,
  LuTrash2,
} from "react-icons/lu";

import { EmptyState, QueryError } from "@/components/globals/query-states";
import { ProgressBar } from "@/components/projects/project-badges";
import { FieldError } from "@/components/projects/project-fields";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  useDeleteMilestone,
  useMilestones,
  useSaveMilestone,
  useSetMilestoneStatus,
} from "@/hooks/use-projects";
import { formatDateOnly, toDateInput, todayKey } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { Milestone } from "@/types";

/** Milestones tab: list with progress; create/edit/complete/delete for managers. */
export function ProjectMilestones({
  projectId,
  canManage,
}: {
  projectId: string;
  canManage: boolean;
}) {
  const milestones = useMilestones(projectId);
  const setStatus = useSetMilestoneStatus(projectId);
  const [editing, setEditing] = useState<Milestone | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [deleting, setDeleting] = useState<Milestone | null>(null);

  function openCreate() {
    setEditing(null);
    setFormOpen(true);
  }

  const items = milestones.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-heading text-lg font-semibold">Milestones</h2>
          <p className="text-sm text-muted-foreground">
            Group tasks into checkpoints. Progress follows the tasks in each milestone.
          </p>
        </div>
        {canManage && items.length > 0 && (
          <Button onClick={openCreate}>
            <LuPlus aria-hidden />
            New milestone
          </Button>
        )}
      </div>

      {milestones.isPending ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading milestones">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : milestones.isError ? (
        <QueryError
          title="Couldn't load milestones"
          error={milestones.error}
          onRetry={() => void milestones.refetch()}
          retrying={milestones.isRefetching}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={LuFlag}
          title="No milestones yet"
          description={
            canManage
              ? "Break the project into checkpoints and attach tasks to them."
              : "The project manager hasn't added milestones."
          }
        >
          {canManage && (
            <Button onClick={openCreate}>
              <LuPlus aria-hidden />
              New milestone
            </Button>
          )}
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {items.map((milestone) => {
            const complete = milestone.status === "complete";
            const late =
              !complete && milestone.endDate !== null && toDateInput(milestone.endDate) < todayKey();
            const busy = setStatus.isPending && setStatus.variables?.id === milestone._id;
            return (
              <li
                key={milestone._id}
                className="rounded-xl border bg-card p-4 text-card-foreground"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3
                        className={cn(
                          "font-medium",
                          complete && "text-muted-foreground line-through"
                        )}
                      >
                        {milestone.title}
                      </h3>
                      {complete ? (
                        <Badge variant="secondary" className="gap-1">
                          <LuCircleCheck aria-hidden className="size-3" />
                          Complete
                        </Badge>
                      ) : late ? (
                        <Badge variant="destructive">Past end date</Badge>
                      ) : null}
                    </div>
                    {milestone.summary && (
                      <p className="text-sm whitespace-pre-wrap text-muted-foreground">
                        {milestone.summary}
                      </p>
                    )}
                    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <LuCalendar aria-hidden className="size-3.5" />
                        {milestone.startDate || milestone.endDate
                          ? `${formatDateOnly(milestone.startDate)} → ${formatDateOnly(milestone.endDate)}`
                          : "No dates"}
                      </span>
                      <span className="tabular-nums">
                        {milestone.completedTaskCount}/{milestone.taskCount} tasks done
                      </span>
                    </p>
                  </div>
                  {canManage && (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          setStatus.mutate({
                            id: milestone._id,
                            status: complete ? "incomplete" : "complete",
                          })
                        }
                      >
                        {busy ? (
                          <LuLoaderCircle aria-hidden className="animate-spin" />
                        ) : complete ? (
                          <LuRotateCcw aria-hidden />
                        ) : (
                          <LuCircleCheck aria-hidden />
                        )}
                        {complete ? "Reopen" : "Complete"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${milestone.title}`}
                        onClick={() => {
                          setEditing(milestone);
                          setFormOpen(true);
                        }}
                      >
                        <LuPencil aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${milestone.title}`}
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => setDeleting(milestone)}
                      >
                        <LuTrash2 aria-hidden />
                      </Button>
                    </div>
                  )}
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <ProgressBar value={milestone.progress} className="flex-1" />
                  <span className="w-10 text-right text-xs font-medium tabular-nums">
                    {Math.round(milestone.progress)}%
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {canManage && (
        <>
          <MilestoneFormDialog
            projectId={projectId}
            milestone={editing}
            open={formOpen}
            onOpenChange={setFormOpen}
          />
          <DeleteMilestoneDialog
            projectId={projectId}
            milestone={deleting}
            onClose={() => setDeleting(null)}
          />
        </>
      )}
    </div>
  );
}

function MilestoneFormDialog({
  projectId,
  milestone,
  open,
  onOpenChange,
}: {
  projectId: string;
  milestone: Milestone | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const save = useSaveMilestone(projectId);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(milestone?.title ?? "");
    setSummary(milestone?.summary ?? "");
    setStartDate(toDateInput(milestone?.startDate));
    setEndDate(toDateInput(milestone?.endDate));
    setSubmitted(false);
  }, [open, milestone]);

  const titleError = title.trim() ? (title.length > 200 ? "Max 200 characters." : null) : "A title is required.";
  const datesError =
    startDate && endDate && endDate < startDate ? "The end date can't be before the start." : null;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (titleError || datesError) return;
    save.mutate(
      {
        id: milestone?._id,
        input: {
          title: title.trim(),
          summary: summary.trim(),
          startDate: startDate || null,
          endDate: endDate || null,
        },
      },
      { onSuccess: () => onOpenChange(false) }
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !save.isPending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{milestone ? "Edit milestone" : "New milestone"}</DialogTitle>
          <DialogDescription>Tasks can be attached to a milestone from the task form.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="milestone-title">Title</Label>
            <Input
              id="milestone-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
              placeholder="e.g. Beta launch"
              aria-invalid={(submitted && Boolean(titleError)) || undefined}
              autoFocus
            />
            {submitted && titleError && <FieldError>{titleError}</FieldError>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="milestone-summary">Summary</Label>
            <Textarea
              id="milestone-summary"
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              rows={3}
              maxLength={2000}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="milestone-start">Start date</Label>
              <Input
                id="milestone-start"
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="milestone-end">End date</Label>
              <Input
                id="milestone-end"
                type="date"
                value={endDate}
                min={startDate || undefined}
                onChange={(event) => setEndDate(event.target.value)}
                aria-invalid={(submitted && Boolean(datesError)) || undefined}
              />
            </div>
            {submitted && datesError && (
              <div className="sm:col-span-2">
                <FieldError>{datesError}</FieldError>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={save.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? (
                <LuLoaderCircle aria-hidden className="animate-spin" />
              ) : milestone ? (
                <LuSave aria-hidden />
              ) : (
                <LuPlus aria-hidden />
              )}
              {milestone ? "Save" : "Create milestone"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteMilestoneDialog({
  projectId,
  milestone,
  onClose,
}: {
  projectId: string;
  milestone: Milestone | null;
  onClose: () => void;
}) {
  const remove = useDeleteMilestone(projectId);
  return (
    <AlertDialog
      open={milestone !== null}
      onOpenChange={(open) => !open && !remove.isPending && onClose()}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this milestone?</AlertDialogTitle>
          <AlertDialogDescription>
            &ldquo;{milestone?.title}&rdquo; will be removed. Its tasks stay in the project without a
            milestone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => milestone && remove.mutate(milestone._id, { onSuccess: onClose })}
          >
            {remove.isPending ? (
              <LuLoaderCircle aria-hidden className="animate-spin" />
            ) : (
              <LuTrash2 aria-hidden />
            )}
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
