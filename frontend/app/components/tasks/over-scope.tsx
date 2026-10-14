import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LuCircleCheck, LuCircleX, LuShieldAlert } from "react-icons/lu";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentUser } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { api, getErrorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { Task } from "@/types";

interface OverScopeRow {
  _id: string;
  title: string;
  shortCode?: string | null;
  project?: { _id: string; name: string; code: string } | null;
  assignedBy?: { name: string } | null;
  assignees?: Array<{ name: string }>;
  overScope: NonNullable<Task["overScope"]>;
  createdAt: string;
}

/** Admins: tasks over their project's approved scope. */
export function useOverScopeTasks(enabled: boolean) {
  return useQuery({
    queryKey: ["tasks", "over-scope"],
    queryFn: async () => (await api.get<{ tasks: OverScopeRow[] }>("/tasks/over-scope")).data.tasks,
    enabled,
  });
}

export function useDecideOverScope() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async ({ id, decision, reason }: { id: string; decision: "approve" | "reject"; reason?: string }) =>
      (await api.post(`/tasks/${id}/scope-approval`, { decision, reason })).data,
    onSuccess: (_data, { decision }) => {
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      toast.success(decision === "approve" ? "Extra work approved" : "Extra work not approved");
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });
}

function DecideButtons({ id, size = "sm" }: { id: string; size?: "sm" | "default" }) {
  const decide = useDecideOverScope();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Button size={size} onClick={() => decide.mutate({ id, decision: "approve" })} disabled={decide.isPending}>
          <LuCircleCheck aria-hidden />
          Approve extra
        </Button>
        <Button size={size} variant="outline" onClick={() => setRejecting((v) => !v)} disabled={decide.isPending}>
          <LuCircleX aria-hidden />
          Reject
        </Button>
      </div>
      {rejecting && (
        <div className="space-y-2">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} placeholder="Reason" aria-label="Reason" />
          <Button size="sm" variant="destructive" onClick={() => decide.mutate({ id, decision: "reject", reason: reason.trim() || undefined })}>
            Reject extra work
          </Button>
        </div>
      )}
    </div>
  );
}

/** Task page: over-scope state (admins decide here too). */
export function OverScopeBanner({ task }: { task: Task }) {
  const { data: user } = useCurrentUser();
  const o = task.overScope;
  if (!o) return null;
  const text = `${o.used + o.requested} ${o.unit} against ${o.allowed} approved in the scope (this task: ${o.requested}).`;
  if (o.status === "approved") {
    return (
      <p className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        Approved beyond the scope by an admin. {text}
      </p>
    );
  }
  return (
    <div
      className={
        o.status === "pending"
          ? "space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
          : "space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
      }
    >
      <p className="flex items-start gap-2 text-foreground">
        <LuShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-600" />
        <span>
          <span className="font-medium">
            {o.status === "pending" ? "Over the approved scope — blocked until an admin approves it." : "Not approved beyond the scope."}
          </span>{" "}
          {text}
          {o.reason ? ` Reason: ${o.reason}` : ""}
        </span>
      </p>
      {o.status === "pending" && user?.role === "admin" && <DecideButtons id={task._id} />}
    </div>
  );
}

/** Approvals page (admins): tasks waiting for a scope decision. */
export function OverScopeApprovals() {
  const { data: user } = useCurrentUser();
  const query = useOverScopeTasks(user?.role === "admin");
  if (user?.role !== "admin") return null;
  const rows = query.data ?? [];
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-foreground">Tasks over the approved scope ({rows.length})</h2>
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">No tasks over scope.</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((t) => (
            <li key={t._id} className="flex flex-wrap items-start justify-between gap-3 rounded-xl border bg-card p-4">
              <div className="min-w-0 space-y-1">
                <Link to={`/tasks?task=${t._id}`} className="font-medium break-words text-foreground hover:underline">
                  {t.shortCode ? `${t.shortCode} · ` : ""}
                  {t.title}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {t.project ? `${t.project.name} · ` : ""}
                  {t.assignedBy?.name ?? "Someone"} · {formatDateTime(t.createdAt)}
                </p>
                <p className="text-sm">
                  <span className="font-medium">{t.overScope.unit}:</span> {t.overScope.used} used + {t.overScope.requested} new ={" "}
                  <span className="font-medium text-amber-700 dark:text-amber-400">{t.overScope.used + t.overScope.requested}</span> of{" "}
                  {t.overScope.allowed} approved
                </p>
              </div>
              <DecideButtons id={t._id} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
