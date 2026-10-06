import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import {
  LuArrowLeft,
  LuCalendarClock,
  LuEye,
  LuLoaderCircle,
  LuPencil,
  LuRepeat,
  LuSave,
  LuSquare,
  LuTrash2,
} from "react-icons/lu";

import { ConfirmDialog } from "@/components/globals/confirm-dialog";
import { AvatarStack } from "@/components/globals/data-table/avatar-stack";
import { FiltersBar } from "@/components/globals/data-table/filters-bar";
import { DataTablePager } from "@/components/globals/data-table/pagination";
import { RowActions, type RowAction } from "@/components/globals/data-table/row-actions";
import { DataTable, MobileField, type DataTableColumn } from "@/components/globals/data-table/table";
import { EmptyState, PageHeader } from "@/components/globals/query-states";
import { ShortCode } from "@/components/projects/project-badges";
import { RecurrenceField, recurrenceError } from "@/components/tasks/recurrence-field";
import { DeleteTaskDialog } from "@/components/tasks/task-action-dialogs";
import { TaskDetailSheet } from "@/components/tasks/task-detail-sheet";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCurrentUser } from "@/hooks/use-auth";
import { useTableState } from "@/hooks/use-table-state";
import {
  useSetTaskRecurrence,
  useTaskList,
  useTaskRealtime,
  type TaskSortField,
} from "@/hooks/use-tasks";
import { formatTimestampDMY, taskCode } from "@/lib/tasks";
import type { Recurrence, RecurrenceInput, Role, Task } from "@/types";

const SORT_FIELDS: TaskSortField[] = ["title", "code", "dueDate"];

/** "Every week", "Every 2 months". */
export function describeSchedule(recurrence: Pick<Recurrence, "every" | "unit">): string {
  const unit = recurrence.every === 1 ? recurrence.unit : `${recurrence.unit}s`;
  return recurrence.every === 1 ? `Every ${unit}` : `Every ${recurrence.every} ${unit}`;
}

/** "3 / 10" or "3 / ∞". */
function cyclesText(recurrence: Recurrence): string {
  return `${recurrence.generated} / ${recurrence.cycles === -1 ? "∞" : recurrence.cycles}`;
}

type Dialog = { kind: "schedule" | "stop" | "delete"; task: Task } | null;

/** /tasks/recurring — every recurring task the caller can see, with schedule controls. */
export function RecurringTasksPage() {
  const { data: user } = useCurrentUser();
  const role: Role = user?.role ?? "employee";
  const me = useMemo(() => ({ _id: user?._id ?? "", role }), [user?._id, role]);
  useTaskRealtime();

  const table = useTableState({ storageKey: "recurring-tasks", defaults: { search: "" } });
  const sort = (SORT_FIELDS as string[]).includes(table.sort) ? (table.sort as TaskSortField) : "";

  const list = useTaskList(
    {
      scope: "all",
      search: table.filters.search,
      priority: "",
      label: "",
      category: "",
      assignee: "",
      due: "",
      recurring: true,
      status: "all",
      sort,
      dir: table.dir,
      limit: table.pageSize,
      offset: table.offset,
    },
    Boolean(user)
  );
  const { clampPage } = table;
  useEffect(() => {
    if (list.data) clampPage(list.data.total);
  }, [list.data, clampPage]);

  const [dialog, setDialog] = useState<Dialog>(null);
  const setRecurrence = useSetTaskRecurrence();

  const [searchParams, setSearchParams] = useSearchParams();
  const openTaskId = searchParams.get("task");
  function openTask(id: string | null) {
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        if (id) next.set("task", id);
        else next.delete("task");
        return next;
      },
      { preventScrollReset: true }
    );
  }

  function actions(task: Task): RowAction[] {
    return [
      { label: "View", icon: LuEye, onSelect: () => openTask(task._id) },
      { label: "Edit schedule", icon: LuPencil, onSelect: () => setDialog({ kind: "schedule", task }) },
      { label: "Stop repeating", icon: LuSquare, onSelect: () => setDialog({ kind: "stop", task }) },
      {
        label: "Delete",
        icon: LuTrash2,
        variant: "destructive",
        separated: true,
        onSelect: () => setDialog({ kind: "delete", task }),
      },
    ];
  }

  const copiesLink = (task: Task) => (
    <Link
      to={`/tasks?recurringParent=${task._id}`}
      className="text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:underline"
    >
      {task.copyCount ?? 0} {task.copyCount === 1 ? "copy" : "copies"}
    </Link>
  );

  const columns: DataTableColumn<Task>[] = [
    {
      id: "task",
      header: "Task",
      sortKey: "title",
      className: "min-w-64 max-w-md whitespace-normal",
      cell: (task) => (
        <div className="min-w-0 space-y-1">
          <button
            type="button"
            onClick={() => openTask(task._id)}
            className="text-left font-medium break-words text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
          >
            {task.title}
          </button>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {taskCode(task) && <ShortCode code={taskCode(task)} />}
            {task.project && <span className="truncate">{task.project.name}</span>}
          </div>
        </div>
      ),
    },
    {
      id: "schedule",
      header: "Schedule",
      cell: (task) =>
        task.recurrence ? (
          <span className="inline-flex items-center gap-1.5">
            <LuRepeat aria-hidden className="size-3.5 text-muted-foreground" />
            {describeSchedule(task.recurrence)}
          </span>
        ) : (
          "--"
        ),
    },
    {
      id: "cycles",
      header: "Cycles",
      className: "tabular-nums",
      cell: (task) => (task.recurrence ? cyclesText(task.recurrence) : "--"),
    },
    {
      id: "next",
      header: "Next run",
      className: "tabular-nums",
      cell: (task) =>
        task.recurrence?.nextRunAt ? formatTimestampDMY(task.recurrence.nextRunAt) : "--",
    },
    {
      id: "assignees",
      header: "Assignees",
      cell: (task) => <AvatarStack users={task.assignees} label="Assignees" />,
    },
    { id: "copies", header: "Copies", cell: copiesLink },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "w-12 text-right",
      cell: (task) => <RowActions label={`Actions for ${task.title}`} actions={actions(task)} />,
    },
  ];

  const total = list.data?.total ?? 0;
  const tasks = list.data?.tasks;

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        to="/tasks"
        className="inline-flex items-center gap-1.5 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <LuArrowLeft aria-hidden className="size-4" />
        All tasks
      </Link>
      <div className="mt-3">
        <PageHeader
          title="Recurring tasks"
          description="Schedules that create a fresh copy of a task on repeat. Stopping keeps the copies already made."
        />
      </div>

      <div className="mt-6 space-y-4">
        <FiltersBar
          search={table.filters.search}
          onSearchChange={(search) => table.setFilters({ search })}
          searchPlaceholder="Search recurring tasks…"
          canClear={Boolean(table.filters.search)}
          onClearAll={() => table.clearFilters()}
        />

        <DataTable
          caption={`Recurring tasks, ${total} total`}
          columns={columns}
          rows={tasks}
          getRowId={(task) => task._id}
          getRowLabel={(task) => task.title}
          sort={table.sort}
          dir={table.dir}
          onSort={table.toggleSort}
          loading={list.isPending}
          error={list.isError ? list.error : null}
          onRetry={() => void list.refetch()}
          retrying={list.isRefetching}
          errorTitle="Couldn't load recurring tasks"
          dimmed={list.isPlaceholderData}
          empty={
            <EmptyState
              icon={LuCalendarClock}
              title={table.filters.search ? "No matching recurring tasks" : "No recurring tasks"}
              description={
                table.filters.search
                  ? "Try a different search."
                  : "Turn on “Repeat” when creating or editing a task to schedule copies."
              }
              className="border-0"
            />
          }
          footer={
            list.data && total > 0 ? (
              <DataTablePager
                page={table.page}
                pageSize={table.pageSize}
                total={total}
                shown={tasks?.length ?? 0}
                onPageChange={table.setPage}
                onPageSizeChange={table.setPageSize}
              />
            ) : null
          }
          mobileCard={(task) => (
            <div className="space-y-2">
              <div className="flex items-start justify-between gap-2">
                <button
                  type="button"
                  onClick={() => openTask(task._id)}
                  className="min-w-0 text-left font-medium break-words text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
                >
                  {task.title}
                </button>
                <RowActions label={`Actions for ${task.title}`} actions={actions(task)} />
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
                <MobileField label="Schedule">
                  {task.recurrence ? describeSchedule(task.recurrence) : "--"}
                </MobileField>
                <MobileField label="Cycles">{task.recurrence ? cyclesText(task.recurrence) : "--"}</MobileField>
                <MobileField label="Next run">
                  {task.recurrence?.nextRunAt ? formatTimestampDMY(task.recurrence.nextRunAt) : "--"}
                </MobileField>
                <MobileField label="Copies">{copiesLink(task)}</MobileField>
                <MobileField label="Assignees">
                  <AvatarStack users={task.assignees} label="Assignees" />
                </MobileField>
              </dl>
            </div>
          )}
        />
      </div>

      {dialog && (
        <>
          <ScheduleDialog
            task={dialog.task}
            open={dialog.kind === "schedule"}
            onOpenChange={(open) => !open && setDialog(null)}
          />
          <ConfirmDialog
            open={dialog.kind === "stop"}
            onOpenChange={(open) => !open && setDialog(null)}
            pending={setRecurrence.isPending}
            title="Stop repeating this task?"
            description={`“${dialog.task.title}” won't create new copies.${
              dialog.task.copyCount
                ? ` The ${dialog.task.copyCount} existing ${dialog.task.copyCount === 1 ? "copy is" : "copies are"} kept.`
                : ""
            }`}
            confirmLabel="Stop repeating"
            icon={<LuSquare aria-hidden />}
            onConfirm={() =>
              setRecurrence.mutate(
                { id: dialog.task._id, recurrence: null },
                { onSuccess: () => setDialog(null) }
              )
            }
          />
          <DeleteTaskDialog
            task={dialog.task}
            open={dialog.kind === "delete"}
            onOpenChange={(open) => !open && setDialog(null)}
            onDeleted={() => setDialog(null)}
          />
        </>
      )}

      {user && (
        <TaskDetailSheet taskId={openTaskId} me={me} onClose={() => openTask(null)} />
      )}
    </div>
  );
}

function ScheduleDialog({
  task,
  open,
  onOpenChange,
}: {
  task: Task;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const setRecurrence = useSetTaskRecurrence();
  const [value, setValue] = useState<RecurrenceInput | null>(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (open && task.recurrence) {
      setValue({ every: task.recurrence.every, unit: task.recurrence.unit, cycles: task.recurrence.cycles });
      setSubmitted(false);
    }
  }, [open, task.recurrence]);

  function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (recurrenceError(value)) return;
    setRecurrence.mutate({ id: task._id, recurrence: value }, { onSuccess: () => onOpenChange(false) });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !setRecurrence.isPending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit schedule</DialogTitle>
          <DialogDescription>
            “{task.title}” — turning repeat off stops new copies and keeps the existing ones.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="space-y-4">
          <RecurrenceField value={value} onChange={setValue} showError={submitted} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={setRecurrence.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={setRecurrence.isPending}>
              {setRecurrence.isPending ? (
                <LuLoaderCircle aria-hidden className="animate-spin" />
              ) : (
                <LuSave aria-hidden />
              )}
              Save schedule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
