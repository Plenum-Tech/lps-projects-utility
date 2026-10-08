import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { LuMap, LuUsers } from "react-icons/lu";

import { BrandName } from "@/components/delivery/brand-dot";
import { CsvButton } from "@/components/delivery/csv-button";
import { CappedNote } from "@/components/delivery/analysis-section";
import { fmtDays, fmtNum, fmtPct, lowRateTone, rateTone, TONE_TEXT, userName } from "@/components/delivery/delivery-format";
import {
  ChartPanel,
  DeliverySection,
  Panel,
  PanelState,
  SortTable,
  type SortColumn,
} from "@/components/delivery/delivery-ui";
import { PersonDrawer } from "@/components/delivery/person-drawer";
import { WeeklyBars, WeeklyLine, WeeklyTable } from "@/components/delivery/weekly-charts";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useDeliveryPeople, useDeliveryTeamMap, useDeliveryWeekly } from "@/hooks/use-delivery";
import { formatDateOnly } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DeliveryFilters, DeliveryPeopleResponse, DeliveryTeamMapResponse } from "@/types";

type PersonRow = DeliveryPeopleResponse["rows"][number];

/** 4 · People — individuals (+ drawer), week by week, team map coverage. */
export function PeopleSection({
  filters,
  isAdmin,
  onOpenTask,
}: {
  filters: DeliveryFilters;
  isAdmin: boolean;
  onOpenTask: (id: string) => void;
}) {
  const people = useDeliveryPeople(filters);
  const weekly = useDeliveryWeekly(filters);
  const teamMap = useDeliveryTeamMap(filters);
  const [person, setPerson] = useState<{ id: string; name: string } | null>(null);
  const weeks = weekly.data?.weeks ?? [];

  return (
    <DeliverySection id="people" index={4} title="People" description="Doers only — traffic managers are left out.">
      <Panel
        title="Individuals"
        description={
          people.data
            ? `People with fewer than ${people.data.minCompletedToRank} completed tasks are not ranked (greyed). Rework share = rework ÷ tasks created in the period. Click a person for details.`
            : "Click a person for their brands, weekly trend and open work."
        }
        action={<CsvButton table="people" filters={filters} disabled={!people.data?.rows.length} />}
      >
        <PanelState
          query={people}
          errorTitle="Couldn't load people"
          isEmpty={people.data?.rows.length === 0}
          emptyIcon={LuUsers}
          emptyTitle="No doers in this view"
          emptyDescription="Nobody had tasks created, completed or open for these filters."
        >
          {() => (
            <PeopleTable
              rows={people.data!.rows}
              onSelect={(row) => row.person.id && setPerson({ id: row.person.id, name: userName(row.person) })}
            />
          )}
        </PanelState>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-3">
        {weekly.isPending ? (
          Array.from({ length: 3 }).map((_, index) => <Skeleton key={index} className="h-72 rounded-xl" />)
        ) : weekly.isError ? (
          <Panel title="Week by week" className="lg:col-span-3">
            <PanelState query={weekly} errorTitle="Couldn't load weekly data">
              {() => null}
            </PanelState>
          </Panel>
        ) : (
          <>
            <ChartPanel
              title="Completed per week"
              description={<CappedNote weekly={weekly.data} />}
              isEmpty={weeks.every((week) => week.completed === 0)}
              emptyText="Nothing completed."
              chart={() => <WeeklyBars weeks={weeks} dataKey="completed" className="h-48" color="var(--chart-1)" />}
              table={() => <WeeklyTable weeks={weeks} columns={[{ key: "completed", format: fmtNum }]} />}
            />
            <ChartPanel
              title="Overdue % by week"
              description="Open and late ÷ open, at each week's end."
              isEmpty={weeks.every((week) => week.overduePct === null)}
              emptyText="No open work to measure."
              chart={() => <WeeklyLine weeks={weeks} dataKey="overduePct" unit="%" className="h-48" color="var(--critical)" />}
              table={() => (
                <WeeklyTable
                  weeks={weeks}
                  columns={[
                    { key: "overduePct", format: fmtPct },
                  ]}
                />
              )}
            />
            <ChartPanel
              title="Rework % by week"
              description="Rework ÷ tasks created that week."
              isEmpty={weeks.every((week) => week.reworkPct === null)}
              emptyText="No tasks created."
              chart={() => <WeeklyLine weeks={weeks} dataKey="reworkPct" unit="%" className="h-48" color="var(--warn)" />}
              table={() => <WeeklyTable weeks={weeks} columns={[{ key: "reworkPct", format: fmtPct }]} />}
            />
          </>
        )}
      </div>

      <Panel
        title="Team map coverage"
        description={
          teamMap.data
            ? `Since ${formatDateOnly(teamMap.data.startDate)} (the period filter doesn't apply) · ${teamMap.data.mappedBrands} mapped ${teamMap.data.mappedBrands === 1 ? "brand" : "brands"}.`
            : "Who works on which brand, against each brand's team map."
        }
        action={
          isAdmin && (
            <Link to="/settings/delivery" className="text-xs font-medium text-primary underline-offset-4 hover:underline">
              Edit team maps
            </Link>
          )
        }
      >
        <PanelState query={teamMap} errorTitle="Couldn't load team map coverage" skeletonHeight="h-40">
          {() => <TeamMapCoverage data={teamMap.data!} />}
        </PanelState>
      </Panel>

      <PersonDrawer
        personId={person?.id ?? null}
        personName={person?.name ?? ""}
        filters={filters}
        onClose={() => setPerson(null)}
        onOpenTask={onOpenTask}
      />
    </DeliverySection>
  );
}

function PeopleTable({ rows, onSelect }: { rows: PersonRow[]; onSelect: (row: PersonRow) => void }) {
  const columns: SortColumn<PersonRow>[] = [
    {
      id: "person",
      header: "Person",
      cell: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2 font-medium">
            {userName(row.person)}
            {!row.ranked && (
              <Badge variant="outline" className="h-4 px-1.5 text-[0.65rem] font-normal">
                not ranked
              </Badge>
            )}
          </span>
          <span className="text-xs text-muted-foreground">{row.person.team.name}</span>
        </span>
      ),
      sortValue: (row) => userName(row.person),
    },
    { id: "completed", header: "Completed", align: "right", cell: (row) => fmtNum(row.completed), sortValue: (row) => row.completed },
    { id: "onTime", header: "On time", align: "right", cell: (row) => <span className={cn(row.ranked && row.onTimePct !== null && TONE_TEXT[rateTone(row.onTimePct)])}>{fmtPct(row.onTimePct)}</span>, sortValue: (row) => row.onTimePct },
    { id: "meanDays", header: "Mean days", align: "right", cell: (row) => fmtDays(row.meanDays), sortValue: (row) => row.meanDays },
    { id: "startToDone", header: "Mean start → done", hint: "Days from the actual start to done, for tasks completed in the period that have an actual start", align: "right", cell: (row) => fmtDays(row.startToDoneDays), sortValue: (row) => row.startToDoneDays },
    { id: "rework", header: "Rework share", hint: "Rework tasks ÷ tasks created in the period", align: "right", cell: (row) => <span className={cn(row.ranked && row.reworkPct !== null && TONE_TEXT[lowRateTone(row.reworkPct)])}>{fmtPct(row.reworkPct)}</span>, sortValue: (row) => row.reworkPct },
    { id: "overdue", header: "Overdue now", align: "right", cell: (row) => <span className={cn(row.ranked && row.overdue > 0 && "text-critical")}>{fmtNum(row.overdue)}</span>, sortValue: (row) => row.overdue },
    { id: "open", header: "Open now", align: "right", cell: (row) => fmtNum(row.open), sortValue: (row) => row.open },
    { id: "brands", header: "Brands", hint: "Distinct brands worked on", align: "right", cell: (row) => fmtNum(row.brandCount), sortValue: (row) => row.brandCount },
  ];
  return (
    <SortTable
      caption="Individuals"
      columns={columns}
      rows={rows}
      getRowId={(row) => row.person.id ?? `former-${row.person.name}`}
      onRowClick={onSelect}
      rowLabel={(row) => `Open details for ${userName(row.person)}`}
      rowClassName={(row) => (row.ranked ? undefined : "text-muted-foreground opacity-75")}
    />
  );
}

function TeamMapCoverage({ data }: { data: DeliveryTeamMapResponse }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <CoverageList
        title="Off-map"
        hint="Completed tasks done by people who aren't on that brand's map."
        empty={data.mappedBrands === 0 ? "No brand has a team map yet." : "All completed work was done by mapped people."}
        count={data.offMap.reduce((sum, item) => sum + item.total, 0)}
        tone="critical"
      >
        {data.offMap.map((item) => (
          <li key={item.brand.id} className="space-y-1.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <BrandName name={item.brand.name} color={item.brand.color} noBrand={item.brand.noBrand} className="text-sm font-medium" />
              <span className="text-xs tabular-nums text-muted-foreground">{item.total} tasks</span>
            </div>
            <ul className="flex flex-wrap gap-1">
              {item.people.map((entry) => (
                <li
                  key={entry.person.id ?? entry.person.name}
                  className="inline-flex h-6 items-center gap-1 rounded-full border bg-muted/40 px-2 text-xs"
                >
                  {userName(entry.person)}
                  <span className="font-medium tabular-nums text-critical">×{entry.count}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </CoverageList>

      <CoverageList
        title="Mapped but unused"
        hint="People on a brand's map with no tasks on that brand."
        empty="Everyone on a map has worked on their brand."
        count={data.mappedUnused.reduce((sum, item) => sum + item.people.length, 0)}
        tone="warn"
      >
        {data.mappedUnused.map((item) => (
          <li key={item.brand.id} className="space-y-1.5 py-2">
            <BrandName name={item.brand.name} color={item.brand.color} className="text-sm font-medium" />
            <p className="text-xs text-muted-foreground">{item.people.map(userName).join(", ")}</p>
          </li>
        ))}
      </CoverageList>

      <CoverageList
        title="Unmapped brands"
        hint="Active brands with no team map."
        empty="Every active brand has a team map."
        count={data.unmappedBrands.length}
        tone="neutral"
      >
        {data.unmappedBrands.map((item) => (
          <li key={item.brand.id} className="flex items-center justify-between gap-2 py-2">
            <BrandName name={item.brand.name} color={item.brand.color} className="text-sm" />
            <span className="text-xs tabular-nums text-muted-foreground">{item.tasks} tasks</span>
          </li>
        ))}
      </CoverageList>
    </div>
  );
}

function CoverageList({
  title,
  hint,
  empty,
  count,
  tone,
  children,
}: {
  title: string;
  hint: string;
  empty: string;
  count: number;
  tone: "critical" | "warn" | "neutral";
  children: ReactNode[];
}) {
  return (
    <section aria-label={title} className="min-w-0 rounded-lg border p-3">
      <h3 className="flex items-center justify-between gap-2 text-sm font-medium">
        {title}
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-xs tabular-nums",
            count === 0 ? "bg-muted text-muted-foreground" : tone === "critical" ? "bg-critical/10 text-critical" : tone === "warn" ? "bg-warn/10 text-warn" : "bg-muted text-foreground"
          )}
        >
          {count}
        </span>
      </h3>
      <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      {children.length === 0 ? (
        <p className="mt-3 flex items-center gap-2 rounded-md border border-dashed px-3 py-3 text-xs text-muted-foreground">
          <LuMap aria-hidden className="size-4 shrink-0" />
          {empty}
        </p>
      ) : (
        <ul className="mt-1 max-h-72 divide-y overflow-auto">{children}</ul>
      )}
    </section>
  );
}
