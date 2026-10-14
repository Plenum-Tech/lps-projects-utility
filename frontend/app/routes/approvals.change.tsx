import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { LuArrowLeft, LuCircleCheck, LuCircleX, LuExternalLink, LuLoaderCircle, LuTriangleAlert } from "react-icons/lu";

import { ChangeTable, KIND_LABEL } from "@/components/approvals/change-approvals";
import { PageHeader, QueryError } from "@/components/globals/query-states";
import { planRowsToTable } from "@/components/manpower/manpower-page";
import { PlanTable } from "@/components/manpower/plan-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useManpowerMonths, useManpowerPlan } from "@/hooks/use-manpower";
import { useDecideChange } from "@/hooks/use-project-approval";
import { api } from "@/lib/api";
import { formatDate, formatDateTime } from "@/lib/format";
import { MANPOWER_ROLE_FALLBACK } from "@/lib/manpower";
import { namingMonthLabel } from "@/lib/projects";
import { LABEL_COLOR_META } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { ChangeRequestItem, ScopeItem } from "@/types";

import type { Route } from "./+types/approvals.change";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Review change | LPS" }];
}

type TeamView = Array<{ role: string; label: string; people: string[] }>;

interface ChangeReview {
  change: ChangeRequestItem;
  context: {
    project?: {
      _id: string;
      name: string;
      code: string;
      brand: string | null;
      type: string | null;
      month: string | null;
      manager: string | null;
      status: string | null;
      category: string | null;
      startDate: string | null;
      deadline: string | null;
      members: number;
      archived: boolean;
    };
    scope?: { changed: boolean; current: string; proposed: string };
    scopeRows?: { changed: boolean; current: ScopeItem[]; proposed: ScopeItem[] };
    team?: { changed: boolean; current: TeamView; proposed: TeamView };
    brand?: {
      _id: string;
      projects: number;
      current: { name: string; shortName: string; color: string; active: boolean };
      proposed: { name: string; shortName: string; color: string; active: boolean };
    };
    plan?: {
      month: string;
      version: number;
      status: string;
      liveVersion: number | null;
      lines: number;
      changedKeys: string[];
      removed: string[];
    };
  };
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{value === null || value === undefined || value === "" ? "—" : value}</dd>
    </div>
  );
}

/** Before / after side by side; the changed side is marked. */
function Compare({ before, after, changed, render }: { before: ReactNode; after: ReactNode; changed: boolean; render?: "text" }) {
  const box = "min-h-16 rounded-lg border p-3 text-sm break-words";
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground">Now</p>
        <div className={cn(box, render === "text" && "whitespace-pre-wrap", "bg-muted/30")}>{before}</div>
      </div>
      <div className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground">{changed ? "Proposed" : "Proposed (unchanged)"}</p>
        <div className={cn(box, render === "text" && "whitespace-pre-wrap", changed && "border-amber-500/60 bg-amber-500/10")}>{after}</div>
      </div>
    </div>
  );
}

function TeamCompare({ current, proposed }: { current: TeamView; proposed: TeamView }) {
  const roles = [...new Map([...current, ...proposed].map((e) => [e.role, e.label])).entries()];
  const names = (team: TeamView, role: string) => team.find((e) => e.role === role)?.people ?? [];
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[34rem] text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="py-1.5 pr-3 font-medium">Role</th>
            <th className="py-1.5 pr-3 font-medium">Now</th>
            <th className="py-1.5 font-medium">Proposed</th>
          </tr>
        </thead>
        <tbody className="divide-y align-top">
          {roles.map(([role, label]) => {
            const before = names(current, role);
            const after = names(proposed, role);
            const changed = before.join("|") !== after.join("|");
            return (
              <tr key={role} className={changed ? "bg-amber-500/10" : undefined}>
                <td className="py-2 pr-3 font-medium text-foreground">{label}</td>
                <td className="py-2 pr-3 text-muted-foreground">{before.join(", ") || "—"}</td>
                <td className="py-2 text-foreground">
                  {after.map((n) => (
                    <span key={n} className={cn("mr-1.5 inline-block", !before.includes(n) && "font-medium text-amber-700 dark:text-amber-400")}>
                      {n}
                      {!before.includes(n) ? " (new)" : ""}
                    </span>
                  ))}
                  {after.length === 0 && "—"}
                  {before.filter((n) => !after.includes(n)).map((n) => (
                    <span key={`x-${n}`} className="mr-1.5 inline-block text-destructive line-through">
                      {n}
                    </span>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ScopeRowsView({ rows }: { rows: ScopeItem[] }) {
  if (rows.length === 0) return <span className="text-muted-foreground">No scope rows</span>;
  const total = rows.reduce((n, r) => n + r.quantity * r.languages * r.sizes, 0);
  return (
    <ul className="space-y-0.5">
      {rows.map((r, i) => (
        <li key={i} className="flex justify-between gap-3 tabular-nums">
          <span>{r.unit}</span>
          <span className="text-muted-foreground">
            {r.quantity} × {r.languages} × {r.sizes} = <span className="font-medium text-foreground">{r.quantity * r.languages * r.sizes}</span>
          </span>
        </li>
      ))}
      <li className="flex justify-between border-t pt-1 font-medium">
        <span>Total</span>
        <span>{total}</span>
      </li>
    </ul>
  );
}

function BrandCard({ b }: { b: { name: string; shortName: string; color: string; active: boolean } }) {
  const meta = LABEL_COLOR_META[b.color as keyof typeof LABEL_COLOR_META];
  return (
    <dl className="grid grid-cols-2 gap-3">
      <Fact label="Name" value={b.name} />
      <Fact label="Short name" value={b.shortName} />
      <Fact
        label="Colour"
        value={
          <span className="inline-flex items-center gap-2">
            <span aria-hidden className={cn("size-3 rounded-full", meta?.dot)} />
            {meta?.name ?? b.color}
          </span>
        }
      />
      <Fact label="Status" value={b.active ? "Active" : "Inactive"} />
    </dl>
  );
}

function PlanReview({ plan }: { plan: NonNullable<ChangeReview["context"]["plan"]> }) {
  const months = useManpowerMonths();
  const roles = months.data?.roles ?? MANPOWER_ROLE_FALLBACK;
  const data = useManpowerPlan(plan.month, plan.version);
  const changed = new Set(plan.changedKeys);
  return (
    <Section
      title={`Proposed plan · ${namingMonthLabel(plan.month)} · version ${plan.version}`}
      aside={
        <Link to={`/manpower?month=${plan.month}&v=${plan.version}`} className="inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2">
          Open in Manpower plan <LuExternalLink aria-hidden className="size-3" />
        </Link>
      }
    >
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Fact label="In use now" value={plan.liveVersion ? `Version ${plan.liveVersion}` : "Nothing approved yet"} />
        <Fact label="Lines" value={plan.lines} />
        <Fact label="Lines changed or added" value={changed.size} />
        <Fact label="Lines removed" value={plan.removed.length} />
      </dl>
      {plan.removed.length > 0 && (
        <p className="text-sm text-destructive">Removed: {plan.removed.join(", ")}</p>
      )}
      <p className="text-xs text-muted-foreground">Highlighted lines differ from the version in use.</p>
      {data.isPending ? (
        <Skeleton className="h-60 w-full rounded-xl" />
      ) : data.data ? (
        <PlanTable rows={planRowsToTable(data.data)} roles={roles} changedRows={changed} />
      ) : (
        <p className="text-sm text-muted-foreground">Couldn&apos;t load the plan version.</p>
      )}
    </Section>
  );
}

/** Leadership: everything needed to approve or reject one change. */
export default function ChangeReviewRoute() {
  const { id } = useParams();
  const navigate = useNavigate();
  const decide = useDecideChange();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const query = useQuery({
    queryKey: ["project-approvals", "change", id],
    queryFn: async () => (await api.get<ChangeReview>(`/projects/approvals/changes/${id}`)).data,
    enabled: Boolean(id),
  });

  const review = query.data;
  const change = review?.change;
  const ctx = review?.context ?? {};
  const pending = change?.status === "pending";

  function decideNow(decision: "approve" | "reject") {
    if (!change) return;
    decide.mutate(
      { id: change._id, decision, reason: decision === "reject" ? reason.trim() || undefined : undefined },
      { onSuccess: () => navigate("/approvals") },
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-8 sm:px-6 lg:px-8">
      <Link to="/approvals" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <LuArrowLeft aria-hidden className="size-4" />
        All approvals
      </Link>
      {query.isPending && <Skeleton className="h-80 w-full rounded-xl" />}
      {query.isError && <QueryError title="Couldn't load this change" error={query.error} onRetry={() => void query.refetch()} />}
      {change && (
        <>
          <PageHeader
            title={change.title}
            description={`${KIND_LABEL[change.kind]} · requested by ${change.requestedBy?.name ?? "someone"} on ${formatDateTime(change.createdAt)}`}
          />
          <div className="sticky top-0 z-20 -mx-1 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-background/95 px-4 py-3 backdrop-blur">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="outline">{KIND_LABEL[change.kind]}</Badge>
              {change.brand?.name && <Badge variant="secondary">{change.brand.name}</Badge>}
              {pending ? (
                <span className="text-muted-foreground">Nothing changes until you approve.</span>
              ) : (
                <Badge variant={change.status === "approved" ? "secondary" : "destructive"}>
                  {change.status === "approved" ? "Approved" : change.status === "rejected" ? "Rejected" : "Replaced by a newer change"}
                  {change.decidedBy?.name ? ` · ${change.decidedBy.name}` : ""}
                </Badge>
              )}
            </div>
            {pending && (
              <div className="flex gap-2">
                <Button onClick={() => decideNow("approve")} disabled={decide.isPending}>
                  {decide.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuCircleCheck aria-hidden />}
                  Approve
                </Button>
                <Button variant="outline" onClick={() => setRejecting((v) => !v)} disabled={decide.isPending}>
                  <LuCircleX aria-hidden />
                  Reject
                </Button>
              </div>
            )}
            {pending && rejecting && (
              <div className="w-full space-y-2">
                <Textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  maxLength={500}
                  placeholder="Reason (sent to the person who made the change)"
                  aria-label="Reason for rejecting"
                />
                <Button size="sm" variant="destructive" onClick={() => decideNow("reject")} disabled={decide.isPending}>
                  Reject change
                </Button>
              </div>
            )}
          </div>

          <Section title={`What changes (${change.changes.length})`}>
            <ChangeTable lines={change.changes} />
          </Section>

          {ctx.project && (
            <Section
              title="Project"
              aside={
                <Link to={`/projects/${ctx.project._id}`} className="inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2">
                  Open project <LuExternalLink aria-hidden className="size-3" />
                </Link>
              }
            >
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Fact label="Code" value={ctx.project.code} />
                <Fact label="Brand" value={ctx.project.brand} />
                <Fact label="Type" value={ctx.project.type} />
                <Fact label="Month" value={ctx.project.month ? namingMonthLabel(ctx.project.month) : null} />
                <Fact label="Manager" value={ctx.project.manager} />
                <Fact label="Status" value={ctx.project.status} />
                <Fact label="Start" value={ctx.project.startDate ? formatDate(ctx.project.startDate) : null} />
                <Fact label="Deadline" value={ctx.project.deadline ? formatDate(ctx.project.deadline) : null} />
                <Fact label="Category" value={ctx.project.category} />
                <Fact label="Members" value={ctx.project.members} />
              </dl>
            </Section>
          )}
          {ctx.scope && (
            <Section title="Scope">
              <Compare render="text" changed={ctx.scope.changed} before={ctx.scope.current || "No scope written"} after={ctx.scope.proposed || "No scope written"} />
            </Section>
          )}
          {ctx.scopeRows && (ctx.scopeRows.current.length > 0 || ctx.scopeRows.proposed.length > 0) && (
            <Section title={ctx.scopeRows.changed ? "Scope rows" : "Scope rows (unchanged)"}>
              <Compare
                changed={ctx.scopeRows.changed}
                before={<ScopeRowsView rows={ctx.scopeRows.current} />}
                after={<ScopeRowsView rows={ctx.scopeRows.proposed} />}
              />
            </Section>
          )}
          {ctx.team && (
            <Section title={ctx.team.changed ? "Team" : "Team (unchanged)"}>
              <TeamCompare current={ctx.team.current} proposed={ctx.team.proposed} />
            </Section>
          )}
          {ctx.brand && (
            <Section title="Brand">
              <Compare changed before={<BrandCard b={ctx.brand.current} />} after={<BrandCard b={ctx.brand.proposed} />} />
              {ctx.brand.current.active && !ctx.brand.proposed.active && (
                <p className="flex items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-foreground">
                  <LuTriangleAlert aria-hidden className="size-4 text-amber-600" />
                  {ctx.brand.projects} active project{ctx.brand.projects === 1 ? "" : "s"} use this brand. Inactive brands can&apos;t be picked for new projects.
                </p>
              )}
              {ctx.brand.current.active === ctx.brand.proposed.active && (
                <p className="text-xs text-muted-foreground">Used by {ctx.brand.projects} active project{ctx.brand.projects === 1 ? "" : "s"}.</p>
              )}
            </Section>
          )}
          {ctx.plan && <PlanReview plan={ctx.plan} />}
        </>
      )}
    </div>
  );
}
