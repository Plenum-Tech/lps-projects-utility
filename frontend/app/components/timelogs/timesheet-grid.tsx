import { ShortCode } from "@/components/projects/project-badges";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { dateKey, formatDayLabel, formatMinutes } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { TimesheetTask } from "@/types";

const DAY_MAX = 24 * 60;

/** Grid cell key. */
export function cellKey(taskId: string, day: string) {
  return `${taskId}|${day}`;
}

/**
 * Parses an hours cell: "1.5" / "1,5" → 90, "1:30" → 90, "45m" → 45, "" → 0.
 * Returns null when unparseable or outside 0–24h.
 */
export function parseHours(raw: string): number | null {
  const value = raw.trim().toLowerCase();
  if (value === "") return 0;
  let minutes: number;
  const clock = /^(\d{1,2}):([0-5]?\d)$/.exec(value);
  const mins = /^(\d{1,4})\s*m$/.exec(value);
  if (clock) {
    minutes = Number(clock[1]) * 60 + Number(clock[2]);
  } else if (mins) {
    minutes = Number(mins[1]);
  } else {
    const normalized = value.replace(",", ".").replace(/h$/, "");
    if (!/^\d*\.?\d+$|^\d+\.$/.test(normalized)) return null;
    minutes = Math.round(Number(normalized) * 60);
  }
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > DAY_MAX) return null;
  return minutes;
}

/** Minutes → compact hours text for an input ("1.5", "0.75", ""). */
export function minutesToCell(minutes: number): string {
  if (!minutes) return "";
  const hours = minutes / 60;
  return Number.isInteger(hours) ? String(hours) : String(Number(hours.toFixed(2)));
}

/**
 * Weekly grid: tasks × Mon–Sun with hour inputs, row / day / grand totals.
 * Values are raw strings so the user can type "1:30" freely; invalid cells
 * are flagged and excluded from totals.
 */
export function TimesheetGrid({
  tasks,
  days,
  values,
  onChange,
  readOnly,
}: {
  tasks: TimesheetTask[];
  days: string[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  readOnly: boolean;
}) {
  const today = dateKey(new Date());

  const minutesOf = (taskId: string, day: string) =>
    parseHours(values[cellKey(taskId, day)] ?? "") ?? 0;

  const dayTotals = days.map((day) => tasks.reduce((sum, task) => sum + minutesOf(task._id, day), 0));
  const grandTotal = dayTotals.reduce((sum, value) => sum + value, 0);

  return (
    <Card className="py-0">
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table className="min-w-[46rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-10 min-w-52 bg-card">Task</TableHead>
                {days.map((day) => {
                  const label = formatDayLabel(day);
                  return (
                    <TableHead
                      key={day}
                      className={cn("w-20 text-center", day === today && "text-primary")}
                    >
                      <span className="block text-xs font-semibold">{label.weekday}</span>
                      <span className="block text-[0.7rem] font-normal text-muted-foreground">
                        {label.day}
                      </span>
                    </TableHead>
                  );
                })}
                <TableHead className="w-20 text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((task) => {
                const rowTotal = days.reduce((sum, day) => sum + minutesOf(task._id, day), 0);
                return (
                  <TableRow key={task._id}>
                    <TableCell className="sticky left-0 z-10 max-w-64 bg-card">
                      <div className="flex min-w-0 items-center gap-1.5">
                        {task.shortCode && <ShortCode code={task.shortCode} />}
                        <span className="truncate text-sm font-medium" title={task.title}>
                          {task.title}
                        </span>
                      </div>
                      {task.project && (
                        <p className="truncate text-xs text-muted-foreground">
                          {task.project.code} · {task.project.name}
                        </p>
                      )}
                    </TableCell>
                    {days.map((day) => {
                      const key = cellKey(task._id, day);
                      const raw = values[key] ?? "";
                      const parsed = parseHours(raw);
                      const label = formatDayLabel(day);
                      return (
                        <TableCell key={day} className="px-1 text-center">
                          {readOnly ? (
                            <span
                              className={cn(
                                "text-sm tabular-nums",
                                !parsed && "text-muted-foreground"
                              )}
                            >
                              {parsed ? formatMinutes(parsed) : "—"}
                            </span>
                          ) : (
                            <Input
                              value={raw}
                              onChange={(event) => onChange(key, event.target.value)}
                              inputMode="decimal"
                              autoComplete="off"
                              placeholder="0"
                              aria-label={`Hours for ${task.shortCode ?? task.title} on ${label.weekday} ${label.day}`}
                              aria-invalid={parsed === null || undefined}
                              title={parsed === null ? "Enter hours like 1.5 or 1:30 (max 24h)" : undefined}
                              className="mx-auto h-8 w-16 text-center tabular-nums"
                            />
                          )}
                        </TableCell>
                      );
                    })}
                    <TableCell className="text-right text-sm font-medium tabular-nums">
                      {rowTotal ? formatMinutes(rowTotal) : "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="sticky left-0 z-10 bg-muted font-medium">Day total</TableCell>
                {dayTotals.map((total, index) => (
                  <TableCell
                    key={days[index]}
                    className={cn(
                      "text-center text-sm tabular-nums",
                      total > DAY_MAX && "text-destructive"
                    )}
                  >
                    {total ? formatMinutes(total) : "—"}
                  </TableCell>
                ))}
                <TableCell className="text-right text-sm font-semibold tabular-nums">
                  {formatMinutes(grandTotal)}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

export function TimesheetGridSkeleton() {
  return (
    <Card aria-busy="true" aria-label="Loading timesheet" className="py-0">
      <CardContent className="space-y-3 p-4">
        {Array.from({ length: 5 }).map((_, row) => (
          <div key={row} className="flex items-center gap-2">
            <Skeleton className="h-8 w-48" />
            {Array.from({ length: 7 }).map((__, col) => (
              <Skeleton key={col} className="hidden h-8 flex-1 sm:block" />
            ))}
            <Skeleton className="h-8 w-14" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
