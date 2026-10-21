import { useCallback, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router";
import { LuClipboardList } from "react-icons/lu";

import { SegmentedControl, type SegmentedOption } from "@/components/globals/segmented-control";
import { FiltersBar } from "@/components/globals/data-table/filters-bar";
import { DataTablePager } from "@/components/globals/data-table/pagination";
import { EmptyState, PageHeader } from "@/components/globals/query-states";
import { TaskDetailSheet } from "@/components/tasks/task-detail-sheet";
import { TasksTable } from "@/components/tasks/tasks-table";
import { useCurrentUser } from "@/hooks/use-auth";
import { useTableState } from "@/hooks/use-table-state";
import { useTaskList, useTaskRealtime, type TaskSortField } from "@/hooks/use-tasks";
import type { TaskStatusFilter } from "@/types";

type StatusTab = "all" | "todo" | "in_progress" | "completed";
const STATUS_TABS: readonly SegmentedOption<StatusTab>[] = [
  { value: "all", label: "All", title: "All tasks" },
  { value: "todo", label: "To do", title: "To do" },
  { value: "in_progress", label: "In progress", title: "In progress" },
  { value: "completed", label: "Completed", title: "Completed" },
];

const SORT_FIELDS: TaskSortField[] = ["code", "title", "startDate", "dueDate", "status", "priority"];

/**
 * /tasks for an outside guest: just the tasks they were invited to (the API
 * returns nothing else), search + status sections, and the `?task=<id>`
 * detail sheet where they comment, upload, log time and submit. No create,
 * import, export, bulk actions or people filters.
 */
export function GuestTaskWorkspace() {
  const { data: user } = useCurrentUser();
  const me = useMemo(() => ({ _id: user?._id ?? "", role: user?.role ?? "employee" }), [user?._id, user?.role]);
  useTaskRealtime();

  const table = useTableState({ storageKey: "guest-tasks", defaults: { search: "", status: "" } });
  const { filters } = table;
  const [searchParams, setSearchParams] = useSearchParams();
  const openTaskId = searchParams.get("task");

  const openTask = useCallback(
    (id: string) =>
      setSearchParams(
        (params) => {
          const next = new URLSearchParams(params);
          next.set("task", id);
          return next;
        },
        { preventScrollReset: true }
      ),
    [setSearchParams]
  );
  const closeTask = useCallback(
    () =>
      setSearchParams(
        (params) => {
          const next = new URLSearchParams(params);
          next.delete("task");
          next.delete("subtask");
          next.delete("tab");
          return next;
        },
        { preventScrollReset: true }
      ),
    [setSearchParams]
  );

  const status = (["todo", "in_progress", "completed"].includes(filters.status) ? filters.status : "all") as StatusTab;
  const sort = (SORT_FIELDS as string[]).includes(table.sort) ? (table.sort as TaskSortField) : "";
  const list = useTaskList(
    {
      scope: "all",
      search: filters.search,
      priority: "",
      label: "",
      category: "",
      assignee: "",
      due: "",
      status: status as TaskStatusFilter,
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

  const tasks = list.data?.tasks;
  const total = list.data?.total ?? 0;
  const filtered = filters.search !== "" || status !== "all";

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="My tasks"
        description="The tasks you were invited to — track time, share files and submit your work."
      />
      <div className="mt-6 space-y-4">
        <FiltersBar
          search={filters.search}
          onSearchChange={(search) => table.setFilters({ search })}
          searchPlaceholder="Search title or code…"
          canClear={filtered}
          onClearAll={() => table.clearFilters()}
        />
        <SegmentedControl
          label="Task section"
          value={status}
          onChange={(value) => table.setFilters({ status: value === "all" ? "" : value })}
          options={STATUS_TABS}
          className="w-fit"
        />
        <TasksTable
          tasks={tasks}
          total={total}
          loading={list.isPending}
          error={list.isError ? list.error : null}
          onRetry={() => void list.refetch()}
          retrying={list.isRefetching}
          dimmed={list.isPlaceholderData}
          sort={table.sort}
          dir={table.dir}
          onSort={table.toggleSort}
          me={me}
          onOpen={openTask}
          // Guests have no edit / delete actions (the row menu only offers them from the server permissions).
          onDialog={() => undefined}
          // The project page isn't theirs to open (its name shows in the task).
          showProject={false}
          empty={
            <EmptyState
              icon={LuClipboardList}
              title={filtered ? "No matching tasks" : "No tasks yet"}
              description={
                filtered
                  ? "Try a different search or section."
                  : "When someone invites you to a task, it shows up here."
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
        />
      </div>
      {user && <TaskDetailSheet taskId={openTaskId} me={me} onClose={closeTask} />}
    </div>
  );
}
