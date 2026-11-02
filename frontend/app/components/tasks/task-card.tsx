import type { ComponentProps } from "react";
import { LuListChecks, LuMessageSquare, LuPaperclip, LuRepeat } from "react-icons/lu";

import { ShortCode } from "@/components/projects/project-badges";
import { LabelChip } from "@/components/tasks/label-chip";
import { AssigneeStack, DueDateChip, PriorityIndicator, TaskProjectLine } from "@/components/tasks/task-badges";
import { cn } from "@/lib/utils";
import type { Task } from "@/types";

/** Compact meta row: subtasks, comments, files, recurrence. */
export function TaskCounts({ task, className }: { task: Task; className?: string }) {
  const done = task.subtasks.filter((sub) => sub.done).length;
  return (
    <div className={cn("flex items-center gap-2.5 text-xs text-muted-foreground", className)}>
      {task.subtasks.length > 0 && (
        <span
          className={cn(
            "inline-flex items-center gap-1",
            done === task.subtasks.length && "text-primary"
          )}
          title={`${done} of ${task.subtasks.length} subtasks done`}
        >
          <LuListChecks aria-hidden className="size-3.5" />
          {done}/{task.subtasks.length}
        </span>
      )}
      {task.commentCount > 0 && (
        <span className="inline-flex items-center gap-1" title={`${task.commentCount} comments`}>
          <LuMessageSquare aria-hidden className="size-3.5" />
          {task.commentCount}
        </span>
      )}
      {task.fileCount > 0 && (
        <span className="inline-flex items-center gap-1" title={`${task.fileCount} files`}>
          <LuPaperclip aria-hidden className="size-3.5" />
          {task.fileCount}
        </span>
      )}
      {task.recurrence && (
        <span className="inline-flex items-center" title="Recurring task">
          <LuRepeat aria-hidden className="size-3.5" />
          <span className="sr-only">Recurring</span>
        </span>
      )}
    </div>
  );
}

/**
 * Kanban card. Presentational only — the board wraps it with drag behaviour.
 * The title is a real button so keyboard users can open the task.
 */
export function TaskCard({
  task,
  onOpen,
  dragging,
  disabled,
  className,
  ...props
}: {
  task: Task;
  onOpen?: (id: string) => void;
  dragging?: boolean;
  /** The current user can't move this card (visual hint only). */
  disabled?: boolean;
} & ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn(
        "group/card flex flex-col gap-2.5 rounded-lg border bg-card p-3 text-card-foreground shadow-xs transition-[box-shadow,border-color] duration-150 ease-out hover:border-ring/40 hover:shadow-sm",
        dragging && "rotate-1 border-ring/60 shadow-lg",
        disabled ? "cursor-pointer" : "cursor-grab active:cursor-grabbing",
        className
      )}
      onClick={(event) => {
        props.onClick?.(event);
        if (!event.defaultPrevented) onOpen?.(task._id);
      }}
    >
      <div className="flex items-start gap-2">
        <PriorityIndicator priority={task.priority} showLabel={false} className="mt-1.5" />
        <button
          type="button"
          className="min-w-0 flex-1 text-left text-sm leading-snug font-medium text-foreground outline-none hover:underline focus-visible:underline"
          onClick={(event) => {
            event.stopPropagation();
            onOpen?.(task._id);
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <span className="line-clamp-2">{task.title}</span>
        </button>
      </div>

      {/* Brand · Project, for tracking. */}
      <TaskProjectLine task={task} link={task.access !== "read"} className="text-[0.7rem]" />

      {(task.shortCode || task.milestone) && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {task.shortCode && <ShortCode code={task.shortCode} />}
          {task.milestone && (
            <span className="truncate text-[0.7rem] text-muted-foreground" title="Milestone">
              {task.milestone.title}
            </span>
          )}
        </div>
      )}

      {(task.labels.length > 0 || task.category) && (
        <div className="flex flex-wrap items-center gap-1">
          {task.category && (
            <span className="text-[0.7rem] font-medium text-muted-foreground">
              {task.category.name}
            </span>
          )}
          {task.labels.slice(0, 3).map((label) => (
            <LabelChip key={label._id} name={label.name} color={label.color} />
          ))}
          {task.labels.length > 3 && (
            <span className="text-[0.7rem] text-muted-foreground">+{task.labels.length - 3}</span>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <DueDateChip task={task} />
          <TaskCounts task={task} />
        </div>
        <AssigneeStack users={task.assignees} />
      </div>
    </div>
  );
}
