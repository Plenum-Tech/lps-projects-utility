import { useEffect, useState } from "react";
import { type VariantProps } from "class-variance-authority";
import { AlertCircle, LoaderCircle, RefreshCw, ScrollText } from "lucide-react";

import { formatDateTime } from "@/lib/format";
import { DataTablePagination } from "@/components/globals/data-table-pagination";
import { DataTableSearch } from "@/components/globals/data-table-search";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useActivityLogs } from "@/hooks/use-activity-logs";
import { usePagination } from "@/hooks/use-pagination";
import { getErrorMessage } from "@/lib/api";
import { DOCUMENT_TYPE_LABELS } from "@/lib/documents";
import type { ActivityAction, ActivityLog, DocumentType } from "@/types";

import type { Route } from "./+types/activity-log";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Activity Log | LPS" }];
}

const PAGE_SIZE = 10;

/** Humanized labels + badge tone per action. */
const ACTION_META: Record<
  ActivityAction,
  {
    label: string;
    badge: NonNullable<VariantProps<typeof badgeVariants>["variant"]>;
  }
> = {
  login: { label: "Signed in", badge: "default" },
  login_failed: { label: "Failed sign-in", badge: "destructive" },
  logout: { label: "Signed out", badge: "secondary" },
  user_created: { label: "Created user", badge: "default" },
  user_updated: { label: "Updated user", badge: "secondary" },
  user_deleted: { label: "Deleted user", badge: "destructive" },
  profile_updated: { label: "Updated profile", badge: "secondary" },
  department_created: { label: "Created department", badge: "secondary" },
  department_updated: { label: "Updated department", badge: "secondary" },
  department_deleted: { label: "Deleted department", badge: "destructive" },
  department_members_updated: {
    label: "Updated department members",
    badge: "secondary",
  },
  leave_created: { label: "Applied for leave", badge: "secondary" },
  leave_cancelled: { label: "Cancelled leave", badge: "secondary" },
  leave_approved: { label: "Approved leave", badge: "default" },
  leave_rejected: { label: "Rejected leave", badge: "destructive" },
  leave_balance_adjusted: {
    label: "Adjusted leave balance",
    badge: "secondary",
  },
  leave_policy_updated: { label: "Updated leave policy", badge: "secondary" },
  announcement_created: { label: "Created announcement", badge: "secondary" },
  announcement_updated: { label: "Updated announcement", badge: "secondary" },
  announcement_deleted: { label: "Deleted announcement", badge: "destructive" },
  feedback_created: { label: "Submitted feedback", badge: "secondary" },
  feedback_responded: { label: "Responded to feedback", badge: "secondary" },
  feedback_resolved: { label: "Resolved feedback", badge: "default" },
  feedback_reopened: { label: "Reopened feedback", badge: "secondary" },
  attendance_marked: { label: "Marked attendance", badge: "secondary" },
  attendance_bulk_marked: { label: "Bulk-marked attendance", badge: "default" },
  review_created: { label: "Created review", badge: "default" },
  review_generated: { label: "Generated review", badge: "secondary" },
  review_acknowledged: { label: "Acknowledged review", badge: "default" },
  review_completed: { label: "Completed review", badge: "default" },
  review_deleted: { label: "Deleted review", badge: "destructive" },
  goal_updated: { label: "Updated goal", badge: "secondary" },
  task_created: { label: "Created task", badge: "default" },
  task_status_updated: { label: "Updated task status", badge: "secondary" },
  task_submitted: { label: "Submitted task", badge: "secondary" },
  task_reviewed: { label: "Reviewed task", badge: "default" },
  task_updated: { label: "Updated task", badge: "secondary" },
  task_deleted: { label: "Deleted task", badge: "destructive" },
  task_settings_updated: { label: "Updated task settings", badge: "secondary" },
  ai_insight_deleted: { label: "Deleted AI insight", badge: "destructive" },
  project_created: { label: "Created project", badge: "default" },
  project_updated: { label: "Updated project", badge: "secondary" },
  project_archived: { label: "Archived project", badge: "secondary" },
  project_deleted: { label: "Deleted project", badge: "destructive" },
  timelog_reviewed: { label: "Reviewed time log", badge: "secondary" },
  timesheet_reviewed: { label: "Reviewed timesheet", badge: "secondary" },
  project_settings_updated: { label: "Updated project settings", badge: "secondary" },
  user_invited: { label: "Invited user", badge: "default" },
  invitation_resent: { label: "Resent invitation", badge: "secondary" },
  invitation_revoked: { label: "Revoked invitation", badge: "destructive" },
  invitation_accepted: { label: "Accepted invitation", badge: "default" },
  document_created: { label: "Added document", badge: "default" },
  document_updated: { label: "Updated document", badge: "secondary" },
  document_deleted: { label: "Deleted document", badge: "destructive" },
  meeting_created: { label: "Added meeting", badge: "default" },
  meeting_deleted: { label: "Deleted meeting", badge: "destructive" },
  meeting_tasks_created: { label: "Created tasks from meeting", badge: "secondary" },
  settings_updated: { label: "Updated company settings", badge: "secondary" },
  import_completed: { label: "Imported records", badge: "default" },
  import_undone: { label: "Undid import", badge: "destructive" },
  password_reset: { label: "Reset password", badge: "secondary" },
  pearity_tag_created: { label: "Created Pearity tag", badge: "default" },
  pearity_key_created: { label: "Created Pearity API key", badge: "default" },
  pearity_key_revoked: { label: "Revoked Pearity API key", badge: "destructive" },
  pearity_settings_updated: { label: "Updated Pearity settings", badge: "secondary" },
  training_created: { label: "Created training", badge: "default" },
  training_updated: { label: "Updated training", badge: "secondary" },
  training_archived: { label: "Archived training", badge: "secondary" },
  training_deleted: { label: "Deleted training", badge: "destructive" },
  training_completed: { label: "Completed training", badge: "default" },
};

function detailsSummary(log: ActivityLog): string | null {
  const details = log.details;
  if (!details || typeof details !== "object") return null;

  switch (log.action) {
    case "user_created":
      return details.role ? `Role: ${String(details.role)}` : null;
    case "user_invited":
    case "invitation_resent":
    case "invitation_revoked":
    case "invitation_accepted": {
      const email = details.email ? String(details.email) : null;
      const role = details.role ? `Role: ${String(details.role)}` : null;
      return [email, role]
        .filter((part): part is string => part !== null)
        .join(" · ");
    }
    case "settings_updated": {
      const changed = details.changed;
      const logo = details.logo ? `Logo ${String(details.logo)}` : null;
      if (logo) return logo;
      return Array.isArray(changed) && changed.length > 0
        ? `Changed: ${changed.join(", ")}`
        : null;
    }
    case "user_updated":
    case "profile_updated": {
      const changed = details.changed;
      return Array.isArray(changed) && changed.length > 0
        ? `Changed: ${changed.join(", ")}`
        : null;
    }
    case "user_deleted": {
      const email = details.email ? String(details.email) : null;
      const role = details.role ? `Role: ${String(details.role)}` : null;
      return [email, role]
        .filter((part): part is string => part !== null)
        .join(" · ");
    }
    case "department_updated": {
      const changed = details.changed;
      return Array.isArray(changed) && changed.length > 0
        ? `Changed: ${changed.join(", ")}`
        : null;
    }
    case "department_members_updated": {
      const added = Number(details.added ?? 0);
      const removed = Number(details.removed ?? 0);
      if (added === 0 && removed === 0) return null;
      return [
        added > 0 ? `+${added} added` : null,
        removed > 0 ? `-${removed} removed` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(", ");
    }
    case "leave_created":
    case "leave_approved":
    case "leave_rejected":
    case "leave_cancelled": {
      const type = details.leaveType ? String(details.leaveType) : null;
      const days = details.days != null ? `${String(details.days)} days` : null;
      const refunded = details.refunded === true ? "balance refunded" : null;
      return [type, days, refunded]
        .filter((part): part is string => part !== null)
        .join(" · ");
    }
    case "leave_balance_adjusted": {
      const type = details.leaveType ? String(details.leaveType) : null;
      const days =
        details.days != null ? `${String(details.days)} days remaining` : null;
      return [type, days]
        .filter((part): part is string => part !== null)
        .join(" · ");
    }
    case "leave_policy_updated": {
      const changed = details.changed;
      return Array.isArray(changed) && changed.length > 0
        ? `Changed: ${changed.join(", ")}`
        : null;
    }
    case "announcement_created": {
      const department = details.department ? String(details.department) : null;
      return department ? `Department: ${department}` : null;
    }
    case "announcement_updated": {
      const changed = details.changed;
      return Array.isArray(changed) && changed.length > 0
        ? `Changed: ${changed.join(", ")}`
        : null;
    }
    case "feedback_created": {
      const category = details.category ? String(details.category) : null;
      const anonymous = details.isAnonymous === true ? "Anonymous" : null;
      return [category, anonymous]
        .filter((part): part is string => part !== null)
        .join(" · ");
    }
    case "feedback_responded":
    case "feedback_resolved":
    case "feedback_reopened": {
      const category = details.category ? String(details.category) : null;
      const previous = details.previous ? `Previously: ${String(details.previous)}` : null;
      return [category, previous]
        .filter((part): part is string => part !== null)
        .join(" · ");
    }
    case "document_created":
    case "document_deleted": {
      const type = details.type ? String(details.type) : null;
      const label = type
        ? DOCUMENT_TYPE_LABELS[type as DocumentType] ?? type
        : null;
      const file = details.hasFile === true ? "with file" : null;
      return [label, file]
        .filter((part): part is string => part !== null)
        .join(" · ");
    }
    case "document_updated": {
      const changed = details.changed;
      return Array.isArray(changed) && changed.length > 0
        ? `Changed: ${changed.join(", ")}`
        : null;
    }
    case "import_completed": {
      const parts = [
        typeof details.created === "number" ? `${details.created} created` : null,
        typeof details.updated === "number" && details.updated > 0 ? `${details.updated} updated` : null,
        typeof details.skipped === "number" && details.skipped > 0 ? `${details.skipped} skipped` : null,
        typeof details.errors === "number" && details.errors > 0 ? `${details.errors} errors` : null,
      ];
      return parts.filter((part): part is string => part !== null).join(" · ") || null;
    }
    case "import_undone": {
      const parts = [
        typeof details.deleted === "number" ? `${details.deleted} deleted` : null,
        typeof details.skipped === "number" && details.skipped > 0 ? `${details.skipped} kept (edited)` : null,
      ];
      return parts.filter((part): part is string => part !== null).join(" · ") || null;
    }
    case "login_failed":
      return "Invalid credentials";
    default:
      return null;
  }
}

function targetLabel(log: ActivityLog): string {
  if (!log.targetName) return "—";
  return log.targetType
    ? `${log.targetType} · ${log.targetName}`
    : log.targetName;
}

/**
 * Admin-only audit trail. The backend gates this endpoint with
 * requireRole("admin"), and the sidebar hides the link for employees.
 */
export default function ActivityLogPage() {
  const [search, setSearch] = useState("");
  const { page, setPage, total, setTotal } = usePagination({
    limit: PAGE_SIZE,
    resetKey: search,
  });
  const { data, isPending, isError, error, refetch, isRefetching } =
    useActivityLogs(page, PAGE_SIZE, search);

  useEffect(() => {
    setTotal(data?.total ?? 0);
  }, [data?.total, setTotal]);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <header>
        <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground">
          Activity Log
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Audit trail of sign-ins and changes across users and departments.
        </p>
      </header>

      <div className="mt-8 space-y-4">
        {isPending ? (
          <ActivityLogSkeleton />
        ) : isError ? (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Couldn&apos;t load the activity log</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              {getErrorMessage(error)}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refetch()}
                disabled={isRefetching}
              >
                {isRefetching ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <RefreshCw />
                )}
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {(total > 0 || search !== "") && (
              <DataTableSearch
                value={search}
                onValueChange={setSearch}
                placeholder="Search by actor, action, or target…"
              />
            )}
            {total > 0 ? (
              <>
                <Card>
                  <CardContent className="p-0">
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Time</TableHead>
                            <TableHead>Actor</TableHead>
                            <TableHead>Action</TableHead>
                            <TableHead>Target</TableHead>
                            <TableHead>Details</TableHead>
                            <TableHead className="text-right">IP</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {data?.logs.map((log) => {
                            const meta = ACTION_META[log.action];
                            const details = detailsSummary(log);
                            return (
                              <TableRow key={log._id}>
                                <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                                  {formatDateTime(log.createdAt)}
                                </TableCell>
                                <TableCell>
                                  <div className="flex items-center gap-2">
                                    <div className="min-w-0">
                                      <p className="truncate text-sm font-medium">
                                        {log.actorName ?? "Unknown user"}
                                      </p>
                                      {log.actorEmail && (
                                        <p className="truncate text-xs text-muted-foreground">
                                          {log.actorEmail}
                                        </p>
                                      )}
                                    </div>
                                    {log.actorRole && (
                                      <Badge
                                        variant={
                                          log.actorRole === "admin"
                                            ? "default"
                                            : log.actorRole === "head"
                                              ? "secondary"
                                              : "outline"
                                        }
                                        className="capitalize"
                                      >
                                        {log.actorRole === "head"
                                          ? "Head of Dept"
                                          : log.actorRole}
                                      </Badge>
                                    )}
                                  </div>
                                </TableCell>
                                <TableCell>
                                  <Badge variant={meta.badge}>{meta.label}</Badge>
                                </TableCell>
                                <TableCell className="text-sm text-muted-foreground">
                                  {targetLabel(log)}
                                </TableCell>
                                <TableCell className="text-sm text-muted-foreground">
                                  {details ?? "—"}
                                </TableCell>
                                <TableCell className="text-right text-sm text-muted-foreground">
                                  {log.ip ?? "—"}
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
                    <ScrollText />
                  </EmptyMedia>
                  <EmptyTitle>No matching activity</EmptyTitle>
                  <EmptyDescription>
                    No activity matches &ldquo;{search}&rdquo;. Try a different actor, action,
                    or target.
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
                    <ScrollText />
                  </EmptyMedia>
                  <EmptyTitle>No activity recorded yet</EmptyTitle>
                  <EmptyDescription>
                    Sign-ins and changes to users and departments will show up here.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ActivityLogSkeleton() {
  return (
    <Card aria-busy="true" aria-label="Loading activity log">
      <CardContent className="space-y-4 p-4">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="flex items-center gap-4">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
