import { LuCalendar } from "react-icons/lu";
import { Link } from "react-router";

import { AvatarStack } from "@/components/globals/data-table/avatar-stack";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  PRIORITY_META,
  STATUS_META,
  formatDateOnly,
  initials,
  isDueToday,
  isOverdue,
} from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { Task, TaskPriority, TaskStatus, UserRef } from "@/types";

export function StatusBadge({ status, className }: { status: TaskStatus; className?: string }) {
  const meta = STATUS_META[status];
  return (
    <Badge variant={meta.badge} className={cn("gap-1.5", className)}>
      <span aria-hidden className={cn("size-1.5 rounded-full", meta.dot)} />
      {meta.label}
    </Badge>
  );
}

export function PriorityIndicator({
  priority,
  showLabel = true,
  className,
}: {
  priority: TaskPriority;
  showLabel?: boolean;
  className?: string;
}) {
  const meta = PRIORITY_META[priority];
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-xs font-medium", meta.text, className)}
      title={`${meta.label} priority`}
    >
      <span aria-hidden className={cn("size-2 rounded-full", meta.dot)} />
      {showLabel ? meta.label : <span className="sr-only">{meta.label} priority</span>}
    </span>
  );
}

/** Due date chip — destructive when overdue, highlighted when due today. */
export function DueDateChip({
  task,
  className,
}: {
  task: Pick<Task, "dueDate" | "status">;
  className?: string;
}) {
  if (!task.dueDate) return null;
  const overdue = isOverdue(task);
  const today = isDueToday(task);
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-[0.7rem] font-medium",
        overdue
          ? "bg-destructive/10 text-destructive"
          : today
            ? "bg-chart-4/15 text-foreground"
            : "bg-muted text-muted-foreground",
        className
      )}
    >
      <LuCalendar aria-hidden className="size-3" />
      {formatDateOnly(task.dueDate)}
      {overdue && <span className="sr-only">(overdue)</span>}
      {today && <span className="sr-only">(due today)</span>}
    </span>
  );
}

export function UserAvatar({
  user,
  size = "sm",
  className,
}: {
  user: Pick<UserRef, "name">;
  size?: "sm" | "default";
  className?: string;
}) {
  return (
    <Avatar size={size} className={className}>
      <AvatarFallback className="bg-primary/10 font-medium text-primary">
        {initials(user.name)}
      </AvatarFallback>
    </Avatar>
  );
}

/** Overlapping assignee avatars with a "+N" overflow (see `AvatarStack`). */
export function AssigneeStack({ users, max = 3 }: { users: UserRef[]; max?: number }) {
  if (users.length === 0) return null;
  return <AvatarStack users={users} max={max} label="Assignees" />;
}

/**
 * "Brand · Project" for tracking where a task belongs. A link to the project unless
 * `link` is off (view-only callers can't open it). The full text is in the tooltip.
 */
export function TaskProjectLine({ task, link = true, className }: { task: Pick<Task, "project">; link?: boolean; className?: string }) {
  if (!task.project) return null;
  const brand = task.project.brand?.name;
  const text = brand ? `${brand} · ${task.project.name}` : task.project.name;
  const body = (
    <>
      {brand && <span className="font-medium text-foreground/80">{brand}</span>}
      {brand && <span aria-hidden> · </span>}
      {task.project.name}
    </>
  );
  const cls = cn("block max-w-full truncate text-xs text-muted-foreground", className);
  return link ? (
    <Link
      to={`/projects/${task.project._id}`}
      title={text}
      onClick={(event) => event.stopPropagation()}
      className={cn(cls, "underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:underline")}
    >
      {body}
    </Link>
  ) : (
    <span title={text} className={cls}>
      {body}
    </span>
  );
}
