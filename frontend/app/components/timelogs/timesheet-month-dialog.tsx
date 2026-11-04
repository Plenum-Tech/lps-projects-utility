import { useEffect, useMemo, useState } from "react";
import { LuCalendarRange, LuLoaderCircle, LuSave, LuSend, LuTags, LuX } from "react-icons/lu";

import { TimesheetStatusBadge } from "@/components/projects/project-badges";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useBrands } from "@/hooks/use-brands";
import { useSaveTimesheetMonth, useTimesheetMonth } from "@/hooks/use-timesheets";
import { brandWithOrg } from "@/lib/tasks";
import { formatLocalDate, formatMinutes } from "@/lib/time";
import { minutesToCell } from "@/components/timelogs/timesheet-grid";

type Option = { value: string; label: string };

interface Row {
  /** "task:<id>" or "brand:<id>". */
  key: string;
  label: string;
  sub: string;
  hours: string;
  note: string;
  lockedMinutes: number;
}

/** Month hours: "120", "37.5", "37:30" → minutes; null when unreadable. Up to 744h (31 × 24). */
function parseMonthHours(raw: string): number | null {
  const value = raw.trim().replace(",", ".").replace(/h$/i, "");
  if (value === "") return 0;
  const clock = /^(\d{1,3}):([0-5]?\d)$/.exec(value);
  const minutes = clock
    ? Number(clock[1]) * 60 + Number(clock[2])
    : /^\d*\.?\d+$/.test(value)
      ? Math.round(Number(value) * 60)
      : NaN;
  return Number.isFinite(minutes) && minutes >= 0 && minutes <= 744 * 60 ? minutes : null;
}

/**
 * "Log a whole month" — the previous month's total hours per task / brand, spread evenly
 * over its working days (Mon–Fri) in the weekly timesheets. Weeks already submitted keep
 * their hours; the rest is spread over the weeks still open.
 */
export function TimesheetMonthDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const month = useTimesheetMonth(open);
  const save = useSaveTimesheetMonth();
  const view = month.data;
  const allBrands = useBrands(false, open && Boolean(view?.canLogBrands));

  const [rows, setRows] = useState<Row[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  const taskLabel = useMemo(() => {
    const map = new Map<string, { label: string; sub: string }>();
    for (const t of view?.tasks ?? []) {
      map.set(t._id, {
        label: t.shortCode ? `${t.shortCode} · ${t.title}` : t.title,
        sub: t.project ? `${t.project.code} · ${t.project.name}` : "",
      });
    }
    return map;
  }, [view?.tasks]);

  // Fill the form from the server once per open.
  useEffect(() => {
    if (!open) {
      setLoadedFor(null);
      return;
    }
    if (!view || loadedFor === view.month) return;
    setRows(
      view.rows.map((r) => {
        const brand = r.brand ? view.brands.find((b) => b._id === r.brand) : null;
        const task = r.task ? taskLabel.get(r.task) : null;
        return {
          key: r.task ? `task:${r.task}` : `brand:${r.brand}`,
          label: r.task ? (task?.label ?? "Task") : brandWithOrg(brand) || "Brand",
          sub: r.task ? (task?.sub ?? "") : "Brand time · no approval needed",
          hours: minutesToCell(r.minutes),
          note: r.note,
          lockedMinutes: r.lockedMinutes,
        };
      })
    );
    setLoadedFor(view.month);
  }, [open, view, loadedFor, taskLabel]);

  const used = new Set(rows.map((r) => r.key));
  const taskOptions: Option[] = (view?.tasks ?? [])
    .filter((t) => !used.has(`task:${t._id}`))
    .map((t) => ({ value: t._id, label: `${taskLabel.get(t._id)?.label ?? t.title}${t.project ? ` — ${t.project.name}` : ""}` }));
  const brandOptions: Option[] = (allBrands.data ?? [])
    .filter((b) => b.active && (!b.status || b.status === "approved") && !used.has(`brand:${b._id}`))
    .map((b) => ({ value: b._id, label: brandWithOrg(b) }));

  const parsed = rows.map((r) => parseMonthHours(r.hours));
  const invalid = parsed.some((m) => m === null);
  const tooLow = rows.some((r, i) => (parsed[i] ?? 0) < r.lockedMinutes);
  const totalMinutes = parsed.reduce<number>((sum, m) => sum + (m ?? 0), 0);
  const editableDays = view?.editableWorkdays ?? 0;
  const lockedTotal = rows.reduce((sum, r) => sum + r.lockedMinutes, 0);
  const perDay = editableDays > 0 ? Math.max(0, totalMinutes - lockedTotal) / editableDays : 0;
  const openWeeks = (view?.weeks ?? []).filter((w) => w.status === "draft" || w.status === "rejected");

  function addRow(key: string, label: string, sub: string) {
    setRows((prev) => [...prev, { key, label, sub, hours: "", note: "", lockedMinutes: 0 }]);
  }

  function update(key: string, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function run(submit: boolean) {
    if (!view || invalid || tooLow) return;
    // Removed rows are sent as 0 so their month hours are cleared too.
    const sent = new Set(rows.map((r) => r.key));
    const removed = view.rows
      .map((r) => (r.task ? `task:${r.task}` : `brand:${r.brand}`))
      .filter((key) => !sent.has(key));
    const payload = [
      ...rows.map((r, i) => ({ key: r.key, minutes: parsed[i] ?? 0, note: r.note })),
      ...removed.map((key) => ({ key, minutes: 0, note: "" })),
    ].map(({ key, minutes, note }) => {
      const [kind, id] = key.split(":") as ["task" | "brand", string];
      return kind === "task" ? { task: id, minutes } : { brand: id, minutes, note };
    });
    save.mutate(
      { month: view.month, rows: payload, submit },
      { onSuccess: () => onOpenChange(false) }
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LuCalendarRange aria-hidden className="size-5" />
            Log {view?.label ?? "last month"}
          </DialogTitle>
          <DialogDescription>
            Enter your total hours for the month per task{view?.canLogBrands ? " or brand" : ""}. They're spread
            evenly over the month's working days (Mon–Fri) in your weekly timesheets.
          </DialogDescription>
        </DialogHeader>

        {month.isPending ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <LuLoaderCircle aria-hidden className="animate-spin" /> Loading your month…
          </div>
        ) : month.isError || !view ? (
          <p className="py-6 text-sm text-destructive">Couldn't load the month. Close this and try again.</p>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>Weeks:</span>
              {view.weeks.map((w) => (
                <span key={w.weekStart} className="inline-flex items-center gap-1">
                  {formatLocalDate(w.weekStart)}
                  <TimesheetStatusBadge status={w.status} />
                </span>
              ))}
            </div>
            {openWeeks.length === 0 && (
              <p className="rounded-md bg-muted px-3 py-2 text-sm">
                Every week of {view.label} is already submitted — nothing left to log here.
              </p>
            )}

            <div className="divide-y rounded-md border">
              {rows.length === 0 && (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  Add the tasks{view.canLogBrands ? " and brands" : ""} you worked on in {view.label}.
                </p>
              )}
              {rows.map((row, i) => {
                const bad = parsed[i] === null;
                const low = !bad && (parsed[i] ?? 0) < row.lockedMinutes;
                const isBrand = row.key.startsWith("brand:");
                return (
                  <div key={row.key} className="flex flex-wrap items-start gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                        {isBrand && <LuTags aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
                        {row.label}
                      </p>
                      {row.sub && <p className="truncate text-xs text-muted-foreground">{row.sub}</p>}
                      {row.lockedMinutes > 0 && (
                        <p className="text-xs text-muted-foreground">
                          {formatMinutes(row.lockedMinutes)} already in submitted weeks (included in the total)
                        </p>
                      )}
                      {isBrand && (
                        <Input
                          className="mt-1.5 h-8 text-xs"
                          placeholder="What for? (optional)"
                          maxLength={300}
                          value={row.note}
                          onChange={(e) => update(row.key, { note: e.target.value })}
                        />
                      )}
                    </div>
                    <div className="w-28">
                      <Input
                        className="h-8 text-right tabular-nums"
                        inputMode="decimal"
                        placeholder="0"
                        aria-label={`Hours in ${view.label} for ${row.label}`}
                        aria-invalid={bad || low}
                        value={row.hours}
                        onChange={(e) => update(row.key, { hours: e.target.value })}
                      />
                      <p className={`mt-0.5 text-right text-xs ${bad || low ? "text-destructive" : "text-muted-foreground"}`}>
                        {bad ? "e.g. 37.5" : low ? `min ${formatMinutes(row.lockedMinutes)}` : "hours"}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${row.label}`}
                      disabled={row.lockedMinutes > 0}
                      onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
                    >
                      <LuX aria-hidden />
                    </Button>
                  </div>
                );
              })}
            </div>

            {openWeeks.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <Combobox
                  items={taskOptions}
                  value={null}
                  onValueChange={(option: Option | null) => {
                    if (!option) return;
                    const meta = taskLabel.get(option.value);
                    addRow(`task:${option.value}`, meta?.label ?? option.label, meta?.sub ?? "");
                  }}
                  isItemEqualToValue={(x: Option, y: Option) => x.value === y.value}
                >
                  <ComboboxInput className="w-72" placeholder="Add a task — search…" aria-label="Add a task row" />
                  <ComboboxContent>
                    <ComboboxEmpty>No open tasks found.</ComboboxEmpty>
                    <ComboboxList>
                      {(option: Option) => (
                        <ComboboxItem key={option.value} value={option}>
                          {option.label}
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
                {view.canLogBrands && (
                  <Combobox
                    items={brandOptions}
                    value={null}
                    onValueChange={(option: Option | null) =>
                      option && addRow(`brand:${option.value}`, option.label, "Brand time · no approval needed")
                    }
                    isItemEqualToValue={(x: Option, y: Option) => x.value === y.value}
                  >
                    <ComboboxInput
                      className="w-72"
                      placeholder={allBrands.isPending ? "Loading brands…" : "Add brand time — search brands…"}
                      aria-label="Add a brand row"
                    />
                    <ComboboxContent>
                      <ComboboxEmpty>No brands found.</ComboboxEmpty>
                      <ComboboxList>
                        {(option: Option) => (
                          <ComboboxItem key={option.value} value={option}>
                            {option.label}
                          </ComboboxItem>
                        )}
                      </ComboboxList>
                    </ComboboxContent>
                  </Combobox>
                )}
              </div>
            )}

            <p className={`text-xs ${perDay > 24 * 60 ? "text-destructive" : "text-muted-foreground"}`}>
              Total {formatMinutes(totalMinutes)} · spread over {editableDays} open working day
              {editableDays === 1 ? "" : "s"} of {view.workdays}
              {editableDays > 0 && totalMinutes > lockedTotal ? ` · about ${formatMinutes(perDay)} a day` : ""}
              {perDay > 24 * 60 ? " — that's more than 24 hours a day, lower the totals." : "."} Submitting
              sends the open weeks for approval (brand-only weeks are approved at once).
            </p>
          </div>
        )}

        <DialogFooter className="sticky bottom-0 z-10 gap-2 bg-background">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => run(false)}
            disabled={!view || invalid || tooLow || save.isPending || openWeeks.length === 0}
          >
            {save.isPending && !save.variables?.submit ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuSave aria-hidden />}
            Save as draft
          </Button>
          <Button
            onClick={() => run(true)}
            disabled={!view || invalid || tooLow || save.isPending || openWeeks.length === 0 || totalMinutes === 0}
          >
            {save.isPending && save.variables?.submit ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuSend aria-hidden />}
            Save &amp; submit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
