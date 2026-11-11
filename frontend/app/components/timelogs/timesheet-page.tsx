import { useEffect, useMemo, useRef, useState } from "react";
import {
  LuCalendarDays,
  LuCalendarRange,
  LuChevronLeft,
  LuChevronRight,
  LuCircleAlert,
  LuClipboardList,
  LuInfo,
  LuLoaderCircle,
  LuSave,
  LuSend,
} from "react-icons/lu";
import { useSearchParams } from "react-router";

import { EmptyState, PageHeader, QueryError } from "@/components/globals/query-states";
import {
  BrandProjectPicker,
  brandProjectLabel,
  brandRowKey,
  splitBrandRowKey,
} from "@/components/timelogs/brand-project-picker";
import { TimesheetStatusBadge } from "@/components/projects/project-badges";
import { TimeNav } from "@/components/timelogs/time-nav";
import { TimesheetMonthDialog } from "@/components/timelogs/timesheet-month-dialog";
import {
  TimesheetGrid,
  TimesheetGridSkeleton,
  cellKey,
  minutesToCell,
  parseHours,
} from "@/components/timelogs/timesheet-grid";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useBrands } from "@/hooks/use-brands";
import { useSaveTimesheet, useSubmitTimesheet, useTimesheetWeek } from "@/hooks/use-timesheets";
import { brandWithOrg } from "@/lib/tasks";
import { addDaysKey, formatLocalDate, formatMinutes, formatWeekRange, mondayOf } from "@/lib/time";
import type { TimesheetEntry, TimesheetView } from "@/types";
import type { TimesheetGridRow } from "@/components/timelogs/timesheet-grid";

const MANY_TASKS = 8;
const DAY_MAX = 24 * 60;

/** Grid row id of a brand row (key: `<brandId>:<projectId>`, see brandRowKey). */
const brandRowId = (key: string) => `brand:${key}`;

function valuesFromView(view: TimesheetView): Record<string, string> {
  const values: Record<string, string> = {};
  for (const entry of view.timesheet.entries) {
    const row = entry.brand ? brandRowId(brandRowKey(entry.brand, entry.project)) : entry.task;
    if (row) values[cellKey(row, entry.date.slice(0, 10))] = minutesToCell(entry.minutes);
  }
  return values;
}

/** Brand rows on the sheet (in order, by brand row key) and each one's note. */
function brandsFromView(view: TimesheetView): { ids: string[]; notes: Record<string, string> } {
  const ids: string[] = [];
  const notes: Record<string, string> = {};
  for (const entry of view.timesheet.entries) {
    if (!entry.brand) continue;
    const key = brandRowKey(entry.brand, entry.project);
    if (!ids.includes(key)) ids.push(key);
    if (entry.note && !notes[key]) notes[key] = entry.note;
  }
  return { ids, notes };
}

type BrandOption = { value: string; label: string };

function isValidWeekParam(value: string | null): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

/**
 * /timesheet — my weekly grid (tasks × Mon–Sun). Save a draft, submit for
 * approval, and see the rejection reason. Read-only once submitted/approved.
 */
export function TimesheetPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const weekParam = searchParams.get("week");
  const week = mondayOf(isValidWeekParam(weekParam) ? weekParam : undefined);
  const thisWeek = mondayOf();

  const sheet = useTimesheetWeek(week);
  const [monthOpen, setMonthOpen] = useState(false);
  const lastMonthName = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).toLocaleDateString("en-GB", {
    month: "long",
  });
  const save = useSaveTimesheet();
  const submit = useSubmitTimesheet();

  const view = sheet.data;
  // While another week loads, keepPreviousData shows the old sheet — hide it.
  const viewForWeek = sheet.isPlaceholderData ? undefined : view;

  const [values, setValues] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Brand rows (Program / CM / leadership): brand row keys (brand + project) on the sheet and their notes.
  const [brandIds, setBrandIds] = useState<string[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const loadedVersion = useRef("");

  // Load server values when the sheet changes (new week or fresh save), unless editing.
  const version = viewForWeek
    ? `${viewForWeek.timesheet._id}:${viewForWeek.timesheet.updatedAt}:${viewForWeek.timesheet.status}`
    : "";
  useEffect(() => {
    if (!viewForWeek || version === loadedVersion.current) return;
    const sameSheet = loadedVersion.current.startsWith(`${viewForWeek.timesheet._id}:`);
    if (sameSheet && dirty) return;
    loadedVersion.current = version;
    setValues(valuesFromView(viewForWeek));
    const fromSheet = brandsFromView(viewForWeek);
    // Brands from the manpower allocation show as rows (brand as a whole) with 0 hours.
    const assigned = (viewForWeek.assignedBrands ?? [])
      .filter((b) => !fromSheet.ids.some((key) => splitBrandRowKey(key).brand === b._id))
      .map((b) => brandRowKey(b._id, null));
    setBrandIds([...fromSheet.ids, ...assigned]);
    setNotes(fromSheet.notes);
    setDirty(false);
  }, [version, viewForWeek, dirty]);

  // Warn before closing the tab with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const readOnly = !viewForWeek?.permissions.canEdit;
  const tasks = viewForWeek?.tasks ?? [];
  const days = viewForWeek?.days ?? [];
  const canLogBrands = Boolean(viewForWeek?.permissions.canLogBrands);
  // Every brand (names for rows already on the sheet, inactive ones too); new rows pick active ones.
  const allBrands = useBrands(false, canLogBrands || brandIds.length > 0);
  const assignedIds = new Set((viewForWeek?.assignedBrands ?? []).map((b) => b._id));
  const brandName = (id: string) => {
    const b = allBrands.data?.find((x) => x._id === id) ?? viewForWeek?.assignedBrands?.find((x) => x._id === id);
    return b ? brandWithOrg(b) : "Brand";
  };
  const brandOptions: BrandOption[] = useMemo(
    () =>
      (allBrands.data ?? [])
        .filter((b) => b.active && (!b.status || b.status === "approved"))
        .map((b) => ({ value: b._id, label: brandWithOrg(b) })),
    [allBrands.data],
  );
  const brandProjects = viewForWeek?.brandProjects ?? [];
  const rowIds = [...tasks.map((t) => t._id), ...brandIds.map(brandRowId)];

  const invalidCells = useMemo(
    () => Object.values(values).filter((raw) => parseHours(raw) === null).length,
    [values]
  );
  const overDays = useMemo(
    () =>
      days.filter(
        (day) =>
          rowIds.reduce((sum, id) => sum + (parseHours(values[cellKey(id, day)] ?? "") ?? 0), 0) >
          DAY_MAX
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [days, rowIds.join(), values]
  );
  const hasErrors = invalidCells > 0 || overDays.length > 0;

  const tasksWithTime = tasks.filter((task) =>
    days.some((day) => (parseHours(values[cellKey(task._id, day)] ?? "") ?? 0) > 0)
  );
  const collapsible = !readOnly && tasks.length > MANY_TASKS;
  const visibleTasks = readOnly
    ? tasksWithTime.length > 0
      ? tasksWithTime
      : tasks
    : collapsible && !showAll
      ? tasksWithTime
      : tasks;

  function entries(): TimesheetEntry[] {
    const out: TimesheetEntry[] = [];
    for (const task of tasks) {
      for (const day of days) {
        const minutes = parseHours(values[cellKey(task._id, day)] ?? "") ?? 0;
        if (minutes > 0) out.push({ task: task._id, date: day, minutes });
      }
    }
    for (const key of brandIds) {
      const { brand, project } = splitBrandRowKey(key);
      const note = (notes[key] ?? "").trim();
      for (const day of days) {
        const minutes = parseHours(values[cellKey(brandRowId(key), day)] ?? "") ?? 0;
        if (minutes > 0) out.push({ brand, ...(project ? { project } : {}), date: day, minutes, ...(note ? { note } : {}) });
      }
    }
    return out;
  }

  function addBrand(brand: string, project: string | null) {
    const id = brandRowKey(brand, project);
    setBrandIds((current) => (current.includes(id) ? current : [...current, id]));
    setDirty(true);
  }

  function removeBrand(id: string) {
    setBrandIds((current) => current.filter((x) => x !== id));
    setValues((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${brandRowId(id)}|`))));
    setDirty(true);
  }

  function changeCell(key: string, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  function goToWeek(target: string) {
    if (target === week) return;
    if (dirty && !window.confirm("You have unsaved changes on this week. Discard them?")) return;
    setDirty(false);
    loadedVersion.current = "";
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        if (target === thisWeek) next.delete("week");
        else next.set("week", target);
        return next;
      },
      { preventScrollReset: true }
    );
  }

  function handleSave() {
    if (!viewForWeek || hasErrors) return;
    save.mutate(
      { id: viewForWeek.timesheet._id, entries: entries() },
      { onSuccess: () => setDirty(false) }
    );
  }

  async function handleSubmit() {
    if (!viewForWeek || hasErrors) return;
    try {
      if (dirty) {
        await save.mutateAsync({ id: viewForWeek.timesheet._id, entries: entries() });
        setDirty(false);
      }
      await submit.mutateAsync(viewForWeek.timesheet._id);
      setConfirmOpen(false);
    } catch {
      // Hooks already toast the server message; keep the dialog open to retry.
    }
  }

  const status = viewForWeek?.timesheet.status;
  const pendingAction = save.isPending || submit.isPending;
  const allEntries = entries();
  const totalMinutes = allEntries.reduce((sum, entry) => sum + entry.minutes, 0);
  // Brand hours need no approval: a week of brand rows only is approved as it's submitted.
  const brandOnly = allEntries.length > 0 && allEntries.every((e) => e.brand);

  const brandRows: TimesheetGridRow[] = brandIds.map((id) => {
    const { brand, project } = splitBrandRowKey(id);
    return {
      id: brandRowId(id),
      title: brandName(brand),
      sublabel: project
        ? `${brandProjectLabel(brandProjects.find((p) => p._id === project))} · no approval needed`
        : `Brand as a whole${assignedIds.has(brand) ? " · from your manpower allocation" : ""} · no approval needed`,
      brand: true,
      note: notes[id] ?? "",
      onNoteChange: (note) => {
        setNotes((current) => ({ ...current, [id]: note }));
        setDirty(true);
      },
      onRemove: () => removeBrand(id),
    };
  });
  const taskRow = (task: (typeof tasks)[number]): TimesheetGridRow => ({
    id: task._id,
    title: task.title,
    code: task.shortCode,
    sublabel: task.project ? `${task.project.code} · ${task.project.name}` : null,
  });

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Timesheet"
        description={
          canLogBrands
            ? "Fill in your hours per task — or per brand — for the week, then submit. Brand hours need no approval."
            : "Fill in your hours per task for the week, then submit for approval."
        }
        actions={<TimeNav current="/timesheet" />}
      />

      <div className="mt-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Previous week"
                onClick={() => goToWeek(addDaysKey(week, -7))}
              >
                <LuChevronLeft aria-hidden />
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Next week"
                onClick={() => goToWeek(addDaysKey(week, 7))}
              >
                <LuChevronRight aria-hidden />
              </Button>
            </div>
            <h2 className="font-heading text-lg font-semibold tabular-nums" aria-live="polite">
              {formatWeekRange(week)}
            </h2>
            {week !== thisWeek && (
              <Button variant="ghost" size="sm" onClick={() => goToWeek(thisWeek)}>
                <LuCalendarDays aria-hidden />
                This week
              </Button>
            )}
            {status && <TimesheetStatusBadge status={status} />}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setMonthOpen(true)}
              title={`Enter ${lastMonthName}'s total hours per task — spread over its working days`}
            >
              <LuCalendarRange aria-hidden />
              Log all of {lastMonthName}
            </Button>
          </div>

          {viewForWeek && (tasks.length > 0 || brandIds.length > 0 || canLogBrands) && (
            <div className="flex flex-wrap items-center gap-2">
              {viewForWeek.permissions.canEdit && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSave}
                  disabled={!dirty || hasErrors || pendingAction}
                >
                  {save.isPending && !submit.isPending ? (
                    <LuLoaderCircle aria-hidden className="animate-spin" />
                  ) : (
                    <LuSave aria-hidden />
                  )}
                  Save draft
                </Button>
              )}
              {/* The server only allows submit once the draft has entries; an unsaved
                  dirty grid is saved first by handleSubmit. */}
              {(viewForWeek.permissions.canSubmit ||
                (viewForWeek.permissions.canEdit && dirty)) && (
                <Button
                  size="sm"
                  onClick={() => setConfirmOpen(true)}
                  disabled={hasErrors || pendingAction || totalMinutes === 0}
                  title={totalMinutes === 0 ? "Add some hours before submitting" : undefined}
                >
                  <LuSend aria-hidden />
                  Submit
                </Button>
              )}
            </div>
          )}
        </div>

        {viewForWeek?.timesheet.status === "rejected" && (
          <Alert variant="destructive">
            <LuCircleAlert aria-hidden className="size-4" />
            <AlertTitle>
              Rejected
              {viewForWeek.timesheet.reviewedBy ? ` by ${viewForWeek.timesheet.reviewedBy.name}` : ""}
            </AlertTitle>
            <AlertDescription>
              {viewForWeek.timesheet.rejectReason || "No reason given."} Update your hours and
              submit again.
            </AlertDescription>
          </Alert>
        )}
        {viewForWeek?.timesheet.status === "submitted" && (
          <Alert>
            <LuInfo aria-hidden className="size-4" />
            <AlertTitle>Waiting for approval</AlertTitle>
            <AlertDescription>
              Submitted
              {viewForWeek.timesheet.submittedAt
                ? ` on ${formatLocalDate(viewForWeek.timesheet.submittedAt)}`
                : ""}
              . The sheet is read-only until it&apos;s reviewed.
            </AlertDescription>
          </Alert>
        )}
        {viewForWeek?.timesheet.status === "approved" && (
          <Alert>
            <LuInfo aria-hidden className="size-4" />
            <AlertTitle>Approved</AlertTitle>
            <AlertDescription>
              {viewForWeek.timesheet.reviewedBy
                ? `Approved by ${viewForWeek.timesheet.reviewedBy.name}`
                : "Approved"}
              {viewForWeek.timesheet.reviewedAt
                ? ` on ${formatLocalDate(viewForWeek.timesheet.reviewedAt)}`
                : ""}
              .
            </AlertDescription>
          </Alert>
        )}

        {sheet.isPending || sheet.isPlaceholderData ? (
          <TimesheetGridSkeleton />
        ) : sheet.isError && !viewForWeek ? (
          <QueryError
            title="Couldn't load your timesheet"
            error={sheet.error}
            onRetry={() => void sheet.refetch()}
            retrying={sheet.isFetching}
          />
        ) : !viewForWeek || (tasks.length === 0 && brandIds.length === 0 && !canLogBrands) ? (
          <EmptyState
            icon={LuClipboardList}
            title="No tasks to log time on"
            description="Open tasks assigned to you in active projects appear here as rows."
          />
        ) : (
          <div className="space-y-3">
            {collapsible && (
              <div className="flex items-center gap-2">
                <Switch id="timesheet-show-all" checked={showAll} onCheckedChange={setShowAll} />
                <Label htmlFor="timesheet-show-all" className="text-sm">
                  Show all {tasks.length} tasks
                </Label>
              </div>
            )}
            {canLogBrands && !readOnly && (
              <div className="flex flex-wrap items-center gap-2">
                <BrandProjectPicker
                  brands={brandOptions}
                  projects={brandProjects}
                  used={new Set(brandIds)}
                  loading={allBrands.isPending}
                  onAdd={addBrand}
                />
                <span className="text-xs text-muted-foreground">
                  Pick the brand, then the project of the month you worked on (or the brand as a whole). It counts at once — no approval.
                </span>
              </div>
            )}
            {visibleTasks.length === 0 && brandRows.length === 0 ? (
              tasks.length > 0 ? (
                <EmptyState
                  icon={LuClipboardList}
                  title="No hours yet this week"
                  description={`You have ${tasks.length} tasks you can log time on.`}
                >
                  <Button size="sm" variant="outline" onClick={() => setShowAll(true)}>
                    Show all tasks
                  </Button>
                </EmptyState>
              ) : (
                <EmptyState
                  icon={LuClipboardList}
                  title="No hours yet this week"
                  description="Add a brand above to log your time on it."
                />
              )
            ) : (
              <TimesheetGrid
                rows={[...brandRows, ...visibleTasks.map(taskRow)]}
                days={days}
                values={values}
                onChange={changeCell}
                readOnly={readOnly}
              />
            )}
            {!readOnly && (
              <p
                className={hasErrors ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
                role={hasErrors ? "alert" : undefined}
              >
                {invalidCells > 0
                  ? `${invalidCells} cell${invalidCells === 1 ? "" : "s"} can't be read — use hours like 1.5 or 1:30 (max 24h).`
                  : overDays.length > 0
                    ? "A day can't have more than 24 hours."
                    : dirty
                      ? "Unsaved changes."
                      : "Enter hours as 1.5 or 1:30. Empty cells count as zero."}
              </p>
            )}
          </div>
        )}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={(open) => !pendingAction && setConfirmOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Submit this timesheet?</AlertDialogTitle>
            <AlertDialogDescription>
              {brandOnly
                ? `${formatMinutes(totalMinutes)} of brand time for ${formatWeekRange(week)} is recorded at once — brand hours need no approval. You can't edit the week afterwards.`
                : `${formatMinutes(totalMinutes)} for ${formatWeekRange(week)} goes to your approver (brand hours count at once). You can't edit it again unless it's rejected.`}
              {dirty ? " Your unsaved changes are saved first." : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendingAction}>Cancel</AlertDialogCancel>
            <Button onClick={() => void handleSubmit()} disabled={pendingAction}>
              {pendingAction ? (
                <LuLoaderCircle aria-hidden className="animate-spin" />
              ) : (
                <LuSend aria-hidden />
              )}
              Submit
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <TimesheetMonthDialog open={monthOpen} onOpenChange={setMonthOpen} />
    </div>
  );
}
