import { SubmitTaskDialog } from "@/components/tasks/task-action-dialogs";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import {
  LuBellRing,
  LuCopy,
  LuEye,
  LuPencil,
  LuPin,
  LuPinOff,
  LuRepeat,
  LuSparkles,
  LuTrash2,
} from "react-icons/lu";

import { AvatarStack } from "@/components/globals/data-table/avatar-stack";
import {
  ColumnVisibilityMenu,
  useColumnVisibility,
  type OptionalColumn,
} from "@/components/globals/data-table/column-visibility";
import { InlineStatus, type StatusOption } from "@/components/globals/data-table/inline-status";
import { RowActions, type RowAction } from "@/components/globals/data-table/row-actions";
import { DataTable, MobileField, type DataTableColumn } from "@/components/globals/data-table/table";
import { ActualDateCell } from "@/components/tasks/actual-dates";
import { ApprovalActions } from "@/components/tasks/approval-actions";
import { LabelChip } from "@/components/tasks/label-chip";
import { PearityTagCell, usePearityGenerateAction } from "@/components/tasks/pearity";
import { ReworkSourceBadge } from "@/components/tasks/rework-panel";
import { PriorityIndicator } from "@/components/tasks/task-badges";
import { TaskTimerButton } from "@/components/tasks/task-timer-button";
import { usePearityStatus } from "@/hooks/use-pearity";
import type { RowSelection, SortDir } from "@/hooks/use-table-state";
import {
  useDuplicateTask,
  useRemindTask,
  useTask,
  useToggleTaskPin,
  useUpdateTaskStatus,
} from "@/hooks/use-tasks";
import {
  STATUS_META,
  TASK_STATUSES,
  allowedDropStatuses,
  formatDMY,
  formatEffort,
  formatTimestampDMY,
  isOverdue,
  taskCode,
} from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { Role, Task } from "@/types";

type Me = { _id: string; role: Role };

export type TaskRowDialog = "edit" | "delete";

/** Hidden by default; turned on from the columns menu (remembered per user). */
const OPTIONAL_COLUMNS: OptionalColumn[] = [
  { id: "actualStart", label: "Actual start" },
  { id: "actualEnd", label: "Actual end" },
];

/** Shown in the columns menu only while the Pearity integration is on. */
const PEARITY_COLUMN: OptionalColumn = { id: "pearityTag", label: "Pearity tag" };

const STATUS_OPTIONS: StatusOption[] = TASK_STATUSES.map((status) => ({
  value: status,
  label: STATUS_META[status].label,
  dot: STATUS_META[status].dot,
}));

function CodeCell({ task, me }: { task: Task; me: Me }) {
  const code = taskCode(task);
  return (
    <div className="flex flex-col items-start gap-1.5">
      <span className="font-mono text-xs font-medium text-muted-foreground">{code || "--"}</span>
      <TaskTimerButton task={task} me={me} />
    </div>
  );
}

function TaskCell({ task, onOpen, showProject }: { task: Task; onOpen: (id: string) => void; showProject: boolean }) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex min-w-0 items-start gap-1.5">
        <button
          type="button"
          onClick={() => onOpen(task._id)}
          className="min-w-0 text-left font-medium break-words text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
        >
          {task.title}
        </button>
        {task.pinned && <LuPin aria-label="Pinned" className="mt-0.5 size-3.5 shrink-0 text-primary" />}
        {task.recurrence && (
          <LuRepeat aria-label="Recurring" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <PriorityIndicator priority={task.priority} />
        {showProject &&
          task.project &&
          (task.access === "read" ? (
            // View only: the caller can't open the project itself.
            <span className="max-w-48 truncate text-xs text-muted-foreground">{task.project.name}</span>
          ) : (
            <Link
              to={`/projects/${task.project._id}`}
              className="max-w-48 truncate text-xs text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:underline"
            >
              {task.project.name}
            </Link>
          ))}
        {task.labels.slice(0, 3).map((label) => (
          <LabelChip key={label._id} name={label.name} color={label.color} />
        ))}
        {task.labels.length > 3 && (
          <span className="text-xs text-muted-foreground">+{task.labels.length - 3}</span>
        )}
      </div>
    </div>
  );
}

function DueCell({ task }: { task: Task }) {
  if (!task.dueDate) return <span className="text-muted-foreground">--</span>;
  const overdue = isOverdue(task);
  return (
    <span className={cn("tabular-nums", overdue && "font-medium text-destructive")}>
      {formatDMY(task.dueDate)}
      {overdue && <span className="sr-only"> (overdue)</span>}
    </span>
  );
}

function LoggedCell({ task }: { task: Task }) {
  const logged = task.loggedMinutes ?? 0;
  const over = Boolean(task.estimateMinutes && logged > task.estimateMinutes);
  return (
    <span
      className={cn("tabular-nums", over && "font-medium text-destructive")}
      title={over ? `Over the estimate by ${formatEffort(logged - (task.estimateMinutes ?? 0))}` : undefined}
    >
      {formatEffort(logged)}
      {over && <span className="sr-only"> (over estimate)</span>}
    </span>
  );
}

/**
 * Status dropdown for a task. Offers the transitions the client can infer;
 * when none are known but the caller might manage the project, the server
 * permissions are fetched as the menu opens.
 */
function TaskStatusCell({ task, me }: { task: Task; me: Me }) {
  const [opened, setOpened] = useState(false);
  // Completing asks for the time spent and a note, file or link (Mark as complete).
  const [completing, setCompleting] = useState(false);
  const updateStatus = useUpdateTaskStatus();
  const clientAllowed = allowedDropStatuses(task, me).filter((status) => status !== task.status);
  // View-only rows (another person's task) never get any status moves.
  const mayBeManager =
    clientAllowed.length === 0 && Boolean(task.project) && !task.project?.archivedAt && task.access !== "read";
  const detail = useTask(task._id, opened && mayBeManager);
  const allowed = mayBeManager
    ? detail.data?.permissions.allowedStatuses
    : clientAllowed;

  return (
    <>
    <InlineStatus
      value={task.status}
      options={STATUS_OPTIONS}
      allowed={allowed}
      loadingAllowed={mayBeManager && opened && detail.isPending}
      onOpenChange={(open) => open && setOpened(true)}
      onChange={async (status) => {
        if (status === "completed") {
          setCompleting(true);
          return;
        }
        await updateStatus.mutateAsync({ id: task._id, status: status as Task["status"] });
      }}
      label={`Change status of ${taskCode(task) || task.title}`}
    />
    <SubmitTaskDialog task={task} open={completing} onOpenChange={setCompleting} />
    </>
  );
}

/** ⋮ menu — Edit / Send reminder / Delete come from the server permissions (loaded on open). */
function TaskRowMenu({
  task,
  me,
  onOpen,
  onDialog,
}: {
  task: Task;
  me: Me;
  onOpen: (id: string) => void;
  onDialog: (kind: TaskRowDialog, task: Task) => void;
}) {
  const [opened, setOpened] = useState(false);
  const detail = useTask(task._id, opened);
  const permissions = detail.data?.permissions;
  const duplicate = useDuplicateTask();
  const pin = useToggleTaskPin();
  const remind = useRemindTask();
  const pearity = usePearityGenerateAction(task);

  // From the row's detail (fetched when the menu opens) — employees only in projects they manage.
  const canDuplicate = Boolean(permissions?.canDuplicate);
  // View-only rows (another person's task): no Generate / Pin — the server refuses both.
  const viewOnly = task.access === "read" || detail.data?.access === "read";
  const actions: RowAction[] = [
    { label: "View", icon: LuEye, onSelect: () => onOpen(task._id) },
  ];
  if (permissions?.canEdit) {
    actions.push({ label: "Edit", icon: LuPencil, onSelect: () => onDialog("edit", detail.data?.task ?? task) });
  }
  if (canDuplicate) {
    actions.push({
      label: "Duplicate",
      icon: LuCopy,
      disabled: duplicate.isPending,
      onSelect: () => duplicate.mutate(task._id),
    });
  }
  if (pearity.visible && !viewOnly) {
    actions.push({
      label: "Generate on Pearity",
      icon: LuSparkles,
      disabled: pearity.pending,
      onSelect: pearity.onSelect,
    });
  }
  if (task.pinned || !viewOnly) {
    actions.push({
      label: task.pinned ? "Unpin" : "Pin",
      icon: task.pinned ? LuPinOff : LuPin,
      onSelect: () => pin.mutate({ id: task._id, pinned: !task.pinned }),
    });
  }
  if (permissions?.canRemind && task.status !== "completed") {
    actions.push({
      label: "Send reminder",
      icon: LuBellRing,
      disabled: remind.isPending,
      onSelect: () => remind.mutate(task._id),
    });
  }
  if (permissions?.canDelete) {
    actions.push({
      label: "Delete",
      icon: LuTrash2,
      variant: "destructive",
      separated: true,
      onSelect: () => onDialog("delete", task),
    });
  }

  return (
    <>
      <RowActions
        label={`Actions for ${taskCode(task) || task.title}`}
        actions={actions}
        loading={opened && detail.isPending}
        onOpenChange={(open) => open && setOpened(true)}
      />
      {pearity.dialog}
    </>
  );
}

export function TasksTable({
  tasks,
  total,
  loading,
  error,
  onRetry,
  retrying,
  dimmed,
  selection,
  sort,
  dir,
  onSort,
  me,
  onOpen,
  onDialog,
  approvals,
  showProject = true,
  empty,
  footer,
}: {
  tasks: Task[] | undefined;
  total: number;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
  dimmed: boolean;
  selection?: RowSelection;
  sort: string;
  dir: SortDir;
  onSort: (field: string) => void;
  me: Me;
  onOpen: (id: string) => void;
  onDialog: (kind: TaskRowDialog, task: Task) => void;
  /** "Waiting approval" view: inline Approve / Reject. */
  approvals?: boolean;
  showProject?: boolean;
  empty: ReactNode;
  footer: ReactNode;
}) {
  const optional = useColumnVisibility("tasks", me._id);
  const pearityOn = usePearityStatus().data === true;
  const optionalColumns = pearityOn ? [...OPTIONAL_COLUMNS, PEARITY_COLUMN] : OPTIONAL_COLUMNS;
  const showPearity = pearityOn && optional.isVisible("pearityTag");
  const columns: DataTableColumn<Task>[] = [
    {
      id: "code",
      header: "Code",
      sortKey: "code",
      className: "w-20",
      cell: (task) => <CodeCell task={task} me={me} />,
    },
    {
      id: "task",
      header: "Task",
      sortKey: "title",
      className: "min-w-64 max-w-md whitespace-normal",
      cell: (task) => <TaskCell task={task} onOpen={onOpen} showProject={showProject} />,
    },
    ...(approvals
      ? [
          {
            id: "review",
            header: "Review",
            cell: (task: Task) => <ApprovalActions task={task} />,
          } satisfies DataTableColumn<Task>,
        ]
      : []),
    {
      id: "completed",
      header: "Completed on",
      className: "tabular-nums",
      cell: (task) =>
        task.completedAt ? formatTimestampDMY(task.completedAt) : <span className="text-muted-foreground">--</span>,
    },
    {
      id: "start",
      header: "Start date",
      sortKey: "startDate",
      className: "tabular-nums",
      cell: (task) => (task.startDate ? formatDMY(task.startDate) : <span className="text-muted-foreground">--</span>),
    },
    {
      id: "due",
      header: "Due date",
      sortKey: "dueDate",
      cell: (task) => <DueCell task={task} />,
    },
    ...(optional.isVisible("actualStart")
      ? [
          {
            id: "actualStart",
            header: "Actual start",
            sortKey: "actualStartAt",
            cell: (task: Task) => <ActualDateCell task={task} field="actualStartAt" />,
          } satisfies DataTableColumn<Task>,
        ]
      : []),
    ...(optional.isVisible("actualEnd")
      ? [
          {
            id: "actualEnd",
            header: "Actual end",
            sortKey: "actualEndAt",
            cell: (task: Task) => <ActualDateCell task={task} field="actualEndAt" />,
          } satisfies DataTableColumn<Task>,
        ]
      : []),
    ...(showPearity
      ? [
          {
            id: "pearityTag",
            header: "Pearity tag",
            cell: (task: Task) => <PearityTagCell task={task} />,
          } satisfies DataTableColumn<Task>,
        ]
      : []),
    {
      id: "estimate",
      header: "Estimated time",
      sortKey: "estimate",
      className: "tabular-nums",
      cell: (task) =>
        task.estimateMinutes ? formatEffort(task.estimateMinutes) : <span className="text-muted-foreground">--</span>,
    },
    {
      id: "logged",
      header: "Hours logged",
      sortKey: "loggedMinutes",
      cell: (task) => <LoggedCell task={task} />,
    },
    {
      id: "assignees",
      header: "Assigned to",
      cell: (task) => <AvatarStack users={task.assignees} label="Assigned to" />,
    },
    {
      id: "iteration",
      header: "Work",
      cell: (task) =>
        task.iteration === "rework" ? (
          <span className="inline-flex items-center gap-1">
            <span
              className="rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-warn"
              title={task.reworkOf ? `Rework of ${task.reworkOf.shortCode ?? ""} ${task.reworkOf.title}`.trim() : "Rework"}
            >
              Rework
            </span>
            <ReworkSourceBadge source={task.reworkSource} />
          </span>
        ) : (
          <span className="rounded-full border bg-muted/40 px-2 py-0.5 text-xs whitespace-nowrap text-muted-foreground">
            New work
          </span>
        ),
    },
    {
      id: "status",
      header: "Status",
      sortKey: "status",
      cell: (task) => <TaskStatusCell task={task} me={me} />,
    },
    {
      id: "actions",
      header: (
        <span className="flex justify-end">
          <ColumnVisibilityMenu columns={optionalColumns} isVisible={optional.isVisible} onToggle={optional.toggle} />
        </span>
      ),
      headClassName: "w-12 text-right",
      className: "w-12 text-right",
      cell: (task) => <TaskRowMenu task={task} me={me} onOpen={onOpen} onDialog={onDialog} />,
    },
  ];

  return (
    <DataTable
      caption={`Tasks, ${total} total`}
      columns={columns}
      rows={tasks}
      getRowId={(task) => task._id}
      getRowLabel={(task) => `${taskCode(task)} ${task.title}`.trim()}
      selection={selection}
      sort={sort}
      dir={dir}
      onSort={onSort}
      loading={loading}
      error={error}
      onRetry={onRetry}
      retrying={retrying}
      errorTitle="Couldn't load tasks"
      dimmed={dimmed}
      empty={empty}
      footer={footer}
      mobileCard={(task) => (
        <div className="space-y-2.5">
          <div className="flex items-start gap-2">
            <div className="flex flex-col items-center gap-1.5 pt-0.5">
              <TaskTimerButton task={task} me={me} />
            </div>
            <div className="min-w-0 flex-1">
              <span className="font-mono text-[0.7rem] text-muted-foreground">{taskCode(task)}</span>
              <TaskCell task={task} onOpen={onOpen} showProject={showProject} />
            </div>
            <TaskRowMenu task={task} me={me} onOpen={onOpen} onDialog={onDialog} />
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
            <MobileField label="Due date">
              <DueCell task={task} />
            </MobileField>
            <MobileField label="Start date">{formatDMY(task.startDate)}</MobileField>
            <MobileField label="Estimate / logged">
              <span className="tabular-nums">
                {task.estimateMinutes ? formatEffort(task.estimateMinutes) : "--"} / <LoggedCell task={task} />
              </span>
            </MobileField>
            <MobileField label="Assigned to">
              <AvatarStack users={task.assignees} label="Assigned to" />
            </MobileField>
            <MobileField label="Status">
              <TaskStatusCell task={task} me={me} />
            </MobileField>
            {task.completedAt && (
              <MobileField label="Completed on">{formatTimestampDMY(task.completedAt)}</MobileField>
            )}
            {optional.isVisible("actualStart") && (
              <MobileField label="Actual start">
                <ActualDateCell task={task} field="actualStartAt" />
              </MobileField>
            )}
            {optional.isVisible("actualEnd") && (
              <MobileField label="Actual end">
                <ActualDateCell task={task} field="actualEndAt" />
              </MobileField>
            )}
            {showPearity && (
              <MobileField label="Pearity tag">
                <PearityTagCell task={task} />
              </MobileField>
            )}
          </dl>
          {approvals && <ApprovalActions task={task} />}
        </div>
      )}
    />
  );
}
