import { useEffect, useState, type FormEvent } from "react";
import {
  AlertCircle,
  CalendarCheck,
  CalendarDays,
  LoaderCircle,
  RefreshCw,
  Save,
} from "lucide-react";

import { DataTablePagination } from "@/components/globals/data-table-pagination";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentUser } from "@/hooks/use-auth";
import {
  useDepartmentAttendance,
  useMarkAttendance,
  useMyAttendance,
} from "@/hooks/use-attendance";
import { usePagination } from "@/hooks/use-pagination";
import { getErrorMessage } from "@/lib/api";
import {
  ATTENDANCE_STATUSES,
  ATTENDANCE_STATUS_LABELS,
  ATTENDANCE_STATUS_META,
  formatAttendanceDate,
  formatTime,
  startOfMonthString,
  todayString,
} from "@/lib/attendance";
import type { Attendance, AttendanceStatus } from "@/types";

import type { Route } from "./+types/attendance";

const PAGE_SIZE = 15;

export function meta({}: Route.MetaArgs) {
  return [{ title: "Attendance | LPS" }];
}

/**
 * Attendance page:
 * - Employees: view their own attendance history.
 * - Heads/Admins: mark attendance for department members.
 */
export default function AttendancePage() {
  const { data: currentUser, isPending: userPending } = useCurrentUser();
  const role = currentUser?.role;
  const canMark = role === "head" || role === "admin";

  if (userPending) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="mt-4 h-64 w-full" />
      </div>
    );
  }

  if (canMark) {
    return <MarkAttendanceView />;
  }

  return <EmployeeAttendanceView />;
}

/* ------------------------------------------------------------------ */
/* Employee view — own attendance history                               */
/* ------------------------------------------------------------------ */

function EmployeeAttendanceView() {
  const [from, setFrom] = useState(startOfMonthString());
  const [to, setTo] = useState(todayString());
  const { page, setPage, offset, total, setTotal } = usePagination({
    limit: PAGE_SIZE,
    resetKey: `${from}-${to}`,
  });
  const {
    data,
    isPending,
    isError,
    error,
    refetch,
    isRefetching,
  } = useMyAttendance({ from, to, limit: PAGE_SIZE, offset });
  const records = data?.attendance;

  useEffect(() => {
    setTotal(data?.total ?? 0);
  }, [data?.total, setTotal]);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <header>
        <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground">
          My Attendance
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          View your attendance history and track your work days.
        </p>
      </header>

      <div className="mt-8 space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="att-from" className="text-xs">From</Label>
            <Input
              id="att-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-40"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="att-to" className="text-xs">To</Label>
            <Input
              id="att-to"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-40"
            />
          </div>
        </div>

        {isPending ? (
          <AttendanceTableSkeleton />
        ) : isError ? (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Couldn&apos;t load attendance</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              {getErrorMessage(error)}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refetch()}
                disabled={isRefetching}
              >
                {isRefetching ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : total > 0 ? (
          <>
            <Card>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Check In</TableHead>
                        <TableHead>Check Out</TableHead>
                        <TableHead>Marked By</TableHead>
                        <TableHead>Notes</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {records?.map((record) => (
                        <TableRow key={record._id}>
                          <TableCell className="whitespace-nowrap text-sm font-medium">
                            {formatAttendanceDate(record.date)}
                          </TableCell>
                          <TableCell>
                            <Badge variant={ATTENDANCE_STATUS_META[record.status].variant}>
                              {ATTENDANCE_STATUS_META[record.status].label}
                            </Badge>
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                            {formatTime(record.checkIn)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                            {formatTime(record.checkOut)}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {record.markedBy.name}
                          </TableCell>
                          <TableCell className="max-w-xs text-sm text-muted-foreground">
                            {record.notes || "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
            <DataTablePagination
              page={page}
              limit={PAGE_SIZE}
              total={total}
              onPageChange={setPage}
            />
          </>
        ) : (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CalendarDays />
              </EmptyMedia>
              <EmptyTitle>No attendance records</EmptyTitle>
              <EmptyDescription>
                No attendance has been recorded for this date range. Your head of
                department will mark your attendance.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Head/Admin view — mark attendance for department                     */
/* ------------------------------------------------------------------ */

function MarkAttendanceView() {
  const [selectedDate, setSelectedDate] = useState(todayString());
  const today = todayString();

  const {
    data,
    isPending,
    isError,
    error,
    refetch,
    isRefetching,
  } = useDepartmentAttendance({ date: selectedDate });

  const members = data?.members ?? [];
  const existingRecords = data?.attendance ?? [];

  // Build a map of userId → existing record for quick lookup.
  const recordMap = new Map<string, Attendance>();
  for (const record of existingRecords) {
    const userId = typeof record.user === "string" ? record.user : record.user._id;
    recordMap.set(userId, record);
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground">
            Mark Attendance
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Record attendance for your department members.
          </p>
        </div>
        <div className="flex items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="mark-date" className="text-xs">Date</Label>
            <Input
              id="mark-date"
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              max={today}
              className="w-44"
            />
          </div>
        </div>
      </header>

      <div className="mt-8">
        {isPending ? (
          <AttendanceTableSkeleton />
        ) : isError ? (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Couldn&apos;t load department members</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              {getErrorMessage(error)}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refetch()}
                disabled={isRefetching}
              >
                {isRefetching ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : members.length === 0 ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CalendarCheck />
              </EmptyMedia>
              <EmptyTitle>No department members</EmptyTitle>
              <EmptyDescription>
                You don&apos;t have any department members to mark attendance for.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <MarkAttendanceTable
            members={members}
            recordMap={recordMap}
            date={selectedDate}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Mark attendance table (editable)                                     */
/* ------------------------------------------------------------------ */

interface Member {
  _id: string;
  name: string;
  email: string;
}

function MarkAttendanceTable({
  members,
  recordMap,
  date,
}: {
  members: Member[];
  recordMap: Map<string, Attendance>;
  date: string;
}) {
  const markAttendance = useMarkAttendance();

  // Local state for each member's attendance fields.
  const [rows, setRows] = useState<
    Array<{
      userId: string;
      name: string;
      email: string;
      status: AttendanceStatus;
      checkIn: string;
      checkOut: string;
      notes: string;
      existingId?: string;
    }>
  >([]);

  // Initialize rows when members/recordMap change.
  useEffect(() => {
    setRows(
      members.map((member) => {
        const existing = recordMap.get(member._id);
        return {
          userId: member._id,
          name: member.name,
          email: member.email,
          status: existing?.status ?? "present",
          checkIn: existing?.checkIn
            ? new Date(existing.checkIn).toISOString().slice(0, 16)
            : "",
          checkOut: existing?.checkOut
            ? new Date(existing.checkOut).toISOString().slice(0, 16)
            : "",
          notes: existing?.notes ?? "",
          existingId: existing?._id,
        };
      })
    );
  }, [members, recordMap]);

  function updateRow(userId: string, field: string, value: string) {
    setRows((prev) =>
      prev.map((row) =>
        row.userId === userId ? { ...row, [field]: value } : row
      )
    );
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    markAttendance.mutate({
      date,
      records: rows.map((row) => ({
        userId: row.userId,
        status: row.status,
        ...(row.checkIn ? { checkIn: new Date(row.checkIn).toISOString() } : {}),
        ...(row.checkOut ? { checkOut: new Date(row.checkOut).toISOString() } : {}),
        ...(row.notes ? { notes: row.notes } : {}),
      })),
    });
  }

  return (
    <form onSubmit={handleSubmit}>
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Check In</TableHead>
                  <TableHead>Check Out</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.userId}>
                    <TableCell>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{row.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {row.email}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={row.status}
                        onValueChange={(value) =>
                          value && updateRow(row.userId, "status", value)
                        }
                      >
                        <SelectTrigger className="w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ATTENDANCE_STATUSES.map((status) => (
                            <SelectItem key={status} value={status}>
                              {ATTENDANCE_STATUS_LABELS[status]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Input
                        type="datetime-local"
                        value={row.checkIn}
                        onChange={(e) =>
                          updateRow(row.userId, "checkIn", e.target.value)
                        }
                        className="w-44"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="datetime-local"
                        value={row.checkOut}
                        onChange={(e) =>
                          updateRow(row.userId, "checkOut", e.target.value)
                        }
                        className="w-44"
                      />
                    </TableCell>
                    <TableCell>
                      <Textarea
                        value={row.notes}
                        onChange={(e) =>
                          updateRow(row.userId, "notes", e.target.value)
                        }
                        placeholder="Optional notes"
                        rows={1}
                        className="min-w-32 resize-none"
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <div className="mt-4 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {rows.length} member{rows.length === 1 ? "" : "s"} &middot;{" "}
          {formatAttendanceDate(date)}
        </p>
        <Button type="submit" disabled={markAttendance.isPending}>
          {markAttendance.isPending ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <Save />
          )}
          {markAttendance.isPending ? "Saving…" : "Save Attendance"}
        </Button>
      </div>

      {markAttendance.isError && (
        <Alert variant="destructive" className="mt-4">
          <AlertCircle className="size-4" />
          <AlertTitle>Couldn&apos;t save attendance</AlertTitle>
          <AlertDescription>{getErrorMessage(markAttendance.error)}</AlertDescription>
        </Alert>
      )}

      {markAttendance.isSuccess && (
        <Alert className="mt-4 border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          <CalendarCheck className="size-4" />
          <AlertTitle>Attendance saved</AlertTitle>
          <AlertDescription>
            Successfully recorded attendance for {markAttendance.data.count} member
            {markAttendance.data.count === 1 ? "" : "s"}.
          </AlertDescription>
        </Alert>
      )}
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Skeleton                                                            */
/* ------------------------------------------------------------------ */

function AttendanceTableSkeleton() {
  return (
    <Card aria-busy="true" aria-label="Loading attendance">
      <CardContent className="space-y-4 p-4">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="flex items-center gap-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-24" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
