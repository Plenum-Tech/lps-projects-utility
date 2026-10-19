import { SegmentedControl, type SegmentedOption } from "@/components/globals/segmented-control";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  LuCalendarDays,
  LuCircleDot,
  LuClipboardCheck,
  LuClipboardList,
  LuDownload,
  LuKanban,
  LuLayoutList,
  LuLoaderCircle,
  LuPin,
  LuPlus,
  LuRepeat,
  LuTrash2,
  LuTriangleAlert,
  LuUserCheck,
} from "react-icons/lu";

import { ConfirmDialog } from "@/components/globals/confirm-dialog";
import { BulkBar, BulkMenu } from "@/components/globals/data-table/bulk-bar";
import { DateRangeFilter, FilterChip, FiltersBar } from "@/components/globals/data-table/filters-bar";
import { FiltersSheet, SheetSelect, SheetSwitch } from "@/components/globals/data-table/filters-sheet";
import { DataTablePager } from "@/components/globals/data-table/pagination";
import { DataTableToolbar, ViewToggle, type ViewOption } from "@/components/globals/data-table/toolbar";
import { FilterSelect } from "@/components/globals/filter-select";
import { ImportButton } from "@/components/imports/import-button";
import { EmptyState, PageHeader, QueryError } from "@/components/globals/query-states";
import { BulkAssignDialog } from "@/components/tasks/bulk-assign-dialog";
import { MySubtasksStrip } from "@/components/tasks/my-subtasks";
import { DeleteTaskDialog } from "@/components/tasks/task-action-dialogs";
import { TaskBoard, TaskBoardSkeleton } from "@/components/tasks/task-board";
import { TaskDetailSheet } from "@/components/tasks/task-detail-sheet";
import { TaskFormDialog } from "@/components/tasks/task-form-dialog";
import { TasksCalendar } from "@/components/tasks/tasks-calendar";
import { TasksTable, type TaskRowDialog } from "@/components/tasks/tasks-table";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useCurrentUser } from "@/hooks/use-auth";
import { useDepartments } from "@/hooks/use-departments";
import { usePearityStatus } from "@/hooks/use-pearity";
import { useMilestones, useProjectOptions } from "@/hooks/use-projects";
import { useRowSelection, useTableState } from "@/hooks/use-table-state";
import { useAssignableUsers, useTaskCategories, useTaskLabels } from "@/hooks/use-task-meta";
import {
  taskQueryParams,
  useBulkTasks,
  useExportTasks,
  useTask,
  useTaskApprovalsCount,
  useTaskBoard,
  useTaskList,
  useTaskRealtime,
  type TaskFilters,
  type TaskSortField,
} from "@/hooks/use-tasks";
import { formatDateOnly } from "@/lib/format";
import { PRIORITIES, PRIORITY_META, STATUS_META, TASK_STATUSES } from "@/lib/tasks";
import type { Role, Task, TaskPriority, TaskScope, TaskStatus, TaskStatusFilter } from "@/types";

type TaskView = "list" | "board" | "calendar" | "pinned" | "approvals";

const SORT_FIELDS: TaskSortField[] = [
  "code",
  "title",
  "startDate",
  "dueDate",
  "actualStartAt",
  "actualEndAt",
  "estimate",
  "loggedMinutes",
  "status",
  "priority",
];

const BASE_DEFAULTS = {
  view: "list",
  mine: "off",
  search: "",
  status: "",
  project: "",
  from: "",
  to: "",
  priority: "",
  label: "",
  category: "",
  assignee: "",
  milestone: "",
  department: "",
  overdue: "",
  pearityTag: "",
  iteration: "",
  recurringParent: "",
  // Set by My dashboard links (shown as removable chips).
  statusIn: "",
  createdOrDueFrom: "",
  createdOrDueTo: "",
  completedFrom: "",
  completedTo: "",
};
type FilterKey = keyof typeof BASE_DEFAULTS;

type StatusTab = "all" | "todo" | "in_progress" | "completed";
const STATUS_TABS: readonly SegmentedOption<StatusTab>[] = [
  { value: "all", label: "All", title: "All tasks" },
  { value: "todo", label: "To do", title: "To do" },
  { value: "in_progress", label: "In progress", title: "In progress" },
  { value: "completed", label: "Completed", title: "Completed" },
];

const INLINE_KEYS: FilterKey[] = ["search", "status", "project", "from", "to"];
const SHEET_KEYS: FilterKey[] = [
  "iteration",
  "priority",
  "label",
  "category",
  "assignee",
  "milestone",
  "department",
  "overdue",
  "pearityTag",
];

/** Filters without an inline control, shown as removable chips. */
const CHIP_KEYS: FilterKey[] = [
  "recurringParent",
  "statusIn",
  "createdOrDueFrom",
  "createdOrDueTo",
  "completedFrom",
  "completedTo",
];

/** "9 Sep 2026 – 8 Oct 2026" / "from …" / "until …". */
function rangeText(from: string, to: string): string {
  if (from && to) return `${formatDateOnly(from)} – ${formatDateOnly(to)}`;
  return from ? `from ${formatDateOnly(from)}` : `until ${formatDateOnly(to)}`;
}

const SUBTITLES: Record<Role, string> = {
  admin: "Plan, assign and review work across the organisation.",
  head: "Assign work to your department and review what comes back.",
  employee: "Everything assigned to you — track time and move work forward.",
};

/** Scoping for the embedded project "Tasks" tab. */
export interface WorkspaceProject {
  _id: string;
  name: string;
  code: string;
  /** From the project permissions (admin, head, project manager). */
  canCreateTasks: boolean;
  /**
   * New project without scope: no tasks until it has one. Shown instead of
   * "Add task", with a link to where the scope is added.
   */
  noScope?: { addScopeHref: string | null } | null;
}

/** "Add task" replacement on a new project that has no scope yet. */
function NoScopeNotice({ addScopeHref }: { addScopeHref: string | null }) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-1.5 text-sm"
    >
      <LuTriangleAlert aria-hidden className="size-4 shrink-0 text-destructive" />
      <span>No tasks yet — this project has no scope. Add its scope (or the brand&apos;s) first.</span>
      {addScopeHref && (
        <Link to={addScopeHref} className={buttonVariants({ size: "sm", variant: "outline" })}>
          Add scope
        </Link>
      )}
    </div>
  );
}

/**
 * The /tasks experience for every role: toolbar, URL-backed filters, the
 * table / board / calendar / pinned / waiting-approval views, bulk actions,
 * the `?task=<id>` detail sheet and the create dialog.
 *
 * With `project` it renders embedded in the project page: filters live in
 * component state (the page owns the URL), the project is fixed and the
 * Waiting approval view is left to /tasks.
 */
export function TaskWorkspace({ project }: { project?: WorkspaceProject } = {}) {
  const { data: user } = useCurrentUser();
  // RequireAuth guarantees a user; keep hooks unconditional anyway.
  const role: Role = user?.role ?? "employee";
  const isManager = role === "admin" || role === "head";
  const me = useMemo(() => ({ _id: user?._id ?? "", role }), [user?._id, role]);

  useTaskRealtime();

  const table = useTableState({
    storageKey: project ? "project-tasks" : "tasks",
    defaults: { ...BASE_DEFAULTS, mine: isManager || project ? "off" : "on" },
    mode: project ? "memory" : "url",
  });
  const { filters } = table;

  // --- Detail sheet (`?task=<id>`) -------------------------------------------
  const [searchParams, setSearchParams] = useSearchParams();
  const openTaskId = searchParams.get("task");
  const openSubtaskId = searchParams.get("subtask");
  // On the project page `tab` belongs to the project tabs.
  const openTab = project ? null : searchParams.get("tab");

  const openTask = useCallback(
    (id: string, subtaskId?: string) => {
      setSearchParams(
        (params) => {
          const next = new URLSearchParams(params);
          next.set("task", id);
          if (!project) next.delete("tab");
          if (subtaskId) next.set("subtask", subtaskId);
          else next.delete("subtask");
          return next;
        },
        { preventScrollReset: true }
      );
    },
    [setSearchParams, project]
  );

  const closeTask = useCallback(() => {
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        next.delete("task");
        next.delete("subtask");
        if (!project) next.delete("tab");
        return next;
      },
      { preventScrollReset: true }
    );
  }, [setSearchParams, project]);

  // --- Views -------------------------------------------------------------------
  const approvalsCount = useTaskApprovalsCount(Boolean(user) && !project);
  const isReviewer = Boolean(approvalsCount.data?.isReviewer) && !project;
  const views = useMemo<ViewOption<TaskView>[]>(() => {
    const list: ViewOption<TaskView>[] = [
      { value: "list", label: "List", icon: LuLayoutList },
      { value: "board", label: "Board", icon: LuKanban },
      { value: "calendar", label: "Calendar", icon: LuCalendarDays },
      { value: "pinned", label: "Pinned", icon: LuPin },
    ];
    if (isReviewer) {
      list.push({
        value: "approvals",
        label: "Waiting approval",
        icon: LuClipboardCheck,
        badge: approvalsCount.data?.count,
      });
    }
    return list;
  }, [isReviewer, approvalsCount.data?.count]);
  const requestedView = filters.view as TaskView;
  const view: TaskView =
    requestedView === "approvals"
      ? isReviewer || approvalsCount.isPending
        ? "approvals"
        : "list"
      : views.some((option) => option.value === requestedView)
        ? requestedView
        : "list";
  const tableView = view === "list" || view === "pinned" || view === "approvals";

  // --- Query params -----------------------------------------------------------
  // A picked employee wins over "My tasks" (e.g. a shared `?assignee=` link).
  const mine = filters.mine === "on" && !filters.assignee;
  const scope: TaskScope = view === "approvals" ? "approvals" : mine ? "assigned" : "all";
  const status = (filters.status || "all") as TaskStatusFilter;
  const sort = (SORT_FIELDS as string[]).includes(table.sort) ? (table.sort as TaskSortField) : "";
  const pearityOn = usePearityStatus(Boolean(user)).data === true;
  const taskFilters: TaskFilters = {
    scope,
    search: filters.search,
    priority: filters.priority as TaskPriority | "",
    label: filters.label,
    category: filters.category,
    assignee: filters.assignee,
    due: "",
    project: project?._id ?? (filters.project || undefined),
    milestone: filters.milestone || undefined,
    department: filters.department || undefined,
    from: filters.from || undefined,
    to: filters.to || undefined,
    overdue: filters.overdue === "on",
    pearityTag: pearityOn && (filters.pearityTag === "has" || filters.pearityTag === "none") ? filters.pearityTag : "",
    iteration: filters.iteration === "new" || filters.iteration === "rework" ? filters.iteration : "",
    pinned: view === "pinned",
    recurringParent: filters.recurringParent || undefined,
    statusIn: filters.statusIn || undefined,
    createdOrDueFrom: filters.createdOrDueFrom || undefined,
    createdOrDueTo: filters.createdOrDueTo || undefined,
    completedFrom: filters.completedFrom || undefined,
    completedTo: filters.completedTo || undefined,
  };

  const list = useTaskList(
    { ...taskFilters, status, sort, dir: table.dir, limit: table.pageSize, offset: table.offset },
    tableView && Boolean(user)
  );
  const board = useTaskBoard(taskFilters, view === "board" && Boolean(user));
  const { clampPage } = table;
  useEffect(() => {
    if (list.data && tableView) clampPage(list.data.total);
  }, [list.data, tableView, clampPage]);

  // --- Selection & bulk -------------------------------------------------------
  const selection = useRowSelection();
  const { clear: clearSelection } = selection;
  const selectionKey = JSON.stringify({ ...filters, sort: table.sort, dir: table.dir });
  // View-only rows (another person's tasks via the Employee filter) on the pages
  // seen since the selection was cleared: only "Export selected" works on them.
  const [readOnlySeen, setReadOnlySeen] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    clearSelection();
    setReadOnlySeen(new Set());
  }, [selectionKey, clearSelection]);
  const pageReadOnly = useMemo(
    () => (list.data?.tasks ?? []).filter((task) => task.access === "read").map((task) => task._id),
    [list.data]
  );
  useEffect(() => {
    if (pageReadOnly.length > 0) setReadOnlySeen((current) => new Set([...current, ...pageReadOnly]));
  }, [pageReadOnly]);
  const canWriteSelection = selection.ids.some((id) => !readOnlySeen.has(id) && !pageReadOnly.includes(id));

  const bulk = useBulkTasks();
  const exporter = useExportTasks();
  const [assignOpen, setAssignOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  function runBulk(input: { action: "status" | "assign" | "delete"; status?: TaskStatus; assignees?: string[] }) {
    bulk.mutate(
      { ids: selection.ids, ...input },
      {
        onSuccess: (result) => {
          setAssignOpen(false);
          setDeleteOpen(false);
          // Keep the skipped rows selected so they can be retried or inspected.
          selection.setMany(result.updatedIds, false);
        },
      }
    );
  }

  function exportCsv(ids?: string[]) {
    exporter.mutate(
      ids
        ? // The employee lets the server export their view-only rows too.
          { ids: ids.join(","), ...(taskFilters.assignee ? { assignee: taskFilters.assignee } : {}) }
        : taskQueryParams({ ...taskFilters, status, sort, dir: table.dir })
    );
  }

  // --- Dialogs ------------------------------------------------------------------
  const [createOpen, setCreateOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [rowDialog, setRowDialog] = useState<{ kind: TaskRowDialog; task: Task } | null>(null);

  // --- Filter options ---------------------------------------------------------------
  const labels = useTaskLabels();
  const categories = useTaskCategories();
  // Employee filter: everyone, for every role (other people's tasks open view only).
  const assignable = useAssignableUsers(Boolean(user));
  const projectOptions = useProjectOptions(Boolean(user) && !project);
  // Everyone gets "Add task" (the form lists the projects they can add to, or
  // explains how to get one); inside a project it follows its permissions.
  const noScope = project?.noScope ?? null;
  const canCreate = (project ? project.canCreateTasks : true) && !noScope;
  const milestoneProject = project?._id ?? (filters.project && filters.project !== "none" ? filters.project : "");
  const milestones = useMilestones(milestoneProject || null, Boolean(milestoneProject));
  const recurringParent = useTask(filters.recurringParent || null);

  const sheetKeys = SHEET_KEYS.filter(
    (key) => (key !== "department" || role === "admin") && (key !== "pearityTag" || pearityOn)
  );
  const sheetCount = table.countActive(sheetKeys);
  const inlineKeys = INLINE_KEYS.filter((key) => key !== "project" || !project);
  const clearableKeys: FilterKey[] = [...inlineKeys, ...sheetKeys, ...CHIP_KEYS];
  const filtered = table.countActive(clearableKeys) > 0;

  const projectFilterOptions = useMemo(
    () => [
      { value: "none", label: "No project" },
      ...(projectOptions.data ?? []).map((item) => ({ value: item._id, label: `${item.code} · ${item.name}` })),
    ],
    [projectOptions.data]
  );
  const employeeOptions = useMemo(() => {
    const options = (assignable.data ?? []).map((person) => ({
      value: person._id,
      label: person._id === me._id ? `${person.name} (you)` : person.name,
    }));
    // Keep an employee from the URL labelled while the people load.
    if (filters.assignee && !options.some((option) => option.value === filters.assignee)) {
      options.push({ value: filters.assignee, label: assignable.isPending ? "Loading…" : "Selected employee" });
    }
    return options;
  }, [assignable.data, assignable.isPending, filters.assignee, me._id]);
  // Picking someone turns "My tasks" off (both together would match only shared
  // tasks); turning "My tasks" on clears the employee.
  const selectEmployee = (assignee: string) =>
    table.setFilters(assignee ? { assignee, mine: "off" } : { assignee });

  const tasks = list.data?.tasks;
  const total = list.data?.total ?? 0;

  const empty = filtered ? (
    <EmptyState
      icon={LuClipboardList}
      title="No matching tasks"
      description="Try a different search or clear the filters."
      className="border-0"
    >
      <Button variant="outline" onClick={() => table.clearFilters(clearableKeys)}>
        Clear filters
      </Button>
    </EmptyState>
  ) : view === "pinned" ? (
    <EmptyState
      icon={LuPin}
      title="Nothing pinned yet"
      description="Pin tasks from their ⋮ menu to keep them one click away."
      className="border-0"
    />
  ) : view === "approvals" ? (
    <EmptyState
      icon={LuClipboardCheck}
      title="Nothing waiting for you"
      description="Tasks submitted for review that you can approve show up here."
      className="border-0"
    />
  ) : (
    <EmptyState
      icon={LuClipboardList}
      title={
        mine ? "Nothing assigned to you" : project ? `No tasks in ${project.code} yet` : "No tasks yet"
      }
      description={
        canCreate
          ? project
            ? `Add the first task — it gets a short code like ${project.code}-1.`
            : "Create a task, assign it to your team and track it from here."
          : "When someone assigns you work, it shows up here."
      }
      className="border-0"
    >
      {noScope && project?.canCreateTasks ? (
        <NoScopeNotice addScopeHref={noScope.addScopeHref} />
      ) : (
        canCreate && (
          <Button onClick={() => setCreateOpen(true)}>
            <LuPlus aria-hidden />
            Add task
          </Button>
        )
      )}
    </EmptyState>
  );

  return (
    <div className={project ? "w-full" : "mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8"}>
      {!project && (
        <PageHeader
          title="Tasks"
          description={
            filters.assignee && filters.assignee !== me._id
              ? `Tasks of ${assignable.data?.find((person) => person._id === filters.assignee)?.name ?? "the selected employee"}. Ones you aren't on open view only.`
              : SUBTITLES[role]
          }
        />
      )}

      <div className={project ? "space-y-4" : "mt-6 space-y-4"}>
        {!project && user && <MySubtasksStrip onOpen={openTask} />}

        <DataTableToolbar
          actions={
            <>
              {noScope && project?.canCreateTasks && <NoScopeNotice addScopeHref={noScope.addScopeHref} />}
              {canCreate && (
                <Button onClick={() => setCreateOpen(true)}>
                  <LuPlus aria-hidden />
                  Add task
                </Button>
              )}
              {view !== "approvals" && (
                <div className="flex h-8 items-center gap-2 rounded-lg border bg-background px-2.5">
                  <Switch
                    id="tasks-mine"
                    size="sm"
                    checked={mine}
                    onCheckedChange={(checked) =>
                      table.setFilters(checked ? { mine: "on", assignee: "" } : { mine: "off" })
                    }
                  />
                  <Label htmlFor="tasks-mine" className="cursor-pointer text-sm font-medium">
                    My tasks
                  </Label>
                </div>
              )}
              {!project && (
                <Link to="/tasks/recurring" className={buttonVariants({ variant: "outline" })}>
                  <LuRepeat aria-hidden />
                  Recurring tasks
                </Link>
              )}
              <Button
                variant="outline"
                onClick={() => exportCsv()}
                disabled={exporter.isPending || !tableView}
              >
                {exporter.isPending ? (
                  <LuLoaderCircle aria-hidden className="animate-spin" />
                ) : (
                  <LuDownload aria-hidden />
                )}
                Export
              </Button>
              {canCreate && <ImportButton type="tasks" defaultProjectId={project?._id} />}
            </>
          }
          end={
            <ViewToggle
              label="Tasks view"
              value={view}
              onChange={(next) => table.setFilters({ view: next })}
              options={views}
            />
          }
        />

        <FiltersBar
          search={filters.search}
          onSearchChange={(search) => table.setFilters({ search })}
          searchPlaceholder="Search title, code or description…"
          sheetCount={sheetCount}
          onOpenSheet={() => setSheetOpen(true)}
          canClear={filtered}
          onClearAll={() => table.clearFilters(clearableKeys)}
          chips={
            table.countActive(CHIP_KEYS) > 0 ? (
              <>
                {filters.recurringParent && (
                  <FilterChip onRemove={() => table.setFilters({ recurringParent: "" })}>
                    <LuRepeat aria-hidden className="size-3.5 text-muted-foreground" />
                    Copies of{" "}
                    {recurringParent.data
                      ? `“${recurringParent.data.task.title}”`
                      : "a recurring task"}
                  </FilterChip>
                )}
                {filters.statusIn && (
                  <FilterChip onRemove={() => table.setFilters({ statusIn: "" })}>
                    Status:{" "}
                    {filters.statusIn
                      .split(",")
                      .map((value) => STATUS_META[value as TaskStatus]?.label ?? value)
                      .join(", ")}
                  </FilterChip>
                )}
                {(filters.createdOrDueFrom || filters.createdOrDueTo) && (
                  <FilterChip onRemove={() => table.setFilters({ createdOrDueFrom: "", createdOrDueTo: "" })}>
                    Created or due {rangeText(filters.createdOrDueFrom, filters.createdOrDueTo)}
                  </FilterChip>
                )}
                {(filters.completedFrom || filters.completedTo) && (
                  <FilterChip onRemove={() => table.setFilters({ completedFrom: "", completedTo: "" })}>
                    Completed {rangeText(filters.completedFrom, filters.completedTo)}
                  </FilterChip>
                )}
              </>
            ) : undefined
          }
        >
          {view !== "calendar" && (
            <DateRangeFilter
              from={filters.from}
              to={filters.to}
              onChange={(range) => table.setFilters(range)}
              description="Tasks due within this range."
            />
          )}
          {view !== "board" && view !== "approvals" && (
            <FilterSelect
              label="Status"
              value={filters.status}
              onChange={(value) => table.setFilters({ status: value })}
              options={TASK_STATUSES.map((value) => ({ value, label: STATUS_META[value].label }))}
            />
          )}
          {!project && (
            <FilterSelect
              label="Project"
              value={filters.project}
              onChange={(value) => table.setFilters({ project: value, milestone: "" })}
              options={projectFilterOptions}
              className="max-w-56"
            />
          )}
          <FilterSelect
            label="Work"
            value={filters.iteration}
            onChange={(iteration) => table.setFilters({ iteration })}
            options={[
              { value: "new", label: "New work" },
              { value: "rework", label: "Rework" },
            ]}
          />
          <FilterSelect
            label="Employee"
            value={filters.assignee}
            onChange={selectEmployee}
            options={employeeOptions}
            anyLabel="Everyone"
            className="max-w-56"
            searchable
            searchPlaceholder="Search people…"
          />
        </FiltersBar>

        {tableView && (
          <BulkBar count={selection.count} onClear={selection.clear} pending={bulk.isPending}>
            {/* Only view-only rows selected: nothing to change, just export. */}
            {canWriteSelection && (
              <BulkMenu
                label="Change status"
                icon={<LuCircleDot aria-hidden />}
                heading="Set status to"
                options={TASK_STATUSES.map((value) => ({
                  value,
                  label: STATUS_META[value].label,
                  dot: STATUS_META[value].dot,
                }))}
                onSelect={(value) => runBulk({ action: "status", status: value as TaskStatus })}
                disabled={bulk.isPending}
              />
            )}
            {isManager && canWriteSelection && (
              <Button variant="outline" size="sm" onClick={() => setAssignOpen(true)} disabled={bulk.isPending}>
                <LuUserCheck aria-hidden />
                Assign to
              </Button>
            )}
            {isManager && canWriteSelection && (
              <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)} disabled={bulk.isPending}>
                <LuTrash2 aria-hidden />
                Delete
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => exportCsv(selection.ids)}
              disabled={exporter.isPending}
            >
              <LuDownload aria-hidden />
              Export selected
            </Button>
          </BulkBar>
        )}

        {view === "board" ? (
          board.isPending ? (
            <TaskBoardSkeleton />
          ) : board.isError ? (
            <QueryError
              title="Couldn't load the board"
              error={board.error}
              onRetry={() => void board.refetch()}
              retrying={board.isRefetching}
            />
          ) : board.data && user ? (
            <TaskBoard board={board.data} user={me} onOpen={openTask} />
          ) : null
        ) : view === "calendar" ? (
          <TasksCalendar filters={taskFilters} status={status} onOpen={openTask} />
        ) : (
          <>
          {/* Sections by status (the Board view shows them as columns). */}
          {view === "list" && (
            <SegmentedControl
              label="Task section"
              value={(["todo", "in_progress", "completed"].includes(filters.status) ? filters.status : "all") as StatusTab}
              onChange={(value) => table.setFilters({ status: value === "all" ? "" : value })}
              options={STATUS_TABS}
              className="w-fit"
            />
          )}
          <TasksTable
            tasks={tasks}
            total={total}
            loading={list.isPending}
            error={list.isError ? list.error : null}
            onRetry={() => void list.refetch()}
            retrying={list.isRefetching}
            dimmed={list.isPlaceholderData}
            selection={selection}
            sort={table.sort}
            dir={table.dir}
            onSort={table.toggleSort}
            me={me}
            onOpen={openTask}
            onDialog={(kind, task) => setRowDialog({ kind, task })}
            approvals={view === "approvals"}
            showProject={!project}
            empty={empty}
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
          />
          </>
        )}
      </div>

      <FiltersSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        activeCount={sheetCount}
        onClear={() => table.clearFilters(sheetKeys)}
      >
        <SheetSelect
          label="Priority"
          value={filters.priority}
          onChange={(priority) => table.setFilters({ priority })}
          options={PRIORITIES.map((value) => ({ value, label: PRIORITY_META[value].label }))}
        />
        <SheetSelect
          label="Label"
          value={filters.label}
          onChange={(label) => table.setFilters({ label })}
          options={(labels.data ?? []).map((label) => ({ value: label._id, label: label.name }))}
        />
        <SheetSelect
          label="Category"
          value={filters.category}
          onChange={(category) => table.setFilters({ category })}
          options={(categories.data ?? []).map((category) => ({ value: category._id, label: category.name }))}
        />
        <SheetSelect
          label="Employee"
          value={filters.assignee}
          onChange={selectEmployee}
          options={employeeOptions}
          anyLabel="Everyone"
        />
        {milestoneProject ? (
          <SheetSelect
            label="Milestone"
            value={filters.milestone}
            onChange={(milestone) => table.setFilters({ milestone })}
            options={[
              { value: "none", label: "No milestone" },
              ...(milestones.data ?? []).map((milestone) => ({ value: milestone._id, label: milestone.title })),
            ]}
          />
        ) : (
          <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
            Pick a project to filter by milestone.
          </p>
        )}
        {role === "admin" && (
          <DepartmentSheetSelect
            value={filters.department}
            onChange={(department) => table.setFilters({ department })}
          />
        )}
        {pearityOn && (
          <SheetSelect
            label="Pearity tag"
            value={filters.pearityTag}
            onChange={(pearityTag) => table.setFilters({ pearityTag })}
            anyLabel="Any"
            options={[
              { value: "has", label: "Has tag" },
              { value: "none", label: "No tag" },
            ]}
          />
        )}
        <SheetSwitch
          label="Overdue only"
          description="Due before today and not completed."
          checked={filters.overdue === "on"}
          onCheckedChange={(checked) => table.setFilters({ overdue: checked ? "on" : "" })}
        />
      </FiltersSheet>

      {user && (
        <TaskDetailSheet
          taskId={openTaskId}
          me={me}
          onClose={closeTask}
          subtaskId={openSubtaskId}
          tab={openTab}
        />
      )}

      {canCreate && (
        <TaskFormDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={openTask}
          defaultProjectId={project?._id}
        />
      )}

      {rowDialog && (
        <>
          <TaskFormDialog
            open={rowDialog.kind === "edit"}
            onOpenChange={(open) => !open && setRowDialog(null)}
            task={rowDialog.task}
          />
          <DeleteTaskDialog
            task={rowDialog.task}
            open={rowDialog.kind === "delete"}
            onOpenChange={(open) => !open && setRowDialog(null)}
            onDeleted={() => {
              selection.toggle(rowDialog.task._id, false);
              setRowDialog(null);
            }}
          />
        </>
      )}

      {isManager && (
        <BulkAssignDialog
          open={assignOpen}
          onOpenChange={setAssignOpen}
          count={selection.count}
          pending={bulk.isPending}
          onConfirm={(assignees) => runBulk({ action: "assign", assignees })}
        />
      )}

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        pending={bulk.isPending}
        destructive
        title={`Delete ${selection.count} task${selection.count === 1 ? "" : "s"}?`}
        description="Comments, files and history go with them. Tasks you can't delete are skipped. This can't be undone."
        confirmLabel="Delete"
        icon={<LuTrash2 aria-hidden />}
        onConfirm={() => runBulk({ action: "delete" })}
      />
    </div>
  );
}

/** Admin-only — mounted only for admins so the endpoint never 403s. */
function DepartmentSheetSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const departments = useDepartments();
  return (
    <SheetSelect
      label="Department"
      value={value}
      onChange={onChange}
      options={(departments.data?.departments ?? []).map((department) => ({
        value: department._id,
        label: department.name,
      }))}
    />
  );
}
