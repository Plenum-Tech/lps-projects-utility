import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { LuChevronDown, LuChevronRight, LuFileSpreadsheet, LuTarget } from "react-icons/lu";
import * as XLSX from "xlsx";

import { EmptyState, PageHeader, QueryError } from "@/components/globals/query-states";
import { ReportSkeleton } from "@/components/reports/report-shared";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { brandWithOrg, todayKey } from "@/lib/tasks";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Scope creep (leadership): per brand, per month — extra units beyond the scope
// and iterations beyond two. Order (as leadership asked): tiles › brands ranked ›
// brand → project table › brand × month trend. A bar or trend cell opens its
// brand in the table.
// ---------------------------------------------------------------------------

interface CreepExtra {
  deliverable: string;
  unit: string;
  n: number;
  tasks: number;
  taskId: string;
  status: "approved" | "pending" | "unflagged";
  decidedBy: string | null;
  decidedAt: string | null;
}

interface CreepIteration {
  deliverable: string;
  reworks: number;
  beyond: number;
  client: number;
  internal: number;
  notSet: number;
  taskId: string;
}

interface CreepProject {
  _id: string;
  name: string;
  code: string;
  month: string;
  hasScope: boolean;
  scope: Array<{ unit: string; total: number; used: number }>;
  scopeUnits: number;
  used: number;
  extras: CreepExtra[];
  iterations: CreepIteration[];
  extra: number;
  iter: number;
  creepPct: number | null;
}

interface CreepBrand {
  _id: string;
  name: string;
  organisation: string;
  projects: CreepProject[];
  scopeUnits: number;
  used: number;
  extra: number;
  iter: number;
  creepPct: number | null;
  heat: Array<number | null>;
}

interface ScopeCreepView {
  month: string;
  months: string[];
  rules: { freeIterations: number; repeatPct: number; repeatMonths: number };
  totals: {
    creepPct: number | null;
    prevCreepPct: number | null;
    scopeUnits: number;
    extra: { total: number; approved: number; pending: number; unflagged: number };
    iter: { total: number; client: number; internal: number; notSet: number };
    brands: number;
    brandsWithCreep: number;
    projectsWithoutScope: number;
  };
  repeatOffenders: string[];
  brands: CreepBrand[];
  trend: Array<{ _id: string; name: string; organisation: string; heat: Array<number | null> }>;
}

function useScopeCreep(month: string) {
  return useQuery({
    queryKey: ["reports", "scope-creep", month],
    queryFn: async () => (await api.get<ScopeCreepView>("/reports/scope-creep", { params: { month } })).data,
  });
}

/** "2026-11" → "November 2026" / "Nov". */
function monthLabel(month: string, short = false): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString("en-GB", short ? { month: "short", timeZone: "UTC" } : { month: "long", year: "numeric", timeZone: "UTC" });
}

function addMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const pctText = (v: number | null) => (v === null ? "—" : `${v}%`);
const brandLabel = (b: { name: string; organisation: string }) => brandWithOrg(b);
const over = (x: { extra: number; iter: number }) => x.extra + x.iter;

/** Creep % pill: grey under 5 %, amber 5–10 %, red over 10 %. */
function creepTone(v: number | null): string {
  if (v === null || v < 5) return "bg-muted text-foreground";
  if (v <= 10) return "bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200";
  return "bg-red-100 text-red-900 dark:bg-red-500/20 dark:text-red-200";
}

/** Trend cell: 0 % · under 5 % · 5–10 % · over 10 % · no scoped project. */
function heatTone(v: number | null): string {
  if (v === null) return "border border-dashed text-muted-foreground";
  if (v === 0) return "bg-muted text-foreground";
  if (v < 5) return "bg-amber-200 text-amber-950 dark:bg-amber-500/30 dark:text-amber-100";
  if (v <= 10) return "bg-amber-500 text-amber-950";
  return "bg-amber-800 text-white";
}

const EXTRA_STATUS: Record<CreepExtra["status"], { label: string; className: string }> = {
  approved: { label: "Approved", className: "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/20 dark:text-emerald-200" },
  pending: { label: "Waiting", className: "bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200" },
  unflagged: { label: "Not requested", className: "bg-muted text-muted-foreground" },
};

function askedBy(i: Pick<CreepIteration, "client" | "internal" | "notSet">): string {
  const parts = [i.client && `Client ${i.client}`, i.internal && `Internal ${i.internal}`, i.notSet && `Not set ${i.notSet}`].filter(Boolean);
  return parts.join(" · ") || "—";
}

function scopeText(p: CreepProject): string {
  if (!p.hasScope) return "No scope";
  return p.scope.map((s) => `${s.used} / ${s.total} ${s.unit}`).join(" · ");
}

function exportExcel(view: ScopeCreepView) {
  const wb = XLSX.utils.book_new();
  const brands = view.brands.map((b) => ({
    Brand: brandLabel(b),
    Projects: b.projects.length,
    "Scope units": b.scopeUnits,
    Used: b.used,
    "Extra units": b.extra,
    "Iterations beyond 2": b.iter,
    "Creep %": b.creepPct,
  }));
  const projects = view.brands.flatMap((b) =>
    b.projects.map((p) => ({
      Brand: brandLabel(b),
      Project: p.name,
      Code: p.code,
      "Scope (used / approved)": scopeText(p),
      "Scope units": p.scopeUnits,
      Used: p.used,
      "Extra units": p.extra,
      "Iterations beyond 2": p.iter,
      "Creep %": p.creepPct,
    }))
  );
  const extras = view.brands.flatMap((b) =>
    b.projects.flatMap((p) =>
      p.extras.map((x) => ({
        Brand: brandLabel(b),
        Project: p.name,
        Deliverable: x.deliverable,
        Tasks: x.tasks,
        Status: EXTRA_STATUS[x.status].label,
        "Decided by": x.decidedBy ?? "",
        "Decided on": x.decidedAt ? formatDate(x.decidedAt) : "",
      }))
    )
  );
  const iterations = view.brands.flatMap((b) =>
    b.projects.flatMap((p) =>
      p.iterations.map((i) => ({
        Brand: brandLabel(b),
        Project: p.name,
        Deliverable: i.deliverable,
        Reworks: i.reworks,
        "Beyond 2": i.beyond,
        Client: i.client,
        Internal: i.internal,
        "Not set": i.notSet,
      }))
    )
  );
  const trend = view.trend.map((t) => ({
    Brand: brandLabel(t),
    ...Object.fromEntries(view.months.map((m, i) => [monthLabel(m), t.heat[i] ?? ""])),
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(brands), "Brands");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(projects), "Projects");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(extras), "Extra units");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(iterations), "Iterations beyond 2");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(trend), "Creep % by month");
  XLSX.writeFile(wb, `scope-creep-${view.month}.xlsx`);
}

function Tile({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card p-4 text-card-foreground">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 font-heading text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-sm bg-amber-500" aria-hidden />
        Extra units
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-sm bg-blue-700" aria-hidden />
        Iterations beyond 2
      </span>
    </div>
  );
}

function ProjectDetail({ project }: { project: CreepProject }) {
  if (!project.hasScope) {
    return <p className="px-10 pb-3 text-xs text-muted-foreground">This project has no scope, so it isn't counted.</p>;
  }
  return (
    <div className="grid gap-4 px-10 pb-4 md:grid-cols-2">
      <div className="space-y-1.5">
        <p className="text-xs font-semibold text-amber-700 dark:text-amber-400">Extra units beyond scope</p>
        {project.extras.length === 0 ? (
          <p className="text-xs text-muted-foreground">None — within scope.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-2 font-medium">Deliverable</th>
                <th className="py-1 pr-2 font-medium">Tasks</th>
                <th className="py-1 pr-2 font-medium">Status</th>
                <th className="py-1 font-medium">Decided by</th>
              </tr>
            </thead>
            <tbody>
              {project.extras.map((x) => (
                <tr key={`${x.unit}-${x.n}`} className="border-t">
                  <td className="py-1.5 pr-2 font-medium">{x.deliverable}</td>
                  <td className="py-1.5 pr-2">
                    <Link to={`/tasks?task=${x.taskId}`} className="text-primary hover:underline">
                      {x.tasks} {x.tasks === 1 ? "task" : "tasks"}
                    </Link>
                  </td>
                  <td className="py-1.5 pr-2">
                    <span className={cn("rounded-full px-2 py-0.5 font-medium", EXTRA_STATUS[x.status].className)}>{EXTRA_STATUS[x.status].label}</span>
                  </td>
                  <td className="py-1.5 text-muted-foreground">
                    {x.decidedBy ? `${x.decidedBy}${x.decidedAt ? ` · ${formatDate(x.decidedAt)}` : ""}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-semibold text-blue-700 dark:text-blue-400">Iterations beyond 2</p>
        {project.iterations.length === 0 ? (
          <p className="text-xs text-muted-foreground">None — every deliverable within 2 rounds.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-2 font-medium">Deliverable</th>
                <th className="py-1 pr-2 font-medium">Reworks</th>
                <th className="py-1 pr-2 font-medium">Beyond 2</th>
                <th className="py-1 font-medium">Asked by</th>
              </tr>
            </thead>
            <tbody>
              {project.iterations.map((i) => (
                <tr key={i.deliverable} className="border-t">
                  <td className="py-1.5 pr-2 font-medium">
                    <Link to={`/tasks?task=${i.taskId}`} className="hover:underline">
                      {i.deliverable}
                    </Link>
                  </td>
                  <td className="py-1.5 pr-2">{i.reworks}</td>
                  <td className="py-1.5 pr-2 font-semibold text-blue-700 dark:text-blue-400">+{i.beyond}</td>
                  <td className="py-1.5 text-muted-foreground">{askedBy(i)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const BRAND_GRID = "grid grid-cols-[2rem_minmax(14rem,2fr)_5rem_6rem_5rem_6rem_8rem_5.5rem] items-center gap-2";
const PROJECT_GRID = "grid grid-cols-[1.5rem_minmax(14rem,2fr)_minmax(10rem,1fr)_6rem_8rem_5rem] items-center gap-2";

export function ScopeCreepReport() {
  const thisMonth = todayKey().slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [openBrand, setOpenBrand] = useState<string | null>(null);
  const [openProject, setOpenProject] = useState<string | null>(null);
  const [allBrands, setAllBrands] = useState(false);
  const query = useScopeCreep(month);
  const view = query.data;

  const monthOptions = useMemo(() => Array.from({ length: 13 }, (_, i) => addMonths(thisMonth, -i)), [thisMonth]);
  const ranked = (view?.brands ?? []).filter((b) => over(b) > 0);
  const tableBrands = allBrands ? (view?.brands ?? []) : ranked;
  const maxOver = Math.max(1, ...ranked.map(over));

  function focusBrand(id: string) {
    setOpenBrand(id);
    if (!ranked.some((b) => b._id === id)) setAllBrands(true);
    requestAnimationFrame(() => document.getElementById(`creep-brand-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function pickMonth(next: string) {
    setMonth(next);
    setOpenBrand(null);
    setOpenProject(null);
  }

  const t = view?.totals;
  const delta = t && t.creepPct !== null && t.prevCreepPct !== null ? Math.round((t.creepPct - t.prevCreepPct) * 10) / 10 : null;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Scope creep"
        description="Which brands go over, by how much, and whether it keeps happening month after month."
        actions={
          <>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              Month
              <NativeSelect value={month} onChange={(e) => pickMonth(e.target.value)} aria-label="Month">
                {monthOptions.map((m) => (
                  <NativeSelectOption key={m} value={m}>
                    {monthLabel(m)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <Button variant="outline" onClick={() => view && exportExcel(view)} disabled={!view}>
              <LuFileSpreadsheet aria-hidden />
              Export Excel
            </Button>
          </>
        }
      />

      {query.isPending ? (
        <ReportSkeleton kpis={4} charts={1} />
      ) : query.isError ? (
        <QueryError title="Couldn't load the scope creep report" error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
      ) : (
        view &&
        t && (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Tile
                label={`Overall creep · ${monthLabel(view.month, true)}`}
                value={
                  <span className="flex flex-wrap items-baseline gap-2">
                    {pctText(t.creepPct)}
                    {delta !== null && delta !== 0 && (
                      <span className={cn("text-sm font-medium", delta > 0 ? "text-red-700 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400")}>
                        {delta > 0 ? "▲" : "▼"} {Math.abs(delta)} pts vs {monthLabel(addMonths(view.month, -1), true)}
                      </span>
                    )}
                  </span>
                }
                hint={`${t.extra.total + t.iter.total} over ${t.scopeUnits} scope units`}
              />
              <Tile
                label="Extra units"
                value={<span className="text-amber-700 dark:text-amber-400">{t.extra.total}</span>}
                hint={[`${t.extra.approved} approved`, `${t.extra.pending} waiting`, t.extra.unflagged ? `${t.extra.unflagged} not requested` : ""].filter(Boolean).join(" · ")}
              />
              <Tile
                label="Iterations beyond 2"
                value={<span className="text-blue-700 dark:text-blue-400">{t.iter.total}</span>}
                hint={[`${t.iter.client} client`, `${t.iter.internal} internal`, t.iter.notSet ? `${t.iter.notSet} not set` : ""].filter(Boolean).join(" · ")}
              />
              <Tile
                label="Repeat offenders"
                value={`${view.repeatOffenders.length} ${view.repeatOffenders.length === 1 ? "brand" : "brands"}`}
                hint={
                  <span title={view.repeatOffenders.join(", ")}>
                    over {view.rules.repeatPct}% for {view.rules.repeatMonths}+ months running
                    {view.repeatOffenders.length > 0 && `: ${view.repeatOffenders.slice(0, 3).join(", ")}${view.repeatOffenders.length > 3 ? "…" : ""}`}
                  </span>
                }
              />
            </div>

            <section className="space-y-3 rounded-xl border bg-card p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold">Brands ranked by scope creep · {monthLabel(view.month)}</h2>
                <Legend />
              </div>
              {ranked.length === 0 ? (
                <EmptyState icon={LuTarget} title="No scope creep this month" description={`${t.brands} brands with projects in ${monthLabel(view.month)}, all within scope.`} />
              ) : (
                <ul className="space-y-1">
                  {ranked.map((b) => (
                    <li key={b._id}>
                      <button
                        type="button"
                        onClick={() => focusBrand(b._id)}
                        className={cn(
                          "grid w-full grid-cols-[minmax(8rem,13rem)_minmax(0,1fr)_4.5rem] items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors hover:bg-muted/50",
                          openBrand === b._id ? "border-primary/40 bg-primary/5" : "border-transparent"
                        )}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold">{b.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {b.organisation && b.organisation.toLowerCase() !== b.name.toLowerCase() ? `${b.organisation} · ` : ""}
                            {b.projects.length} {b.projects.length === 1 ? "project" : "projects"}
                          </span>
                        </span>
                        <span className="flex h-6 overflow-hidden rounded bg-muted" aria-label={`${b.extra} extra units, ${b.iter} iterations beyond 2`}>
                          {b.extra > 0 && (
                            <span className="flex items-center justify-center bg-amber-500 text-xs font-semibold text-amber-950" style={{ width: `${(b.extra / maxOver) * 100}%` }}>
                              {b.extra}
                            </span>
                          )}
                          {b.iter > 0 && (
                            <span className="flex items-center justify-center bg-blue-700 text-xs font-semibold text-white" style={{ width: `${(b.iter / maxOver) * 100}%` }}>
                              {b.iter}
                            </span>
                          )}
                        </span>
                        <span
                          className={cn(
                            "text-right text-sm font-semibold tabular-nums",
                            (b.creepPct ?? 0) > 10 ? "text-red-700 dark:text-red-400" : (b.creepPct ?? 0) >= 5 ? "text-amber-700 dark:text-amber-400" : "text-foreground"
                          )}
                        >
                          {pctText(b.creepPct)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">Bar length = units over scope. Click a brand to open it in the table below.</p>
            </section>

            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold">Brands and projects · {monthLabel(view.month)}</h2>
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={allBrands} onCheckedChange={setAllBrands} />
                  Show all brands ({t.brands})
                </label>
              </div>
              <div className="overflow-x-auto rounded-xl border bg-card">
                <div className="min-w-[60rem]">
                  <div className={cn(BRAND_GRID, "border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground")}>
                    <span />
                    <span>Brand</span>
                    <span className="text-right">Projects</span>
                    <span className="text-right">Scope units</span>
                    <span className="text-right">Used</span>
                    <span className="text-right">Extra units</span>
                    <span className="text-right">Iterations beyond 2</span>
                    <span className="text-right">Creep</span>
                  </div>
                  {tableBrands.length === 0 && <p className="px-4 py-8 text-center text-sm text-muted-foreground">No brands with scope creep this month.</p>}
                  {tableBrands.map((b) => {
                    const open = openBrand === b._id;
                    return (
                      <div key={b._id} id={`creep-brand-${b._id}`} className="scroll-mt-4 border-b last:border-b-0">
                        <button
                          type="button"
                          aria-expanded={open}
                          onClick={() => setOpenBrand(open ? null : b._id)}
                          className={cn(BRAND_GRID, "w-full px-3 py-3 text-left text-sm hover:bg-muted/40", open && "bg-muted/30")}
                        >
                          {open ? <LuChevronDown aria-hidden className="size-4 text-muted-foreground" /> : <LuChevronRight aria-hidden className="size-4 text-muted-foreground" />}
                          <span className="min-w-0">
                            <span className="block truncate font-semibold">{b.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {b.organisation && b.organisation.toLowerCase() !== b.name.toLowerCase() ? b.organisation : "—"}
                            </span>
                          </span>
                          <span className="text-right tabular-nums">{b.projects.length}</span>
                          <span className="text-right tabular-nums">{b.scopeUnits}</span>
                          <span className="text-right tabular-nums">{b.used}</span>
                          <span className="text-right font-semibold text-amber-700 tabular-nums dark:text-amber-400">{b.extra}</span>
                          <span className="text-right font-semibold text-blue-700 tabular-nums dark:text-blue-400">{b.iter}</span>
                          <span className="text-right">
                            <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums", creepTone(b.creepPct))}>{pctText(b.creepPct)}</span>
                          </span>
                        </button>
                        {open && (
                          <div className="space-y-2 bg-muted/20 px-3 pt-1 pb-4 sm:pl-11">
                            <p className="text-xs font-medium text-muted-foreground">
                              Projects of {b.name} · {monthLabel(view.month)}
                            </p>
                            <div className="overflow-hidden rounded-lg border bg-card">
                              <div className={cn(PROJECT_GRID, "border-b px-3 py-2 text-xs font-medium text-muted-foreground")}>
                                <span />
                                <span>Project</span>
                                <span>Scope (used / approved)</span>
                                <span className="text-right">Extra units</span>
                                <span className="text-right">Iterations beyond 2</span>
                                <span className="text-right">Creep</span>
                              </div>
                              {b.projects.map((p) => {
                                const pOpen = openProject === p._id;
                                return (
                                  <Fragment key={p._id}>
                                    <button
                                      type="button"
                                      aria-expanded={pOpen}
                                      onClick={() => setOpenProject(pOpen ? null : p._id)}
                                      className={cn(PROJECT_GRID, "w-full border-b px-3 py-2.5 text-left text-sm last:border-b-0 hover:bg-muted/40")}
                                    >
                                      {pOpen ? <LuChevronDown aria-hidden className="size-3.5 text-muted-foreground" /> : <LuChevronRight aria-hidden className="size-3.5 text-muted-foreground" />}
                                      <span className="min-w-0">
                                        <span className="block truncate font-medium">{p.name}</span>
                                        <span className="block truncate text-xs text-muted-foreground">{p.code}</span>
                                      </span>
                                      <span className={cn("text-xs", p.hasScope ? "text-foreground" : "text-muted-foreground")}>{scopeText(p)}</span>
                                      <span className="text-right font-semibold text-amber-700 tabular-nums dark:text-amber-400">{p.hasScope ? p.extra : "—"}</span>
                                      <span className="text-right font-semibold text-blue-700 tabular-nums dark:text-blue-400">{p.hasScope ? p.iter : "—"}</span>
                                      <span className="text-right tabular-nums">{pctText(p.creepPct)}</span>
                                    </button>
                                    {pOpen && (
                                      <div className="border-b bg-muted/10 pt-2 last:border-b-0">
                                        <ProjectDetail project={p} />
                                      </div>
                                    )}
                                  </Fragment>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {tableBrands.length > 0 && (
                    <div className={cn(BRAND_GRID, "border-t bg-muted/40 px-3 py-3 text-sm font-semibold")}>
                      <span />
                      <span>
                        Total ({tableBrands.length} {tableBrands.length === 1 ? "brand" : "brands"})
                      </span>
                      <span className="text-right tabular-nums">{tableBrands.reduce((n, b) => n + b.projects.length, 0)}</span>
                      <span className="text-right tabular-nums">{tableBrands.reduce((n, b) => n + b.scopeUnits, 0)}</span>
                      <span className="text-right tabular-nums">{tableBrands.reduce((n, b) => n + b.used, 0)}</span>
                      <span className="text-right text-amber-700 tabular-nums dark:text-amber-400">{tableBrands.reduce((n, b) => n + b.extra, 0)}</span>
                      <span className="text-right text-blue-700 tabular-nums dark:text-blue-400">{tableBrands.reduce((n, b) => n + b.iter, 0)}</span>
                      <span className="text-right tabular-nums">
                        {pctText(
                          (() => {
                            const units = tableBrands.reduce((n, b) => n + b.scopeUnits, 0);
                            return units ? Math.round((tableBrands.reduce((n, b) => n + over(b), 0) / units) * 1000) / 10 : null;
                          })()
                        )}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </section>

            <section className="space-y-3 rounded-xl border bg-card p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold">Brand × month — creep % (last {view.months.length} months)</h2>
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                  {[
                    ["bg-muted", "0%"],
                    ["bg-amber-200", "under 5%"],
                    ["bg-amber-500", "5–10%"],
                    ["bg-amber-800", "over 10%"],
                  ].map(([cls, label]) => (
                    <span key={label} className="flex items-center gap-1.5">
                      <span className={cn("h-2.5 w-3.5 rounded-sm", cls)} aria-hidden />
                      {label}
                    </span>
                  ))}
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-3.5 rounded-sm border border-dashed" aria-hidden />
                    no project
                  </span>
                </div>
              </div>
              {view.trend.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">No scope creep in these months.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[44rem] border-separate border-spacing-1 text-xs">
                    <thead>
                      <tr>
                        <th className="w-44" />
                        {view.months.map((m) => (
                          <th key={m} className="pb-1 text-center font-medium text-muted-foreground">
                            {monthLabel(m, true)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {view.trend.map((row) => (
                        <tr key={row._id}>
                          <th scope="row" className="max-w-44 truncate pr-2 text-left text-sm font-semibold">
                            {row.name}
                          </th>
                          {row.heat.map((v, i) => {
                            const m = view.months[i]!;
                            const cell = <span className={cn("flex h-9 items-center justify-center rounded-md font-semibold tabular-nums", heatTone(v))}>{v === null ? "—" : `${v}%`}</span>;
                            return (
                              <td key={m} className="p-0">
                                {v === null ? (
                                  <span title={`${row.name} · ${monthLabel(m)}: no project with scope`}>{cell}</span>
                                ) : (
                                  <button
                                    type="button"
                                    className="block w-full"
                                    title={`${row.name} · ${monthLabel(m)}: ${v}%`}
                                    onClick={() => {
                                      if (m !== month) pickMonth(m);
                                      if (v === 0) setAllBrands(true);
                                      focusBrand(row._id);
                                    }}
                                  >
                                    {cell}
                                  </button>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                A row that stays orange shows a brand whose scope keeps being exceeded: a case for renegotiating its scope. Click a cell to open that brand and month.
              </p>
            </section>

            <p className="text-xs text-muted-foreground">
              Extra units: deliverables beyond the scope total (Video 16 when the scope is 15 Video) or on a unit the project has no scope for; approved and waiting
              count, rejected don't. Iterations beyond 2: rework tasks on one deliverable after the second. Creep = (extra units + iterations beyond 2) ÷ scope
              units. A project's month is its naming month, else the month in its name, else its deadline.
              {t.projectsWithoutScope > 0 && ` ${t.projectsWithoutScope} project${t.projectsWithoutScope === 1 ? "" : "s"} this month ha${t.projectsWithoutScope === 1 ? "s" : "ve"} no scope and ${t.projectsWithoutScope === 1 ? "isn't" : "aren't"} counted.`}
            </p>
          </>
        )
      )}
    </div>
  );
}
