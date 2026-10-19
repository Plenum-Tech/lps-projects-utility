import { Fragment, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { LuPlus, LuSearch, LuTags } from "react-icons/lu";

import { BrandFlowDialog } from "@/components/brands/brand-flow-dialog";
import { AllocCell, CellLegend, cellTone, SaveBar, StatusDot, usePlanEdits, type CellOption } from "@/components/brands/alloc-cell";
import { EmptyState, QueryError } from "@/components/globals/query-states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-auth";
import { useBrandOverview } from "@/hooks/use-brand-dashboard";
import { neededRoles } from "@/lib/brand-roles";
import { firstName } from "@/lib/manpower";
import { cn } from "@/lib/utils";
import type { BrandChecks, BrandOverviewResponse, BrandSummary } from "@/types";

// ---------------------------------------------------------------------------
// Brands → Overview (checks per brand, least set up first) and Allocation
// (brands × plan roles, colour-only cells editing the month's manpower plan).
// Brands without a scope are flagged, never blocked.
// ---------------------------------------------------------------------------

type Filter = "all" | "noscope" | "nodocs" | "noplan" | "nolead";
const FILTERS: Array<[Filter, string]> = [
  ["all", "All"],
  ["noscope", "No scope"],
  ["nodocs", "No documents"],
  ["noplan", "Not in manpower plan"],
  ["nolead", "No lead"],
];
const CHECK: Record<Exclude<Filter, "all">, keyof BrandChecks> = { noscope: "scope", nodocs: "docs", noplan: "plan", nolead: "lead" };
const score = (b: BrandSummary) => Object.values(b.checks).filter(Boolean).length;

export const thisMonth = () => new Date().toISOString().slice(0, 7);

export function monthLabel(month: string) {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** Month picker shared by the Brands tabs. */
export function MonthPicker({ month, onChange }: { month: string; onChange: (month: string) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Month</span>
      <Input type="month" value={month} onChange={(e) => e.target.value && onChange(e.target.value)} className="h-8 w-40" aria-label="Month" />
    </label>
  );
}

/** "New brand" (brand creators only — Nazeer; leadership approves). */
export function NewBrandButton() {
  const { data: user } = useCurrentUser();
  const [open, setOpen] = useState(false);
  if (!user?.access?.brandCreator) return null;
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        <LuPlus aria-hidden /> New brand
      </Button>
      <BrandFlowDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function KpiCard({ label, value, of, on, onClick }: { label: string; value: number; of: number | null; on: boolean; onClick: () => void }) {
  const pct = of === null ? null : Math.round((100 * value) / Math.max(1, of));
  const bar = pct === null ? "" : pct < 34 ? "bg-red-600 dark:bg-red-400" : pct < 67 ? "bg-amber-500" : "bg-emerald-600 dark:bg-emerald-400";
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn("rounded-xl border bg-card p-3 text-left text-card-foreground transition-colors hover:bg-muted/40", on && "ring-2 ring-primary")}
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold tabular-nums">
        {value}
        {of !== null && <span className="ml-1 text-xs font-normal text-muted-foreground">/ {of}</span>}
      </p>
      {pct !== null && (
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
          <i className={cn("block h-full", bar)} style={{ width: `${pct}%` }} />
        </div>
      )}
    </button>
  );
}

export function BrandsOverview({ month, data, isPending, error, refetch }: { month: string; data: BrandOverviewResponse | undefined; isPending: boolean; error: unknown; refetch: () => void }) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>("all");
  const [showAll, setShowAll] = useState(false);
  const [q, setQ] = useState("");

  // Active brands, plus every brand of an organisation with an active brand (ENOC → Zoom, Autopro, Tasjeel …).
  const base = useMemo(() => {
    const all = data?.brands ?? [];
    if (showAll) return all;
    const orgs = new Set(all.filter((b) => b.active && b.organisation).map((b) => b.organisation.toLowerCase()));
    return all.filter((b) => b.active || (b.organisation && orgs.has(b.organisation.toLowerCase())));
  }, [data, showAll]);
  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    return base
      .filter((b) => !term || b.name.toLowerCase().includes(term) || b.organisation.toLowerCase().includes(term))
      .filter((b) => filter === "all" || !b.checks[CHECK[filter]])
      .sort((a, b) => score(a) - score(b) || b.current.length - a.current.length || a.name.localeCompare(b.name));
  }, [base, q, filter]);

  // Brands of one organisation sit together under its heading; a brand without one stands alone.
  const groups = useMemo(() => {
    const out: Array<{ org: string; brands: typeof list }> = [];
    const byOrg = new Map<string, (typeof out)[number]>();
    for (const b of list) {
      const key = b.organisation.trim().toLowerCase();
      if (!key) {
        out.push({ org: "", brands: [b] });
        continue;
      }
      let g = byOrg.get(key);
      if (!g) {
        g = { org: b.organisation.trim(), brands: [] };
        byOrg.set(key, g);
        out.push(g);
      }
      g.brands.push(b);
    }
    return out;
  }, [list]);

  if (error && !data) return <QueryError title="Couldn't load the brands" error={error} onRetry={refetch} />;
  if (isPending && !data) return <Skeleton className="h-96 w-full" />;
  const n = base.length;
  const count = (k: keyof BrandChecks) => base.filter((b) => b.checks[k]).length;
  const pick = (f: Filter) => setFilter(filter === f && f !== "all" ? "all" : f);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-5">
        <KpiCard label={showAll ? "Brands" : "Active brands"} value={n} of={null} on={filter === "all"} onClick={() => setFilter("all")} />
        <KpiCard label="With scope" value={count("scope")} of={n} on={filter === "noscope"} onClick={() => pick("noscope")} />
        <KpiCard label="With documents" value={count("docs")} of={n} on={filter === "nodocs"} onClick={() => pick("nodocs")} />
        <KpiCard label="In manpower plan" value={count("plan")} of={n} on={filter === "noplan"} onClick={() => pick("noplan")} />
        <KpiCard label="With a lead" value={count("lead")} of={n} on={filter === "nolead"} onClick={() => pick("nolead")} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card p-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter">
          {FILTERS.map(([f, label]) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={cn("rounded-full border px-2.5 py-0.5 text-xs", filter === f ? "border-primary bg-primary/10 font-medium text-primary" : "hover:bg-muted")}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" className="size-4 accent-primary" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            All {data?.brands.length ?? 0} brands
          </label>
          <div className="relative">
            <LuSearch aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search brands…" aria-label="Search brands" className="h-8 w-52 pl-7" />
          </div>
        </div>
      </div>

      {list.length === 0 ? (
        <EmptyState icon={LuTags} title="No brands match" description={showAll ? "Try another filter or search." : `No active brand in ${monthLabel(month)} matches. Tick “All brands” to see the rest.`} />
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full min-w-[56rem] text-sm">
            <thead className="text-xs text-muted-foreground uppercase">
              <tr className="border-b text-left">
                <th className="px-3 py-2 font-medium">Brand</th>
                <th className="px-3 py-2 font-medium">Scope</th>
                <th className="px-3 py-2 font-medium">Documents</th>
                <th className="px-3 py-2 font-medium">Manpower plan</th>
                <th className="px-3 py-2 font-medium">Team</th>
                <th className="px-3 py-2 font-medium">Lead(s)</th>
                <th className="px-3 py-2 font-medium">Current projects</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.org || g.brands[0]!._id}>
                {g.org && (
                  <tr className="border-b bg-muted/50">
                    <td colSpan={7} className="px-3 py-1.5 text-xs">
                      <span className="font-semibold text-foreground">{g.org}</span>
                      <span className="ml-1.5 text-muted-foreground">· organisation · {g.brands.filter((b) => b.name.trim().toLowerCase() !== g.org.toLowerCase()).length} brands, each with its own scope, team, manpower and projects</span>
                    </td>
                  </tr>
                )}
                {g.brands.map((b) => (
                <tr
                  key={b._id}
                  className="cursor-pointer border-b last:border-0 hover:bg-muted/40"
                  onClick={() => void navigate(`/brands/${b._id}?month=${month}`)}
                >
                  <td className={cn("px-3 py-2", g.org && "pl-7")}>
                    <Link to={`/brands/${b._id}?month=${month}`} className="font-semibold hover:underline" onClick={(e) => e.stopPropagation()}>
                      {b.name}
                    </Link>
                    {g.org && b.name.trim().toLowerCase() === g.org.toLowerCase() && (
                      <Badge variant="destructive" className="ml-2" title={`${g.org} is the organisation: move each project to its brand`}>
                        organisation, not a brand — move its projects to a brand
                      </Badge>
                    )}
                    {b.status === "pending" && <Badge variant="outline" className="ml-2">waiting for approval</Badge>}
                    {b.organisation && !g.org && <p className="text-xs text-muted-foreground">{b.organisation}</p>}
                  </td>
                  <td className="px-3 py-2"><span className="inline-flex items-center gap-1.5"><StatusDot ok={b.checks.scope} />{b.checks.scope ? `${b.scopeItems.length} item${b.scopeItems.length === 1 ? "" : "s"}` : "no scope"}</span></td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-1.5"><StatusDot ok={b.checks.docs} />{b.checks.docs ? b.scopeFiles : "none"}</span>
                    {b.projectFiles > 0 && <span className="ml-1.5 text-xs text-muted-foreground">({b.projectFiles} on projects)</span>}
                  </td>
                  <td className="px-3 py-2"><span className="inline-flex items-center gap-1.5"><StatusDot ok={b.checks.plan} />{b.checks.plan ? `${b.planLines.length} line${b.planLines.length === 1 ? "" : "s"}` : "not linked"}</span></td>
                  <td className="px-3 py-2 tabular-nums">{b.people || "—"}</td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-1.5">
                      <StatusDot ok={b.checks.lead} />
                      {b.leads.length ? b.leads.map((l) => firstName(l.name)).join(", ") : "none"}
                    </span>
                  </td>
                  <td className="px-3 py-2 tabular-nums">{b.current.length}</td>
                </tr>
                ))}
                </Fragment>
              ))}
            </tbody>
          </table>
          <p className="border-t px-3 py-2 text-xs text-muted-foreground">{list.length} shown · red dot = missing (flag only — nothing is blocked)</p>
        </div>
      )}
    </div>
  );
}

/** Pool for a role: people holding it somewhere in the month's plan, least busy first. */
export function poolOptions(data: Pick<BrandOverviewResponse, "pool" | "people">, role: string, brandsOf: (id: string) => number): CellOption[] {
  return (data.pool[role] ?? [])
    .map((id) => ({ id, name: data.people[id]?.name ?? "Unknown", brands: brandsOf(id) }))
    .sort((a, b) => a.brands - b.brands || a.name.localeCompare(b.name));
}

export function BrandsAllocation({ month, data, isPending, error, refetch }: { month: string; data: BrandOverviewResponse | undefined; isPending: boolean; error: unknown; refetch: () => void }) {
  const edits = usePlanEdits(month, Boolean(data?.canEditPlan));
  const [showAll, setShowAll] = useState(false);
  const [q, setQ] = useState("");
  const roles = data?.roles ?? [];
  const brands = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (data?.brands ?? [])
      .filter((b) => b.status !== "rejected")
      .filter((b) => (showAll ? true : b.active && (b.checks.plan || b.checks.scope || b.current.length > 0)))
      .filter((b) => !term || b.name.toLowerCase().includes(term))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data, showAll, q]);
  const onBrand = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const b of data?.brands ?? []) map.set(b._id, new Set(Object.values(b.roles).flatMap((l) => l.map((p) => p._id))));
    return map;
  }, [data]);

  if (error && !data) return <QueryError title="Couldn't load the allocation" error={error} onRetry={refetch} />;
  if (isPending || !data) return <Skeleton className="h-96 w-full" />;
  const max = data.max;
  const brandsOf = (id: string) => (data.people[id]?.brands ?? 0) + edits.brandDelta(id, (brand) => onBrand.get(brand)?.has(id) ?? false);
  const nameOf = (id: string) => data.people[id]?.name ?? "Unknown";
  const brandInfo = new Map((data.brands ?? []).map((b) => [b._id, { name: b.name, isPitch: b.isPitch }]));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card p-3">
        <CellLegend max={max} />
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" className="size-4 accent-primary" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            All brands
          </label>
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search brands…" aria-label="Search brands" className="h-8 w-48" />
        </div>
        <p className="w-full text-xs text-muted-foreground">
          {data.canEditPlan
            ? `Click a cell → pick from the dropdown right there. Same people as the Manpower plan (${monthLabel(month)}${data.planVersion ? `, version ${data.planVersion} — the latest` : ", no plan yet"}).`
            : `Same people as the Manpower plan (${monthLabel(month)}). Only leadership and Nazeer change it.`}
        </p>
      </div>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b text-left">
              <th className="sticky left-0 z-10 bg-card px-3 py-2 font-medium">Brand</th>
              {roles.map((r) => (
                <th key={r.key} className="px-1.5 py-2 font-medium whitespace-nowrap">{r.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {brands.map((b) => {
              const need = neededRoles(b.scopeItems);
              return (
                <tr key={b._id} className="border-b last:border-0">
                  <td className="sticky left-0 z-10 bg-card px-3 py-1.5 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5">
                      <Link to={`/brands/${b._id}?month=${month}`} className="font-semibold hover:underline">{b.name}</Link>
                      <StatusDot ok={b.checks.scope} label={b.checks.scope ? "Has a scope" : "No scope"} />
                    </span>
                  </td>
                  {roles.map((r) => {
                    const current = (b.roles[r.key] ?? []).map((p) => p._id);
                    const people = edits.get(b._id, r.key, current);
                    const isNeeded = need.has(r.key) && !b.notNeeded.includes(r.key);
                    return (
                      <td key={r.key} className="px-1 py-1">
                        <AllocCell
                          label={`${r.label} for ${b.name}`}
                          people={people}
                          nameOf={nameOf}
                          options={poolOptions(data, r.key, brandsOf)}
                          tone={cellTone(people, isNeeded, brandsOf, max)}
                          editable={data.canEditPlan && b.status !== "rejected"}
                          edited={edits.isEdited(b._id, r.key)}
                          brandsOf={brandsOf}
                          onChange={(ids) => edits.set(b._id, r.key, current, ids)}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        {brands.length === 0 && <p className="p-4 text-sm text-muted-foreground">No brands to show. Tick “All brands”.</p>}
      </div>
      <SaveBar
        count={edits.count}
        ready={edits.ready}
        saving={edits.save.isPending}
        onReset={edits.reset}
        onSave={() => edits.submit(brandInfo, `Brands → Allocation: ${edits.count} change${edits.count === 1 ? "" : "s"}`, refetch)}
      />
    </div>
  );
}

/** The overview data for both tabs. */
export function useBrandsMonth(month: string) {
  return useBrandOverview(month);
}
