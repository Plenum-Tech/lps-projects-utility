import { useMemo, useState, type ReactNode } from "react";
import {
  addDays,
  addMonths,
  addWeeks,
  differenceInCalendarDays,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  isToday,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { LuCalendarX2, LuChevronLeft, LuChevronRight, LuLoaderCircle } from "react-icons/lu";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatDate, weekStartsOn } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Lightweight month / week / day / list calendar (date-fns, no extra dependency).
 *
 * The range maths (`getCalendarRange`), the lane layout (`layoutWeek`) and the
 * event shape are mode-independent. Month and week render lanes of chips
 * (`WeekRow`); day and list render stacked rows (`DayView` / `ListView`).
 * Callers opt into modes with `modes` (default month + week).
 */
export type CalendarMode = "month" | "week" | "day" | "list";

const DEFAULT_MODES: CalendarMode[] = ["month", "week"];

export interface CalendarEvent {
  id: string;
  title: string;
  /** "YYYY-MM-DD" (inclusive). */
  start: string;
  /** "YYYY-MM-DD" (inclusive) — same as `start` for single-day items. */
  end: string;
  /** Tint + border classes (theme tokens), e.g. "bg-chart-2/15 border-chart-2/30". */
  chipClass: string;
  /** Solid dot class, e.g. "bg-chart-2". */
  dotClass: string;
  /** Short prefix shown before the title (e.g. a code). */
  prefix?: string;
  /** Extra text for the accessible name (status, dates…). */
  description?: string;
  /** Visually de-emphasise (e.g. completed). */
  muted?: boolean;
}

const MONTH_LANES = 4;
const WEEK_LANES = 12;

export const toKey = (date: Date) => format(date, "yyyy-MM-dd");

/**
 * First and last visible day for a mode: whole weeks for month / week, the
 * anchor day for day, and the calendar month (no padding) for list.
 */
export function getCalendarRange(mode: CalendarMode, anchor: Date) {
  let from: Date;
  let to: Date;
  if (mode === "month") {
    from = startOfWeek(startOfMonth(anchor), { weekStartsOn: weekStartsOn() });
    to = endOfWeek(endOfMonth(anchor), { weekStartsOn: weekStartsOn() });
  } else if (mode === "week") {
    from = startOfWeek(anchor, { weekStartsOn: weekStartsOn() });
    to = endOfWeek(anchor, { weekStartsOn: weekStartsOn() });
  } else if (mode === "day") {
    from = startOfDay(anchor);
    to = from;
  } else {
    from = startOfMonth(anchor);
    to = startOfDay(endOfMonth(anchor));
  }
  return { from, to, fromKey: toKey(from), toKey: toKey(to) };
}

/** Events whose start → end span covers `day`. */
function eventsOn(day: Date, events: CalendarEvent[]) {
  const key = toKey(day);
  return events.filter(
    (event) => event.start <= key && (event.end < event.start ? event.start : event.end) >= key
  );
}

function eventDates(event: CalendarEvent) {
  return event.end <= event.start
    ? format(parseISO(event.start), "d MMM")
    : `${format(parseISO(event.start), "d MMM")} – ${format(parseISO(event.end), "d MMM")}`;
}

/** Mode + anchor date state, with the visible range for fetching. */
export function useCalendarState(initialMode: CalendarMode = "month") {
  const [mode, setMode] = useState<CalendarMode>(initialMode);
  const [anchor, setAnchor] = useState(() => new Date());
  const range = useMemo(() => getCalendarRange(mode, anchor), [mode, anchor]);
  return { mode, setMode, anchor, setAnchor, range };
}

export interface WeekSegment {
  event: CalendarEvent;
  /** 0..6 within the week. */
  startCol: number;
  endCol: number;
  lane: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/** Places the week's events into lanes (greedy, longest first on ties). */
export function layoutWeek(weekStart: Date, events: CalendarEvent[]) {
  const weekEnd = addDays(weekStart, 6);
  const raw = events
    .map((event) => {
      const start = parseISO(event.start);
      const end = parseISO(event.end < event.start ? event.start : event.end);
      if (end < weekStart || start > weekEnd) return null;
      return {
        event,
        startCol: Math.max(0, differenceInCalendarDays(start, weekStart)),
        endCol: Math.min(6, differenceInCalendarDays(end, weekStart)),
        continuesBefore: start < weekStart,
        continuesAfter: end > weekEnd,
      };
    })
    .filter((item): item is Omit<WeekSegment, "lane"> => item !== null)
    .sort(
      (a, b) =>
        a.startCol - b.startCol ||
        b.endCol - b.startCol - (a.endCol - a.startCol) ||
        a.event.title.localeCompare(b.event.title)
    );

  const laneEnds: number[] = [];
  const segments: WeekSegment[] = raw.map((item) => {
    let lane = laneEnds.findIndex((end) => end < item.startCol);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.endCol);
    } else {
      laneEnds[lane] = item.endCol;
    }
    return { ...item, lane };
  });
  return { segments, laneCount: laneEnds.length };
}

export function CalendarMonth({
  mode,
  onModeChange,
  anchor,
  onAnchorChange,
  events,
  onEventClick,
  loading,
  toolbar,
  note,
  label = "Calendar",
  modes = DEFAULT_MODES,
  emptyText = "No events to display",
  className,
}: {
  mode: CalendarMode;
  onModeChange: (mode: CalendarMode) => void;
  anchor: Date;
  onAnchorChange: (date: Date) => void;
  events: CalendarEvent[];
  onEventClick: (event: CalendarEvent) => void;
  loading?: boolean;
  /** Extra controls on the right of the header (legend, filters…). */
  toolbar?: ReactNode;
  /** Small notice under the header (e.g. "Showing the first 500"). */
  note?: ReactNode;
  label?: string;
  /** Range buttons to offer (default month + week). */
  modes?: CalendarMode[];
  /** Day / list views: shown when the range has no events. */
  emptyText?: string;
  className?: string;
}) {
  const { from, to } = getCalendarRange(mode, anchor);
  const weeks = useMemo(() => {
    const out: Date[] = [];
    for (let day = from; day <= to; day = addDays(day, 7)) out.push(day);
    return out;
  }, [from.getTime(), to.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps

  const title =
    mode === "month" || mode === "list"
      ? format(anchor, "MMMM yyyy")
      : mode === "day"
        ? `${format(anchor, "EEE")}, ${formatDate(anchor)}`
        : `${formatDate(from)} – ${formatDate(to)}`;
  const unit = mode === "month" || mode === "list" ? "month" : mode;

  function step(direction: 1 | -1) {
    onAnchorChange(
      unit === "month"
        ? addMonths(anchor, direction)
        : unit === "week"
          ? addWeeks(anchor, direction)
          : addDays(anchor, direction)
    );
  }

  const weekdays = Array.from({ length: 7 }, (_, index) => addDays(from, index));

  return (
    <section
      aria-label={label}
      className={cn("overflow-hidden rounded-xl border bg-card text-card-foreground", className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2.5 sm:px-4">
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="icon-sm" onClick={() => step(-1)} aria-label={`Previous ${unit}`}>
            <LuChevronLeft aria-hidden />
          </Button>
          <Button variant="outline" size="icon-sm" onClick={() => step(1)} aria-label={`Next ${unit}`}>
            <LuChevronRight aria-hidden />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onAnchorChange(new Date())}>
            Today
          </Button>
          <h2 aria-live="polite" className="ml-1 font-heading text-base font-semibold text-foreground">
            {title}
          </h2>
          {loading && (
            <LuLoaderCircle aria-label="Loading" className="size-4 animate-spin text-muted-foreground" />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {toolbar}
          <div role="radiogroup" aria-label="Calendar range" className="inline-flex rounded-lg border bg-background p-0.5">
            {modes.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={mode === value}
                onClick={() => onModeChange(value)}
                className={cn(
                  "h-7 rounded-md px-2.5 text-xs font-medium text-muted-foreground capitalize transition-colors duration-150 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
                  mode === value && "bg-primary/10 text-primary hover:text-primary"
                )}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
      </div>
      {note && <div className="border-b bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">{note}</div>}

      {mode === "day" ? (
        <DayView day={from} events={events} onEventClick={onEventClick} emptyText={emptyText} loading={loading} />
      ) : mode === "list" ? (
        <ListView
          from={from}
          to={to}
          events={events}
          onEventClick={onEventClick}
          emptyText={emptyText}
          loading={loading}
        />
      ) : (
        <GridView
          mode={mode}
          anchor={anchor}
          weekdays={weekdays}
          weeks={weeks}
          events={events}
          onEventClick={onEventClick}
          loading={loading}
        />
      )}
    </section>
  );
}

/** Month / week body: weekday header + one lane row per week. */
function GridView({
  mode,
  anchor,
  weekdays,
  weeks,
  events,
  onEventClick,
  loading,
}: {
  mode: CalendarMode;
  anchor: Date;
  weekdays: Date[];
  weeks: Date[];
  events: CalendarEvent[];
  onEventClick: (event: CalendarEvent) => void;
  loading?: boolean;
}) {
  return (
    <>
      <div className="grid grid-cols-7 border-b bg-muted/40">
        {weekdays.map((day) => (
          <div
            key={day.toISOString()}
            className="px-1 py-1.5 text-center text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase sm:px-2"
          >
            <span aria-hidden className="sm:hidden">{format(day, "EEEEE")}</span>
            <span className="hidden sm:inline">{format(day, "EEE")}</span>
            {mode === "week" && (
              <span
                className={cn(
                  "mt-0.5 block text-sm font-semibold normal-case",
                  isToday(day) ? "text-primary" : "text-foreground"
                )}
              >
                {format(day, "d")}
              </span>
            )}
          </div>
        ))}
      </div>

      <div className={cn("transition-opacity duration-150", loading && "opacity-70")}>
        {weeks.map((weekStart) => (
          <WeekRow
            key={weekStart.toISOString()}
            weekStart={weekStart}
            anchor={anchor}
            mode={mode}
            events={events}
            onEventClick={onEventClick}
          />
        ))}
      </div>
    </>
  );
}

/** One row per event (day + list views). */
function EventRow({ event, onClick }: { event: CalendarEvent; onClick: () => void }) {
  const dates = eventDates(event);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${event.prefix ? `${event.prefix} ` : ""}${event.title}, ${dates}${event.description ? `, ${event.description}` : ""}`}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-sm text-foreground transition-[filter,box-shadow] duration-150 ease-out outline-none hover:brightness-95 focus-visible:ring-2 focus-visible:ring-ring/60 dark:hover:brightness-110",
        event.chipClass,
        event.muted && "opacity-60"
      )}
    >
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", event.dotClass)} />
      {event.prefix && (
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{event.prefix}</span>
      )}
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate font-medium",
            event.muted && "line-through decoration-muted-foreground/60"
          )}
        >
          {event.title}
        </span>
        {event.description && (
          <span className="block truncate text-xs text-muted-foreground">{event.description}</span>
        )}
      </span>
      {event.end > event.start && (
        <span className="hidden shrink-0 text-xs text-muted-foreground tabular-nums sm:inline">
          {dates}
        </span>
      )}
    </button>
  );
}

function CalendarEmpty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center text-sm text-muted-foreground">
      <span className="flex size-9 items-center justify-center rounded-lg bg-muted">
        <LuCalendarX2 aria-hidden className="size-4" />
      </span>
      {text}
    </div>
  );
}

function DayView({
  day,
  events,
  onEventClick,
  emptyText,
  loading,
}: {
  day: Date;
  events: CalendarEvent[];
  onEventClick: (event: CalendarEvent) => void;
  emptyText: string;
  loading?: boolean;
}) {
  const items = eventsOn(day, events);
  return (
    <div className={cn("min-h-60 transition-opacity duration-150", loading && "opacity-70")}>
      <div
        className={cn(
          "border-b bg-muted/40 px-4 py-1.5 text-[0.7rem] font-medium tracking-wide uppercase",
          isToday(day) ? "text-primary" : "text-muted-foreground"
        )}
      >
        {isToday(day) ? "Today" : format(day, "EEEE")}
      </div>
      {items.length === 0 ? (
        <CalendarEmpty text={emptyText} />
      ) : (
        <ul className="space-y-1.5 p-3">
          {items.map((event) => (
            <li key={event.id}>
              <EventRow event={event} onClick={() => onEventClick(event)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ListView({
  from,
  to,
  events,
  onEventClick,
  emptyText,
  loading,
}: {
  from: Date;
  to: Date;
  events: CalendarEvent[];
  onEventClick: (event: CalendarEvent) => void;
  emptyText: string;
  loading?: boolean;
}) {
  const groups = useMemo(() => {
    const out: { day: Date; items: CalendarEvent[] }[] = [];
    for (let day = from; day <= to; day = addDays(day, 1)) {
      const items = eventsOn(day, events);
      if (items.length > 0) out.push({ day, items });
    }
    return out;
  }, [from.getTime(), to.getTime(), events]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={cn("min-h-60 transition-opacity duration-150", loading && "opacity-70")}>
      {groups.length === 0 ? (
        <CalendarEmpty text={emptyText} />
      ) : (
        <ol>
          {groups.map(({ day, items }) => (
            <li key={day.toISOString()} className="border-b last:border-b-0">
              <h3
                className={cn(
                  "flex items-center justify-between gap-2 bg-muted/40 px-4 py-1.5 text-xs font-semibold",
                  isToday(day) ? "text-primary" : "text-foreground"
                )}
              >
                <span>{format(day, "EEEE")}</span>
                <span className="font-normal text-muted-foreground tabular-nums">
                  {formatDate(day)}
                </span>
              </h3>
              <ul className="space-y-1.5 p-2.5">
                {items.map((event) => (
                  <li key={event.id}>
                    <EventRow event={event} onClick={() => onEventClick(event)} />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function WeekRow({
  weekStart,
  anchor,
  mode,
  events,
  onEventClick,
}: {
  weekStart: Date;
  anchor: Date;
  mode: CalendarMode;
  events: CalendarEvent[];
  onEventClick: (event: CalendarEvent) => void;
}) {
  const maxLanes = mode === "month" ? MONTH_LANES : WEEK_LANES;
  const { segments } = useMemo(() => layoutWeek(weekStart, events), [weekStart, events]);
  const visible = segments.filter((segment) => segment.lane < maxLanes);
  const days = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
  const hidden = days.map((_, col) =>
    segments.filter((segment) => segment.lane >= maxLanes && segment.startCol <= col && segment.endCol >= col)
  );
  const lanesUsed = Math.min(maxLanes, Math.max(0, ...segments.map((segment) => segment.lane + 1)));
  const showDayNumbers = mode === "month";

  return (
    <div className={cn("relative border-b last:border-b-0", mode === "month" ? "min-h-28" : "min-h-80")}>
      {/* Day backgrounds */}
      <div aria-hidden className="absolute inset-0 grid grid-cols-7">
        {days.map((day) => (
          <div
            key={day.toISOString()}
            className={cn(
              "border-r last:border-r-0",
              mode === "month" && !isSameMonth(day, anchor) && "bg-muted/40",
              isToday(day) && "bg-primary/5"
            )}
          />
        ))}
      </div>

      <div
        className="relative grid grid-cols-7 gap-y-1 pb-1.5"
        style={{
          gridTemplateRows: `${showDayNumbers ? "auto " : ""}repeat(${Math.max(lanesUsed, 1)}, 1.5rem) auto`,
        }}
      >
        {showDayNumbers &&
          days.map((day, col) => (
            <div key={day.toISOString()} className="px-1.5 pt-1 text-right sm:px-2" style={{ gridColumn: col + 1, gridRow: 1 }}>
              <span
                className={cn(
                  "inline-flex size-6 items-center justify-center rounded-full text-xs tabular-nums",
                  isToday(day)
                    ? "bg-primary font-semibold text-primary-foreground"
                    : isSameMonth(day, anchor)
                      ? "text-foreground"
                      : "text-muted-foreground"
                )}
              >
                <span aria-hidden>{format(day, "d")}</span>
                <span className="sr-only">{format(day, "EEEE d MMMM yyyy")}</span>
              </span>
            </div>
          ))}
        {!showDayNumbers && <div aria-hidden className="h-1" style={{ gridColumn: "1 / span 7", gridRow: 1 }} />}

        {visible.map((segment) => (
          <EventChip
            key={`${segment.event.id}-${segment.startCol}`}
            segment={segment}
            row={segment.lane + 2}
            onClick={() => onEventClick(segment.event)}
          />
        ))}

        {hidden.map((items, col) =>
          items.length > 0 ? (
            <div
              key={`more-${col}`}
              className="px-1"
              style={{ gridColumn: col + 1, gridRow: lanesUsed + 2 }}
            >
              <MorePopover
                day={days[col]}
                events={segments
                  .filter((segment) => segment.startCol <= col && segment.endCol >= col)
                  .map((segment) => segment.event)}
                count={items.length}
                onEventClick={onEventClick}
              />
            </div>
          ) : null
        )}
      </div>
    </div>
  );
}

function EventChip({
  segment,
  row,
  onClick,
}: {
  segment: WeekSegment;
  row: number;
  onClick: () => void;
}) {
  const { event } = segment;
  const span = segment.endCol - segment.startCol + 1;
  const dates =
    event.start === event.end
      ? format(parseISO(event.start), "d MMM")
      : `${format(parseISO(event.start), "d MMM")} – ${format(parseISO(event.end), "d MMM")}`;
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${event.prefix ? `${event.prefix} · ` : ""}${event.title} (${dates})`}
      aria-label={`${event.prefix ? `${event.prefix} ` : ""}${event.title}, ${dates}${event.description ? `, ${event.description}` : ""}`}
      style={{ gridColumn: `${segment.startCol + 1} / span ${span}`, gridRow: row }}
      className={cn(
        "mx-0.5 flex h-6 min-w-0 items-center gap-1 overflow-hidden border px-1.5 text-left text-[0.7rem] font-medium text-foreground transition-[filter,box-shadow] duration-150 ease-out outline-none hover:brightness-95 focus-visible:ring-2 focus-visible:ring-ring/60 dark:hover:brightness-110",
        segment.continuesBefore ? "rounded-l-none border-l-0" : "rounded-l-md",
        segment.continuesAfter ? "rounded-r-none border-r-0" : "rounded-r-md",
        event.chipClass,
        event.muted && "opacity-60"
      )}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", event.dotClass)} />
      {event.prefix && (
        <span className="hidden shrink-0 font-mono text-[0.65rem] text-muted-foreground sm:inline">
          {event.prefix}
        </span>
      )}
      <span className={cn("truncate", event.muted && "line-through decoration-muted-foreground/60")}>
        {event.title}
      </span>
    </button>
  );
}

function MorePopover({
  day,
  events,
  count,
  onEventClick,
}: {
  day: Date;
  events: CalendarEvent[];
  count: number;
  onEventClick: (event: CalendarEvent) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="w-full truncate rounded-md px-1 text-left text-[0.7rem] font-medium text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label={`${count} more on ${format(day, "EEEE d MMMM")}`}
          />
        }
      >
        +{count} more
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 gap-1.5">
        <p className="text-xs font-semibold text-foreground">{format(day, "EEEE d MMMM")}</p>
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {events.map((event) => (
            <li key={event.id}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onEventClick(event);
                }}
                className={cn(
                  "flex w-full min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-left text-xs font-medium text-foreground outline-none hover:brightness-95 focus-visible:ring-2 focus-visible:ring-ring/60",
                  event.chipClass,
                  event.muted && "opacity-60"
                )}
              >
                <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", event.dotClass)} />
                {event.prefix && (
                  <span className="shrink-0 font-mono text-[0.65rem] text-muted-foreground">{event.prefix}</span>
                )}
                <span className="truncate">{event.title}</span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
