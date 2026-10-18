import { LuTags, LuUsers } from "react-icons/lu";

import { BrandName } from "@/components/delivery/brand-dot";
import {
  fmtDays,
  fmtNum,
  fmtPct,
  lowRateTone,
  rateTone,
  TONE_TEXT,
} from "@/components/delivery/delivery-format";
import {
  ChartPanel,
  DeliverySection,
  DeltaPill,
  Panel,
  PanelState,
  ScorePill,
  SortTable,
  TonePill,
  VolumeBar,
  type SortColumn,
} from "@/components/delivery/delivery-ui";
import { CsvButton } from "@/components/delivery/csv-button";
import { WeeklyBars, WeeklyLines, WeeklyTable } from "@/components/delivery/weekly-charts";
import { Skeleton } from "@/components/ui/skeleton";
import { useDeliveryBrands, useDeliveryTeams, useDeliveryWeekly } from "@/hooks/use-delivery";
import { cn } from "@/lib/utils";
import type {
  DeliveryBrandRow,
  DeliveryDelta,
  DeliveryFilters,
  DeliveryPerformer,
  DeliveryTeamRow,
  DeliveryWeeklyResponse,
} from "@/types";

export function CappedNote({ weekly }: { weekly: DeliveryWeeklyResponse | undefined }) {
  if (!weekly?.capped) return null;
  return <span>Showing the latest {weekly.maxWeeks} weeks.</span>;
}

/** 2 · Analysis — throughput & speed, teams, brands, brand movement. */
export function AnalysisSection({ filters }: { filters: DeliveryFilters }) {
  const weekly = useDeliveryWeekly(filters);
  const teams = useDeliveryTeams(filters);
  const brands = useDeliveryBrands(filters);
  const weeks = weekly.data?.weeks ?? [];

  return (
    <DeliverySection id="analysis" index={2} title="Analysis" description="Throughput, speed and where the work goes.">
      <div className="grid gap-4 lg:grid-cols-2">
        {weekly.isPending || weekly.isError ? (
          <>
            <Panel title="Completed per week">
              <PanelState query={weekly} errorTitle="Couldn't load weekly data" skeletonHeight="h-56">
                {() => null}
              </PanelState>
            </Panel>
            {weekly.isPending && <Skeleton className="h-80 rounded-xl" />}
          </>
        ) : (
          <>
            <ChartPanel
              title="Completed per week"
              description={<>Tasks completed each week (Mon–Sun). <CappedNote weekly={weekly.data} /></>}
              isEmpty={weeks.every((week) => week.completed === 0)}
              emptyText="Nothing was completed in this period."
              chart={() => <WeeklyBars weeks={weeks} dataKey="completed" />}
              table={() => <WeeklyTable weeks={weeks} columns={[{ key: "completed", format: fmtNum }]} />}
            />
            <ChartPanel
              title="Mean days to done"
              description="Average calendar days to completion, by completion week: from the brief (created) and from the actual start."
              isEmpty={weeks.every((week) => week.meanDays === null && week.startToDoneDays === null)}
              emptyText="No completed tasks to measure."
              chart={() => (
                <WeeklyLines
                  weeks={weeks}
                  unit="d"
                  series={[
                    { key: "meanDays", label: "Brief → done", color: "var(--chart-2)" },
                    { key: "startToDoneDays", label: "Start → done", color: "var(--chart-4)" },
                  ]}
                />
              )}
              table={() => (
                <WeeklyTable
                  weeks={weeks}
                  columns={[
                    { key: "meanDays", format: fmtDays },
                    { key: "startToDoneDays", format: fmtDays },
                  ]}
                />
              )}
            />
          </>
        )}
      </div>

      <Panel
        title="Teams"
        description={`By the doer's department. A task with doers in several teams counts once for each; tasks assigned only to traffic managers fall under “Other”. Rework share = rework ÷ tasks created in the period. Best / bottom performer: ranked within the team on on-time rate, mean days, rework share, overdue and volume — people with fewer than ${teams.data?.minCompletedToRank ?? 5} completed tasks are not ranked.`}
        action={<CsvButton table="teams" filters={filters} disabled={!teams.data?.rows.length} />}
      >
        <PanelState
          query={teams}
          errorTitle="Couldn't load teams"
          isEmpty={teams.data?.rows.length === 0}
          emptyIcon={LuUsers}
          emptyTitle="No teams to show"
          emptyDescription="Choose dashboard teams in Settings → Delivery, or widen the filters."
        >
          {() => <TeamsTable rows={teams.data!.rows} minCompleted={teams.data!.minCompletedToRank ?? 5} />}
        </PanelState>
      </Panel>

      <Panel
        title="Brands"
        description="A task's brand is its project's brand. Tasks in archived projects are still counted. Brief quality = mean LPS brief score (0–100) of the brand's tasks created in the period."
        action={<CsvButton table="brands" filters={filters} disabled={!brands.data?.rows.length} />}
      >
        <PanelState
          query={brands}
          errorTitle="Couldn't load brands"
          isEmpty={brands.data?.rows.length === 0}
          emptyIcon={LuTags}
          emptyTitle="No brand activity"
          emptyDescription="No tasks were created, completed or open for any brand in this period."
        >
          {() => <BrandsTable rows={brands.data!.rows} />}
        </PanelState>
      </Panel>

      <Panel
        title="Brand movement"
        description="This period vs the previous one of the same length: now, what it was, and the change (green is better, red is worse). Warning signs = rework up, on time down, overdue up."
      >
        <PanelState
          query={brands}
          errorTitle="Couldn't load brands"
          isEmpty={brands.data?.rows.length === 0 || brands.data?.meta.period === "all"}
          emptyIcon={LuTags}
          emptyTitle={brands.data?.meta.period === "all" ? "No previous period for “All”" : "No brand activity"}
          emptyDescription={
            brands.data?.meta.period === "all"
              ? "Pick 7d, 30d, 90d or 12m to compare with the period before."
              : "Nothing to compare in this period."
          }
        >
          {() => <MovementTable rows={brands.data!.rows} />}
        </PanelState>
      </Panel>
    </DeliverySection>
  );
}

const pctCell = (value: number | null, tone: (v: number | null) => keyof typeof TONE_TEXT) => (
  <span className={cn(value !== null && TONE_TEXT[tone(value)])}>{fmtPct(value)}</span>
);

function PerformerCell({ performer, minCompleted }: { performer: DeliveryPerformer | null; minCompleted: number }) {
  if (!performer) {
    return <span className="text-xs text-muted-foreground">— (fewer than 2 people with {minCompleted}+ tasks)</span>;
  }
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate font-medium">{performer.person.former ? "Former user" : performer.person.name}</span>
      <span className="text-xs text-muted-foreground">{performer.why}</span>
    </span>
  );
}

function TeamsTable({ rows, minCompleted }: { rows: DeliveryTeamRow[]; minCompleted: number }) {
  const max = Math.max(0, ...rows.map((row) => row.volume));
  const columns: SortColumn<DeliveryTeamRow>[] = [
    { id: "team", header: "Team", cell: (row) => <span className="font-medium">{row.team.name}</span>, sortValue: (row) => row.team.name },
    { id: "people", header: "People", hint: "People in the team with work in the period", align: "right", cell: (row) => fmtNum(row.people), sortValue: (row) => row.people },
    { id: "completed", header: "Completed", align: "right", cell: (row) => fmtNum(row.completed), sortValue: (row) => row.completed },
    { id: "onTime", header: "On time", align: "right", cell: (row) => pctCell(row.onTimePct, (v) => rateTone(v)), sortValue: (row) => row.onTimePct },
    { id: "meanDays", header: "Mean days", align: "right", cell: (row) => fmtDays(row.meanDays), sortValue: (row) => row.meanDays },
    { id: "meanDays30", header: "Mean days · 30d", hint: "Brief → done for tasks completed in the last 30 days, whatever the period", align: "right", cell: (row) => fmtDays(row.meanDays30), sortValue: (row) => row.meanDays30 },
    { id: "startToDone", header: "Mean start → done", hint: "Days from the actual start to done, for tasks completed in the period that have an actual start", align: "right", cell: (row) => fmtDays(row.startToDoneDays), sortValue: (row) => row.startToDoneDays },
    { id: "rework", header: "Rework share", hint: "Rework tasks ÷ tasks created in the period", align: "right", cell: (row) => pctCell(row.reworkPct, (v) => lowRateTone(v)), sortValue: (row) => row.reworkPct },
    { id: "overdue", header: "Overdue now", align: "right", cell: (row) => <span className={cn(row.overdue > 0 && "text-critical")}>{fmtNum(row.overdue)}</span>, sortValue: (row) => row.overdue },
    { id: "open", header: "Open", align: "right", cell: (row) => fmtNum(row.open), sortValue: (row) => row.open },
    {
      id: "volume",
      header: "Volume",
      hint: "Completed in the period, relative to the busiest team",
      className: "w-40",
      cell: (row) => <VolumeBar value={row.volume} max={max} label={`${row.volume} completed`} />,
      sortValue: (row) => row.volume,
    },
    {
      id: "best",
      header: "Best performer",
      className: "min-w-44",
      cell: (row) => <PerformerCell performer={row.best} minCompleted={minCompleted} />,
      sortValue: (row) => row.best?.person.name ?? null,
    },
    {
      id: "bottom",
      header: "Bottom performer",
      className: "min-w-44",
      cell: (row) => <PerformerCell performer={row.bottom} minCompleted={minCompleted} />,
      sortValue: (row) => row.bottom?.person.name ?? null,
    },
  ];
  return <SortTable caption="Teams" columns={columns} rows={rows} getRowId={(row) => row.team.id} defaultSort="completed" />;
}

function brandCell(row: DeliveryBrandRow) {
  return (
    <BrandName
      name={row.brand.name}
      color={row.brand.color}
      noBrand={row.brand.noBrand}
      active={row.brand.active}
      className="max-w-48 font-medium"
    />
  );
}

function BrandsTable({ rows }: { rows: DeliveryBrandRow[] }) {
  const columns: SortColumn<DeliveryBrandRow>[] = [
    { id: "brand", header: "Brand", cell: brandCell, sortValue: (row) => row.brand.name },
    { id: "created", header: "Created", align: "right", cell: (row) => fmtNum(row.created), sortValue: (row) => row.created },
    { id: "completed", header: "Completed", align: "right", cell: (row) => fmtNum(row.completed), sortValue: (row) => row.completed },
    { id: "onTime", header: "On time", align: "right", cell: (row) => pctCell(row.onTimePct, (v) => rateTone(v)), sortValue: (row) => row.onTimePct },
    { id: "meanDays", header: "Mean days", align: "right", cell: (row) => fmtDays(row.meanDays), sortValue: (row) => row.meanDays },
    { id: "rework", header: "Rework", hint: "Rework tasks ÷ tasks created in the period", align: "right", cell: (row) => pctCell(row.reworkPct, (v) => lowRateTone(v)), sortValue: (row) => row.reworkPct },
    { id: "overdue", header: "Overdue now", align: "right", cell: (row) => <span className={cn(row.overdue > 0 && "text-critical")}>{fmtNum(row.overdue)}</span>, sortValue: (row) => row.overdue },
    {
      id: "briefScore",
      header: "Brief quality",
      hint: "Mean LPS brief score (0–100) of the brand's tasks created in the period — see Actions → Brief coverage",
      align: "right",
      cell: (row) => <ScorePill score={row.briefScore ?? null} title={`${row.briefsScored ?? 0} briefs scored`} />,
      sortValue: (row) => row.briefScore ?? null,
    },
  ];
  return <SortTable caption="Brands" columns={columns} rows={rows} getRowId={(row) => row.brand.id} defaultSort="completed" />;
}

const WARNING_LABELS = { reworkUp: "rework up", onTimeDown: "on time down", overdueUp: "overdue up" } as const;

function WarningCell({ warnings }: { warnings: DeliveryBrandRow["warnings"] }) {
  if (!warnings) return <span className="text-xs text-muted-foreground">—</span>;
  const title = warnings.flags.length ? warnings.flags.map((f) => WARNING_LABELS[f]).join(", ") : "No warning signs";
  if (warnings.count === 0) {
    return (
      <TonePill tone="good" title={title}>
        none
      </TonePill>
    );
  }
  return (
    <TonePill tone={warnings.count >= 2 ? "critical" : "warn"} title={title}>
      {warnings.count} of 3
    </TonePill>
  );
}

function MovementTable({ rows }: { rows: DeliveryBrandRow[] }) {
  const change = (row: DeliveryBrandRow, key: keyof NonNullable<DeliveryBrandRow["deltas"]>) =>
    row.deltas?.[key]?.change ?? null;
  const columns: SortColumn<DeliveryBrandRow>[] = [
    { id: "brand", header: "Brand", cell: brandCell, sortValue: (row) => row.brand.name },
    { id: "created", header: "Tasks briefed", hint: "Tasks created in each period", align: "right", cell: (row) => <Moved value={row.created} delta={row.deltas?.created} unit="count" format={fmtNum} />, sortValue: (row) => change(row, "created") },
    { id: "overdue", header: "Overdue", hint: "Open and late at the end of each period (lower is better)", align: "right", cell: (row) => <Moved value={row.overdue} delta={row.deltas?.overdue} unit="count" format={fmtNum} />, sortValue: (row) => change(row, "overdue") },
    { id: "rework", header: "Rework %", align: "right", cell: (row) => <Moved value={row.reworkPct} delta={row.deltas?.reworkPct} unit="pct" format={fmtPct} />, sortValue: (row) => change(row, "reworkPct") },
    { id: "onTime", header: "On time %", align: "right", cell: (row) => <Moved value={row.onTimePct} delta={row.deltas?.onTimePct} unit="pct" format={fmtPct} />, sortValue: (row) => change(row, "onTimePct") },
    { id: "completed", header: "Completed", align: "right", cell: (row) => <Moved value={row.completed} delta={row.deltas?.completed} unit="count" format={fmtNum} />, sortValue: (row) => change(row, "completed") },
    { id: "meanDays", header: "Mean days", align: "right", cell: (row) => <Moved value={row.meanDays} delta={row.deltas?.meanDays} unit="days" format={fmtDays} />, sortValue: (row) => change(row, "meanDays") },
    {
      id: "warnings",
      header: "Warning signs",
      hint: "Rework up, on time down, overdue up — vs the previous period",
      cell: (row) => <WarningCell warnings={row.warnings ?? null} />,
      sortValue: (row) => row.warnings?.count ?? null,
    },
  ];
  return <SortTable caption="Brand movement vs previous period" columns={columns} rows={rows} getRowId={(row) => row.brand.id} defaultSort="created" />;
}

/** "now  was X  ▲ delta". */
function Moved({
  value,
  delta,
  unit,
  format,
}: {
  value: number | null;
  delta: DeliveryDelta | undefined;
  unit: "count" | "pct" | "days";
  format: (value: number | null) => string;
}) {
  const was = delta && !delta.noPreviousData ? delta.previous : null;
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="font-medium tabular-nums">{format(value)}</span>
      {was !== null && <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">was {format(was)}</span>}
      <DeltaPill delta={delta} unit={unit} compact />
    </span>
  );
}
