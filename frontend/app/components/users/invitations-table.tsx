import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  LuBan,
  LuBuilding2,
  LuFolderKanban,
  LuLoaderCircle,
  LuMailPlus,
  LuMails,
  LuRefreshCw,
  LuSearchX,
} from "react-icons/lu";

import { formatDate, formatDateTime } from "@/lib/format";
import { DataTablePagination } from "@/components/globals/data-table-pagination";
import { DataTableSearch } from "@/components/globals/data-table-search";
import { EmptyState, QueryError } from "@/components/globals/query-states";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useInvitations, useResendInvitation, useRevokeInvitation } from "@/hooks/use-invitations";
import { usePagination } from "@/hooks/use-pagination";
import { cn } from "@/lib/utils";
import type { Invitation, InvitationState, Role } from "@/types";

const PAGE_SIZE = 10;

type StatusFilter = InvitationState | "all";

const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "accepted", label: "Accepted" },
  { value: "expired", label: "Expired" },
  { value: "revoked", label: "Revoked" },
  { value: "all", label: "All" },
];

const STATE_META: Record<
  InvitationState,
  { label: string; variant: "default" | "secondary" | "outline" | "destructive"; className?: string }
> = {
  pending: { label: "Pending", variant: "secondary" },
  accepted: { label: "Accepted", variant: "default" },
  expired: { label: "Expired", variant: "outline", className: "border-chart-4/50 text-foreground" },
  revoked: { label: "Revoked", variant: "destructive" },
};

const ROLE_LABELS: Record<Role, string> = {
  admin: "Admin",
  head: "Head of Dept",
  employee: "Employee",
};

function sentLabel(invitation: Invitation) {
  const ago = formatDistanceToNow(new Date(invitation.lastSentAt), { addSuffix: true });
  return invitation.sendCount > 1 ? `${ago} · sent ${invitation.sendCount}×` : ago;
}

function outcomeLabel(invitation: Invitation) {
  switch (invitation.state) {
    case "pending":
      return `Expires ${formatDistanceToNow(new Date(invitation.expiresAt), { addSuffix: true })}`;
    case "expired":
      return `Expired ${formatDistanceToNow(new Date(invitation.expiresAt), { addSuffix: true })}`;
    case "accepted":
      return invitation.acceptedAt
        ? `Accepted ${formatDate(invitation.acceptedAt)}`
        : "Accepted";
    case "revoked":
      return invitation.revokedAt
        ? `Revoked ${formatDate(invitation.revokedAt)}`
        : "Revoked";
  }
}

function canAct(invitation: Invitation) {
  return invitation.state === "pending" || invitation.state === "expired";
}

/**
 * Admin Invitations tab: status chips with counts, email search, and a table
 * (stacked cards on mobile) with Resend / Revoke row actions.
 */
export function InvitationsTable({ onInvite }: { onInvite: () => void }) {
  const [status, setStatus] = useState<StatusFilter>("pending");
  const [search, setSearch] = useState("");
  const { page, setPage, offset, total, setTotal } = usePagination({
    limit: PAGE_SIZE,
    resetKey: `${status}|${search}`,
  });
  const query = useInvitations({ status, search: search || undefined, limit: PAGE_SIZE, offset });
  const resend = useResendInvitation();
  const [revoking, setRevoking] = useState<Invitation | null>(null);

  useEffect(() => {
    setTotal(query.data?.total ?? 0);
  }, [query.data?.total, setTotal]);

  const counts = query.data?.counts;
  const allCount = counts ? counts.pending + counts.accepted + counts.expired + counts.revoked : undefined;
  const invitations = query.data?.invitations ?? [];
  const resendingId = resend.isPending ? resend.variables : null;

  const actions = (invitation: Invitation) =>
    canAct(invitation) ? (
      <div className="flex justify-end gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => resend.mutate(invitation._id)}
          disabled={resendingId === invitation._id}
          aria-label={`Resend invitation to ${invitation.email}`}
        >
          {resendingId === invitation._id ? (
            <LuLoaderCircle aria-hidden className="animate-spin" />
          ) : (
            <LuRefreshCw aria-hidden />
          )}
          Resend
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => setRevoking(invitation)}
          aria-label={`Revoke invitation to ${invitation.email}`}
        >
          <LuBan aria-hidden />
          Revoke
        </Button>
      </div>
    ) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div role="group" aria-label="Filter invitations by status" className="flex flex-wrap gap-1.5">
          {FILTERS.map((filter) => {
            const count = filter.value === "all" ? allCount : counts?.[filter.value];
            const active = status === filter.value;
            return (
              <button
                key={filter.value}
                type="button"
                onClick={() => setStatus(filter.value)}
                aria-pressed={active}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors duration-150 ease-out focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                {filter.label}
                <span
                  className={cn(
                    "rounded-full px-1.5 text-[0.7rem] tabular-nums",
                    active ? "bg-primary-foreground/20" : "bg-muted"
                  )}
                >
                  {count ?? "–"}
                </span>
              </button>
            );
          })}
        </div>
        <DataTableSearch
          value={search}
          onValueChange={setSearch}
          placeholder="Search by email…"
          className="lg:w-64"
        />
      </div>

      {query.isPending ? (
        <InvitationsSkeleton />
      ) : query.isError ? (
        <QueryError
          title="Couldn't load invitations"
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isRefetching}
        />
      ) : invitations.length === 0 ? (
        search ? (
          <EmptyState
            icon={LuSearchX}
            title="No matching invitations"
            description={<>No invitations match &ldquo;{search}&rdquo;.</>}
          >
            <Button variant="outline" onClick={() => setSearch("")}>
              Clear search
            </Button>
          </EmptyState>
        ) : allCount === 0 ? (
          <EmptyState
            icon={LuMails}
            title="No invitations yet"
            description="Invite people by email. They set their own name and password to join."
          >
            <Button onClick={onInvite}>
              <LuMailPlus aria-hidden />
              Invite people
            </Button>
          </EmptyState>
        ) : (
          <EmptyState
            icon={LuMails}
            title={`No ${status === "all" ? "" : STATE_META[status as InvitationState].label.toLowerCase() + " "}invitations`}
            description="Try another status filter."
          >
            <Button variant="outline" onClick={() => setStatus("all")}>
              Show all
            </Button>
          </EmptyState>
        )
      ) : (
        <>
          {/* Desktop table */}
          <Card className="hidden md:block">
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Email</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Department</TableHead>
                      <TableHead>Projects</TableHead>
                      <TableHead>Invited by</TableHead>
                      <TableHead>Sent</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invitations.map((invitation) => (
                      <TableRow key={invitation._id}>
                        <TableCell className="max-w-56">
                          <p className="truncate font-medium">{invitation.email}</p>
                          {invitation.acceptedUser && (
                            <p className="truncate text-xs text-muted-foreground">
                              Joined as {invitation.acceptedUser.name}
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm">{ROLE_LABELS[invitation.role]}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {invitation.department?.name ?? "—"}
                        </TableCell>
                        <TableCell className="max-w-40">
                          <ProjectList invitation={invitation} />
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {invitation.invitedBy?.name ?? "Deleted user"}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                          <time dateTime={invitation.lastSentAt} title={formatDateTime(invitation.lastSentAt)}>
                            {sentLabel(invitation)}
                          </time>
                        </TableCell>
                        <TableCell>
                          <StatusBadge invitation={invitation} />
                          <p className="mt-1 whitespace-nowrap text-xs text-muted-foreground">
                            {outcomeLabel(invitation)}
                          </p>
                        </TableCell>
                        <TableCell>{actions(invitation)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {/* Mobile cards */}
          <ul className="space-y-3 md:hidden" aria-label="Invitations">
            {invitations.map((invitation) => (
              <li key={invitation._id} className="rounded-xl border bg-card p-4 text-card-foreground">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{invitation.email}</p>
                    <p className="text-xs text-muted-foreground">
                      {ROLE_LABELS[invitation.role]}
                      {invitation.invitedBy ? ` · by ${invitation.invitedBy.name}` : ""}
                    </p>
                  </div>
                  <StatusBadge invitation={invitation} />
                </div>
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
                  <dt className="flex items-center gap-1 text-muted-foreground">
                    <LuBuilding2 aria-hidden className="size-3" /> Department
                  </dt>
                  <dd className="truncate">{invitation.department?.name ?? "—"}</dd>
                  <dt className="flex items-center gap-1 text-muted-foreground">
                    <LuFolderKanban aria-hidden className="size-3" /> Projects
                  </dt>
                  <dd className="min-w-0">
                    <ProjectList invitation={invitation} />
                  </dd>
                  <dt className="text-muted-foreground">Sent</dt>
                  <dd>{sentLabel(invitation)}</dd>
                  <dt className="text-muted-foreground">Status</dt>
                  <dd>{outcomeLabel(invitation)}</dd>
                </dl>
                {canAct(invitation) && <div className="mt-3 border-t pt-2">{actions(invitation)}</div>}
              </li>
            ))}
          </ul>

          <DataTablePagination page={page} limit={PAGE_SIZE} total={total} onPageChange={setPage} />
        </>
      )}

      <RevokeDialog invitation={revoking} onClose={() => setRevoking(null)} />
    </div>
  );
}

function StatusBadge({ invitation }: { invitation: Invitation }) {
  const meta = STATE_META[invitation.state];
  return (
    <Badge variant={meta.variant} className={meta.className}>
      {meta.label}
    </Badge>
  );
}

function ProjectList({ invitation }: { invitation: Invitation }) {
  if (invitation.projects.length === 0) return <span className="text-sm text-muted-foreground">—</span>;
  const names = invitation.projects.map((project) => project.code || project.name);
  const shown = names.slice(0, 2).join(", ");
  const rest = names.length - 2;
  return (
    <span className="block truncate text-sm" title={invitation.projects.map((p) => `${p.code} · ${p.name}`).join("\n")}>
      {shown}
      {rest > 0 && <span className="text-muted-foreground"> +{rest}</span>}
    </span>
  );
}

function RevokeDialog({ invitation, onClose }: { invitation: Invitation | null; onClose: () => void }) {
  const revoke = useRevokeInvitation();
  return (
    <AlertDialog open={invitation !== null} onOpenChange={(open) => !open && !revoke.isPending && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke this invitation?</AlertDialogTitle>
          <AlertDialogDescription>
            The link sent to <span className="font-medium text-foreground">{invitation?.email}</span> stops working
            immediately. You can invite them again later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={revoke.isPending}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={revoke.isPending}
            onClick={() => invitation && revoke.mutate(invitation._id, { onSuccess: onClose })}
          >
            {revoke.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuBan aria-hidden />}
            {revoke.isPending ? "Revoking…" : "Revoke invite"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function InvitationsSkeleton() {
  return (
    <Card aria-busy="true" aria-label="Loading invitations">
      <CardContent className="space-y-4 p-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="flex items-center gap-4">
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-1/4" />
            </div>
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-7 w-24" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
