import { useState } from "react";
import { Link } from "react-router";
import { LuCircleCheck, LuCircleX, LuEye, LuLoaderCircle } from "react-icons/lu";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useDecideChange } from "@/hooks/use-project-approval";
import { formatDateTime } from "@/lib/format";
import type { ChangeRequestItem } from "@/types";

export const KIND_LABEL: Record<ChangeRequestItem["kind"], string> = {
  project_change: "Scope / team",
  brand_edit: "Brand",
  manpower_plan: "Manpower plan",
};

/** Before → after table of a request's changes. */
export function ChangeTable({ lines }: { lines: ChangeRequestItem["changes"] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="py-1 pr-3 font-medium">Change</th>
            <th className="py-1 pr-3 font-medium">Before</th>
            <th className="py-1 font-medium">After</th>
          </tr>
        </thead>
        <tbody className="divide-y align-top">
          {lines.map((line, index) => (
            <tr key={index}>
              <td className="py-1.5 pr-3 font-medium text-foreground">{line.label}</td>
              <td className="py-1.5 pr-3 break-words text-muted-foreground line-through decoration-muted-foreground/40">{line.before}</td>
              <td className="py-1.5 break-words text-foreground">{line.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One request: what changed (before → after), with Approve / Reject. */
function ChangeCard({ item }: { item: ChangeRequestItem }) {
  const decide = useDecideChange();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [showAll, setShowAll] = useState(false);
  const link = `/approvals/${item._id}`;
  const lines = showAll ? item.changes : item.changes.slice(0, 12);

  return (
    <li className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{KIND_LABEL[item.kind]}</Badge>
            <Link to={link} className="font-medium break-words text-foreground hover:underline">
              {item.title}
            </Link>
          </div>
          <p className="text-xs text-muted-foreground">
            {item.brand?.name ? `${item.brand.name} · ` : ""}
            {item.requestedBy?.name ?? "Someone"} · {formatDateTime(item.createdAt)} · {item.changes.length} change
            {item.changes.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" render={<Link to={link} />}>
            <LuEye aria-hidden />
            Review
          </Button>
          <Button size="sm" onClick={() => decide.mutate({ id: item._id, decision: "approve" })} disabled={decide.isPending}>
            {decide.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuCircleCheck aria-hidden />}
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setRejecting(true);
              setReason("");
            }}
            disabled={decide.isPending}
          >
            <LuCircleX aria-hidden />
            Reject
          </Button>
        </div>
      </div>
      <ChangeTable lines={lines} />
      {item.changes.length > 12 && (
        <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show fewer" : `Show all ${item.changes.length} changes`}
        </Button>
      )}
      {rejecting && (
        <div className="space-y-2">
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder="Reason (sent to the person who made the change)"
            aria-label="Reason for rejecting"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={decide.isPending}
              onClick={() =>
                decide.mutate(
                  { id: item._id, decision: "reject", reason: reason.trim() || undefined },
                  { onSuccess: () => setRejecting(false) },
                )
              }
            >
              Reject change
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

/** Approvals page: scope / team, brand and manpower plan changes waiting for leadership. */
export function ChangeApprovals({ pending, recent }: { pending: ChangeRequestItem[]; recent: ChangeRequestItem[] }) {
  return (
    <>
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-foreground">Changes waiting for you ({pending.length})</h2>
        {pending.length === 0 ? (
          <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            No scope, team, brand or manpower plan changes to approve.
          </p>
        ) : (
          <ul className="space-y-3">
            {pending.map((item) => (
              <ChangeCard key={item._id} item={item} />
            ))}
          </ul>
        )}
      </section>
      {recent.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-foreground">Changes decided in the last 30 days</h2>
          <ul className="divide-y rounded-xl border bg-card text-sm">
            {recent.map((item) => (
              <li key={item._id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <Badge variant="outline">{KIND_LABEL[item.kind]}</Badge>
                <span className="font-medium">{item.title}</span>
                {item.status === "approved" ? <Badge variant="secondary">Approved</Badge> : <Badge variant="destructive">Rejected</Badge>}
                <span className="text-xs text-muted-foreground">
                  {item.decidedBy?.name ?? ""} · {formatDateTime(item.decidedAt)}
                  {item.reason ? ` · ${item.reason}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
