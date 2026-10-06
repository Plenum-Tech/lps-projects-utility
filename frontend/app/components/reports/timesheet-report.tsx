import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { LuCalendarCheck, LuCheck, LuLoaderCircle, LuX } from "react-icons/lu";

import { DataTablePagination } from "@/components/globals/data-table-pagination";
import { FilterSelect } from "@/components/globals/filter-select";
import { EmptyState, PageHeader, QueryError } from "@/components/globals/query-states";
import { ReasonDialog } from "@/components/globals/reason-dialog";
import { TimesheetStatusBadge } from "@/components/projects/project-badges";
import {
  DateRangeInputs,
  DepartmentFilter,
  EmployeeFilter,
  RangePresets,
  ReportFilterBar,
} from "@/components/reports/report-filters";
import { CsvExportButton } from "@/components/reports/report-shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { usePagination } from "@/hooks/use-pagination";
import { useApproveTimesheet, useRejectTimesheet } from "@/hooks/use-timesheets";
import { useTimesheetReport } from "@/hooks/use-work-reports";
import {
  TIMESHEET_STATUS_META,
  addDaysKey,
  formatLocalDate,
  formatMinutes,
  formatWeekRange,
  mondayOf,
} from "@/lib/time";
import { cn } from "@/lib/utils";
import type { Role, TimesheetReportRow, TimesheetStatus } from "@/types";

const LIMIT = 20;
const STATUSES: TimesheetStatus[] = ["draft", "submitted", "approved", "rejected"];

interface Filters {
  from: string;
  to: string;
  user: string;
  department: string;
  status: TimesheetStatus | "";
  includeEmpty: boolean;
}

function defaultRange() {
  const thisWeek = mondayOf();
  return { from: addDaysKey(thisWeek, -7 * 7), to: thisWeek };
}

function isStatus(value: string | null): value is TimesheetStatus {
  return value !== null && (STATUSES as string[]).includes(value);
}

/** Head/admin: one row per employee per week with inline review. */
export function TimesheetReport({ role }: { role: Role }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const isAdmin = role === "admin";

  const initial = useMemo<Filters>(
    () => ({
      ...defaultRange(),
      user: "",
      department: "",
      status: "",
      includeEmpty: false,
    }),
    []
  );
  const [filters, setFilters] = useState<Filters>(() => {
    const status = searchParams.get("status");
    return { ...initial, status: isStatus(status) ? status : "" };
  });

  const set = (patch: Partial<Filters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    // Keep the notification deep link (?status=) in sync with the filter.
    if ("status" in patch) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (patch.status) next.set("status", patch.status);
          else next.delete("status");
          return next;
        },
        { replace: true }
      );
    }
  };

  // Follow later deep links (e.g. clicking a "timesheet submitted" notification while here).
  const urlStatus = searchParams.get("status");
  useEffect(() => {
    const next = isStatus(urlStatus) ? urlStatus : "";
    setFilters((prev) => (prev.status === next ? prev : { ...prev, status: next }));
  }, [urlStatus]);

  const pagination = usePagination({ limit: LIMIT, resetKey: JSON.stringify(filters) });
  const params = { ...filters, limit: LIMIT, offset: pagination.offset };
  const report = useTimesheetReport(params);
  const { setTotal } = pagination;

  useEffect(() => {
    if (report.data) setTotal(report.data.total);
  }, [report.data, setTotal]);

  const presets = useMemo(() => {
    const thisWeek = mondayOf();
    return [
      { label: "This week", from: thisWeek, to: thisWeek },
      { label: "Last 4 weeks", from: addDaysKey(thisWeek, -21), to: thisWeek },
      { label: "Last 8 weeks", from: addDaysKey(thisWeek, -49), to: thisWeek },
    ];
  }, []);

  const dirty = JSON.stringify(filters) !== JSON.stringify(initial);

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Weekly timesheets"
        description={
          isAdmin
            ? "Every employee's weekly timesheet, with inline approval."
            : "Weekly timesheets in your department, with inline approval."
        }
        actions={
          <CsvExportButton
            path="/reports/timesheets/export"
            params={filters}
            filenamePrefix="weekly-timesheets"
            disabled={!report.data || report.data.total === 0}
          />
        }
      />

      <ReportFilterBar onReset={() => set({ ...initial })} canReset={dirty}>
        <DateRangeInputs
          idPrefix="timesheet-report"
          label="Weeks starting between"
          from={filters.from}
          to={filters.to}
          onChange={({ from, to }) =>
            set({ from: from ? mondayOf(from) : "", to: to ? mondayOf(to) : "" })
          }
        />
        <RangePresets presets={presets} from={filters.from} to={filters.to} onSelect={set} />
        {isAdmin && (
          <DepartmentFilter
            value={filters.department}
            onChange={(department) => set({ department, user: "" })}
          />
        )}
        <EmployeeFilter
          value={filters.user}
          department={filters.department}
          onChange={(user) => set({ user })}
        />
        <FilterSelect
          label="Status"
          value={filters.status}
          onChange={(status) => set({ status: status as TimesheetStatus | "" })}
          options={STATUSES.map((status) => ({
            value: status,
            label: TIMESHEET_STATUS_META[status].label,
          }))}
          anyLabel="All statuses"
        />
        <div className="flex items-center gap-2 px-1">
          <Switch
            id="timesheet-include-empty"
            size="sm"
            checked={filters.includeEmpty}
            onCheckedChange={(includeEmpty) => set({ includeEmpty })}
          />
          <Label htmlFor="timesheet-include-empty" className="text-xs font-normal">
            Include empty drafts
          </Label>
        </div>
      </ReportFilterBar>
      <p className="-mt-4 text-xs text-muted-foreground">
        Dates snap to the Monday of their week.
      </p>

      {report.isPending ? (
        <div className="space-y-2" aria-busy="true" aria-label="Loading timesheets">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      ) : report.isError ? (
        <QueryError
          title="Couldn't load timesheets"
          error={report.error}
          onRetry={() => void report.refetch()}
          retrying={report.isFetching}
        />
      ) : report.data.timesheets.length === 0 ? (
        <EmptyState
          icon={LuCalendarCheck}
          title={filters.status === "submitted" ? "Nothing waiting for review" : "No timesheets"}
          description={
            filters.status === "submitted"
              ? "There are no submitted timesheets in this range."
              : "No timesheets match these filters. Try a wider week range."
          }
        />
      ) : (
        <Card className={cn("transition-opacity duration-200", report.isFetching && "opacity-70")}>
          <CardContent>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Employee</TableHead>
                    <TableHead>Week</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Submitted</TableHead>
                    <TableHead>Reviewed</TableHead>
                    <TableHead>Reviewer</TableHead>
                    <TableHead>Reject reason</TableHead>
                    <TableHead className="text-right">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.data.timesheets.map((row) => (
                    <TimesheetRow key={row._id} row={row} />
                  ))}
                </TableBody>
              </Table>
            </div>
            <DataTablePagination
              page={pagination.page}
              limit={LIMIT}
              total={report.data.total}
              onPageChange={pagination.setPage}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function TimesheetRow({ row }: { row: TimesheetReportRow }) {
  const approve = useApproveTimesheet();
  const reject = useRejectTimesheet();
  const [rejecting, setRejecting] = useState(false);
  const reviewable = row.canReview && row.status === "submitted";
  const busy = approve.isPending || reject.isPending;

  return (
    <TableRow>
      <TableCell className="max-w-64">
        <p className="truncate font-medium text-foreground">{row.user.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {row.user.email}
          {row.user.department ? ` · ${row.user.department.name}` : ""}
        </p>
      </TableCell>
      <TableCell className="whitespace-nowrap">{formatWeekRange(row.weekStartKey)}</TableCell>
      <TableCell className="text-right whitespace-nowrap tabular-nums">
        {formatMinutes(row.totalMinutes)}
      </TableCell>
      <TableCell>
        <TimesheetStatusBadge status={row.status} />
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {row.submittedAt ? formatLocalDate(row.submittedAt) : "—"}
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {row.reviewedAt ? formatLocalDate(row.reviewedAt) : "—"}
      </TableCell>
      <TableCell className="text-muted-foreground">{row.reviewedBy?.name ?? "—"}</TableCell>
      <TableCell className="max-w-56 text-muted-foreground">
        {row.rejectReason ? (
          <span className="line-clamp-2 text-xs" title={row.rejectReason}>
            {row.rejectReason}
          </span>
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell className="text-right">
        {reviewable && (
          <div className="flex justify-end gap-1.5">
            <Button
              size="sm"
              onClick={() => approve.mutate(row._id)}
              disabled={busy}
              aria-label={`Approve ${row.user.name}'s timesheet for ${formatWeekRange(row.weekStartKey)}`}
            >
              {approve.isPending ? (
                <LuLoaderCircle aria-hidden className="animate-spin" />
              ) : (
                <LuCheck aria-hidden />
              )}
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRejecting(true)}
              disabled={busy}
              aria-label={`Reject ${row.user.name}'s timesheet for ${formatWeekRange(row.weekStartKey)}`}
            >
              <LuX aria-hidden />
              Reject
            </Button>
          </div>
        )}
        <ReasonDialog
          open={rejecting}
          onOpenChange={setRejecting}
          title="Reject timesheet"
          description={`${row.user.name} · ${formatWeekRange(row.weekStartKey)}. The generated time logs are removed and the employee can edit and resubmit.`}
          pending={reject.isPending}
          onConfirm={(reason) =>
            reject.mutate({ id: row._id, reason }, { onSuccess: () => setRejecting(false) })
          }
        />
      </TableCell>
    </TableRow>
  );
}
