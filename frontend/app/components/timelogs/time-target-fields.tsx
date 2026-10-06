import { useMemo } from "react";

import { ShortCode } from "@/components/projects/project-badges";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useProjectOptions } from "@/hooks/use-projects";
import { useTask, useTaskList } from "@/hooks/use-tasks";
import type { Task } from "@/types";

const NONE = "none";
const TASK_LIMIT = 100;

/** Projects time can be logged on: not archived, not in a completed status. */
export function useLoggableProjects(enabled = true) {
  const query = useProjectOptions(enabled);
  const projects = useMemo(
    () => (query.data ?? []).filter((project) => !project.archivedAt && !project.status?.isCompleted),
    [query.data]
  );
  return { projects, all: query.data ?? [], isPending: query.isPending, isError: query.isError };
}

/**
 * Tasks for a picker: every task of `projectId`, or my assigned tasks when no
 * project is chosen. `openOnly` drops completed tasks (they can't take time).
 */
export function usePickerTasks(projectId: string, { enabled = true, openOnly = true } = {}) {
  const query = useTaskList(
    {
      scope: projectId ? "all" : "assigned",
      search: "",
      priority: "",
      label: "",
      category: "",
      assignee: "",
      due: "",
      project: projectId || undefined,
      status: "all",
      limit: TASK_LIMIT,
      offset: 0,
    },
    enabled
  );
  const tasks = useMemo(
    () =>
      (query.data?.tasks ?? []).filter((task) => !openOnly || task.status !== "completed"),
    [query.data, openOnly]
  );
  return { tasks, isPending: query.isPending, isError: query.isError };
}

export function taskOptionLabel(task: Pick<Task, "title" | "shortCode">): string {
  return task.shortCode ? `${task.shortCode} · ${task.title}` : task.title;
}

/**
 * Project + task pickers shared by the start-timer and manual-entry dialogs.
 * `lockProject` / `lockTask` render the prefilled value read-only.
 */
export function TimeTargetFields({
  idPrefix,
  projectId,
  taskId,
  onChange,
  lockProject,
  lockTask,
  enabled = true,
  invalid,
}: {
  idPrefix: string;
  projectId: string;
  taskId: string;
  onChange: (next: { projectId: string; taskId: string }) => void;
  lockProject?: boolean;
  lockTask?: boolean;
  enabled?: boolean;
  /** Show the "pick a project or a task" error. */
  invalid?: boolean;
}) {
  const loggable = useLoggableProjects(enabled && !lockTask);
  const pickerTasks = usePickerTasks(projectId, { enabled: enabled && !lockTask });

  const taskInList = pickerTasks.tasks.find((task) => task._id === taskId);
  // Label fallback for a prefilled task that isn't in the picker list.
  const fallbackTask = useTask(enabled && taskId && !taskInList ? taskId : null);
  const fallback = fallbackTask.data?.task;

  const projectItems: Record<string, string> = { [NONE]: "No project" };
  for (const project of loggable.projects) {
    projectItems[project._id] = `${project.code} · ${project.name}`;
  }
  if (projectId && !projectItems[projectId]) {
    const known = loggable.all.find((project) => project._id === projectId);
    projectItems[projectId] = known ? `${known.code} · ${known.name}` : "Selected project";
  }

  const taskItems: Record<string, string> = { [NONE]: projectId ? "No specific task" : "No task" };
  for (const task of pickerTasks.tasks) taskItems[task._id] = taskOptionLabel(task);
  if (taskId && !taskItems[taskId]) {
    taskItems[taskId] = fallback ? taskOptionLabel(fallback) : "Selected task";
  }

  const errorId = `${idPrefix}-target-error`;

  if (lockTask && taskId) {
    const task = taskInList ?? fallback;
    return (
      <div className="space-y-1.5">
        <Label>Task</Label>
        <div className="flex min-h-8 items-center gap-2 rounded-lg border bg-muted/40 px-2.5 py-1.5 text-sm">
          {task ? (
            <>
              {task.shortCode && <ShortCode code={task.shortCode} />}
              <span className="truncate">{task.title}</span>
            </>
          ) : (
            <Skeleton className="h-4 w-40" />
          )}
        </div>
      </div>
    );
  }

  function changeProject(next: string) {
    const nextProject = next === NONE ? "" : next;
    // Clear a task that belongs to another project.
    const current = pickerTasks.tasks.find((task) => task._id === taskId);
    const keepTask = current && (current.project?._id ?? "") === nextProject;
    onChange({ projectId: nextProject, taskId: keepTask ? taskId : "" });
  }

  function changeTask(next: string) {
    const nextTask = next === NONE ? "" : next;
    const task = pickerTasks.tasks.find((item) => item._id === nextTask);
    const taskProject = task?.project?._id;
    onChange({
      projectId: !projectId && taskProject && !lockProject ? taskProject : projectId,
      taskId: nextTask,
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-project`}>Project</Label>
          <Select
            value={projectId || NONE}
            onValueChange={(value) => changeProject(String(value ?? NONE))}
            items={projectItems}
            disabled={lockProject}
          >
            <SelectTrigger
              id={`${idPrefix}-project`}
              className="w-full"
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? errorId : undefined}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>No project</SelectItem>
              {loggable.projects.map((project) => (
                <SelectItem key={project._id} value={project._id}>
                  <ShortCode code={project.code} />
                  <span className="truncate">{project.name}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {loggable.isError && (
            <p className="text-xs text-destructive">Couldn&apos;t load projects.</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-task`}>Task</Label>
          <Select
            value={taskId || NONE}
            onValueChange={(value) => changeTask(String(value ?? NONE))}
            items={taskItems}
          >
            <SelectTrigger
              id={`${idPrefix}-task`}
              className="w-full"
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? errorId : undefined}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{taskItems[NONE]}</SelectItem>
              {pickerTasks.tasks.map((task) => (
                <SelectItem key={task._id} value={task._id}>
                  {task.shortCode && <ShortCode code={task.shortCode} />}
                  <span className="truncate">{task.title}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {pickerTasks.isPending
              ? "Loading tasks…"
              : pickerTasks.isError
                ? "Couldn't load tasks."
                : projectId
                  ? `${pickerTasks.tasks.length} open task${pickerTasks.tasks.length === 1 ? "" : "s"} in this project`
                  : "Your open assigned tasks"}
          </p>
        </div>
      </div>
      {invalid && (
        <p id={errorId} className="-mt-2 text-xs text-destructive">
          Choose a project or a task.
        </p>
      )}
    </div>
  );
}
