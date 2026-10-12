import { useEffect, useMemo, useRef, useState } from "react";
import {
  LuCalendarDays,
  LuChevronRight,
  LuEllipsis,
  LuListChecks,
  LuLoaderCircle,
  LuPaperclip,
  LuPencil,
  LuPlay,
  LuPlus,
  LuTimer,
  LuTrash2,
} from "react-icons/lu";

import { VarianceChip, varianceDays } from "@/components/tasks/actual-dates";
import { CompleteReworkDialog } from "@/components/tasks/complete-rework-dialog";
import { SubtaskFormDialog } from "@/components/tasks/subtask-form";
import { UserAvatar } from "@/components/tasks/task-badges";
import { FileRow } from "@/components/tasks/task-files";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDeleteSubtask, useTaskFiles, useUpdateSubtask } from "@/hooks/use-tasks";
import { formatDate, formatDateTime, formatTimeOfDay } from "@/lib/format";
import { formatDateOnly, toDateInput, todayKey } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { Role, Subtask, Task, TaskFile, TaskPermissions } from "@/types";

const MAX_SUBTASKS = 50;

/**
 * Subtasks tab: progress, rows that expand to show the description and
 * attachments, and the add/edit form dialog.
 */
export function TaskSubtasks({
  task,
  permissions,
  me,
  focusSubtaskId,
}: {
  task: Task;
  permissions: TaskPermissions;
  me: { _id: string; role: Role };
  /** `?subtask=<id>` — expanded and scrolled into view on open. */
  focusSubtaskId?: string | null;
}) {
  const files = useTaskFiles(task._id);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(focusSubtaskId ? [focusSubtaskId] : [])
  );
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Subtask | null>(null);
  const [deleting, setDeleting] = useState<Subtask | null>(null);

  useEffect(() => {
    if (focusSubtaskId) setExpanded((current) => new Set(current).add(focusSubtaskId));
  }, [focusSubtaskId]);

  const filesBySubtask = useMemo(() => {
    const map = new Map<string, TaskFile[]>();
    for (const file of files.data?.files ?? []) {
      if (!file.subtask) continue;
      map.set(file.subtask, [...(map.get(file.subtask) ?? []), file]);
    }
    return map;
  }, [files.data]);

  const done = task.subtasks.filter((sub) => sub.done).length;
  const total = task.subtasks.length;
  const percent = total ? Math.round((done / total) * 100) : 0;
  const readOnly = Boolean(permissions.readOnly);
  const canAdd = !readOnly && Boolean(permissions.canAddSubtasks ?? permissions.canManageSubtasks);

  function toggleExpanded(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function openAdd() {
    setEditing(null);
    setFormOpen(true);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {total > 0 ? (
          <div className="min-w-48 flex-1 space-y-1.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {done} of {total} done
              </span>
              <span className="tabular-nums">{percent}%</span>
            </div>
            <div
              className="h-1.5 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Rework progress"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        ) : (
          <span />
        )}
        {canAdd && total > 0 && total < MAX_SUBTASKS && (
          <Button size="sm" variant="outline" onClick={openAdd}>
            <LuPlus aria-hidden />
            Add rework
          </Button>
        )}
      </div>

      {total === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center">
          <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <LuListChecks aria-hidden className="size-4" />
          </span>
          <p className="text-sm font-medium text-foreground">No rework yet</p>
          <p className="text-xs text-muted-foreground">
            {canAdd
              ? "Break the work into smaller steps with owners and dates."
              : "This task has no checklist."}
          </p>
          {canAdd && (
            <Button size="sm" className="mt-1" onClick={openAdd}>
              <LuPlus aria-hidden />
              Add rework
            </Button>
          )}
        </div>
      ) : (
        <ul className="divide-y rounded-lg border">
          {task.subtasks.map((subtask) => {
            const manage = permissions.canManageSubtasks && !readOnly;
            const canEdit =
              manage || (!readOnly && Boolean(permissions.canAddSubtasks) && subtask.createdBy === me._id);
            const canToggle =
              !readOnly &&
              (manage ||
                (permissions.canToggleSubtasks &&
                  (!subtask.assignee || subtask.assignee._id === me._id)));
            return (
              <SubtaskRow
                key={subtask._id}
                task={task}
                subtask={subtask}
                me={me}
                files={filesBySubtask.get(subtask._id) ?? []}
                filesLoading={files.isPending}
                canEdit={canEdit}
                canToggle={canToggle}
                canManageFiles={permissions.canDelete || me.role === "admin"}
                expanded={expanded.has(subtask._id)}
                focused={focusSubtaskId === subtask._id}
                onToggleExpanded={() => toggleExpanded(subtask._id)}
                onEdit={() => {
                  setEditing(subtask);
                  setFormOpen(true);
                }}
                onDelete={() => setDeleting(subtask)}
              />
            );
          })}
        </ul>
      )}

      {total >= MAX_SUBTASKS && canAdd && (
        <p className="text-xs text-muted-foreground">This task has reached the {MAX_SUBTASKS}-rework limit.</p>
      )}

      <SubtaskFormDialog
        task={task}
        subtask={editing}
        me={me}
        open={formOpen}
        onOpenChange={setFormOpen}
        onSaved={(id) => setExpanded((current) => new Set(current).add(id))}
      />
      <DeleteSubtaskDialog taskId={task._id} subtask={deleting} files={deleting ? (filesBySubtask.get(deleting._id)?.length ?? 0) : 0} onClose={() => setDeleting(null)} />
    </div>
  );
}

function SubtaskDates({ subtask }: { subtask: Subtask }) {
  if (!subtask.startDate && !subtask.dueDate) return null;
  const overdue = !subtask.done && Boolean(subtask.dueDate) && toDateInput(subtask.dueDate) < todayKey();
  const label =
    subtask.startDate && subtask.dueDate
      ? `${formatDateOnly(subtask.startDate)} – ${formatDateOnly(subtask.dueDate)}`
      : subtask.dueDate
        ? `Due ${formatDateOnly(subtask.dueDate)}`
        : `Starts ${formatDateOnly(subtask.startDate)}`;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.7rem] whitespace-nowrap",
        overdue ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"
      )}
    >
      <LuCalendarDays aria-hidden className="size-3" />
      {label}
      {overdue && <span className="sr-only"> (overdue)</span>}
    </span>
  );
}

/** Compact "Actual 8 Oct · 10:30 → 12:05" chip plus late/early chips vs the planned dates. */
function SubtaskActual({ subtask }: { subtask: Subtask }) {
  const start = subtask.actualStartAt ?? null;
  const end = subtask.actualEndAt ?? null;
  if (!start && !end) return null;
  const sameDay = Boolean(start && end && formatDate(start) === formatDate(end));
  const endText = end ? (sameDay ? formatTimeOfDay(end) : formatDateTime(end)) : "…";
  const label = start ? `${formatDateTime(start)} → ${endText}` : `Ended ${formatDateTime(end)}`;
  const startVariance = varianceDays(start, subtask.startDate ?? null);
  const finishVariance = varianceDays(end, subtask.dueDate);
  return (
    <>
      <span
        className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[0.7rem] whitespace-nowrap text-muted-foreground tabular-nums"
        title={`Actual start: ${formatDateTime(start)} · Actual end: ${formatDateTime(end)}`}
      >
        <LuTimer aria-hidden className="size-3" />
        <span className="sr-only">Actual: </span>
        {label}
      </span>
      <VarianceChip kind="start" days={startVariance} />
      <VarianceChip kind="finish" days={finishVariance} />
    </>
  );
}

function SubtaskRow({
  task,
  subtask,
  me,
  files,
  filesLoading,
  canEdit,
  canToggle,
  canManageFiles,
  expanded,
  focused,
  onToggleExpanded,
  onEdit,
  onDelete,
}: {
  task: Task;
  subtask: Subtask;
  me: { _id: string; role: Role };
  files: TaskFile[];
  filesLoading: boolean;
  canEdit: boolean;
  canToggle: boolean;
  canManageFiles: boolean;
  expanded: boolean;
  focused: boolean;
  onToggleExpanded: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const update = useUpdateSubtask(task._id);
  const [completing, setCompleting] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);
  const isMine = subtask.assignee?._id === me._id;
  const panelId = `subtask-panel-${subtask._id}`;
  // "Start now" — open subtasks without an actual start, for whoever may edit or tick it off.
  const canStartNow = (canEdit || canToggle) && !subtask.done && !subtask.actualStartAt;

  useEffect(() => {
    if (focused) rowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focused]);

  return (
    <li ref={rowRef} className={cn("transition-colors duration-200", focused && "bg-primary/5")}>
      <CompleteReworkDialog
        task={task}
        subtask={subtask}
        existingFiles={files.length}
        open={completing}
        onOpenChange={setCompleting}
      />
      <div className="flex items-center gap-2 px-3 py-2.5 sm:gap-3">
        <Checkbox
          checked={subtask.done}
          disabled={!canToggle || update.isPending}
          onCheckedChange={(checked) => {
            // Ticking off asks for a note, file or time; un-ticking is immediate.
            if (checked) setCompleting(true);
            else update.mutate({ subId: subtask._id, input: { done: false } });
          }}
          aria-label={`Mark "${subtask.title}" as ${subtask.done ? "not done" : "done"}`}
        />
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          aria-controls={panelId}
          className="group/row flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <LuChevronRight
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out",
              expanded && "rotate-90"
            )}
          />
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                "block truncate text-sm text-foreground transition-colors",
                subtask.done && "text-muted-foreground line-through"
              )}
            >
              {subtask.title}
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-1.5 sm:hidden">
              <SubtaskDates subtask={subtask} />
            </span>
            {(subtask.actualStartAt || subtask.actualEndAt) && (
              <span className="mt-1 flex flex-wrap items-center gap-1.5">
                <SubtaskActual subtask={subtask} />
              </span>
            )}
          </span>
        </button>

        <span className="hidden sm:inline-flex">
          <SubtaskDates subtask={subtask} />
        </span>
        {files.length > 0 && (
          <span
            className="inline-flex items-center gap-0.5 text-xs text-muted-foreground tabular-nums"
            title={`${files.length} attachment${files.length === 1 ? "" : "s"}`}
          >
            <LuPaperclip aria-hidden className="size-3.5" />
            {files.length}
            <span className="sr-only"> attachments</span>
          </span>
        )}
        {subtask.assignee ? (
          <span className="flex shrink-0 items-center gap-1" title={subtask.assignee.name}>
            <UserAvatar user={subtask.assignee} />
            {isMine && (
              <Badge variant="secondary" className="h-4 px-1.5 text-[0.65rem]">
                You
              </Badge>
            )}
            <span className="sr-only">Assigned to {subtask.assignee.name}</span>
          </span>
        ) : (
          <span className="hidden text-xs text-muted-foreground sm:inline">Unassigned</span>
        )}

        {canEdit || canStartNow ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-sm" aria-label={`Actions for "${subtask.title}"`} />
              }
            >
              <LuEllipsis aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canStartNow && (
                <DropdownMenuItem
                  disabled={update.isPending}
                  onClick={() => update.mutate({ subId: subtask._id, input: { startNow: true } })}
                >
                  <LuPlay aria-hidden />
                  Start now
                </DropdownMenuItem>
              )}
              {canEdit && (
                <>
                  <DropdownMenuItem onClick={onEdit}>
                    <LuPencil aria-hidden />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onClick={onDelete}>
                    <LuTrash2 aria-hidden />
                    Delete
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span aria-hidden className="size-7 shrink-0" />
        )}
      </div>

      {expanded && (
        <div id={panelId} className="space-y-3 border-t bg-muted/20 px-3 py-3 sm:pl-12">
          {subtask.completionNote ? (
            <p className="rounded-md border bg-card px-2.5 py-1.5 text-sm break-words whitespace-pre-wrap text-foreground">
              <span className="font-medium">Done: </span>
              {subtask.completionNote}
            </p>
          ) : null}
          {subtask.description ? (
            <p className="text-sm break-words whitespace-pre-wrap text-foreground">{subtask.description}</p>
          ) : (
            <p className="text-sm text-muted-foreground italic">No description.</p>
          )}
          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
            <div className="flex gap-1">
              <dt>Assigned to</dt>
              <dd className="font-medium text-foreground">
                {subtask.assignee ? `${subtask.assignee.name}${isMine ? " (you)" : ""}` : "Unassigned"}
              </dd>
            </div>
            <div className="flex gap-1">
              <dt>Start</dt>
              <dd className="font-medium text-foreground">{formatDateOnly(subtask.startDate, true)}</dd>
            </div>
            <div className="flex gap-1">
              <dt>Due</dt>
              <dd className="font-medium text-foreground">{formatDateOnly(subtask.dueDate, true)}</dd>
            </div>
            <div className="flex gap-1">
              <dt>Actual start</dt>
              <dd className="font-medium text-foreground tabular-nums">{formatDateTime(subtask.actualStartAt)}</dd>
            </div>
            <div className="flex gap-1">
              <dt>Actual end</dt>
              <dd className="font-medium text-foreground tabular-nums">{formatDateTime(subtask.actualEndAt)}</dd>
            </div>
          </dl>
          <div className="space-y-1.5">
            <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Attachments</h4>
            {filesLoading ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <LuLoaderCircle aria-hidden className="size-3.5 animate-spin" />
                Loading files…
              </p>
            ) : files.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No files{canEdit ? " — add some from Edit." : "."}
              </p>
            ) : (
              <ul className="divide-y rounded-lg border bg-background">
                {files.map((file) => (
                  <FileRow
                    key={file._id}
                    taskId={task._id}
                    file={file}
                    canDelete={canManageFiles || file.uploadedBy?._id === me._id}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function DeleteSubtaskDialog({
  taskId,
  subtask,
  files,
  onClose,
}: {
  taskId: string;
  subtask: Subtask | null;
  files: number;
  onClose: () => void;
}) {
  const remove = useDeleteSubtask(taskId);
  return (
    <AlertDialog open={subtask !== null} onOpenChange={(open) => !open && !remove.isPending && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this rework?</AlertDialogTitle>
          <AlertDialogDescription>
            &ldquo;{subtask?.title}&rdquo;
            {files > 0 ? ` and its ${files} attachment${files === 1 ? "" : "s"}` : ""} will be removed. This
            can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => subtask && remove.mutate(subtask._id, { onSuccess: onClose })}
          >
            {remove.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuTrash2 aria-hidden />}
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
