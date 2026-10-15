import { useEffect, useState, type FormEvent } from "react";
import {
  AlertCircle,
  CalendarDays,
  CalendarPlus,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";

import { DataTablePagination } from "@/components/globals/data-table-pagination";
import { DataTableSearch } from "@/components/globals/data-table-search";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { useCancelLeave, useCreateLeave, useMyLeaveBalance, useMyLeaves } from "@/hooks/use-leaves";
import { usePagination } from "@/hooks/use-pagination";
import { getErrorMessage } from "@/lib/api";
import {
  countLeaveDays,
  formatLeaveDate,
  leaveDecidedByName,
  leaveHasStarted,
  LEAVE_STATUS_META,
  LEAVE_TYPE_LABELS,
} from "@/lib/leave";
import type { Leave, LeaveType } from "@/types";


const LEAVE_TYPES: LeaveType[] = ["annual", "sick", "personal", "unpaid"];

const PAGE_SIZE = 10;


const STARTED_HINT = "Already started — ask your manager or HR to cancel it";

/**
 * Employee leave management: view balance, apply for leave, and cancel
 * pending requests or approved ones that haven't started (cancelling an
 * approved request refunds the days).
 */
export function MyLeaveRequests({ embedded = false }: { embedded?: boolean }) {
  const { data: currentUser } = useCurrentUser();
  // A head's own requests are decided by an admin, never by themselves.
  const isHead = currentUser?.role === "head";
  const isAdmin = currentUser?.role === "admin";
  const [search, setSearch] = useState("");
  const { page, setPage, offset, total, setTotal } = usePagination({
    limit: PAGE_SIZE,
    resetKey: search,
  });
  const {
    data,
    isPending,
    isError,
    error,
    refetch,
    isRefetching,
  } = useMyLeaves({ search: search || undefined, limit: PAGE_SIZE, offset });
  const leaves = data?.leaves;
  const { data: balance } = useMyLeaveBalance();
  const [applyOpen, setApplyOpen] = useState(false);
  const [cancelling, setCancelling] = useState<Leave | null>(null);

  useEffect(() => {
    setTotal(data?.total ?? 0);
  }, [data?.total, setTotal]);

  return (
    <div className={embedded ? undefined : "mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-8"}>
      <header className={embedded ? "flex flex-wrap items-end justify-end gap-4" : "flex flex-wrap items-end justify-between gap-4"}>
        {!embedded && (
          <div>
          <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground">
            My Leave Requests
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Apply for time off, track approvals, and manage your requests.
          </p>
          </div>
        )}
        <Button onClick={() => setApplyOpen(true)}>
          <CalendarPlus />
          Apply for leave
        </Button>
      </header>

      <div className={embedded ? "mt-4 space-y-6" : "mt-8 space-y-6"}>
        <BalanceCards balance={balance} />

        <div className="space-y-4">
          {(total > 0 || search !== "") && (
            <DataTableSearch
              value={search}
              onValueChange={setSearch}
              placeholder="Search by type, status, or reason…"
            />
          )}
          {isPending ? (
            <LeaveListSkeleton />
          ) : isError ? (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>Couldn&apos;t load your leave requests</AlertTitle>
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
                          <TableHead>Type</TableHead>
                          <TableHead>Dates</TableHead>
                          <TableHead className="text-right">Days</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Reason</TableHead>
                          <TableHead>Applied</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {leaves?.map((leave) => {
                          // Once an approved leave has started, only an admin / the approver cancels it.
                          const locked = leaveHasStarted(leave) && !isAdmin;
                          const cancellable =
                            (leave.status === "pending" || leave.status === "approved") && !locked;
                          return (
                            <TableRow key={leave._id}>
                              <TableCell className="whitespace-nowrap text-sm font-medium">
                                {LEAVE_TYPE_LABELS[leave.leaveType]}
                              </TableCell>
                              <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                                {formatLeaveDate(leave.startDate)} – {formatLeaveDate(leave.endDate)}
                              </TableCell>
                              <TableCell className="text-right text-sm text-muted-foreground">
                                {leave.days}
                              </TableCell>
                              <TableCell>
                                <Badge variant={LEAVE_STATUS_META[leave.status].variant}>
                                  {LEAVE_STATUS_META[leave.status].label}
                                </Badge>
                                {leave.status === "pending" && isHead ? (
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    Awaiting admin approval
                                  </p>
                                ) : leaveDecidedByName(leave) ? (
                                  <p className="mt-1 truncate text-xs text-muted-foreground">
                                    by {leaveDecidedByName(leave)}
                                  </p>
                                ) : null}
                              </TableCell>
                              <TableCell className="max-w-xs">
                                <p className="truncate text-sm text-muted-foreground">
                                  {leave.reason}
                                </p>
                              </TableCell>
                              <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                                {formatLeaveDate(leave.createdAt)}
                              </TableCell>
                              <TableCell>
                                <div className="flex flex-col items-end">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setCancelling(leave)}
                                    disabled={!cancellable}
                                    aria-label={
                                      cancellable
                                        ? `Cancel ${LEAVE_TYPE_LABELS[leave.leaveType]} request`
                                        : locked
                                          ? STARTED_HINT
                                          : "This request can no longer be cancelled"
                                    }
                                  >
                                    <X />
                                    Cancel
                                  </Button>
                                  {locked && (
                                    <p className="mt-1 max-w-44 whitespace-normal text-right text-xs text-muted-foreground">
                                      {STARTED_HINT}
                                    </p>
                                  )}
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
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
          ) : search !== "" ? (
            <Empty className="py-12">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <CalendarDays />
                </EmptyMedia>
                <EmptyTitle>No matching requests</EmptyTitle>
                <EmptyDescription>
                  No requests match &ldquo;{search}&rdquo;. Try a different type, status, or
                  reason.
                </EmptyDescription>
              </EmptyHeader>
              <Button variant="outline" onClick={() => setSearch("")}>
                Clear search
              </Button>
            </Empty>
          ) : (
            <Empty className="py-12">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <CalendarDays />
                </EmptyMedia>
                <EmptyTitle>No leave requests yet</EmptyTitle>
                <EmptyDescription>
                  Apply for your first leave to get started.
                </EmptyDescription>
              </EmptyHeader>
              <Button onClick={() => setApplyOpen(true)}>
                <CalendarPlus />
                Apply for leave
              </Button>
            </Empty>
          )}
        </div>
      </div>

      <ApplyLeaveDialog
        open={applyOpen}
        onOpenChange={(open) => {
          if (!open) setApplyOpen(false);
        }}
      />
      <CancelLeaveDialog
        leave={cancelling}
        onOpenChange={(open) => {
          if (!open) setCancelling(null);
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Balance cards                                                       */
/* ------------------------------------------------------------------ */

const BALANCE_CARDS: { type: LeaveType; hint: string }[] = [
  { type: "annual", hint: "Paid time off for vacations and personal plans." },
  { type: "sick", hint: "Paid time off for illness and recovery." },
  { type: "personal", hint: "Paid time off for personal matters." },
  { type: "unpaid", hint: "Time off without pay — not balance-tracked." },
];

function BalanceCards({ balance }: { balance: ReturnType<typeof useMyLeaveBalance>["data"] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {BALANCE_CARDS.map(({ type, hint }) => {
        const remaining = type === "unpaid" ? null : balance?.[type];
        return (
          <Card key={type}>
            <CardContent className="p-4">
              <p className="text-sm font-medium text-muted-foreground capitalize">{type}</p>
              <p className="mt-1 font-heading text-2xl font-semibold tracking-tight text-foreground">
                {remaining === null ? "—" : `${remaining} days`}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function LeaveListSkeleton() {
  return (
    <Card aria-busy="true" aria-label="Loading leave requests">
      <CardContent className="space-y-4 p-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="flex items-center gap-3">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-8" />
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-4 w-32" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Apply for leave dialog                                              */
/* ------------------------------------------------------------------ */

function ApplyLeaveDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateLeave();

  const [leaveType, setLeaveType] = useState<LeaveType>("annual");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [reason, setReason] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (open) {
      setLeaveType("annual");
      setStartDate("");
      setEndDate("");
      setReason("");
      setSubmitted(false);
    }
  }, [open]);

  const days = countLeaveDays(startDate, endDate);
  const today = new Date().toISOString().slice(0, 10);

  const reasonInvalid = submitted && reason.trim() === "";
  const datesInvalid = submitted && (startDate === "" || endDate === "" || days === null);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!reason.trim() || !startDate || !endDate || days === null) return;

    create.mutate(
      { leaveType, startDate, endDate, reason: reason.trim() },
      { onSuccess: () => onOpenChange(false) }
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Apply for leave</DialogTitle>
          <DialogDescription>
            Pick a leave type and the dates you&apos;ll be away.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="leave-type">Leave type</Label>
            <Select value={leaveType} onValueChange={(value) => setLeaveType(value as LeaveType)}>
              <SelectTrigger id="leave-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LEAVE_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {LEAVE_TYPE_LABELS[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="leave-start">Start date</Label>
              <Input
                id="leave-start"
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
                min={today}
                aria-invalid={datesInvalid}
                aria-describedby={datesInvalid ? "leave-dates-error" : undefined}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="leave-end">End date</Label>
              <Input
                id="leave-end"
                type="date"
                value={endDate}
                onChange={(event) => setEndDate(event.target.value)}
                min={startDate || today}
                aria-invalid={datesInvalid}
                aria-describedby={datesInvalid ? "leave-dates-error" : undefined}
              />
            </div>
          </div>
          {datesInvalid && (
            <p id="leave-dates-error" className="text-xs text-destructive">
              {endDate && days === null
                ? "End date must be on or after the start date."
                : "Pick a start and end date."}
            </p>
          )}
          {days !== null && days > 0 && (
            <p className="text-xs text-muted-foreground">
              Duration: <span className="font-medium text-foreground">{days} day{days === 1 ? "" : "s"}</span>
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="leave-reason">Reason</Label>
            <Textarea
              id="leave-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why are you taking this leave?"
              rows={3}
              aria-invalid={reasonInvalid}
              aria-describedby={reasonInvalid ? "leave-reason-error" : undefined}
            />
            {reasonInvalid && (
              <p id="leave-reason-error" className="text-xs text-destructive">
                A reason is required.
              </p>
            )}
          </div>

          {create.isError && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>Couldn&apos;t submit request</AlertTitle>
              <AlertDescription>{getErrorMessage(create.error)}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? <LoaderCircle className="animate-spin" /> : <CalendarPlus />}
              {create.isPending ? "Submitting…" : "Submit request"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Cancel dialog                                                       */
/* ------------------------------------------------------------------ */

function CancelLeaveDialog({
  leave,
  onOpenChange,
}: {
  leave: Leave | null;
  onOpenChange: (open: boolean) => void;
}) {
  const cancel = useCancelLeave();
  const open = leave !== null;
  const refunds = leave?.status === "approved";

  function handleCancel() {
    if (!leave) return;
    cancel.mutate(leave._id, { onSuccess: () => onOpenChange(false) });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel leave request?</DialogTitle>
          <DialogDescription>
            {leave && (
              <>
                Your {LEAVE_TYPE_LABELS[leave.leaveType].toLowerCase()} request for{" "}
                {formatLeaveDate(leave.startDate)} – {formatLeaveDate(leave.endDate)} (
                {leave.days} day{leave.days === 1 ? "" : "s"}) will be cancelled.
                {refunds && " The days will be returned to your balance."}
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {cancel.isError && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Couldn&apos;t cancel request</AlertTitle>
            <AlertDescription>{getErrorMessage(cancel.error)}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={cancel.isPending}
          >
            Keep request
          </Button>
          <Button variant="destructive" onClick={handleCancel} disabled={cancel.isPending}>
            {cancel.isPending ? <LoaderCircle className="animate-spin" /> : <X />}
            {cancel.isPending ? "Cancelling…" : "Cancel request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
