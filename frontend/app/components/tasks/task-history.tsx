import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import type { IconType } from "react-icons";
import {
  LuArrowRight,
  LuBellRing,
  LuCalendarClock,
  LuCircleAlert,
  LuCircleCheck,
  LuCirclePlus,
  LuCircleX,
  LuHistory,
  LuListChecks,
  LuLoaderCircle,
  LuMessageSquare,
  LuMessagesSquare,
  LuNotebookPen,
  LuPaperclip,
  LuPencil,
  LuRefreshCw,
  LuSend,
  LuSparkles,
  LuTrash2,
  LuUsers,
} from "react-icons/lu";

import { formatDateTime } from "@/lib/format";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useTaskHistory } from "@/hooks/use-tasks";
import { getErrorMessage } from "@/lib/api";
import { STATUS_META } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { TaskHistoryAction, TaskHistoryEntry, TaskStatus } from "@/types";

const PAGE = 30;

const ACTION_ICONS: Record<TaskHistoryAction, { icon: IconType; tone: string }> = {
  created: { icon: LuCirclePlus, tone: "bg-primary/10 text-primary" },
  updated: { icon: LuPencil, tone: "bg-muted text-muted-foreground" },
  status_changed: { icon: LuArrowRight, tone: "bg-chart-2/15 text-foreground" },
  assignees_changed: { icon: LuUsers, tone: "bg-chart-3/15 text-foreground" },
  subtask_added: { icon: LuListChecks, tone: "bg-muted text-muted-foreground" },
  subtask_updated: { icon: LuPencil, tone: "bg-muted text-muted-foreground" },
  subtask_completed: { icon: LuCircleCheck, tone: "bg-primary/10 text-primary" },
  subtask_reopened: { icon: LuListChecks, tone: "bg-muted text-muted-foreground" },
  subtask_removed: { icon: LuTrash2, tone: "bg-muted text-muted-foreground" },
  comment_added: { icon: LuMessageSquare, tone: "bg-chart-2/15 text-foreground" },
  file_added: { icon: LuPaperclip, tone: "bg-muted text-muted-foreground" },
  file_removed: { icon: LuTrash2, tone: "bg-muted text-muted-foreground" },
  note_added: { icon: LuNotebookPen, tone: "bg-chart-3/15 text-foreground" },
  note_updated: { icon: LuNotebookPen, tone: "bg-muted text-muted-foreground" },
  note_removed: { icon: LuTrash2, tone: "bg-muted text-muted-foreground" },
  submitted: { icon: LuSend, tone: "bg-chart-4/15 text-foreground" },
  reviewed: { icon: LuCircleCheck, tone: "bg-primary/10 text-primary" },
  reminder_sent: { icon: LuBellRing, tone: "bg-chart-4/15 text-foreground" },
  created_from_meeting: { icon: LuMessagesSquare, tone: "bg-primary/10 text-primary" },
  actual_dates_updated: { icon: LuCalendarClock, tone: "bg-chart-3/15 text-foreground" },
  subtask_actual_dates_updated: { icon: LuCalendarClock, tone: "bg-muted text-muted-foreground" },
  pearity_generated: { icon: LuSparkles, tone: "bg-chart-5/15 text-foreground" },
  rework_added: { icon: LuRefreshCw, tone: "bg-warn/10 text-foreground" },
};

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function list(value: unknown): string {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string").join(", ") : "";
}

function statusLabel(value: unknown): string {
  return STATUS_META[value as TaskStatus]?.label ?? str(value);
}

/** "set the actual start to …" phrases for an actual-dates history entry. */
function actualChangeParts(raw: unknown): string[] {
  const changes = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
  return changes.map((change) => {
    const label = change.field === "actualEndAt" ? "actual end" : "actual start";
    const to = str(change.to);
    if (!to) return `cleared the ${label}`;
    const from = str(change.from);
    if (change.source !== "manual") {
      return from ? `reset the ${label} to automatic (${formatDateTime(to)})` : `set the ${label} to ${formatDateTime(to)}`;
    }
    return `set the ${label} to ${formatDateTime(to)}${from ? ` (was ${formatDateTime(from)})` : ""}`;
  });
}

/** Human sentence for a history entry (actor name is rendered separately). */
function describe(entry: TaskHistoryEntry): string {
  const d = entry.details ?? {};
  switch (entry.action) {
    case "created":
      if (d.recurringParent) return "created this task as a recurring copy";
      return d.assignees ? `created the task and assigned ${list(d.assignees)}` : "created the task";
    case "created_from_meeting": {
      const meeting = str(d.meetingTitle);
      const from = meeting ? ` from the meeting "${meeting}"` : " from a meeting";
      return d.assignees && list(d.assignees)
        ? `created the task${from} and assigned ${list(d.assignees)}`
        : `created the task${from}`;
    }
    case "updated":
      if (d.subtask) return `updated rework "${str(d.subtask)}" (${list(d.fields)})`;
      return d.fields ? `updated ${list(d.fields)}` : "updated the task";
    case "status_changed":
      return `moved it from ${statusLabel(d.from)} to ${statusLabel(d.to)}`;
    case "assignees_changed": {
      const parts = [];
      if (list(d.added)) parts.push(`added ${list(d.added)}`);
      if (list(d.removed)) parts.push(`removed ${list(d.removed)}`);
      return parts.length ? parts.join(" and ") : "changed the assignees";
    }
    case "subtask_added":
      return `added rework "${str(d.title)}"`;
    case "subtask_updated":
      return `updated rework "${str(d.title)}"${list(d.fields) ? ` (${list(d.fields)})` : ""}`;
    case "subtask_completed":
      return `completed rework "${str(d.title)}"`;
    case "subtask_reopened":
      return `reopened rework "${str(d.title)}"`;
    case "subtask_removed":
      return `removed rework "${str(d.title)}"`;
    case "comment_added":
      return d.excerpt ? `commented: "${str(d.excerpt)}"` : "added a comment";
    case "file_added": {
      const sub = d.subtask as { title?: unknown } | undefined;
      const target = sub && str(sub.title) ? ` to rework "${str(sub.title)}"` : "";
      return `attached ${str(d.filename) || "a file"}${target}`;
    }
    case "file_removed":
      return `removed ${str(d.filename) || "a file"}`;
    case "note_added":
      return d.title ? `added the note "${str(d.title)}"` : "added a note";
    case "note_updated":
      if (list(d.fields) === "pinned") return d.title ? `pinned/unpinned "${str(d.title)}"` : "pinned/unpinned a note";
      return d.title ? `updated the note "${str(d.title)}"` : "updated a note";
    case "note_removed":
      return d.title ? `removed the note "${str(d.title)}"` : "removed a note";
    case "submitted":
      return "submitted the task for review";
    case "reviewed":
      return d.decision === "approved" ? "approved the task" : "rejected the task";
    case "reminder_sent": {
      const kind = str(d.kind);
      if (kind === "manual") return "sent a reminder to the assignees";
      if (kind === "after") return "sent an overdue reminder";
      if (kind === "on") return "sent a due-today reminder";
      return "sent an upcoming due-date reminder";
    }
    case "actual_dates_updated": {
      const parts = actualChangeParts(d.changes);
      return parts.length ? parts.join(" and ") : "updated the actual dates";
    }
    case "subtask_actual_dates_updated": {
      const parts = actualChangeParts(d.changes);
      return `${parts.length ? parts.join(" and ") : "updated the actual dates"} of rework "${str(d.title)}"`;
    }
    case "pearity_generated": {
      const tag = str(d.tagName);
      const via = d.source === "pearity" ? " from Pearity" : "";
      if (d.created) return `created the Pearity tag ${tag} and opened the production engine${via}`;
      return `generated in Pearity with the tag ${tag}${via}`;
    }
    case "rework_added":
      return `added rework ${d.shortCode ? `${str(d.shortCode)} ` : ""}"${str(d.title)}" as a new task`;
    default:
      return "made a change";
  }
}

/** Timeline of everything that happened to a task (newest first). */
export function TaskHistory({ taskId }: { taskId: string }) {
  const [limit, setLimit] = useState(PAGE);
  const history = useTaskHistory(taskId, limit);
  const entries = history.data?.history ?? [];
  const total = history.data?.total ?? 0;

  if (history.isPending) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading history">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="flex gap-3">
            <Skeleton className="size-7 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (history.isError) {
    return (
      <Alert variant="destructive">
        <LuCircleAlert aria-hidden className="size-4" />
        <AlertTitle>Couldn&apos;t load history</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-2">
          {getErrorMessage(history.error)}
          <Button variant="outline" size="sm" onClick={() => void history.refetch()}>
            <LuRefreshCw aria-hidden />
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center">
        <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <LuHistory aria-hidden className="size-4" />
        </span>
        <p className="text-sm font-medium text-foreground">No activity yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ol className="relative space-y-4 before:absolute before:top-2 before:bottom-2 before:left-3.5 before:w-px before:bg-border">
        {entries.map((entry) => {
          const meta = ACTION_ICONS[entry.action] ?? ACTION_ICONS.updated;
          const Icon =
            entry.action === "reviewed" && entry.details?.decision === "rejected"
              ? LuCircleX
              : meta.icon;
          return (
            <li key={entry._id} className="relative flex gap-3">
              <span
                className={cn(
                  "relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full ring-4 ring-popover",
                  meta.tone
                )}
              >
                <Icon aria-hidden className="size-3.5" />
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <p className="text-sm text-foreground">
                  <span className="font-medium">{entry.actor?.name ?? "System"}</span>{" "}
                  <span className="text-muted-foreground">{describe(entry)}</span>
                </p>
                <time
                  dateTime={entry.createdAt}
                  className="text-xs text-muted-foreground"
                  title={formatDateTime(entry.createdAt)}
                >
                  {formatDistanceToNow(new Date(entry.createdAt), { addSuffix: true })}
                </time>
              </div>
            </li>
          );
        })}
      </ol>
      {total > entries.length && (
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => setLimit((current) => current + PAGE)}
          disabled={history.isFetching}
        >
          {history.isFetching && <LuLoaderCircle aria-hidden className="animate-spin" />}
          Show older activity
        </Button>
      )}
    </div>
  );
}
