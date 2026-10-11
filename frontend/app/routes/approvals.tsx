import { useState } from "react";
import { Link } from "react-router";
import { LuCircleCheck, LuCircleX, LuClipboardCheck, LuLoaderCircle } from "react-icons/lu";

import { EmptyState, PageHeader, QueryError } from "@/components/globals/query-states";
import { RejectDialog } from "@/components/projects/project-approval";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useApprovalQueue, useDecideProjectApproval } from "@/hooks/use-project-approval";
import { formatDateTime } from "@/lib/format";
import type { ProjectApprovalLinkResponse } from "@/types";

import type { Route } from "./+types/approvals";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Approvals | LPS" }];
}

type Item = ProjectApprovalLinkResponse["project"];

/** Project approvers (Aasim by default): new projects waiting for a decision, and recent decisions. */
export default function ApprovalsRoute() {
  const queue = useApprovalQueue();
  const decide = useDecideProjectApproval();
  const [rejecting, setRejecting] = useState<Item | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  function approve(item: Item) {
    setBusy(item._id);
    decide.mutate({ id: item._id, decision: "approve" }, { onSettled: () => setBusy(null) });
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Approvals"
        description="New projects wait here until you approve them. Nobody can add tasks to a project before that."
      />

      {queue.isPending && <Skeleton className="h-60 w-full rounded-xl" />}
      {queue.isError && <QueryError title="Couldn't load approvals" error={queue.error} onRetry={() => void queue.refetch()} />}
      {queue.data && !queue.data.isApprover && (
        <EmptyState
          icon={LuClipboardCheck}
          title="You're not a project approver"
          description="Admins choose the approvers in Settings → Projects → Project approval."
        />
      )}

      {queue.data?.isApprover && (
        <>
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-foreground">Waiting for you ({queue.data.pending.length})</h2>
            {queue.data.pending.length === 0 ? (
              <EmptyState icon={LuClipboardCheck} title="Nothing to approve" description="New projects will appear here." />
            ) : (
              <ul className="space-y-3">
                {queue.data.pending.map((item) => (
                  <li key={item._id} className="rounded-xl border bg-card p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <Link to={`/projects/${item._id}`} className="font-medium break-words text-foreground hover:underline">
                          {item.name}
                        </Link>
                        <p className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                          <span className="font-mono">{item.code}</span>
                          {item.tag && <span className="font-mono">· {item.tag}</span>}
                          {item.brand && <span>· {item.brand}</span>}
                          {item.type && <span>· {item.type}</span>}
                          {item.month && <span>· {item.month}</span>}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Requested by {item.requestedBy ?? "someone"}
                          {item.approval?.requestedAt ? ` · ${formatDateTime(item.approval.requestedAt)}` : ""}
                          {item.manager ? ` · Manager: ${item.manager}` : ""}
                        </p>
                        {item.team.length > 0 && (
                          <p className="text-xs text-muted-foreground">Team: {item.team.join(", ")}</p>
                        )}
                        {item.summary && <p className="pt-1 text-sm whitespace-pre-line text-muted-foreground">{item.summary}</p>}
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => approve(item)} disabled={decide.isPending}>
                          {busy === item._id ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuCircleCheck aria-hidden />}
                          Approve
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setRejecting(item)} disabled={decide.isPending}>
                          <LuCircleX aria-hidden />
                          Reject
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {queue.data.recent.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-foreground">Decided in the last 30 days</h2>
              <div className="overflow-x-auto rounded-xl border bg-card">
                <table className="w-full text-sm">
                  <thead className="bg-muted text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Project</th>
                      <th className="px-3 py-2 font-medium">Decision</th>
                      <th className="px-3 py-2 font-medium">When</th>
                      <th className="px-3 py-2 font-medium">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {queue.data.recent.map((item) => (
                      <tr key={item._id} className="border-t align-top">
                        <td className="px-3 py-2">
                          <Link to={`/projects/${item._id}`} className="hover:underline">
                            {item.name}
                          </Link>
                        </td>
                        <td className="px-3 py-2">
                          {item.approval?.status === "approved" ? (
                            <Badge variant="secondary">Approved</Badge>
                          ) : (
                            <Badge variant="destructive">Rejected</Badge>
                          )}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{formatDateTime(item.approval?.decidedAt ?? null)}</td>
                        <td className="px-3 py-2 text-muted-foreground">{item.approval?.reason || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      <RejectDialog
        open={rejecting !== null}
        onOpenChange={(open) => !open && setRejecting(null)}
        pending={decide.isPending}
        onConfirm={(reason) =>
          rejecting && decide.mutate({ id: rejecting._id, decision: "reject", reason }, { onSuccess: () => setRejecting(null) })
        }
      />
    </div>
  );
}
