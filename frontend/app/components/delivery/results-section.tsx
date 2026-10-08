import type { ReactNode } from "react";

import {
  DASH,
  TONE_TEXT,
  fmtDays,
  fmtNum,
  fmtPct,
  lowRateTone,
  overdueTone,
  rateTone,
  type DeltaUnit,
  type Tone,
} from "@/components/delivery/delivery-format";
import { DeltaPill, DeliverySection, InfoTip } from "@/components/delivery/delivery-ui";
import { QueryError } from "@/components/globals/query-states";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateOnly } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DeliveryDelta, DeliverySummaryResponse } from "@/types";

type SummaryQuery = {
  data: DeliverySummaryResponse | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  isFetching: boolean;
  refetch: () => unknown;
};

function KpiTile({
  label,
  value,
  tone = "neutral",
  delta,
  unit,
  explanation,
  tip,
}: {
  label: string;
  value: string;
  tone?: Tone;
  delta: DeliveryDelta;
  unit: DeltaUnit;
  explanation: string;
  tip?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-xl border bg-card p-4 text-card-foreground">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {label}
          {tip && <InfoTip label={`About ${label}`}>{tip}</InfoTip>}
        </p>
      </div>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <p className={cn("font-heading text-3xl font-semibold tracking-tight tabular-nums", value === DASH ? "text-muted-foreground" : TONE_TEXT[tone])}>
          {value}
        </p>
        <DeltaPill delta={delta} unit={unit} />
      </div>
      <p className="mt-auto pt-2 text-xs leading-snug text-muted-foreground">{explanation}</p>
    </div>
  );
}

/** 1 · Results — KPI tiles with deltas vs the previous period. */
export function ResultsSection({ summary }: { summary: SummaryQuery }) {
  const meta = summary.data?.meta;
  const range = meta
    ? meta.period === "all"
      ? "All time"
      : `${formatDateOnly(meta.range.start)} – ${formatDateOnly(meta.range.end)}`
    : null;

  return (
    <DeliverySection
      id="results"
      index={1}
      title="Results"
      description={
        range && (
          <>
            {range}
            {meta?.previous && (
              <> · compared with {formatDateOnly(meta.previous.start)} – {formatDateOnly(meta.previous.end)}</>
            )}
          </>
        )
      }
    >
      {summary.isPending ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-busy="true" aria-label="Loading KPIs">
          {Array.from({ length: 9 }).map((_, index) => (
            <Skeleton key={index} className="h-32 rounded-xl" />
          ))}
        </div>
      ) : summary.isError || !summary.data ? (
        <QueryError
          title="Couldn't load the summary"
          error={summary.error}
          onRetry={() => void summary.refetch()}
          retrying={summary.isFetching}
        />
      ) : (
        <Kpis data={summary.data} dimmed={summary.isFetching} />
      )}
    </DeliverySection>
  );
}

function Kpis({ data, dimmed }: { data: DeliverySummaryResponse; dimmed: boolean }) {
  const { kpis, deltas } = data;
  const empty = kpis.created === 0 && kpis.completed === 0 && kpis.open === 0;
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-3 transition-opacity duration-200 sm:grid-cols-2 xl:grid-cols-4",
        dimmed && "opacity-70"
      )}
      aria-busy={dimmed}
    >
      <KpiTile
        label="Completed"
        value={empty ? DASH : fmtNum(kpis.completed)}
        delta={deltas.completed}
        unit="count"
        explanation="Tasks marked completed in the period."
      />
      <KpiTile
        label="On time"
        value={fmtPct(kpis.onTimePct)}
        tone={rateTone(kpis.onTimePct)}
        delta={deltas.onTimePct}
        unit="pct"
        explanation={`Done on or before the due date · ${fmtNum(kpis.completedWithDue)} with a due date.`}
        tip={
          <>
            Of tasks completed in the period that have a due date.{" "}
            {kpis.completedNoDue > 0
              ? `${kpis.completedNoDue} completed without a due date ${kpis.completedNoDue === 1 ? "is" : "are"} left out.`
              : "Every completed task had a due date."}
          </>
        }
      />
      <KpiTile
        label="Brief → done"
        value={fmtDays(kpis.meanDays)}
        delta={deltas.meanDays}
        unit="days"
        explanation="Mean calendar days from brief (created) to completed."
      />
      <KpiTile
        label="Mean days start → done"
        value={fmtDays(kpis.startToDoneDays)}
        delta={deltas.startToDoneDays}
        unit="days"
        explanation={`From the actual start to completed · ${fmtNum(kpis.startedCompleted)} of ${fmtNum(kpis.completed)} completed had an actual start.`}
        tip="Tasks completed in the period that have an actual start (set automatically when work starts — first move to In progress, timer or time log — or edited on the task)."
      />
      <KpiTile
        label="Late starts"
        value={fmtPct(kpis.lateStartPct)}
        tone={lowRateTone(kpis.lateStartPct)}
        delta={deltas.lateStartPct}
        unit="pct"
        explanation={`${fmtNum(kpis.lateStarts)} of ${fmtNum(kpis.startsWithPlan)} started after the planned start date.`}
        tip="Of tasks whose actual start falls in the period and that have a planned start date: the share whose actual start date is after the planned one."
      />
      <KpiTile
        label="Rework"
        value={fmtPct(kpis.reworkPct)}
        tone={lowRateTone(kpis.reworkPct)}
        delta={deltas.reworkPct}
        unit="pct"
        explanation={`${fmtNum(kpis.rework)} amends / revisions ÷ ${fmtNum(kpis.created)} tasks created.`}
        tip="A task is rework when its title contains a rework keyword (whole word) or its category is a rework category — see Settings → Delivery."
      />
      <KpiTile
        label="Tasks created"
        value={empty ? DASH : fmtNum(kpis.created)}
        delta={deltas.created}
        unit="count"
        explanation="New briefs (tasks created) in the period."
      />
      <KpiTile
        label="Open now"
        value={fmtNum(kpis.open)}
        delta={deltas.open}
        unit="count"
        explanation="To do, in progress, in review or rejected — vs the start of the period."
      />
      <KpiTile
        label="Overdue now"
        value={fmtNum(kpis.overdue)}
        tone={overdueTone(kpis.overdue, kpis.open)}
        delta={deltas.overdue}
        unit="count"
        explanation="Open and past the due date today — vs the start of the period."
      />
    </div>
  );
}
