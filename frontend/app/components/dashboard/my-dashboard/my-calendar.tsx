import { useMemo } from "react";
import { useNavigate } from "react-router";

import {
  CalendarMonth,
  useCalendarState,
  type CalendarEvent,
} from "@/components/globals/calendar-month";
import { QueryError } from "@/components/globals/query-states";
import { useMyCalendar } from "@/hooks/use-my-dashboard";
import { STATUS_META } from "@/lib/tasks";
import type { MyCalendarItem, MyCalendarItemKind, TaskStatus } from "@/types";

/** Colour per item kind (theme tokens only). */
const KIND_META: Record<MyCalendarItemKind, { label: string; chip: string; dot: string }> = {
  task: { label: "Task", chip: "bg-chart-2/15 border-chart-2/30", dot: "bg-chart-2" },
  subtask: { label: "Rework", chip: "bg-chart-3/15 border-chart-3/30", dot: "bg-chart-3" },
  leave: { label: "Leave", chip: "bg-chart-4/15 border-chart-4/30", dot: "bg-chart-4" },
  project_deadline: {
    label: "Project deadline",
    chip: "bg-destructive/10 border-destructive/30",
    dot: "bg-destructive",
  },
};

const LEAVE_LABELS: Record<string, string> = {
  annual: "Annual",
  sick: "Sick",
  personal: "Personal",
  unpaid: "Unpaid",
};

function describe(item: MyCalendarItem): string {
  switch (item.kind) {
    case "task":
      return [
        STATUS_META[item.status as TaskStatus]?.label ?? item.status,
        item.project?.name,
      ]
        .filter(Boolean)
        .join(" · ");
    case "subtask":
      return `Rework · ${item.status === "done" ? "Done" : "Open"}`;
    case "leave":
      return `${item.leaveType ? `${LEAVE_LABELS[item.leaveType] ?? item.leaveType} leave` : "Leave"} · ${
        item.status === "approved" ? "Approved" : "Pending"
      }`;
    case "project_deadline":
      return `Project deadline${item.status === "completed" ? " · Completed" : ""}`;
  }
}

/**
 * My calendar: tasks, subtasks, leaves and project deadlines in month, week,
 * day and list views. Tasks / subtasks open the task sheet.
 *
 * It always opens on today — week view for a 7-day period, month view
 * otherwise — so the default 30-day period doesn't land on last month. It can
 * be navigated freely (remount with a new `key` to re-open on another period).
 */
export function MyCalendar({
  onOpenTask,
  periodDays,
}: {
  onOpenTask: (taskId: string, subtaskId?: string) => void;
  /** First day of the dashboard period ("YYYY-MM-DD"), null for all time. */
  periodFrom: string | null;
  /** Length of the period in days (null for all time). */
  periodDays: number | null;
}) {
  const navigate = useNavigate();
  const calendar = useCalendarState(periodDays !== null && periodDays <= 7 ? "week" : "month");
  const query = useMyCalendar(calendar.range.fromKey, calendar.range.toKey);

  const items = query.data?.items;
  const events = useMemo<CalendarEvent[]>(
    () =>
      (items ?? []).map((item) => {
        const meta = KIND_META[item.kind];
        const done =
          (item.kind === "task" && item.status === "completed") ||
          (item.kind === "subtask" && item.status === "done") ||
          (item.kind === "project_deadline" && item.status === "completed");
        return {
          id: item.id,
          title: item.title,
          start: item.start,
          end: item.end,
          prefix: item.code,
          chipClass: `${meta.chip}${item.kind === "leave" && item.status === "pending" ? " border-dashed" : ""}`,
          dotClass: meta.dot,
          description: describe(item),
          muted: done,
        };
      }),
    [items]
  );

  const byId = useMemo(() => new Map((items ?? []).map((item) => [item.id, item])), [items]);

  function open(event: CalendarEvent) {
    const item = byId.get(event.id);
    if (!item) return;
    if ((item.kind === "task" || item.kind === "subtask") && item.taskId) {
      onOpenTask(item.taskId, item.subtaskId);
    } else if (item.kind === "leave") {
      void navigate("/leaves");
    } else if (item.kind === "project_deadline" && item.project) {
      void navigate(`/projects/${item.project._id}`);
    }
  }

  if (query.isError && !query.data) {
    return (
      <QueryError
        title="Couldn't load your calendar"
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isRefetching}
      />
    );
  }

  return (
    <CalendarMonth
      label="My calendar"
      modes={["month", "week", "day", "list"]}
      mode={calendar.mode}
      onModeChange={calendar.setMode}
      anchor={calendar.anchor}
      onAnchorChange={calendar.setAnchor}
      events={events}
      loading={query.isFetching}
      onEventClick={open}
      emptyText="No events to display"
      toolbar={
        <ul aria-label="Colour key" className="hidden items-center gap-3 text-xs text-muted-foreground 2xl:flex">
          {(Object.keys(KIND_META) as MyCalendarItemKind[]).map((kind) => (
            <li key={kind} className="inline-flex items-center gap-1.5">
              <span aria-hidden className={`size-2 rounded-full ${KIND_META[kind].dot}`} />
              {KIND_META[kind].label}
            </li>
          ))}
        </ul>
      }
      note={
        query.data?.truncated
          ? `Showing the first ${query.data.items.length} of ${query.data.total} items.`
          : query.data &&
              !query.isPlaceholderData &&
              query.data.items.length === 0 &&
              (calendar.mode === "month" || calendar.mode === "week")
            ? "No events to display"
            : undefined
      }
    />
  );
}

/** Small legend shown under the calendar on narrower screens. */
export function MyCalendarLegend() {
  return (
    <ul aria-label="Calendar colour key" className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground 2xl:hidden">
      {(Object.keys(KIND_META) as MyCalendarItemKind[]).map((kind) => (
        <li key={kind} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={`size-2 rounded-full ${KIND_META[kind].dot}`} />
          {KIND_META[kind].label}
        </li>
      ))}
    </ul>
  );
}
