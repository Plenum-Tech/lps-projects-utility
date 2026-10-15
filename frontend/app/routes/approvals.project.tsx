import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { LuArrowLeft, LuCircleCheck, LuCircleX, LuExternalLink, LuLoaderCircle, LuTriangleAlert } from "react-icons/lu";

import { PageHeader, QueryError } from "@/components/globals/query-states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useManpowerRows } from "@/hooks/use-manpower";
import { useDecideProjectApproval } from "@/hooks/use-project-approval";
import { useProject } from "@/hooks/use-projects";
import { useTeamLoad } from "@/hooks/use-team-load";
import { formatDateOnly, formatDateTime } from "@/lib/format";
import { MANPOWER_ROLE_FALLBACK, TEAM_OTHERS } from "@/lib/manpower";
import { namingMonthLabel } from "@/lib/projects";
import { scopeTotal, scopeTotals } from "@/lib/scope";
import { cn } from "@/lib/utils";

import type { Route } from "./+types/approvals.project";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Review project | LPS" }];
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

/** Leadership: everything needed to approve or reject a new project. */
export default function ProjectReviewRoute() {
  const { id } = useParams();
  const navigate = useNavigate();
  const query = useProject(id);
  const decide = useDecideProjectApproval();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const project = query.data?.project;
  const month = project?.naming?.month ?? "";
  const load = useTeamLoad(month, Boolean(month));
  const planRows = useManpowerRows(month, Boolean(month));
  const roleLabel = new Map([...MANPOWER_ROLE_FALLBACK, TEAM_OTHERS].map((r) => [r.key, r.label]));
  const pending = project?.approval?.status === "pending";
  const scopeRows = project?.scopeItems ?? [];
  const totals = scopeTotals(scopeRows);
  const grand = totals.reduce((n, t) => n + t.total, 0);
  const team = (project?.team ?? []).filter((t) => t.users.length > 0);
  const people = new Set(team.flatMap((t) => t.users.map((u) => u._id)));
  const planLine = project?.manpowerRow ? planRows.data?.rows.find((r) => r.key === project.manpowerRow) : undefined;

  function decideNow(decision: "approve" | "reject") {
    if (!project) return;
    decide.mutate(
      { id: project._id, decision, reason: decision === "reject" ? reason.trim() || undefined : undefined },
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
      {query.isError && <QueryError title="Couldn't load this project" error={query.error} onRetry={() => void query.refetch()} />}
      {project && (
        <>
          <PageHeader
            title={project.name}
            description={`New project · requested by ${project.createdBy?.name ?? "someone"}${
              project.approval?.requestedAt ? ` on ${formatDateTime(project.approval.requestedAt)}` : ""
            }`}
          />
          <div className="sticky top-0 z-20 -mx-1 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-background/95 px-4 py-3 backdrop-blur">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="outline">New project</Badge>
              {project.brand?.name && <Badge variant="secondary">{project.brand.name}</Badge>}
              {pending ? (
                <span className="text-muted-foreground">No tasks can be added until you approve.</span>
              ) : (
                <Badge variant={project.approval?.status === "rejected" ? "destructive" : "secondary"}>
                  {project.approval?.status === "rejected" ? "Rejected" : "Approved"}
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
                  placeholder="Reason (sent to the person who created it)"
                  aria-label="Reason for rejecting"
                />
                <Button size="sm" variant="destructive" onClick={() => decideNow("reject")} disabled={decide.isPending}>
                  Reject project
                </Button>
              </div>
            )}
          </div>

          <Section
            title="Project"
            aside={
              <Link to={`/projects/${project._id}`} className="inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2">
                Open project <LuExternalLink aria-hidden className="size-3" />
              </Link>
            }
          >
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Fact label="Code" value={<span className="font-mono">{project.code}</span>} />
              <Fact label="Brand" value={project.brand?.name} />
              <Fact label="Type" value={project.naming?.type} />
              <Fact label="Month" value={month ? namingMonthLabel(month) : null} />
              <Fact label="Manager" value={project.manager?.name} />
              <Fact label="Status" value={project.status?.name} />
              <Fact label="Start" value={formatDateOnly(project.startDate)} />
              <Fact label="Deadline" value={project.deadline ? formatDateOnly(project.deadline) : null} />
              <Fact label="Category" value={project.category?.name} />
              <Fact label="Created by" value={project.createdBy?.name} />
              <Fact label="Manpower plan line" value={planLine ? planLine.name : project.manpowerRow ? "Linked line" : "Automatic"} />
              <Fact label="Task approval" value={project.requireTaskApproval ? "Required" : "Not required"} />
            </dl>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Summary</p>
              <p className="rounded-lg border bg-muted/30 p-3 text-sm whitespace-pre-wrap">
                {project.summary?.trim() || <span className="text-muted-foreground">No summary written.</span>}
              </p>
            </div>
          </Section>

          <Section title={`Scope${grand ? ` · ${grand} deliverables` : ""}`}>
            {scopeRows.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400">
                <LuTriangleAlert aria-hidden className="size-4" />
                No scope rows: tasks on this project won&apos;t be checked against a scope.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[28rem] text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr className="border-b">
                      <th className="py-1.5 pr-3 text-left font-medium">Unit</th>
                      <th className="py-1.5 pr-3 text-right font-medium">Quantity</th>
                      <th className="py-1.5 pr-3 text-right font-medium">Languages</th>
                      <th className="py-1.5 pr-3 text-right font-medium">Sizes</th>
                      <th className="py-1.5 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scopeRows.map((row, index) => (
                      <tr key={index} className="border-b last:border-0">
                        <td className="py-1.5 pr-3">{row.unit}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{row.quantity}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          × {row.languageList?.length ? `${row.languages} (${row.languageList.join(", ")})` : row.languages}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">× {row.sizes}</td>
                        <td className="py-1.5 text-right font-semibold tabular-nums">{scopeTotal(row)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-sm text-muted-foreground">{totals.map((t) => `${t.total} ${t.unit}`).join(" · ")}</p>
              </div>
            )}
          </Section>

          <Section title={`Team · ${people.size} ${people.size === 1 ? "person" : "people"}`}>
            {team.length === 0 ? (
              <p className="text-sm text-muted-foreground">No team set.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[28rem] text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr className="border-b">
                      <th className="py-1.5 pr-3 text-left font-medium">Role</th>
                      <th className="py-1.5 text-left font-medium">
                        People <span className="font-normal">(projects in {month ? namingMonthLabel(month) : "the month"})</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {team.map((entry) => (
                      <tr key={entry.role} className="border-b align-top last:border-0">
                        <td className="py-2 pr-3 font-medium">{roleLabel.get(entry.role) ?? entry.role}</td>
                        <td className="py-2">
                          <div className="flex flex-wrap gap-1.5">
                            {entry.users.map((u) => {
                              const n = load.data?.load[u._id] ?? 0;
                              const max = load.data?.max ?? 0;
                              const full = Boolean(max) && n > max;
                              return (
                                <span
                                  key={u._id}
                                  className={cn(
                                    "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs",
                                    full ? "bg-destructive/10 text-destructive" : "bg-muted",
                                  )}
                                >
                                  {u.name}
                                  {load.data && (
                                    <span className="tabular-nums opacity-80">
                                      {n}/{max}
                                    </span>
                                  )}
                                </span>
                              );
                            })}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-xs text-muted-foreground">
                  The number is how many of the month&apos;s projects each person is on (this one included); red is over the
                  manpower plan&apos;s limit.
                </p>
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
