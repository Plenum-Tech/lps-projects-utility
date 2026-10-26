import { useMemo, useState } from "react";
import {
  LuChartColumn,
  LuChartColumnStacked,
  LuChartLine,
  LuChartPie,
  LuChevronDown,
  LuChevronRight,
  LuLoaderCircle,
  LuPin,
  LuSheet,
  LuTrash2,
  LuX,
} from "react-icons/lu";

import { useInsightsActions, type InsightsActions } from "@/components/insights/actions";
import { DataChart, KpiTiles, SortableTable } from "@/components/insights/data-view";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { useBlockData, useInsightOptions } from "@/hooks/use-insights";
import { defaultSort, sortRows, type SortState } from "@/lib/insights/sort";
import type { BlockSpec, BlockView, Cell, Dataset, FilterKind } from "@/lib/insights/types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// One live Insights block (chat answer, board, drill-down sheet): the tool's
// data re-run server-side for the block's params — filter chips change the
// params (no AI call), the view switch changes table / chart, rows drill in,
// and chat blocks can be pinned to a board.
// ---------------------------------------------------------------------------

const VIEWS: Array<{ view: BlockView; label: string; icon: typeof LuSheet }> = [
  { view: "table", label: "Table", icon: LuSheet },
  { view: "bar", label: "Bar chart", icon: LuChartColumn },
  { view: "stacked", label: "Stacked bars", icon: LuChartColumnStacked },
  { view: "line", label: "Line chart", icon: LuChartLine },
  { view: "pie", label: "Pie chart", icon: LuChartPie },
];

const LIST_LABELS: Record<string, string> = {
  groups: "Groups",
  tasks: "Tasks",
  brands: "By brand",
  projects: "By project",
  people: "People",
  lines: "Plan lines needing staff",
  byLead: "By lead",
  byMonth: "By month",
  pitches: "Pitches",
  trend: "Weekly trend",
  items: "Items",
};

const pad = (n: number) => String(n).padStart(2, "0");
const monthKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const quarterKey = (d: Date) => `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
const PERIOD_KEYS = ["from", "to", "month", "quarter"];

/** Period choices for a tool's period kind (computed from today, browser time). */
function periodChoices(kind: "period" | "month" | "quarter"): Array<{ label: string; params: Record<string, string> }> {
  const now = new Date();
  const month = (offset: number) => monthKey(new Date(now.getFullYear(), now.getMonth() + offset, 1));
  const quarter = (offset: number) => quarterKey(new Date(now.getFullYear(), now.getMonth() + offset * 3, 1));
  if (kind === "month") return [{ label: "This month", params: { month: month(0) } }, { label: "Last month", params: { month: month(-1) } }, { label: "Next month", params: { month: month(1) } }];
  if (kind === "quarter") return [{ label: "This quarter", params: { quarter: quarter(0) } }, { label: "Last quarter", params: { quarter: quarter(-1) } }, { label: "Next quarter", params: { quarter: quarter(1) } }];
  const days = (n: number) => ({ from: dayKey(new Date(now.getTime() - (n - 1) * 86_400_000)), to: dayKey(now) });
  return [
    { label: "Last 7 days", params: days(7) },
    { label: "Last 30 days", params: days(30) },
    { label: "This month", params: { month: month(0) } },
    { label: "Last month", params: { month: month(-1) } },
    { label: "Last 3 months", params: { from: `${month(-2)}-01`, to: dayKey(now) } },
    { label: "Last 6 months", params: { from: `${month(-5)}-01`, to: dayKey(now) } },
    { label: "This quarter", params: { quarter: quarter(0) } },
    { label: "Last quarter", params: { quarter: quarter(-1) } },
  ];
}

const NAME_FILTER_LABEL: Record<string, string> = { brand: "Brand", team: "Team", person: "Person", lead: "Lead", project: "Project", status: "Status" };

function NameFilter({ label, options, onPick }: { label: string; options: Array<{ id: string; name: string }>; onPick: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" size="xs" className="h-6 gap-1 rounded-full px-2 text-[11px]" />}>
        {label}
        <LuChevronDown className="size-3" aria-hidden />
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder={`Find ${label.toLowerCase()}…`} />
          <CommandList>
            <CommandEmpty>No match.</CommandEmpty>
            {options.map((o) => (
              <CommandItem
                key={o.id}
                value={o.name}
                onSelect={() => {
                  onPick(o.name);
                  setOpen(false);
                }}
              >
                {o.name}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function DataBlock({
  spec: initial,
  mode,
  onChange,
  onRemove,
  actions: override,
}: {
  spec: Omit<BlockSpec, "id"> & { id?: string };
  mode: "chat" | "board" | "sheet";
  /** Board blocks: persist every change. Chat / sheet blocks keep their changes locally. */
  onChange?: (spec: Omit<BlockSpec, "id">) => void;
  onRemove?: () => void;
  /** Chat blocks route pin / drill through the OpenUI Renderer's actions. */
  actions?: Partial<Pick<InsightsActions, "pin" | "drill">>;
}) {
  const ctx = useInsightsActions();
  const actions = { ...ctx, ...override };
  const [local, setLocal] = useState(initial);
  const spec = onChange ? initial : local;
  const set = (patch: Partial<BlockSpec>) => {
    const next = { ...spec, ...patch };
    if (onChange) onChange(next);
    else setLocal(next);
  };
  const setParams = (params: Record<string, unknown>) => set({ params });

  const query = useBlockData(spec);
  const options = useInsightOptions();
  const dataset: Dataset | null = query.data?.dataset ?? null;
  const [userSort, setUserSort] = useState<SortState | null>(null);
  const sort = useMemo(
    () => userSort ?? (dataset ? defaultSort(dataset, mode === "chat" ? ctx.question : "", { sortBy: spec.sortBy, sortDir: spec.sortDir }) : null),
    [userSort, dataset, mode, ctx.question, spec.sortBy, spec.sortDir],
  );
  const rows = useMemo(() => (dataset ? sortRows(dataset, sort) : []), [dataset, sort]);
  const view: BlockView = spec.view ?? (dataset?.ordered ? "line" : "table");

  const drillRow = dataset?.drill
    ? (row: Record<string, Cell>) => {
        const value = row[dataset.drill!.key];
        if (value !== null && value !== undefined && value !== "") actions.drill({ kind: dataset.drill!.kind, value: String(value) });
      }
    : undefined;

  const periodKind = dataset?.filters.find((f): f is "period" | "month" | "quarter" => f === "period" || f === "month" || f === "quarter");
  const nameFilters = (dataset?.filters ?? []).filter((f): f is Exclude<FilterKind, "period" | "month" | "quarter"> => f === "brand" || f === "team" || f === "person");
  const paramOf = (f: string) => (f === "person" && spec.tool === "pitchPipeline" ? "lead" : f);
  const optionList = (f: string) => (f === "brand" ? options.data?.brands : f === "team" ? options.data?.teams : options.data?.people) ?? [];

  return (
    <section className={cn("min-w-0 space-y-2.5 rounded-xl border bg-card p-3", mode === "sheet" && "border-dashed")}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{spec.title}</h3>
          {dataset?.subtitle && <p className="text-xs text-muted-foreground">{dataset.subtitle}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {query.isFetching && <LuLoaderCircle className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading" />}
          <div className="flex rounded-md border p-0.5" role="group" aria-label="View">
            {VIEWS.filter((v) => v.view !== "stacked" || (dataset?.series.length ?? 0) > 1).map((v) => (
              <button
                key={v.view}
                type="button"
                onClick={() => set({ view: v.view })}
                className={cn("rounded p-1 text-muted-foreground hover:text-foreground", view === v.view && "bg-muted text-foreground")}
                title={v.label}
                aria-label={v.label}
                aria-pressed={view === v.view}
              >
                <v.icon className="size-3.5" />
              </button>
            ))}
          </div>
          {mode !== "board" && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="xs" className="h-7 gap-1" />}>
                <LuPin className="size-3.5" aria-hidden />
                Pin
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuGroup>
                <DropdownMenuLabel>Pin to board</DropdownMenuLabel>
                {actions.currentBoardId && <DropdownMenuItem onClick={() => actions.pin(spec, { kind: "current" })}>This board</DropdownMenuItem>}
                {actions.boards
                  .filter((b) => b._id !== actions.currentBoardId)
                  .slice(0, 8)
                  .map((b) => (
                    <DropdownMenuItem key={b._id} onClick={() => actions.pin(spec, { kind: "board", id: b._id })}>
                      <span className="truncate">{b.title}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => actions.pin(spec, { kind: "new" })}>New board…</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {onRemove && (
            <Button variant="ghost" size="icon-xs" onClick={onRemove} title="Remove from the board" aria-label="Remove from the board">
              <LuTrash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </header>

      {dataset && (
        <div className="flex flex-wrap items-center gap-1.5">
          {periodKind && (
            <NativeSelect
              size="sm"
              aria-label="Period"
              className="[&_select]:h-6 [&_select]:rounded-full [&_select]:py-0 [&_select]:text-[11px]"
              value=""
              onChange={(e) => {
                const choice = periodChoices(periodKind)[Number(e.target.value)];
                if (!choice) return;
                const rest = Object.fromEntries(Object.entries(spec.params).filter(([k]) => !PERIOD_KEYS.includes(k)));
                setParams({ ...rest, ...choice.params });
              }}
            >
              <NativeSelectOption value="">Period: {dataset.subtitle || "default"}</NativeSelectOption>
              {periodChoices(periodKind).map((c, i) => (
                <NativeSelectOption key={c.label} value={String(i)}>
                  {c.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
          {nameFilters
            .filter((f) => !spec.params[paramOf(f)])
            .map((f) => (
              <NameFilter key={f} label={NAME_FILTER_LABEL[paramOf(f)] ?? f} options={optionList(f)} onPick={(name) => setParams({ ...spec.params, [paramOf(f)]: name })} />
            ))}
          {Object.entries(dataset.applied).map(([k, v]) => (
            <span key={k} className="inline-flex h-6 items-center gap-1 rounded-full bg-primary/10 pr-1 pl-2 text-[11px] text-primary">
              {NAME_FILTER_LABEL[k] ?? k}: {v}
              <button
                type="button"
                className="rounded-full p-0.5 hover:bg-primary/20"
                onClick={() => setParams(Object.fromEntries(Object.entries(spec.params).filter(([key]) => key !== k)))}
                title={`Clear ${NAME_FILTER_LABEL[k] ?? k}`}
                aria-label={`Clear ${NAME_FILTER_LABEL[k] ?? k} filter`}
              >
                <LuX className="size-3" />
              </button>
            </span>
          ))}
          {spec.only?.length ? (
            <span className="inline-flex h-6 items-center gap-1 rounded-full bg-primary/10 pr-1 pl-2 text-[11px] text-primary">
              Only: {spec.only.join(", ")}
              <button type="button" className="rounded-full p-0.5 hover:bg-primary/20" onClick={() => set({ only: undefined })} aria-label="Show all rows">
                <LuX className="size-3" />
              </button>
            </span>
          ) : null}
          {dataset.lists.length > 1 && (
            <NativeSelect size="sm" aria-label="List" className="[&_select]:h-6 [&_select]:rounded-full [&_select]:py-0 [&_select]:text-[11px]" value={dataset.list} onChange={(e) => set({ list: e.target.value })}>
              {dataset.lists.map((l) => (
                <NativeSelectOption key={l} value={l}>
                  {LIST_LABELS[l] ?? l}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
        </div>
      )}

      {query.isPending && <Skeleton className="h-40 w-full rounded-lg" />}
      {query.isError && <p className="text-sm text-critical">This data couldn't be loaded.</p>}
      {query.data && !dataset && <p className="text-sm text-critical">{query.data.error ?? "No data."}</p>}
      {dataset && (
        <>
          <KpiTiles dataset={dataset} />
          {view !== "kpis" &&
            (view === "table" || dataset.columns.length === 0 ? (
              <SortableTable dataset={dataset} rows={rows} sort={sort} onSort={setUserSort} onRow={drillRow} maxRows={mode === "board" ? 12 : 10} />
            ) : (
              <DataChart dataset={dataset} rows={rows} view={view} sort={sort} onRow={drillRow} />
            ))}
          {dataset.drill && view !== "kpis" && <p className="text-[11px] text-muted-foreground">Click a {view === "table" ? "row" : view === "pie" ? "slice" : "bar"} for details.</p>}
          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1 text-[11px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
              <LuChevronRight className="size-3 transition-transform group-data-[panel-open]:rotate-90" aria-hidden />
              How this was calculated
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-1.5 space-y-1 rounded-lg bg-muted/40 p-2 text-[11px] text-muted-foreground">
                <p className="break-words">
                  <span className="font-medium text-foreground">{spec.tool}</span> ({Object.entries(query.data?.trace.params ?? spec.params).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · ") || "defaults"}) → {dataset.rows.length} of {dataset.total} rows, {query.data?.trace.ms} ms
                </p>
                {sort && <p>Sorted by {dataset.columns.find((c) => c.key === sort.key)?.label ?? sort.key} ({sort.dir === "desc" ? "high → low" : "low → high"}){dataset.rows.some((r) => r.lowVolume) ? "; low-volume groups are ranked after the others for rates" : ""}.</p>}
                {dataset.note && <p>{dataset.note}</p>}
                <p>Numbers come straight from this read-only query of live data — the AI only chose the query.</p>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </>
      )}
    </section>
  );
}
