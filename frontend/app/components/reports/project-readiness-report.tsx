import { useState } from "react";
import { LuGauge, LuSettings2 } from "react-icons/lu";
import { Link } from "react-router";

import { EmptyState, PageHeader, QueryError } from "@/components/globals/query-states";
import { ReadinessBadge } from "@/components/projects/readiness-badge";
import { ReportSkeleton } from "@/components/reports/report-shared";
import { Input } from "@/components/ui/input";
import { useProjectReadinessReport } from "@/hooks/use-work-reports";
import { formatDateOnly } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { ProjectReadinessReport as Report } from "@/types";

const th = "px-3 py-2 text-left text-xs font-semibold tracking-wide whitespace-nowrap text-muted-foreground uppercase";
const td = "px-3 py-2 align-middle";
const num = "px-3 py-2 text-right align-middle whitespace-nowrap tabular-nums";
const currentMonth = () => new Date().toISOString().slice(0, 7);
const monthName = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

function Tile({ label, value, note, tone }: { label: string; value: string; note: string; tone?: "good" | "warn" | "bad" }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className={cn("mt-1 font-heading text-2xl font-semibold tabular-nums", tone === "good" && "text-good", tone === "warn" && "text-warn", tone === "bad" && "text-critical")}>{value}</p>
      <p className="text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

/** "12 / 40" with the measured share under it. */
function Part({ points, max, detail }: { points: number; max: number; detail: string }) {
  return (
    <td className={num}>
      <span className={cn("font-medium", points === max ? "text-good" : points < max / 2 ? "text-critical" : "text-warn")}>{points}</span>
      <span className="text-xs text-muted-foreground"> / {max}</span>
      <span className="block text-[11px] text-muted-foreground">{detail}</span>
    </td>
  );
}

type Band = "all" | "red" | "amber" | "green";

/** Project readiness (leadership): every project and pitch of the month, lowest score first. */
export function ProjectReadinessReport() {
  const [month, setMonth] = useState(currentMonth);
  const [band, setBand] = useState<Band>("all");
  const [kind, setKind] = useState<"all" | "project" | "pitch">("all");
  const report = useProjectReadinessReport(month);
  const data: Report | undefined = report.data;
  const rows = (data?.projects ?? []).filter((p) => (band === "all" || p.band === band) && (kind === "all" || p.kind === kind));

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-4 px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Project readiness"
        description="A score out of 100 for every project and pitch: was it planned — its scope entered as tasks, with assignees, due dates and estimates — by the cut-off at the start of the month or pitch?"
        actions={
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Month
            <Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="h-8 w-40" />
          </label>
        }
      />
      {report.isError && !data ? (
        <QueryError title="Couldn't load the readiness scores" error={report.error} onRetry={() => void report.refetch()} />
      ) : !data ? (
        <ReportSkeleton />
      ) : (
        <div className={cn("space-y-4 transition-opacity", report.isPlaceholderData && "opacity-60")}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label={`Average · ${monthName(data.month)}`} value={data.totals.average === null ? "—" : String(data.totals.average)} note={`${data.totals.projects} projects and pitches`} tone={data.totals.average === null ? undefined : data.totals.average >= data.settings.greenFrom ? "good" : data.totals.average >= data.settings.amberFrom ? "warn" : "bad"} />
            <Tile label="Red" value={String(data.totals.red)} note={`below ${data.settings.amberFrom}`} tone={data.totals.red > 0 ? "bad" : undefined} />
            <Tile label="Amber" value={String(data.totals.amber)} note={`${data.settings.amberFrom} to ${data.settings.greenFrom - 1}`} tone={data.totals.amber > 0 ? "warn" : undefined} />
            <Tile label="Green" value={String(data.totals.green)} note={`${data.settings.greenFrom} and above`} tone="good" />
          </div>

          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border bg-card px-4 py-2.5 text-xs text-muted-foreground">
            <LuSettings2 aria-hidden className="size-4" />
            Retainers are due by working day {data.settings.retainerDay} of the month; pitches {data.settings.pitchDays} working day{data.settings.pitchDays === 1 ? "" : "s"} after the internal briefing (Milestone 1 meeting, else the start date). Green from {data.settings.greenFrom}, amber from {data.settings.amberFrom}.
            <Link to="/settings/projects" className="font-medium text-primary underline-offset-4 hover:underline">
              Change in Settings → Projects
            </Link>
          </p>

          <section className="overflow-hidden rounded-xl border bg-card">
            <h2 className="p-4 pb-1 text-sm font-semibold">By program manager</h2>
            <p className="px-4 pb-3 text-xs text-muted-foreground">Lowest average first — who to speak to.</p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead className="border-y bg-muted/40">
                  <tr>
                    <th className={th}>Manager</th>
                    <th className={cn(th, "text-right")}>Projects</th>
                    <th className={cn(th, "text-right")}>Average score</th>
                    <th className={cn(th, "text-right")}>Red projects</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.managers.map((m) => (
                    <tr key={m.name}>
                      <td className={cn(td, "font-medium")}>{m.name}</td>
                      <td className={num}>{m.projects}</td>
                      <td className={num}>
                        <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-semibold", m.average >= data.settings.greenFrom ? "bg-good/10 text-good" : m.average >= data.settings.amberFrom ? "bg-warn/10 text-warn" : "bg-critical/10 text-critical")}>{m.average}</span>
                      </td>
                      <td className={cn(num, m.red > 0 && "font-medium text-critical")}>{m.red}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="overflow-hidden rounded-xl border bg-card">
            <div className="flex flex-wrap items-center gap-3 p-4">
              <h2 className="text-sm font-semibold">Projects and pitches</h2>
              <span className="inline-flex overflow-hidden rounded-md border" role="group" aria-label="Band">
                {(["all", "red", "amber", "green"] as const).map((value) => (
                  <button key={value} type="button" aria-pressed={band === value} onClick={() => setBand(value)} className={cn("px-3 py-1 text-xs capitalize", band === value ? "bg-foreground text-background" : "bg-background hover:bg-muted")}>
                    {value}
                  </button>
                ))}
              </span>
              <span className="inline-flex overflow-hidden rounded-md border" role="group" aria-label="Kind">
                {(
                  [
                    ["all", "All"],
                    ["project", "Projects"],
                    ["pitch", "Pitches"],
                  ] as const
                ).map(([value, label]) => (
                  <button key={value} type="button" aria-pressed={kind === value} onClick={() => setKind(value)} className={cn("px-3 py-1 text-xs", kind === value ? "bg-foreground text-background" : "bg-background hover:bg-muted")}>
                    {label}
                  </button>
                ))}
              </span>
              <span className="text-xs text-muted-foreground">{rows.length} shown · lowest score first</span>
            </div>
            {rows.length === 0 ? (
              <EmptyState icon={LuGauge} title="No projects match" description="Try another month or filter." className="py-10" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1100px] text-sm">
                  <thead className="border-y bg-muted/40">
                    <tr>
                      <th className={th}>Project</th>
                      <th className={th}>Manager</th>
                      <th className={th}>Score</th>
                      <th className={th}>Planning due</th>
                      <th className={cn(th, "text-right")}>Scope planned</th>
                      <th className={cn(th, "text-right")}>On time</th>
                      <th className={cn(th, "text-right")}>Assignee</th>
                      <th className={cn(th, "text-right")}>Due date</th>
                      <th className={cn(th, "text-right")}>Estimate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {rows.map((p) => (
                      <tr key={p._id}>
                        <td className={cn(td, "max-w-96")}>
                          <Link to={`/projects/${p._id}`} className="font-medium hover:underline">
                            {p.name}
                          </Link>
                          <span className="block text-xs text-muted-foreground">
                            {p.brand || "No brand"} · {p.type} · {p.tasks} task{p.tasks === 1 ? "" : "s"}
                          </span>
                        </td>
                        <td className={td}>{p.manager?.name ?? <span className="text-critical">No manager</span>}</td>
                        <td className={td}>
                          <ReadinessBadge readiness={p} />
                        </td>
                        <td className={cn(td, "text-xs whitespace-nowrap text-muted-foreground")}>{p.cutoff ? formatDateOnly(p.cutoff, true) : "—"}</td>
                        <Part points={p.parts.scope.points} max={p.parts.scope.max} detail={p.parts.scope.total > 0 ? `${p.parts.scope.planned} of ${p.parts.scope.total}` : "no scope"} />
                        <Part points={p.parts.onTime.points} max={p.parts.onTime.max} detail={`${p.parts.onTime.onTime} of ${p.parts.onTime.tasks}`} />
                        <Part points={p.parts.assignee.points} max={p.parts.assignee.max} detail={`${p.parts.assignee.with} of ${p.parts.assignee.tasks}`} />
                        <Part points={p.parts.dueDate.points} max={p.parts.dueDate.max} detail={`${p.parts.dueDate.with} of ${p.parts.dueDate.tasks}`} />
                        <Part points={p.parts.estimate.points} max={p.parts.estimate.max} detail={`${p.parts.estimate.with} of ${p.parts.estimate.tasks}`} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
