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
  SortTable,
  VolumeBar,
  type SortColumn,
} from "@/components/delivery/delivery-ui";
import { CsvButton } from "@/components/delivery/csv-button";
import { WeeklyBars, WeeklyLine, WeeklyTable } from "@/components/delivery/weekly-charts";
import { Skeleton } from "@/components/ui/skeleton";
import { useDeliveryBrands, useDeliveryTeams, useDeliveryWeekly } from "@/hooks/use-delivery";
import { cn } from "@/lib/utils";
import type { DeliveryBrandRow, DeliveryFilters, DeliveryTeamRow, DeliveryWeeklyResponse } from "@/types";

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
              title="Mean days brief → done"
              description="Average calendar days from creation to completion, by completion week."
              isEmpty={weeks.every((week) => week.meanDays === null)}
              emptyText="No completed tasks to measure."
              chart={() => <WeeklyLine weeks={weeks} dataKey="meanDays" unit="d" color="var(--chart-2)" />}
              table={() => <WeeklyTable weeks={weeks} columns={[{ key: "meanDays", format: fmtDays }]} />}
            />
          </>
        )}
      </div>

      <Panel
        title="Teams"
        description="By the doer's department. A task with doers in several teams counts once for each; tasks assigned only to traffic managers fall under “Other”. Rework share = rework ÷ tasks created in the period."
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
          {() => <TeamsTable rows={teams.data!.rows} />}
        </PanelState>
      </Panel>

      <Panel
        title="Brands"
        description="A task's brand is its project's brand. Tasks in archived projects are still counted."
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
        description="Change vs the previous period of the same length. Green is better, red is worse."
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

function TeamsTable({ rows }: { rows: DeliveryTeamRow[] }) {
  const max = Math.max(0, ...rows.map((row) => row.volume));
  const columns: SortColumn<DeliveryTeamRow>[] = [
    { id: "team", header: "Team", cell: (row) => <span className="font-medium">{row.team.name}</span>, sortValue: (row) => row.team.name },
    { id: "completed", header: "Completed", align: "right", cell: (row) => fmtNum(row.completed), sortValue: (row) => row.completed },
    { id: "onTime", header: "On time", align: "right", cell: (row) => pctCell(row.onTimePct, (v) => rateTone(v)), sortValue: (row) => row.onTimePct },
    { id: "meanDays", header: "Mean days", align: "right", cell: (row) => fmtDays(row.meanDays), sortValue: (row) => row.meanDays },
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
  ];
  return <SortTable caption="Brands" columns={columns} rows={rows} getRowId={(row) => row.brand.id} defaultSort="completed" />;
}

function MovementTable({ rows }: { rows: DeliveryBrandRow[] }) {
  const change = (row: DeliveryBrandRow, key: keyof NonNullable<DeliveryBrandRow["deltas"]>) =>
    row.deltas?.[key]?.change ?? null;
  const columns: SortColumn<DeliveryBrandRow>[] = [
    { id: "brand", header: "Brand", cell: brandCell, sortValue: (row) => row.brand.name },
    { id: "created", header: "Created", align: "right", cell: (row) => <Moved value={fmtNum(row.created)} delta={row.deltas?.created} unit="count" />, sortValue: (row) => change(row, "created") },
    { id: "completed", header: "Completed", align: "right", cell: (row) => <Moved value={fmtNum(row.completed)} delta={row.deltas?.completed} unit="count" />, sortValue: (row) => change(row, "completed") },
    { id: "onTime", header: "On time", align: "right", cell: (row) => <Moved value={fmtPct(row.onTimePct)} delta={row.deltas?.onTimePct} unit="pct" />, sortValue: (row) => change(row, "onTimePct") },
    { id: "meanDays", header: "Mean days", align: "right", cell: (row) => <Moved value={fmtDays(row.meanDays)} delta={row.deltas?.meanDays} unit="days" />, sortValue: (row) => change(row, "meanDays") },
    { id: "rework", header: "Rework", align: "right", cell: (row) => <Moved value={fmtPct(row.reworkPct)} delta={row.deltas?.reworkPct} unit="pct" />, sortValue: (row) => change(row, "reworkPct") },
    { id: "overdue", header: "Overdue now", align: "right", cell: (row) => <Moved value={fmtNum(row.overdue)} delta={row.deltas?.overdue} unit="count" />, sortValue: (row) => change(row, "overdue") },
  ];
  return <SortTable caption="Brand movement vs previous period" columns={columns} rows={rows} getRowId={(row) => row.brand.id} defaultSort="completed" />;
}

function Moved({ value, delta, unit }: { value: string; delta: Parameters<typeof DeltaPill>[0]["delta"]; unit: "count" | "pct" | "days" }) {
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="tabular-nums">{value}</span>
      <DeltaPill delta={delta} unit={unit} compact />
    </span>
  );
}
