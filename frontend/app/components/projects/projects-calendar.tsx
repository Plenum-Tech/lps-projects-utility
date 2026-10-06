import { useMemo } from "react";
import { useNavigate } from "react-router";

import {
  CalendarMonth,
  useCalendarState,
  type CalendarEvent,
} from "@/components/globals/calendar-month";
import { QueryError } from "@/components/globals/query-states";
import { useProjects, type ProjectFilters } from "@/hooks/use-projects";
import { statusColor } from "@/lib/projects";
import { toDateInput } from "@/lib/tasks";

const CALENDAR_LIMIT = 200;

/**
 * Projects as bars from start date to deadline (open-ended ones run to the end
 * of the visible range), coloured by status. Click a bar to open the project.
 */
export function ProjectsCalendar({ filters }: { filters: Omit<ProjectFilters, "tab" | "from" | "to"> }) {
  const navigate = useNavigate();
  const calendar = useCalendarState("month");
  const { fromKey, toKey } = calendar.range;

  const query = useProjects({
    ...filters,
    tab: "active",
    from: fromKey,
    to: toKey,
    sort: "startDate",
    dir: "asc",
    limit: CALENDAR_LIMIT,
    offset: 0,
  });

  const events = useMemo<CalendarEvent[]>(
    () =>
      (query.data?.projects ?? []).map((project) => {
        const color = statusColor(project.status.color);
        const start = toDateInput(project.startDate);
        const end = project.deadline ? toDateInput(project.deadline) : toKey;
        return {
          id: project._id,
          title: project.name,
          prefix: project.code,
          start,
          end: end < start ? start : end,
          chipClass: color.chip,
          dotClass: color.dot,
          description: `${project.status.name}, ${project.progress}% complete${project.deadline ? "" : ", no deadline"}`,
          muted: project.status.isCompleted,
        };
      }),
    [query.data, toKey]
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

  const total = query.data?.total ?? 0;
  return (
    <CalendarMonth
      label="Projects calendar"
      mode={calendar.mode}
      onModeChange={calendar.setMode}
      anchor={calendar.anchor}
      onAnchorChange={calendar.setAnchor}
      events={events}
      loading={query.isFetching}
      onEventClick={(event) => void navigate(`/projects/${event.id}`)}
      note={
        total > CALENDAR_LIMIT
          ? `Showing the first ${CALENDAR_LIMIT} of ${total} projects in this range — narrow the filters to see the rest.`
          : !query.isPending && total === 0
            ? "No projects run during this period."
            : undefined
      }
    />
  );
}
