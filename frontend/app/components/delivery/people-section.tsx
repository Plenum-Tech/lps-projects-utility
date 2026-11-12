import { useState, type ReactNode } from "react";
import { namingMonthLabel } from "@/lib/projects";
import { Link } from "react-router";
import { LuChevronDown, LuChevronRight, LuMap, LuUsers } from "react-icons/lu";

import { BrandName } from "@/components/delivery/brand-dot";
import { CsvButton } from "@/components/delivery/csv-button";
import { CappedNote } from "@/components/delivery/analysis-section";
import {
  fmtDays,
  fmtNum,
  fmtPct,
  fmtReworkSplit,
  lowRateTone,
  rateTone,
  TONE_TEXT,
  userName,
} from "@/components/delivery/delivery-format";
import {
  ChartPanel,
  DeliverySection,
  Panel,
  PanelState,
  SortTable,
  type SortColumn,
} from "@/components/delivery/delivery-ui";
import { PersonDrawer } from "@/components/delivery/person-drawer";
import { TrafficDesk } from "@/components/delivery/traffic-desk";
import {
  WeeklyBars,
  WeeklyLine,
  WeeklyTable,
} from "@/components/delivery/weekly-charts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useDeliveryBrandStructure,
  useDeliveryPeople,
  useDeliveryTeamMap,
  useDeliveryTraffic,
  useDeliveryWeekly,
} from "@/hooks/use-delivery";
import { formatDateOnly } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  DeliveryFilters,
  DeliveryPeopleResponse,
  DeliveryBrandStructureResponse,
  DeliveryStructureBrand,
  DeliveryStructureProject,
  DeliveryTeamMapResponse,
  DeliveryTeamMapWorker,
  DeliveryUserRef,
} from "@/types";

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
  const traffic = useDeliveryTraffic(filters);
  const structure = useDeliveryBrandStructure(filters);
  const [person, setPerson] = useState<{ id: string; name: string } | null>(
    null,
  );
  const weeks = weekly.data?.weeks ?? [];

  return (
    <DeliverySection
      id="people"
      index={4}
      title="People"
      description="Doers only — traffic managers are left out."
    >
      <Panel
        title="Individuals"
        description={
          people.data
            ? `People with fewer than ${people.data.minCompletedToRank} completed tasks are not ranked (greyed). Rework share = rework ÷ tasks created in the period. Click a person for details.`
            : "Click a person for their brands, weekly trend and open work."
        }
        action={
          <CsvButton
            table="people"
            filters={filters}
            disabled={!people.data?.rows.length}
          />
        }
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
              onSelect={(row) =>
                row.person.id &&
                setPerson({ id: row.person.id, name: userName(row.person) })
              }
            />
          )}
        </PanelState>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-3">
        {weekly.isPending ? (
          Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-72 rounded-xl" />
          ))
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
              chart={() => (
                <WeeklyBars
                  weeks={weeks}
                  dataKey="completed"
                  className="h-48"
                  color="var(--chart-1)"
                />
              )}
              table={() => (
                <WeeklyTable
                  weeks={weeks}
                  columns={[{ key: "completed", format: fmtNum }]}
                />
              )}
            />
            <ChartPanel
              title="Overdue % by week"
              description="Open and late ÷ open, at each week's end."
              isEmpty={weeks.every((week) => week.overduePct === null)}
              emptyText="No open work to measure."
              chart={() => (
                <WeeklyLine
                  weeks={weeks}
                  dataKey="overduePct"
                  unit="%"
                  className="h-48"
                  color="var(--critical)"
                />
              )}
              table={() => (
                <WeeklyTable
                  weeks={weeks}
                  columns={[{ key: "overduePct", format: fmtPct }]}
                />
              )}
            />
            <ChartPanel
              title="Rework % by week"
              description="Rework ÷ tasks created that week."
              isEmpty={weeks.every((week) => week.reworkPct === null)}
              emptyText="No tasks created."
              chart={() => (
                <WeeklyLine
                  weeks={weeks}
                  dataKey="reworkPct"
                  unit="%"
                  className="h-48"
                  color="var(--warn)"
                />
              )}
              table={() => (
                <WeeklyTable
                  weeks={weeks}
                  columns={[{ key: "reworkPct", format: fmtPct }]}
                />
              )}
            />
          </>
        )}
      </div>

      <Panel
        title="Brands › projects › people"
        description={
          structure.data
            ? `${structure.data.totals.brands} brands · ${structure.data.totals.projects} projects · ${structure.data.totals.tasks} tasks active in the period (${structure.data.totals.open} open). Expand a brand, then a project, to see its tasks and who is assigned.`
            : "Each brand's projects, their tasks and the people assigned."
        }
      >
        <PanelState
          query={structure}
          errorTitle="Couldn't load the brand structure"
          skeletonHeight="h-40"
        >
          {() => <BrandStructure data={structure.data!} />}
        </PanelState>
      </Panel>

      <Panel
        title="Traffic desk"
        description="Tasks that come in via a traffic manager count as the team member's job once assigned onwards. Waiting = open tasks still sitting only with a traffic manager. Time to assign runs from creation to the first team assignee (tracked for tasks created from 12 Oct 2026)."
        action={
          isAdmin && (
            <Link to="/settings/delivery" className="text-xs font-medium text-primary underline-offset-4 hover:underline">
              Traffic managers
            </Link>
          )
        }
      >
        <PanelState query={traffic} errorTitle="Couldn't load the traffic desk" skeletonHeight="h-40">
          {() => <TrafficDesk data={traffic.data!} />}
        </PanelState>
      </Panel>

      <Panel
        title="Team map coverage"
        description={
          teamMap.data
            ? `Tasks allocated in the period (${formatDateOnly(teamMap.data.range.start)} – ${formatDateOnly(teamMap.data.range.end)}; routed on from traffic, else created), each checked against the manpower plan version that was live on the day it was allocated: the people on its project line (else on its brand). Brands or months without a plan use the brand's team map (${teamMap.data.mappedBrands} configured, ${teamMap.data.derivedBrands} derived from project members). Off-map = done only by people not listed. Only brands with tasks in the period, busiest first.`
            : "Who works on which brand, against each brand's team map."
        }
        action={
          isAdmin && (
            <Link
              to="/settings/delivery"
              className="text-xs font-medium text-primary underline-offset-4 hover:underline"
            >
              Edit team maps
            </Link>
          )
        }
      >
        <PanelState
          query={teamMap}
          errorTitle="Couldn't load team map coverage"
          skeletonHeight="h-40"
        >
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

function PeopleTable({
  rows,
  onSelect,
}: {
  rows: PersonRow[];
  onSelect: (row: PersonRow) => void;
}) {
  const columns: SortColumn<PersonRow>[] = [
    {
      id: "person",
      header: "Person",
      cell: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2 font-medium">
            {userName(row.person)}
            {!row.ranked && (
              <Badge
                variant="outline"
                className="h-4 px-1.5 text-[0.65rem] font-normal"
              >
                not ranked
              </Badge>
            )}
          </span>
          {row.person.designation && (
            <span className="text-xs text-foreground/80">
              {row.person.designation}
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            {row.person.team.name}
          </span>
        </span>
      ),
      sortValue: (row) => userName(row.person),
    },
    {
      id: "completed",
      header: "Completed",
      align: "right",
      cell: (row) => fmtNum(row.completed),
      sortValue: (row) => row.completed,
    },
    {
      id: "thisWeek",
      header: "This week",
      hint: "Completed in the last 7 days, whatever the period",
      align: "right",
      cell: (row) => fmtNum(row.completedThisWeek),
      sortValue: (row) => row.completedThisWeek,
    },
    {
      id: "last30",
      header: "30 days",
      hint: "Completed in the last 30 days, whatever the period",
      align: "right",
      cell: (row) => fmtNum(row.completed30d),
      sortValue: (row) => row.completed30d,
    },
    {
      id: "onTime",
      header: "On time",
      align: "right",
      cell: (row) => (
        <span
          className={cn(
            row.ranked &&
              row.onTimePct !== null &&
              TONE_TEXT[rateTone(row.onTimePct)],
          )}
        >
          {fmtPct(row.onTimePct)}
        </span>
      ),
      sortValue: (row) => row.onTimePct,
    },
    {
      id: "meanDays",
      header: "Mean days",
      align: "right",
      cell: (row) => fmtDays(row.meanDays),
      sortValue: (row) => row.meanDays,
    },
    {
      id: "startToDone",
      header: "Mean start → done",
      hint: "Days from the actual start to done, for tasks completed in the period that have an actual start",
      align: "right",
      cell: (row) => fmtDays(row.startToDoneDays),
      sortValue: (row) => row.startToDoneDays,
    },
    {
      id: "rework",
      header: "Rework share",
      hint: "Rework tasks ÷ tasks created in the period",
      align: "right",
      cell: (row) => (
        <span
          className={cn(
            row.ranked &&
              row.reworkPct !== null &&
              TONE_TEXT[lowRateTone(row.reworkPct)],
          )}
        >
          {fmtPct(row.reworkPct)}
        </span>
      ),
      sortValue: (row) => row.reworkPct,
    },
    {
      id: "reworkSplit",
      header: "Rework by review",
      hint: "Rework tasks created in the period: internal (our review), external (the client's), not set (older reworks)",
      align: "right",
      cell: (row) => <span className="whitespace-nowrap text-muted-foreground">{fmtReworkSplit(row)}</span>,
      sortValue: (row) => row.reworkExternal,
    },
    {
      id: "overdue",
      header: "Overdue now",
      align: "right",
      cell: (row) => (
        <span className={cn(row.ranked && row.overdue > 0 && "text-critical")}>
          {fmtNum(row.overdue)}
        </span>
      ),
      sortValue: (row) => row.overdue,
    },
    {
      id: "open",
      header: "Open now",
      align: "right",
      cell: (row) => fmtNum(row.open),
      sortValue: (row) => row.open,
    },
    {
      id: "brands",
      header: "Brands",
      hint: "Distinct brands worked on",
      align: "right",
      cell: (row) => fmtNum(row.brandCount),
      sortValue: (row) => row.brandCount,
    },
  ];
  return (
    <SortTable
      caption="Individuals"
      columns={columns}
      rows={rows}
      getRowId={(row) => row.person.id ?? `former-${row.person.name}`}
      onRowClick={onSelect}
      rowLabel={(row) => `Open details for ${userName(row.person)}`}
      rowClassName={(row) =>
        row.ranked ? undefined : "text-muted-foreground opacity-75"
      }
    />
  );
}

function TeamMapCoverage({ data }: { data: DeliveryTeamMapResponse }) {
  const [search, setSearch] = useState("");
  const [offMapOnly, setOffMapOnly] = useState(false);
  const [source, setSource] = useState<"all" | "plan" | "map">("all");
  const q = search.trim().toLowerCase();
  const rows = data.rows.filter(
    (r) =>
      (!q || r.brand.name.toLowerCase().includes(q)) &&
      (!offMapOnly || (r.offMapTasks ?? 0) > 0) &&
      (source === "all" || (source === "plan" ? r.planVersions.length > 0 : r.planVersions.length === 0)),
  );
  const names = (list: DeliveryUserRef[]) => list.map(userName).join(", ");
  const counted = (list: DeliveryTeamMapWorker[]) =>
    list.map((w) => `${userName(w.person)} (${w.count})`).join(", ");
  const versionLabel = (v: string) => {
    const [month, version] = v.split(" ");
    return `${namingMonthLabel(month!)} ${version}`;
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search brands…"
          aria-label="Search brands"
          className="h-8 w-56"
        />
        <div className="flex items-center gap-2">
          <Switch id="team-map-offmap" checked={offMapOnly} onCheckedChange={setOffMapOnly} />
          <Label htmlFor="team-map-offmap" className="text-sm">
            Only brands with off-map tasks
          </Label>
        </div>
        <div className="flex items-center gap-1 text-xs" role="group" aria-label="Map source">
          {(
            [
              ["all", "All"],
              ["plan", "Manpower plan"],
              ["map", "Team map only"],
            ] as const
          ).map(([value, label]) => (
            <Button key={value} size="sm" variant={source === value ? "secondary" : "ghost"} className="h-7 px-2 text-xs" onClick={() => setSource(value)}>
              {label}
            </Button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">
          {rows.length} of {data.rows.length} brands · {data.totals.tasks} tasks · {data.totals.offMapTasks} off map
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {data.rows.length === 0 ? "No brand had tasks allocated in this period." : "No brands match the filters."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[1100px] text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Brand</th>
                <th className="px-3 py-2 text-right">Tasks in period</th>
                <th className="px-3 py-2">Off-map tasks</th>
                <th className="px-3 py-2">On map and working it</th>
                <th className="px-3 py-2">Off map but working it</th>
                <th className="px-3 py-2">Mapped but unused</th>
              </tr>
            </thead>
            <tbody className="divide-y align-top">
              {rows.map((row) => (
                <tr key={row.brand.id}>
                  <td className="px-3 py-2">
                    <BrandName name={row.brand.name} color={row.brand.color} noBrand={row.brand.noBrand} className="font-medium" />
                    <p className="mt-0.5 max-w-56 text-xs text-muted-foreground">
                      {row.mapped.length ? names(row.mapped) : "No team map"}
                      {row.derived && row.mapped.length > 0 && <span title="Derived from the brand's project members"> · from projects</span>}
                    </p>
                    {row.planVersions.length > 0 && (
                      <p className="mt-0.5 max-w-56 text-xs text-muted-foreground" title="Manpower plan version live on the day each task was allocated (tasks per version)">
                        Plan: {row.planVersions.map((v) => `${versionLabel(v.version)} (${v.tasks})`).join(", ")}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.tasks}</td>
                  <td className="px-3 py-2">
                    {row.offMapTasks === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span
                        className={cn(
                          "inline-flex rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
                          row.offMapTasks === 0 ? "bg-muted text-muted-foreground" : "bg-critical/10 text-critical",
                        )}
                      >
                        {row.offMapTasks} · {row.offMapPct}%
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-foreground">
                    {row.onMapWorking.length ? names(row.onMapWorking.map((w) => w.person)) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-2 text-foreground">
                    {row.offMapWorking.length ? counted(row.offMapWorking) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{row.mappedUnused.length ? names(row.mappedUnused) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CountChips({
  total,
  open,
  completed,
  overdue,
}: {
  total: number;
  open: number;
  completed: number;
  overdue: number;
}) {
  return (
    <span className="flex flex-wrap items-center gap-1 text-xs tabular-nums">
      <span className="rounded-full border bg-muted/40 px-2 py-0.5">
        {total} tasks
      </span>
      <span className="rounded-full border bg-muted/40 px-2 py-0.5">
        {open} open
      </span>
      {overdue > 0 && (
        <span className="rounded-full border border-critical/30 bg-critical/10 px-2 py-0.5 text-critical">
          {overdue} overdue
        </span>
      )}
      <span className="rounded-full border bg-muted/40 px-2 py-0.5">
        {completed} done
      </span>
    </span>
  );
}

function PeopleChips({
  people,
  max = 8,
}: {
  people: DeliveryStructureBrand["people"];
  max?: number;
}) {
  if (people.length === 0)
    return (
      <span className="text-xs text-muted-foreground">Nobody assigned</span>
    );
  const shown = people.slice(0, max);
  return (
    <ul className="flex flex-wrap gap-1">
      {shown.map((entry) => (
        <li
          key={entry.person.id ?? entry.person.name}
          className="inline-flex h-6 items-center gap-1 rounded-full border bg-background px-2 text-xs"
          title={`${entry.open} open · ${entry.completed} done`}
        >
          {userName(entry.person)}
          <span className="font-medium tabular-nums text-muted-foreground">
            ×{entry.total}
          </span>
        </li>
      ))}
      {people.length > shown.length && (
        <li className="inline-flex h-6 items-center rounded-full px-2 text-xs text-muted-foreground">
          +{people.length - shown.length} more
        </li>
      )}
    </ul>
  );
}

function ProjectRow({ project }: { project: DeliveryStructureProject }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border bg-background">
      <button
        type="button"
        className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="flex min-w-0 items-center gap-2">
          {open ? (
            <LuChevronDown aria-hidden className="size-3.5 shrink-0" />
          ) : (
            <LuChevronRight aria-hidden className="size-3.5 shrink-0" />
          )}
          <span className="truncate text-sm font-medium">
            {project.project.name}
          </span>
          {project.project.code && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {project.project.code}
            </span>
          )}
        </span>
        <CountChips
          total={project.total}
          open={project.open}
          completed={project.completed}
          overdue={project.overdue}
        />
      </button>
      <div className="px-3 pb-2 pl-9">
        <PeopleChips people={project.people} />
      </div>
      {open && (
        <div className="border-t px-3 py-2 pl-9">
          <ul className="divide-y">
            {project.tasks.map((task) => (
              <li
                key={task.id}
                className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm"
              >
                <Link
                  to={`/tasks?task=${task.id}`}
                  className="flex min-w-0 items-center gap-2 underline-offset-4 hover:underline"
                >
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {task.code}
                  </span>
                  <span className="truncate">{task.title}</span>
                </Link>
                <span className="flex flex-wrap items-center gap-1 text-xs">
                  <span
                    className={
                      task.overdue
                        ? "font-medium text-critical"
                        : "text-muted-foreground"
                    }
                  >
                    {task.dueDate
                      ? `due ${formatDateOnly(task.dueDate)}`
                      : "no due date"}
                  </span>
                  <span className="rounded-full border bg-muted/40 px-2 py-0.5">
                    {task.status.replace(/_/g, " ")}
                  </span>
                  <span className="text-muted-foreground">
                    {task.assignees.length
                      ? task.assignees.map(userName).join(", ")
                      : "unassigned"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {project.moreTasks > 0 && (
            <p className="pt-2 text-xs text-muted-foreground">
              +{project.moreTasks} more —{" "}
              <Link
                to={
                  project.project.id
                    ? `/tasks?project=${project.project.id}`
                    : "/tasks"
                }
                className="text-primary underline-offset-4 hover:underline"
              >
                open in Tasks
              </Link>
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function BrandRow({ brand }: { brand: DeliveryStructureBrand }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="py-2">
      <button
        type="button"
        className="flex w-full flex-wrap items-center justify-between gap-2 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          {open ? (
            <LuChevronDown aria-hidden className="size-4 shrink-0" />
          ) : (
            <LuChevronRight aria-hidden className="size-4 shrink-0" />
          )}
          <BrandName
            name={brand.brand.name}
            color={brand.brand.color}
            noBrand={brand.brand.noBrand}
            className="text-sm font-semibold"
          />
          <span className="text-xs text-muted-foreground">
            {brand.projects.length} project
            {brand.projects.length === 1 ? "" : "s"}
          </span>
        </span>
        <CountChips
          total={brand.total}
          open={brand.open}
          completed={brand.completed}
          overdue={brand.overdue}
        />
      </button>
      <div className="mt-1.5 pl-6">
        <PeopleChips people={brand.people} />
      </div>
      {open && (
        <ul className="mt-2 space-y-2 pl-6">
          {brand.projects.map((project) => (
            <ProjectRow key={project.project.id ?? "none"} project={project} />
          ))}
        </ul>
      )}
    </li>
  );
}

function BrandStructure({ data }: { data: DeliveryBrandStructureResponse }) {
  if (data.brands.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        No tasks in this period.
      </p>
    );
  }
  return (
    <ul className="divide-y">
      {data.brands.map((brand) => (
        <BrandRow key={brand.brand.id} brand={brand} />
      ))}
    </ul>
  );
}
