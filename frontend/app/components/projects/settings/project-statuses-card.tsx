import { useMemo, useState, type FormEvent } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  LuCircleDot,
  LuGripVertical,
  LuLoaderCircle,
  LuPencil,
  LuPlus,
  LuSave,
  LuStar,
  LuTrash2,
  LuX,
} from "react-icons/lu";

import { QueryError } from "@/components/globals/query-states";
import { ColorTokenPicker } from "@/components/projects/settings/color-token-picker";
import { ProjectStatusPill } from "@/components/projects/project-badges";
import { LabelColorDot } from "@/components/tasks/label-chip";
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
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  useCreateProjectStatus,
  useDeleteProjectStatus,
  useProjectStatuses,
  useReorderProjectStatuses,
  useSetDefaultProjectStatus,
  useUpdateProjectStatus,
} from "@/hooks/use-project-meta";
import { cn } from "@/lib/utils";
import type { ColorToken, ProjectStatus } from "@/types";

interface StatusDraft {
  name: string;
  color: ColorToken;
  isCompleted: boolean;
  active: boolean;
}

/** Admin: custom project statuses — colour, default/completed flags, drag reorder. */
export function ProjectStatusesCard() {
  const statuses = useProjectStatuses();
  const create = useCreateProjectStatus();
  const reorder = useReorderProjectStatuses();
  const [formKey, setFormKey] = useState(0);
  const [adding, setAdding] = useState(false);

  const sorted = useMemo(
    () => [...(statuses.data ?? [])].sort((a, b) => a.order - b.order),
    [statuses.data]
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = sorted.findIndex((status) => status._id === active.id);
    const to = sorted.findIndex((status) => status._id === over.id);
    if (from < 0 || to < 0) return;
    reorder.mutate(arrayMove(sorted, from, to).map((status) => status._id));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LuCircleDot aria-hidden className="size-4 text-muted-foreground" />
          Project statuses
        </CardTitle>
        <CardDescription>
          Drag to reorder. New projects start in the default status; a completed status sets
          progress to 100%.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {statuses.isPending ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading statuses">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : statuses.isError ? (
          <QueryError
            title="Couldn't load statuses"
            error={statuses.error}
            onRetry={() => void statuses.refetch()}
            retrying={statuses.isFetching}
          />
        ) : sorted.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center">
            <LuCircleDot aria-hidden className="size-5 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">No statuses yet</p>
            <p className="text-xs text-muted-foreground">Add the first status below.</p>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
            accessibility={{
              screenReaderInstructions: {
                draggable:
                  "To reorder, press space or enter to pick up a status, use the arrow keys to move it, then press space or enter again to drop it.",
              },
            }}
          >
            <SortableContext
              items={sorted.map((status) => status._id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="divide-y rounded-lg border" aria-label="Project statuses">
                {sorted.map((status) => (
                  <SortableStatusRow key={status._id} status={status} statuses={sorted} />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}

        {adding ? (
          <div className="rounded-lg border bg-muted/30 p-3">
            <StatusForm
              key={formKey}
              idPrefix="new-status"
              initial={{ name: "", color: "chart-1", isCompleted: false, active: true }}
              pending={create.isPending}
              submitLabel="Add status"
              onCancel={() => setAdding(false)}
              onSubmit={(draft) =>
                create.mutate(draft, {
                  onSuccess: () => {
                    setFormKey((key) => key + 1);
                    setAdding(false);
                  },
                })
              }
            />
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <LuPlus aria-hidden />
            Add status
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function StatusForm({
  initial,
  pending,
  submitLabel,
  onSubmit,
  onCancel,
  idPrefix,
  isDefault = false,
}: {
  initial: StatusDraft;
  pending: boolean;
  submitLabel: string;
  onSubmit: (draft: StatusDraft) => void;
  onCancel?: () => void;
  idPrefix: string;
  isDefault?: boolean;
}) {
  const [draft, setDraft] = useState(initial);
  const [submitted, setSubmitted] = useState(false);
  const trimmed = draft.name.trim();
  const nameInvalid = submitted && (trimmed === "" || trimmed.length > 40);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!trimmed || trimmed.length > 40) return;
    onSubmit({ ...draft, name: trimmed });
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-name`}>Name</Label>
        <Input
          id={`${idPrefix}-name`}
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          maxLength={40}
          placeholder="e.g. On hold, In QA"
          aria-invalid={nameInvalid || undefined}
          aria-describedby={nameInvalid ? `${idPrefix}-name-error` : undefined}
          disabled={pending}
          autoFocus
        />
        {nameInvalid && (
          <p id={`${idPrefix}-name-error`} className="text-xs text-destructive">
            Name is required (max 40 characters).
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <span className="text-sm font-medium text-foreground">Colour</span>
        <ColorTokenPicker
          value={draft.color}
          onChange={(color) => setDraft({ ...draft, color })}
          label="Status colour"
          disabled={pending}
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex items-center justify-between gap-3 rounded-lg border bg-background p-2.5">
          <div>
            <Label htmlFor={`${idPrefix}-completed`}>Completed status</Label>
            <p className="text-xs text-muted-foreground">Sets progress to 100%</p>
          </div>
          <Switch
            id={`${idPrefix}-completed`}
            checked={draft.isCompleted}
            onCheckedChange={(isCompleted) => setDraft({ ...draft, isCompleted })}
            disabled={pending}
          />
        </div>
        <div className="flex items-center justify-between gap-3 rounded-lg border bg-background p-2.5">
          <div>
            <Label htmlFor={`${idPrefix}-active`}>Active</Label>
            <p className="text-xs text-muted-foreground">
              {isDefault ? "The default status is always active" : "Inactive statuses are hidden"}
            </p>
          </div>
          <Switch
            id={`${idPrefix}-active`}
            checked={draft.active}
            onCheckedChange={(active) => setDraft({ ...draft, active })}
            disabled={pending || isDefault}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? (
            <LuLoaderCircle aria-hidden className="animate-spin" />
          ) : isDefault || onCancel ? (
            <LuSave aria-hidden />
          ) : (
            <LuPlus aria-hidden />
          )}
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
            <LuX aria-hidden />
            Cancel
          </Button>
        )}
        {trimmed && (
          <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            Preview <ProjectStatusPill status={{ name: trimmed, color: draft.color }} />
          </span>
        )}
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */

function SortableStatusRow({
  status,
  statuses,
}: {
  status: ProjectStatus;
  statuses: ProjectStatus[];
}) {
  const update = useUpdateProjectStatus();
  const setDefault = useSetDefaultProjectStatus();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: status._id, disabled: editing });

  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        "relative bg-card first:rounded-t-lg last:rounded-b-lg",
        isDragging && "z-10 shadow-lg ring-1 ring-ring/40"
      )}
    >
      {editing ? (
        <div className="p-3">
          <StatusForm
            idPrefix={`status-${status._id}`}
            initial={{
              name: status.name,
              color: status.color,
              isCompleted: status.isCompleted,
              active: status.active,
            }}
            isDefault={status.isDefault}
            pending={update.isPending}
            submitLabel="Save"
            onCancel={() => setEditing(false)}
            onSubmit={(draft) =>
              update.mutate(
                {
                  id: status._id,
                  input: status.isDefault ? { ...draft, active: undefined } : draft,
                },
                { onSuccess: () => setEditing(false) }
              )
            }
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 px-2 py-2.5 sm:flex-nowrap">
          <button
            type="button"
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            aria-label={`Reorder ${status.name}`}
            className="flex size-7 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 active:cursor-grabbing"
          >
            <LuGripVertical aria-hidden className="size-4" />
          </button>
          <LabelColorDot color={status.color} />
          <span
            className={cn(
              "min-w-0 truncate text-sm font-medium",
              status.active ? "text-foreground" : "text-muted-foreground"
            )}
          >
            {status.name}
          </span>
          <div className="flex flex-wrap items-center gap-1">
            {status.isDefault && (
              <Badge variant="secondary" className="gap-1">
                <LuStar aria-hidden className="size-3" />
                Default
              </Badge>
            )}
            {status.isCompleted && <Badge variant="outline">Completed</Badge>}
            {!status.active && <Badge variant="outline">Inactive</Badge>}
          </div>
          <span className="ml-auto text-xs whitespace-nowrap text-muted-foreground tabular-nums">
            {status.projectCount ?? 0} project{status.projectCount === 1 ? "" : "s"}
          </span>
          <div className="flex items-center">
            {!status.isDefault && status.active && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setDefault.mutate(status._id)}
                disabled={setDefault.isPending}
                aria-label={`Make ${status.name} the default status`}
                title="Make default"
              >
                {setDefault.isPending ? (
                  <LuLoaderCircle aria-hidden className="animate-spin" />
                ) : (
                  <LuStar aria-hidden />
                )}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setEditing(true)}
              aria-label={`Edit status ${status.name}`}
              title="Edit"
            >
              <LuPencil aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setDeleting(true)}
              disabled={status.isDefault}
              aria-label={
                status.isDefault
                  ? `${status.name} is the default status and can't be deleted`
                  : `Delete status ${status.name}`
              }
              title={status.isDefault ? "The default status can't be deleted" : "Delete"}
            >
              <LuTrash2 aria-hidden />
            </Button>
          </div>
        </div>
      )}

      <DeleteStatusDialog
        open={deleting}
        onOpenChange={setDeleting}
        status={status}
        statuses={statuses}
      />
    </li>
  );
}

/* ------------------------------------------------------------------ */

function DeleteStatusDialog({
  open,
  onOpenChange,
  status,
  statuses,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: ProjectStatus;
  statuses: ProjectStatus[];
}) {
  const remove = useDeleteProjectStatus();
  // Set after a 409: the status is in use and needs a reassign target.
  const [inUse, setInUse] = useState<number | null>(null);
  const [reassignTo, setReassignTo] = useState("");

  const targets = statuses.filter((item) => item._id !== status._id);
  const defaultTarget = targets.find((item) => item.isDefault)?._id ?? targets[0]?._id ?? "";
  const items = Object.fromEntries(targets.map((item) => [item._id, item.name]));
  const knownInUse = inUse ?? (status.projectCount && status.projectCount > 0 ? status.projectCount : null);

  function handleOpenChange(next: boolean) {
    if (remove.isPending) return;
    onOpenChange(next);
    if (!next) {
      setInUse(null);
      setReassignTo("");
    }
  }

  function confirm() {
    const target = knownInUse ? reassignTo || defaultTarget : undefined;
    remove.mutate(
      { id: status._id, reassignTo: target },
      {
        onSuccess: () => handleOpenChange(false),
        onError: (error) => {
          const response = (error as { response?: { status?: number; data?: { projectCount?: number } } })
            .response;
          if (response?.status === 409) {
            setInUse(response.data?.projectCount ?? 1);
            setReassignTo((current) => current || defaultTarget);
          }
        },
      }
    );
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete status &ldquo;{status.name}&rdquo;?</AlertDialogTitle>
          <AlertDialogDescription>
            {knownInUse
              ? `${knownInUse} project${knownInUse === 1 ? " uses" : "s use"} this status. Choose where to move ${
                  knownInUse === 1 ? "it" : "them"
                } before deleting.`
              : "No projects use this status. This can't be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {knownInUse && (
          <div className="space-y-1.5">
            <Label htmlFor={`reassign-${status._id}`}>Move projects to</Label>
            <Select
              value={reassignTo || defaultTarget}
              onValueChange={(value) => setReassignTo(String(value ?? ""))}
              items={items}
            >
              <SelectTrigger id={`reassign-${status._id}`} className="w-full">
                <SelectValue placeholder="Choose a status" />
              </SelectTrigger>
              <SelectContent>
                {targets.map((item) => (
                  <SelectItem key={item._id} value={item._id}>
                    <LabelColorDot color={item.color} className="size-2.5" />
                    {item.name}
                    {item.isDefault ? " (default)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={remove.isPending || (Boolean(knownInUse) && targets.length === 0)}
            onClick={confirm}
          >
            {remove.isPending && <LuLoaderCircle aria-hidden className="animate-spin" />}
            {knownInUse ? "Move and delete" : "Delete"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
