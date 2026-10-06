import { useMemo } from "react";

import {
  CalendarMonth,
  useCalendarState,
  type CalendarEvent,
} from "@/components/globals/calendar-month";
import { QueryError } from "@/components/globals/query-states";
import { useTaskCalendar, type TaskFilters } from "@/hooks/use-tasks";
import { STATUS_CHIP, STATUS_META, toDateInput } from "@/lib/tasks";
import type { TaskStatusFilter } from "@/types";

/**
 * Tasks on their due date, or spanning start → due when both are set, coloured
 * by status. Every list filter applies. Click a chip to open the detail sheet.
 */
export function TasksCalendar({
  filters,
  status,
  onOpen,
}: {
  filters: TaskFilters;
  status: TaskStatusFilter;
  onOpen: (id: string) => void;
}) {
  const calendar = useCalendarState("month");
  const query = useTaskCalendar(
    { ...filters, status },
    { from: calendar.range.fromKey, to: calendar.range.toKey }
  );

  const events = useMemo<CalendarEvent[]>(
    () =>
      (query.data?.tasks ?? []).map((task) => {
        const due = toDateInput(task.dueDate);
        const start = task.startDate ? toDateInput(task.startDate) : due;
        const code = task.shortCode ?? (task.number ? `#${task.number}` : undefined);
        return {
          id: task._id,
          title: task.title,
          prefix: code,
          start: start <= due ? start : due,
          end: due,
          chipClass: STATUS_CHIP[task.status],
          dotClass: STATUS_META[task.status].dot,
          description: `${STATUS_META[task.status].label}${task.project ? `, ${task.project.name}` : ""}`,
          muted: task.status === "completed",
        };
      }),
    [query.data]
  );

  if (query.isError) {
    return (
      <QueryError
        title="Couldn't load the calendar"
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isRefetching}
      />
    );
  }

  const data = query.data;
  return (
    <CalendarMonth
      label="Tasks calendar"
      mode={calendar.mode}
      onModeChange={calendar.setMode}
      anchor={calendar.anchor}
      onAnchorChange={calendar.setAnchor}
      events={events}
      loading={query.isFetching}
      onEventClick={(event) => onOpen(event.id)}
      toolbar={
        <ul aria-label="Status colours" className="hidden items-center gap-3 text-xs text-muted-foreground xl:flex">
          {(["todo", "in_progress", "in_review", "completed", "rejected"] as const).map((key) => (
            <li key={key} className="inline-flex items-center gap-1.5">
              <span aria-hidden className={`size-2 rounded-full ${STATUS_META[key].dot}`} />
              {STATUS_META[key].label}
            </li>
          ))}
        </ul>
      }
      note={
        data?.truncated
          ? `Showing the first ${data.tasks.length} of ${data.total} tasks — narrow the filters to see the rest.`
          : data && data.total === 0
            ? "No tasks with a due date in this period."
            : undefined
      }
    />
  );
}
