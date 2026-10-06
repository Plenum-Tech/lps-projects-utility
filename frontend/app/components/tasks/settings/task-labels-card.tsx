import { useState, type FormEvent } from "react";
import {
  LuCircleAlert,
  LuLoaderCircle,
  LuPencil,
  LuPlus,
  LuRefreshCw,
  LuSave,
  LuTag,
  LuTrash2,
  LuX,
} from "react-icons/lu";

import { LabelChip, LabelColorDot } from "@/components/tasks/label-chip";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useCreateTaskLabel,
  useDeleteTaskLabel,
  useTaskLabels,
  useUpdateTaskLabel,
} from "@/hooks/use-task-meta";
import { getErrorMessage } from "@/lib/api";
import { LABEL_COLORS, LABEL_COLOR_META } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { LabelColor, TaskLabel } from "@/types";

/** Radio group of theme-token swatches. */
function ColorPicker({
  value,
  onChange,
  name,
}: {
  value: LabelColor;
  onChange: (color: LabelColor) => void;
  name: string;
}) {
  return (
    <div role="radiogroup" aria-label="Label colour" className="flex flex-wrap gap-1.5">
      {LABEL_COLORS.map((color) => {
        const selected = value === color;
        return (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={LABEL_COLOR_META[color].name}
            title={LABEL_COLOR_META[color].name}
            name={name}
            onClick={() => onChange(color)}
            className={cn(
              "flex size-7 items-center justify-center rounded-full border transition-shadow duration-150 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              selected ? "border-ring ring-2 ring-ring/40" : "border-border hover:border-ring/50"
            )}
          >
            <LabelColorDot color={color} className="size-4" />
          </button>
        );
      })}
    </div>
  );
}

interface LabelDraft {
  name: string;
  color: LabelColor;
  description: string;
}

function LabelForm({
  initial,
  pending,
  submitLabel,
  onSubmit,
  onCancel,
  idPrefix,
}: {
  initial: LabelDraft;
  pending: boolean;
  submitLabel: string;
  onSubmit: (draft: LabelDraft) => void;
  onCancel?: () => void;
  idPrefix: string;
}) {
  const [draft, setDraft] = useState(initial);
  const [submitted, setSubmitted] = useState(false);
  const nameInvalid = submitted && (draft.name.trim() === "" || draft.name.trim().length > 40);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    const name = draft.name.trim();
    if (!name || name.length > 40 || draft.description.length > 200) return;
    onSubmit({ ...draft, name, description: draft.description.trim() });
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-name`}>Name</Label>
          <Input
            id={`${idPrefix}-name`}
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            maxLength={40}
            placeholder="e.g. Bug, Client, Blocked"
            aria-invalid={nameInvalid || undefined}
            disabled={pending}
          />
          {nameInvalid && <p className="text-xs text-destructive">Name is required (max 40).</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-description`}>Description (optional)</Label>
          <Input
            id={`${idPrefix}-description`}
            value={draft.description}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            maxLength={200}
            disabled={pending}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <span className="text-sm font-medium text-foreground">Colour</span>
        <ColorPicker
          value={draft.color}
          onChange={(color) => setDraft({ ...draft, color })}
          name={`${idPrefix}-color`}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? (
            <LuLoaderCircle aria-hidden className="animate-spin" />
          ) : onCancel ? (
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
        {draft.name.trim() && (
          <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            Preview <LabelChip name={draft.name.trim()} color={draft.color} />
          </span>
        )}
      </div>
    </form>
  );
}

/** Admin CRUD for task labels. */
export function TaskLabelsCard() {
  const labels = useTaskLabels();
  const create = useCreateTaskLabel();
  const [formKey, setFormKey] = useState(0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LuTag aria-hidden className="size-4 text-muted-foreground" />
          Labels
        </CardTitle>
        <CardDescription>
          Tag tasks across departments. Colours follow the app theme in light and dark mode.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <LabelForm
          key={formKey}
          idPrefix="new-label"
          initial={{ name: "", color: "chart-1", description: "" }}
          pending={create.isPending}
          submitLabel="Add label"
          onSubmit={(draft) =>
            create.mutate(
              {
                name: draft.name,
                color: draft.color,
                description: draft.description || undefined,
              },
              { onSuccess: () => setFormKey((key) => key + 1) }
            )
          }
        />

        {labels.isPending ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading labels">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : labels.isError ? (
          <Alert variant="destructive">
            <LuCircleAlert aria-hidden className="size-4" />
            <AlertTitle>Couldn&apos;t load labels</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              {getErrorMessage(labels.error)}
              <Button variant="outline" size="sm" onClick={() => void labels.refetch()}>
                <LuRefreshCw aria-hidden />
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : labels.data.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center">
            <LuTag aria-hidden className="size-5 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">No labels yet</p>
            <p className="text-xs text-muted-foreground">Add your first label above.</p>
          </div>
        ) : (
          <ul className="divide-y rounded-lg border">
            {labels.data.map((label) => (
              <LabelRow key={label._id} label={label} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function LabelRow({ label }: { label: TaskLabel }) {
  const update = useUpdateTaskLabel();
  const remove = useDeleteTaskLabel();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (editing) {
    return (
      <li className="p-3">
        <LabelForm
          idPrefix={`label-${label._id}`}
          initial={{ name: label.name, color: label.color, description: label.description ?? "" }}
          pending={update.isPending}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={(draft) =>
            update.mutate(
              { id: label._id, input: draft },
              { onSuccess: () => setEditing(false) }
            )
          }
        />
      </li>
    );
  }

  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <LabelChip name={label.name} color={label.color} />
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {label.description}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setEditing(true)}
        aria-label={`Edit label ${label.name}`}
      >
        <LuPencil aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setConfirming(true)}
        aria-label={`Delete label ${label.name}`}
      >
        <LuTrash2 aria-hidden />
      </Button>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete label &ldquo;{label.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              It will be removed from every task that uses it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(label._id, { onSuccess: () => setConfirming(false) })
              }
            >
              {remove.isPending && <LuLoaderCircle aria-hidden className="animate-spin" />}
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}
