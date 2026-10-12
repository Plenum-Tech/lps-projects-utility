import { useMemo } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { LuPlus, LuRefreshCw } from "react-icons/lu";

import { StatusBadge, UserAvatar } from "@/components/tasks/task-badges";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { formatDateOnly } from "@/lib/tasks";
import type { TaskListResponse, TaskStatus } from "@/types";

export interface ReworkTaskOption {
  value: string;
  label: string;
}

/** "RWT-3 · Post 1 – Teaser" (code, else #number). */
export function reworkTaskLabel(task: { title: string; shortCode?: string | null; number?: number | null }): string {
  const code = task.shortCode ?? (typeof task.number === "number" ? `#${task.number}` : "");
  return code ? `${code} · ${task.title}` : task.title;
}

/**
 * Picks the original task a rework task belongs to (tasks of `projectId`).
 * `initial` stays selectable even if it isn't in the loaded page of tasks.
 */
export function ReworkTaskPicker({
  id,
  projectId,
  value,
  onChange,
  initial,
  invalid,
}: {
  id: string;
  projectId: string | null;
  value: string;
  onChange: (value: string) => void;
  initial?: ReworkTaskOption | null;
  invalid?: boolean;
}) {
  const tasks = useQuery({
    queryKey: ["tasks", "rework-picker", projectId],
    queryFn: async () =>
      (await api.get<TaskListResponse>("/tasks", { params: { project: projectId, limit: 300, sort: "-createdAt" } })).data
        .tasks,
    enabled: Boolean(projectId),
    staleTime: 30_000,
  });
  const options = useMemo<ReworkTaskOption[]>(() => {
    const list = (tasks.data ?? []).map((t) => ({ value: t._id, label: reworkTaskLabel(t) }));
    if (initial && !list.some((o) => o.value === initial.value)) list.unshift(initial);
    return list;
  }, [tasks.data, initial]);
  const selected = options.find((o) => o.value === value) ?? null;

  return (
    <Combobox
      items={options}
      value={selected}
      onValueChange={(option: ReworkTaskOption | null) => onChange(option?.value ?? "")}
      isItemEqualToValue={(a: ReworkTaskOption, b: ReworkTaskOption) => a.value === b.value}
      disabled={!projectId}
    >
      <ComboboxInput
        id={id}
        placeholder={!projectId ? "Choose the project first" : tasks.isPending ? "Loading tasks…" : "Search the project's tasks…"}
        aria-invalid={invalid || undefined}
        className="w-full"
      />
      <ComboboxContent>
        <ComboboxEmpty>{tasks.isError ? "Couldn't load tasks." : "No tasks found."}</ComboboxEmpty>
        <ComboboxList>
          {(option: ReworkTaskOption) => (
            <ComboboxItem key={option.value} value={option}>
              {option.label}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

interface ReworkTaskRow {
  _id: string;
  title: string;
  shortCode?: string | null;
  number?: number | null;
  status: TaskStatus;
  round: number;
  assignees: Array<{ _id: string; name: string; email?: string }>;
  assignedBy?: { _id: string; name: string } | null;
  dueDate?: string | null;
  completedAt?: string | null;
  createdAt: string;
}

/**
 * The task's rework history: every rework is its own task, listed here in
 * order (round 1, 2, …) with its status; each row opens that task.
 */
export function ReworkHistory({ taskId, onAdd }: { taskId: string; onAdd?: () => void }) {
  const reworks = useQuery({
    queryKey: ["tasks", taskId, "reworks"],
    queryFn: async () => (await api.get<{ tasks: ReworkTaskRow[] }>(`/tasks/${taskId}/reworks`)).data.tasks,
    staleTime: 15_000,
  });
  const rows = reworks.data ?? [];

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Rework history</h3>
        {onAdd && (
          <Button size="sm" variant="outline" onClick={onAdd}>
            <LuPlus aria-hidden />
            Add rework
          </Button>
        )}
      </div>
      {reworks.isPending ? (
        <Skeleton className="h-12 w-full" />
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center">
          <LuRefreshCw aria-hidden className="size-4 text-muted-foreground" />
          <p className="text-sm font-medium">No rework yet</p>
          <p className="text-xs text-muted-foreground">Each rework is created as a new task and listed here.</p>
        </div>
      ) : (
        <ol className="divide-y rounded-lg border">
          {rows.map((row) => (
            <li key={row._id}>
              <Link
                to={`/tasks?task=${row._id}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 hover:bg-accent"
              >
                <span className="rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 text-xs font-medium text-warn">
                  Round {row.round}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{reworkTaskLabel(row)}</span>
                <StatusBadge status={row.status} />
                <span className="flex -space-x-1">
                  {row.assignees.slice(0, 3).map((a) => (
                    <UserAvatar key={a._id} user={a} />
                  ))}
                </span>
                <span className="text-xs text-muted-foreground">
                  Added {formatDateOnly(row.createdAt.slice(0, 10))}
                  {row.assignedBy ? ` by ${row.assignedBy.name}` : ""}
                  {row.completedAt ? ` · done ${formatDateOnly(row.completedAt.slice(0, 10))}` : ""}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
