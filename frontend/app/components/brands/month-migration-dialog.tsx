import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { LuArrowRight, LuCalendarArrowUp, LuCircleCheck, LuLoaderCircle, LuMinus, LuSearch, LuTriangleAlert } from "react-icons/lu";

import { monthLabel } from "@/components/brands/brands-dashboard";
import { QueryError } from "@/components/globals/query-states";
import { FieldError } from "@/components/projects/project-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-auth";
import { useMonthMigrationPreview, useRunMonthMigration } from "@/hooks/use-brands";
import { getErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { MonthMigrationPreview, MonthMigrationResult } from "@/types";

// ---------------------------------------------------------------------------
// Brands → Migrate to next month (brand creators — Nazeer — and leadership):
// pick brands; their lines in the old month's manpower plan and their old-month
// projects move to the next month — or on through several months (Oct → Nov →
// Dec → Jan), each copied from the one before — approved at once (no approval).
// ---------------------------------------------------------------------------

type Candidate = MonthMigrationPreview["brands"][number];

const addMonths = (month: string, n: number) => {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const currentMonth = () => new Date().toISOString().slice(0, 7);

/** Something left to do for the brand: a project not in the new month yet, or plan lines to copy. */
const hasWork = (c: Candidate) => c.projects.some((p) => !p.exists) || (c.planLines > 0 && !c.inTargetPlan);

export function MonthMigrationButton() {
  const { data: user } = useCurrentUser();
  const [open, setOpen] = useState(false);
  if (!user?.access?.brandCreator) return null;
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <LuCalendarArrowUp aria-hidden /> Migrate to next month
      </Button>
      <MonthMigrationDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

export function MonthMigrationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [from, setFrom] = useState(() => addMonths(currentMonth(), -1));
  // The last month to copy to: one run goes month by month (Oct → Nov → Dec → Jan).
  const [until, setUntil] = useState(currentMonth);
  const to = addMonths(from, 1);
  const last = until > to ? until : to;
  const multi = last > to;
  const months = Array.from({ length: 13 }, (_, i) => addMonths(to, i)).filter((m) => m <= last);
  // The list shows the first step (from → the month after); later months follow from it.
  const preview = useMonthMigrationPreview(from, to, open);
  const run = useRunMonthMigration();
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [q, setQ] = useState("");
  const [result, setResult] = useState<MonthMigrationResult[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setPicked(null);
    setResult(null);
    setQ("");
    run.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, from]);

  const brands = preview.data?.brands ?? [];
  // Nothing is ticked at first: the brand creator picks the brands (or "Tick all").
  const selected = picked ?? new Set<string>();
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? brands.filter((c) => `${c.brand.name} ${c.brand.organisation}`.toLowerCase().includes(needle)) : brands;
  }, [brands, q]);
  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };
  // Over several months a brand already in the first one still moves on to the later ones.
  const canTick = (c: Candidate) => multi || hasWork(c);
  const ticked = brands.filter((c) => selected.has(c.brand._id) && canTick(c));
  const projectCount = ticked.reduce((n, c) => n + c.projects.filter((p) => !p.exists).length, 0);

  return (
    <Dialog open={open} onOpenChange={(next) => !run.isPending && onOpenChange(next)}>
      <DialogContent className="max-h-[92vh] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Migrate brands {multi ? `to ${monthLabel(to)} – ${monthLabel(last)}` : `to ${monthLabel(to)}`}</DialogTitle>
          <DialogDescription>
            The ticked brands&apos; {monthLabel(from)} manpower plan lines are copied {multi ? "month by month" : `to ${monthLabel(to)}`}, and their
            projects that still have open tasks carry on into {multi ? "each month" : monthLabel(to)} — the same project and name, with its closed
            and open tasks, ready for new ones. Projects with every task done stay in {monthLabel(from)}. No approval needed.
          </DialogDescription>
        </DialogHeader>

        {!result && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">From</span>
              <Input type="month" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className="h-8 w-40" aria-label="Copy from month" />
              <LuArrowRight aria-hidden className="size-4 text-muted-foreground" />
              <span className="text-muted-foreground">up to</span>
              <Input
                type="month"
                value={last}
                min={to}
                max={addMonths(from, 12)}
                onChange={(e) => e.target.value && setUntil(e.target.value)}
                className="h-8 w-40"
                aria-label="Copy up to month"
              />
              <div className="relative ml-auto">
                <LuSearch aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search brands…" className="h-8 w-56 pl-7" aria-label="Search brands" />
              </div>
            </div>

            {preview.isPending ? (
              <Skeleton className="h-64 w-full" />
            ) : preview.isError ? (
              <QueryError title="Couldn't load the brands" error={preview.error} onRetry={() => void preview.refetch()} />
            ) : brands.length === 0 ? (
              <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
                No brand has {monthLabel(from)} projects or plan lines to migrate.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    {ticked.length} of {brands.length} brands ticked
                    {multi
                      ? ` · ${months.length} months: ${months.map((m) => monthLabel(m)).join(", ")}`
                      : ` · ${projectCount} project${projectCount === 1 ? "" : "s"} to create`}
                  </span>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setPicked(new Set(brands.filter(canTick).map((c) => c.brand._id)))}>
                    Tick all
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
                    Clear
                  </Button>
                  {preview.data?.fromPlanVersion == null && (
                    <span className="text-amber-700 dark:text-amber-400">{monthLabel(from)} has no approved plan: only projects will move.</span>
                  )}
                </div>
                <ul className="divide-y rounded-lg border">
                  {shown.map((c) => {
                    const work = hasWork(c);
                    const on = canTick(c) && selected.has(c.brand._id);
                    return (
                      <li key={c.brand._id} className={cn("flex gap-3 px-3 py-2.5", !on && "text-muted-foreground")}>
                        <input
                          type="checkbox"
                          aria-label={`Migrate ${c.brand.name}`}
                          className="mt-0.5 size-4 shrink-0 accent-primary"
                          checked={on}
                          disabled={!canTick(c)}
                          onChange={(e) => toggle(c.brand._id, e.target.checked)}
                        />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium text-foreground">{c.brand.name}</span>
                            {c.brand.organisation && c.brand.organisation !== c.brand.name && (
                              <span className="text-xs">· {c.brand.organisation}</span>
                            )}
                            {!work && <Badge variant="secondary">Already in {monthLabel(to)}</Badge>}
                            {!work && multi && <Badge variant="outline">Continues to {monthLabel(last)}</Badge>}
                            {c.planLines > 0 &&
                              (c.inTargetPlan ? (
                                <Badge variant="outline">Plan line already in {monthLabel(to)}</Badge>
                              ) : (
                                <Badge variant="outline">
                                  {c.planLines} plan line{c.planLines === 1 ? "" : "s"} to copy
                                </Badge>
                              ))}
                            {!c.hasScope && <Badge variant="outline" className="text-amber-700 dark:text-amber-400">No scope</Badge>}
                            {!c.hasLead && <Badge variant="outline" className="text-amber-700 dark:text-amber-400">No lead</Badge>}
                          </div>
                          {c.projects.length === 0 ? (
                            <p className="text-xs">No {monthLabel(from)} project — only the plan line moves.</p>
                          ) : (
                            <ul className="space-y-0.5 text-xs">
                              {c.projects.map((p) => (
                                <li key={p._id} className="flex flex-wrap items-center gap-1">
                                  <span className={cn("break-all", !p.exists && on && (p.openTasks ?? 0) > 0 && "font-medium text-foreground")}>{p.name}</span>
                                  <LuArrowRight aria-hidden className="size-3 shrink-0" />
                                  <span className="text-muted-foreground">
                                    {p.exists
                                      ? `already runs in ${monthLabel(to)}`
                                      : (p.openTasks ?? 0) > 0
                                        ? `continues (${p.openTasks} open task${p.openTasks === 1 ? "" : "s"})`
                                        : `no open tasks — stays in ${monthLabel(from)}`}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            {run.isError && <FieldError>{getErrorMessage(run.error)}</FieldError>}
          </div>
        )}

        {result && (
          <div className="space-y-4 text-sm">
            {result.map((step) => (
              <section key={step.to} className="space-y-2">
                <h3 className="font-semibold">{monthLabel(step.to)}</h3>
                <p>
                  <span className="font-semibold">{step.created.length}</span> project{step.created.length === 1 ? "" : "s"} created ·{" "}
                  {"version" in step.plan
                    ? `${step.plan.lines} plan line${step.plan.lines === 1 ? "" : "s"} copied (plan v${step.plan.version}, approved)`
                    : `Plan: ${step.plan.skipped}`}
                </p>
                {step.created.length > 0 && (
                  <ul className="divide-y rounded-lg border">
                    {step.created.map((c) => (
                      <li key={c.projectId} className="flex flex-wrap items-center gap-2 px-3 py-2">
                        <LuCircleCheck aria-hidden className="size-4 text-primary" />
                        <span className="break-all">{c.name}</span>
                        <Link to={`/projects/${c.projectId}`} className="ml-auto text-xs text-primary underline-offset-2 hover:underline" onClick={() => onOpenChange(false)}>
                          Open project
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
                {step.skipped.length > 0 && (
                  <ul className="divide-y rounded-lg border text-muted-foreground">
                    {step.skipped.map((s, i) => (
                      <li key={i} className="flex gap-2 px-3 py-2">
                        {/exists|No .* project/.test(s.reason) ? (
                          <LuMinus aria-hidden className="mt-0.5 size-4 shrink-0" />
                        ) : (
                          <LuTriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-600" />
                        )}
                        <span>
                          <span className="font-medium text-foreground">{s.brand}</span> — {s.reason}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        )}

        <DialogFooter className="sticky bottom-0 z-10 gap-2 bg-background">
          {result ? (
            <Button type="button" onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={run.isPending}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={run.isPending || ticked.length === 0}
                onClick={() => run.mutate({ from, to: last, brandIds: ticked.map((c) => c.brand._id) }, { onSuccess: (data) => setResult(data.steps) })}
              >
                {run.isPending && <LuLoaderCircle aria-hidden className="animate-spin" />}
                {run.isPending ? "Migrating…" : `Migrate ${ticked.length} brand${ticked.length === 1 ? "" : "s"}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
