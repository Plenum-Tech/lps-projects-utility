import { Link } from "react-router";
import { LuCheck, LuChevronLeft, LuChevronRight, LuFileSpreadsheet, LuLoaderCircle, LuPresentation } from "react-icons/lu";

import { shortName } from "@/components/brands/brands-dashboard";
import { EmptyState, PageHeader, QueryError } from "@/components/globals/query-states";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { usePitches, usePitchesExport } from "@/hooks/use-brand-dashboard";
import { cn } from "@/lib/utils";
import type { PitchRow, PitchStepKey, PitchTone } from "@/types";

// ---------------------------------------------------------------------------
// Brands → Pitches: the pitch tracker sheet ("PITCHES/PROACTIVE PROJECTS") as a
// live table — same columns, with the status worked out from the pitch's
// Client presentation / Milestone 1 / Milestone 2 tasks.
// ---------------------------------------------------------------------------

/** "2026-Q4" for today (browser date). */
export function thisQuarter(): string {
  const now = new Date();
  return `${now.getFullYear()}-Q${Math.floor(now.getMonth() / 3) + 1}`;
}

export const isQuarter = (value: string | null): value is string => /^\d{4}-Q[1-4]$/.test(value ?? "");

function shiftQuarter(quarter: string, by: number): string {
  const year = Number(quarter.slice(0, 4));
  const index = year * 4 + Number(quarter.slice(6)) - 1 + by;
  return `${Math.floor(index / 4)}-Q${(index % 4) + 1}`;
}

const quarterLabel = (q: string) => `${q.slice(5)} ${q.slice(0, 4)}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-20" → "20 Oct". */
const shortDate = (key: string) => `${Number(key.slice(8, 10))} ${MONTHS[Number(key.slice(5, 7)) - 1]}`;

const aed = (n: number) => `AED ${n.toLocaleString("en-US")}`;

const TONE_TEXT: Record<PitchTone, string> = {
  ok: "text-emerald-700 dark:text-emerald-400",
  done: "text-emerald-700 dark:text-emerald-400",
  soon: "text-amber-700 dark:text-amber-400",
  missed: "text-red-700 dark:text-red-400",
};
const TONE_DOT: Record<PitchTone, string> = {
  ok: "bg-emerald-600 dark:bg-emerald-400",
  done: "bg-emerald-600 dark:bg-emerald-400",
  soon: "bg-amber-500",
  missed: "bg-red-600 dark:bg-red-400",
};

const HEADERS = ["Client Name", "Campaign/Idea", "Revenue Potential", "Client Pres", "Milestone 1", "Milestone 2", "Status", "Lead"];

function QuarterPicker({ quarter, onChange }: { quarter: string; onChange: (quarter: string) => void }) {
  return (
    <div className="flex items-center gap-1 text-sm">
      <span className="mr-1 text-muted-foreground">Quarter</span>
      <Button type="button" variant="outline" size="icon-sm" aria-label="Previous quarter" onClick={() => onChange(shiftQuarter(quarter, -1))}>
        <LuChevronLeft aria-hidden />
      </Button>
      <span className="w-20 text-center font-medium tabular-nums">{quarterLabel(quarter)}</span>
      <Button type="button" variant="outline" size="icon-sm" aria-label="Next quarter" onClick={() => onChange(shiftQuarter(quarter, 1))}>
        <LuChevronRight aria-hidden />
      </Button>
    </div>
  );
}

function ClientCell({ row }: { row: PitchRow }) {
  if (!row.brand) return <span>{row.name.split("_")[0]}</span>;
  const { name, organisation } = row.brand;
  const sameAsOrg = !organisation || name.trim().toLowerCase() === organisation.trim().toLowerCase();
  return (
    <div className="min-w-0">
      {!sameAsOrg && <p className="text-xs text-muted-foreground">{organisation}</p>}
      <Link to={`/brands/${row.brand.id}`} className="font-medium hover:underline">
        {sameAsOrg ? name : shortName(name, organisation)}
      </Link>
    </div>
  );
}

function DateCell({ row, step }: { row: PitchRow; step: PitchStepKey }) {
  const s = row.steps.find((x) => x.key === step);
  if (!s?.due) return <span className="text-muted-foreground">—</span>;
  const missed = row.status.missed.some((m) => m.key === step);
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap tabular-nums", s.done && "text-emerald-700 dark:text-emerald-400", missed && "font-medium text-red-700 dark:text-red-400")}>
      {s.done && <LuCheck aria-label="done" className="size-3.5" />}
      {shortDate(s.due)}
    </span>
  );
}

export function PitchesTab({ quarter, onQuarterChange }: { quarter: string; onQuarterChange: (quarter: string) => void }) {
  const pitches = usePitches(quarter);
  const exporter = usePitchesExport();
  const rows = pitches.data?.rows ?? [];

  return (
    <div className="mx-auto w-full max-w-[96rem] space-y-4 p-4 md:p-6">
      <PageHeader
        title={`Pitches / proactive projects — ${quarterLabel(quarter)}`}
        description="Every pitch with its client presentation and milestones. The status follows the pitch's tasks; missed dates are emailed to the lead, the manager and leadership."
        actions={
          <>
            <QuarterPicker quarter={quarter} onChange={onQuarterChange} />
            <Button type="button" variant="outline" onClick={() => exporter.mutate(quarter)} disabled={exporter.isPending || rows.length === 0}>
              {exporter.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuFileSpreadsheet aria-hidden />}
              Download Excel
            </Button>
          </>
        }
      />

      {pitches.error ? (
        <QueryError title="Couldn't load the pitches" error={pitches.error} onRetry={() => void pitches.refetch()} retrying={pitches.isFetching} />
      ) : pitches.isPending ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon={LuPresentation} title={`No pitches in ${quarterLabel(quarter)}`} description="A pitch shows here when its month or one of its dates falls in the quarter." />
      ) : (
        <div className={cn("overflow-x-auto rounded-xl border bg-card", pitches.isFetching && "opacity-70")}>
          <table className="w-full min-w-[64rem] text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                {HEADERS.map((h) => (
                  <th key={h} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row) => (
                <tr key={row.id} className="align-top hover:bg-muted/30">
                  <td className="w-44 px-3 py-2.5">
                    <ClientCell row={row} />
                  </td>
                  <td className="px-3 py-2.5">
                    <Link to={`/projects/${row.id}`} className="font-medium text-primary underline-offset-2 hover:underline">
                      {row.title}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{row.revenue === null ? <span className="text-muted-foreground">TBC</span> : aed(row.revenue)}</td>
                  <td className="px-3 py-2.5"><DateCell row={row} step="clientPresentation" /></td>
                  <td className="px-3 py-2.5"><DateCell row={row} step="milestone1" /></td>
                  <td className="px-3 py-2.5"><DateCell row={row} step="milestone2" /></td>
                  <td className="min-w-72 px-3 py-2.5">
                    <p className={cn("flex items-start gap-1.5 font-medium", TONE_TEXT[row.status.tone])}>
                      <i aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", TONE_DOT[row.status.tone])} />
                      <span>{row.status.text}</span>
                    </p>
                    {row.note && <p className="mt-0.5 pl-3.5 text-xs text-muted-foreground">{row.note}</p>}
                  </td>
                  <td className="px-3 py-2.5">{row.leads.length ? row.leads.map((l) => l.name).join(", ") : <span className="text-muted-foreground">—</span>}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t-2 bg-muted/30 font-medium">
              <tr>
                <td className="px-3 py-2.5" colSpan={2}>
                  {pitches.data!.totals.count} pitch{pitches.data!.totals.count === 1 ? "" : "es"}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{aed(pitches.data!.totals.revenue)}</td>
                <td className="px-3 py-2.5 text-xs font-normal text-muted-foreground" colSpan={5}>
                  Known revenue only — TBC pitches aren't counted.
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
