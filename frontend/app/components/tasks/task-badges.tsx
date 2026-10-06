import { LuCalendar } from "react-icons/lu";

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
