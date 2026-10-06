import { useEffect, useState, type FormEvent } from "react";
import {
  AlertCircle,
  CalendarClock,
  Check,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Users,
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
import {
  useAdjustLeaveBalance,
  useDecideLeave,
  useLeaveBalances,
  useLeavePolicies,
  useLeaves,
  useUpdateLeavePolicy,
} from "@/hooks/use-leaves";
import { useCurrentUser } from "@/hooks/use-auth";
import { usePagination } from "@/hooks/use-pagination";
import { getErrorMessage } from "@/lib/api";
import {
  formatLeaveDate,
  leaveDecidedByName,
  LEAVE_STATUS_META,
  LEAVE_TYPE_LABELS,
} from "@/lib/leave";
import type { Leave, LeaveBalance, LeavePolicy, LeaveStatusFilter, LeaveType } from "@/types";


const PAGE_SIZE = 10;

const STATUS_FILTERS: { value: LeaveStatusFilter; label: string }[] = [
  { value: "all", label: "All requests" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "cancelled", label: "Cancelled" },
];


/* ------------------------------------------------------------------ */
/* Requests tab                                                        */
/* ------------------------------------------------------------------ */

/**
 * Team requests. Admins see everyone's; department heads see only the
 * employees of their own department (scoped and enforced by the API).
 */
export function RequestsTab() {
  const { data: currentUser } = useCurrentUser();
  const isHead = currentUser?.role === "head";
  const [status, setStatus] = useState<LeaveStatusFilter>("all");
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
  } = useLeaves({ status, search: search || undefined, limit: PAGE_SIZE, offset });
  const leaves = data?.leaves;
  const [deciding, setDeciding] = useState<Leave | null>(null);

  useEffect(() => {
    setTotal(data?.total ?? 0);
  }, [data?.total, setTotal]);
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");

  return (
    <div className="space-y-4">
      {isHead && (
        <p className="text-sm text-muted-foreground">
          {currentUser?.department
            ? "Requests from employees in your department. Your own requests are approved by an admin."
            : "You aren't assigned to a department yet, so there are no team requests to review."}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <DataTableSearch
          value={search}
          onValueChange={setSearch}
          placeholder="Search by employee name or email…"
          className="flex-1"
        />
        <div className="w-44">
          <Select
            value={status}
            onValueChange={(value) => setStatus(value as LeaveStatusFilter)}
            items={Object.fromEntries(STATUS_FILTERS.map((filter) => [filter.value, filter.label]))}
          >
            <SelectTrigger id="leave-status-filter" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((filter) => (
                <SelectItem key={filter.value} value={filter.value}>
                  {filter.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isPending ? (
        <RequestListSkeleton />
      ) : isError ? (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Couldn&apos;t load leave requests</AlertTitle>
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
                      <TableHead>Employee</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Dates</TableHead>
                      <TableHead className="text-right">Days</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {leaves?.map((leave) => (
                      <TableRow key={leave._id}>
                        <TableCell>
                          <p className="truncate text-sm font-medium">{leave.user.name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {leave.user.email}
                          </p>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
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
                          {leaveDecidedByName(leave) && (
                            <p className="mt-1 truncate text-xs text-muted-foreground">
                              by {leaveDecidedByName(leave)}
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="max-w-xs">
                          <p className="truncate text-sm text-muted-foreground">{leave.reason}</p>
                          {leave.decisionNote && (
                            <p className="truncate text-xs text-muted-foreground">
                              Note: {leave.decisionNote}
                            </p>
                          )}
                        </TableCell>
                        <TableCell>
                          {leave.status === "pending" ? (
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setDecision("approved");
                                  setDeciding(leave);
                                }}
                                aria-label={`Approve ${leave.user.name}'s request`}
                              >
                                <Check />
                                Approve
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setDecision("rejected");
                                  setDeciding(leave);
                                }}
                                aria-label={`Reject ${leave.user.name}'s request`}
                              >
                                <X />
                                Reject
                              </Button>
                            </div>
                          ) : (
                            <div className="flex justify-end" />
                          )}
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
      ) : search !== "" ? (
        <Empty className="py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CalendarClock />
            </EmptyMedia>
            <EmptyTitle>No matching requests</EmptyTitle>
            <EmptyDescription>
              No requests match &ldquo;{search}&rdquo;. Try a different employee name or email.
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
              <CalendarClock />
            </EmptyMedia>
            <EmptyTitle>No {status === "all" ? "" : `${status} `}requests</EmptyTitle>
            <EmptyDescription>
              {status !== "all"
                ? "No requests match this status."
                : isHead
                  ? "Leave requests from employees in your department will show up here."
                  : "Employees' leave requests will show up here."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      <DecideLeaveDialog
        leave={deciding}
        decision={decision}
        onOpenChange={(open) => {
          if (!open) setDeciding(null);
        }}
      />
    </div>
  );
}

function RequestListSkeleton() {
  return (
    <Card aria-busy="true" aria-label="Loading leave requests">
      <CardContent className="space-y-4 p-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="flex items-center gap-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-8" />
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-4 w-28" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function DecideLeaveDialog({
  leave,
  decision,
  onOpenChange,
}: {
  leave: Leave | null;
  decision: "approved" | "rejected";
  onOpenChange: (open: boolean) => void;
}) {
  const decide = useDecideLeave();
  const open = leave !== null;
  const isApproval = decision === "approved";
  const [note, setNote] = useState("");

  useEffect(() => {
    if (open) setNote("");
  }, [open]);

  function handleDecide() {
    if (!leave) return;
    decide.mutate(
      { id: leave._id, decision, note: note.trim() || undefined },
      { onSuccess: () => onOpenChange(false) }
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isApproval ? "Approve request?" : "Reject request?"}</DialogTitle>
          <DialogDescription>
            {leave && (
              <>
                {leave.user.name} ({leave.user.email}) requested{" "}
                {LEAVE_TYPE_LABELS[leave.leaveType].toLowerCase()} for{" "}
                {formatLeaveDate(leave.startDate)} – {formatLeaveDate(leave.endDate)} (
                {leave.days} day{leave.days === 1 ? "" : "s"}).
                {isApproval && " Approved days are deducted from their balance."}
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="decide-note">
            Note <span className="text-muted-foreground">(optional)</span>
          </Label>
          <Textarea
            id="decide-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={isApproval ? "Approved — enjoy the time off." : "Explain why this was rejected."}
            rows={3}
          />
        </div>

        {decide.isError && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Couldn&apos;t {isApproval ? "approve" : "reject"} request</AlertTitle>
            <AlertDescription>{getErrorMessage(decide.error)}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={decide.isPending}
          >
            Back
          </Button>
          <Button
            variant={isApproval ? "default" : "destructive"}
            onClick={handleDecide}
            disabled={decide.isPending}
          >
            {decide.isPending ? <LoaderCircle className="animate-spin" /> : isApproval ? <Check /> : <X />}
            {decide.isPending
              ? isApproval
                ? "Approving…"
                : "Rejecting…"
              : isApproval
                ? "Approve request"
                : "Reject request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Balances tab                                                        */
/* ------------------------------------------------------------------ */

interface BalanceRow {
  user: { _id: string; name: string; email: string };
  balance: LeaveBalance;
}

export function BalancesTab() {
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
  } = useLeaveBalances({ search: search || undefined, limit: PAGE_SIZE, offset });
  const balances = data?.balances;
  const [adjusting, setAdjusting] = useState<BalanceRow | null>(null);

  useEffect(() => {
    setTotal(data?.total ?? 0);
  }, [data?.total, setTotal]);

  return (
    <div className="space-y-4">
      {(total > 0 || search !== "") && (
        <DataTableSearch
          value={search}
          onValueChange={setSearch}
          placeholder="Search by employee name or email…"
        />
      )}
      {isPending ? (
        <Card aria-busy="true" aria-label="Loading balances">
          <CardContent className="space-y-4 p-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="flex items-center gap-3">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-12" />
              </div>
            ))}
          </CardContent>
        </Card>
      ) : isError ? (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Couldn&apos;t load balances</AlertTitle>
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
                      <TableHead>Employee</TableHead>
                      <TableHead className="text-right">Annual</TableHead>
                      <TableHead className="text-right">Sick</TableHead>
                      <TableHead className="text-right">Personal</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {balances?.map((row) => (
                      <TableRow key={row.user._id}>
                        <TableCell>
                          <p className="truncate text-sm font-medium">{row.user.name}</p>
                          <p className="truncate text-xs text-muted-foreground">{row.user.email}</p>
                        </TableCell>
                        <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                          {row.balance.annual}
                        </TableCell>
                        <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                          {row.balance.sick}
                        </TableCell>
                        <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                          {row.balance.personal}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setAdjusting(row)}
                              aria-label={`Adjust ${row.user.name}'s balance`}
                            >
                              <Pencil />
                              Adjust
                            </Button>
                          </div>
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
      ) : search !== "" ? (
        <Empty className="py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Users />
            </EmptyMedia>
            <EmptyTitle>No matching employees</EmptyTitle>
            <EmptyDescription>
              No employees match &ldquo;{search}&rdquo;. Try a different name or email.
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
              <Users />
            </EmptyMedia>
            <EmptyTitle>No employees yet</EmptyTitle>
            <EmptyDescription>
              Balances appear once user accounts exist.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      <AdjustBalanceDialog
        row={adjusting}
        onOpenChange={(open) => {
          if (!open) setAdjusting(null);
        }}
      />
    </div>
  );
}

const ADJUST_TYPES: { value: "annual" | "sick" | "personal"; label: string }[] = [
  { value: "annual", label: "Annual" },
  { value: "sick", label: "Sick" },
  { value: "personal", label: "Personal" },
];

function AdjustBalanceDialog({
  row,
  onOpenChange,
}: {
  row: BalanceRow | null;
  onOpenChange: (open: boolean) => void;
}) {
  const adjust = useAdjustLeaveBalance();
  const open = row !== null;

  const [leaveType, setLeaveType] = useState<"annual" | "sick" | "personal">("annual");
  const [days, setDays] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (open && row) {
      setLeaveType("annual");
      setDays(String(row.balance.annual));
      setSubmitted(false);
    }
  }, [open, row]);

  const daysValue = Number(days);
  const daysInvalid =
    submitted && (!Number.isInteger(daysValue) || daysValue < 0);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!row || !Number.isInteger(daysValue) || daysValue < 0) return;

    adjust.mutate(
      { userId: row.user._id, leaveType, days: daysValue },
      { onSuccess: () => onOpenChange(false) }
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adjust balance</DialogTitle>
          <DialogDescription>
            {row && (
              <>
                Set {row.user.name}&apos;s remaining days for {row.balance.year}. Approved
                leave continues to deduct from these values.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="adjust-type">Leave type</Label>
              <Select
                value={leaveType}
                onValueChange={(value) =>
                  setLeaveType(value as "annual" | "sick" | "personal")
                }
              >
                <SelectTrigger id="adjust-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ADJUST_TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>
                      {type.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="adjust-days">Days remaining</Label>
              <Input
                id="adjust-days"
                type="number"
                min={0}
                step={1}
                value={days}
                onChange={(event) => setDays(event.target.value)}
                aria-invalid={daysInvalid}
                aria-describedby={daysInvalid ? "adjust-days-error" : undefined}
              />
              {daysInvalid && (
                <p id="adjust-days-error" className="text-xs text-destructive">
                  Enter a whole number of days (0 or more).
                </p>
              )}
            </div>
          </div>

          {adjust.isError && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>Couldn&apos;t update balance</AlertTitle>
              <AlertDescription>{getErrorMessage(adjust.error)}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={adjust.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={adjust.isPending}>
              {adjust.isPending ? <LoaderCircle className="animate-spin" /> : <Pencil />}
              {adjust.isPending ? "Saving…" : "Save balance"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Policies tab                                                        */
/* ------------------------------------------------------------------ */

export function PoliciesTab() {
  const {
    data: policies,
    isPending,
    isError,
    error,
    refetch,
    isRefetching,
  } = useLeavePolicies();
  const [editing, setEditing] = useState<LeavePolicy | null>(null);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Per-type limits. The yearly limit is also each employee&apos;s annual entitlement;
        unpaid leave isn&apos;t balance-tracked.
      </p>

      {isPending ? (
        <Card aria-busy="true" aria-label="Loading policies">
          <CardContent className="space-y-4 p-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="flex items-center gap-3">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-12" />
              </div>
            ))}
          </CardContent>
        </Card>
      ) : isError ? (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Couldn&apos;t load leave policies</AlertTitle>
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
      ) : policies && policies.length > 0 ? (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Leave type</TableHead>
                  <TableHead className="text-right">Max per request</TableHead>
                  <TableHead className="text-right">Max per year</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {policies.map((policy) => (
                  <TableRow key={policy.leaveType}>
                    <TableCell className="text-sm font-medium">
                      {LEAVE_TYPE_LABELS[policy.leaveType]}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                      {policy.maxDaysPerRequest} days
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                      {policy.maxDaysPerYear} days
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditing(policy)}
                          aria-label={`Edit ${policy.leaveType} policy`}
                        >
                          <Pencil />
                          Edit
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : (
        <Empty className="py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CalendarClock />
            </EmptyMedia>
            <EmptyTitle>No policies configured</EmptyTitle>
            <EmptyDescription>
              Default policies will appear here automatically.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      <EditPolicyDialog
        policy={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      />
    </div>
  );
}

function EditPolicyDialog({
  policy,
  onOpenChange,
}: {
  policy: LeavePolicy | null;
  onOpenChange: (open: boolean) => void;
}) {
  const update = useUpdateLeavePolicy();
  const open = policy !== null;

  const [maxPerRequest, setMaxPerRequest] = useState("");
  const [maxPerYear, setMaxPerYear] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (open && policy) {
      setMaxPerRequest(String(policy.maxDaysPerRequest));
      setMaxPerYear(String(policy.maxDaysPerYear));
      setSubmitted(false);
    }
  }, [open, policy]);

  const requestValue = Number(maxPerRequest);
  const yearValue = Number(maxPerYear);
  const requestInvalid = submitted && (!Number.isInteger(requestValue) || requestValue < 1);
  const yearInvalid = submitted && (!Number.isInteger(yearValue) || yearValue < 0);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!policy || !Number.isInteger(requestValue) || requestValue < 1) return;
    if (!Number.isInteger(yearValue) || yearValue < 0) return;

    update.mutate(
      {
        leaveType: policy.leaveType as LeaveType,
        input: {
          maxDaysPerRequest: requestValue,
          maxDaysPerYear: yearValue,
        },
      },
      { onSuccess: () => onOpenChange(false) }
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {policy ? LEAVE_TYPE_LABELS[policy.leaveType].toLowerCase() : "leave"} policy</DialogTitle>
          <DialogDescription>
            The yearly limit is each employee&apos;s annual entitlement for this type.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="policy-request">Max per request</Label>
              <Input
                id="policy-request"
                type="number"
                min={1}
                step={1}
                value={maxPerRequest}
                onChange={(event) => setMaxPerRequest(event.target.value)}
                aria-invalid={requestInvalid}
                aria-describedby={requestInvalid ? "policy-request-error" : undefined}
              />
              {requestInvalid && (
                <p id="policy-request-error" className="text-xs text-destructive">
                  Must be a whole number of at least 1.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="policy-year">Max per year</Label>
              <Input
                id="policy-year"
                type="number"
                min={0}
                step={1}
                value={maxPerYear}
                onChange={(event) => setMaxPerYear(event.target.value)}
                aria-invalid={yearInvalid}
                aria-describedby={yearInvalid ? "policy-year-error" : undefined}
              />
              {yearInvalid && (
                <p id="policy-year-error" className="text-xs text-destructive">
                  Must be a whole number of 0 or more.
                </p>
              )}
            </div>
          </div>

          {update.isError && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>Couldn&apos;t update policy</AlertTitle>
              <AlertDescription>{getErrorMessage(update.error)}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={update.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? <LoaderCircle className="animate-spin" /> : <Plus />}
              {update.isPending ? "Saving…" : "Save policy"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
