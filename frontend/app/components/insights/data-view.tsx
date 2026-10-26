import { LuArrowDown, LuArrowUp, LuArrowUpDown } from "react-icons/lu";
import { Bar, BarChart, CartesianGrid, Cell as PieCell, Line, LineChart, Pie, PieChart, XAxis, YAxis } from "recharts";

import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { columnKind, dateValue, type SortState } from "@/lib/insights/sort";
import type { BlockView, Cell, Dataset } from "@/lib/insights/types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Generic views of an Insights dataset (server-computed rows): sortable table,
// grouped / stacked bars, line, pie and KPI tiles. Rows arrive already sorted
// (lib/insights/sort.ts) so charts follow the table order; clicking a row,
// bar or slice drills into it.
// ---------------------------------------------------------------------------

export const CHART_COLORS = ["var(--chart-3)", "var(--chart-1)", "var(--chart-4)", "var(--chart-5)", "var(--chart-2)", "var(--pulse-blue)"];
const MAX_BARS = 15;
const MAX_SLICES = 6;

export const fmtCell = (v: Cell, unit?: string) =>
  v === null || v === undefined || v === ""
    ? "—"
    : typeof v === "number"
      ? `${v.toLocaleString("en-US", { maximumFractionDigits: 1 })}${unit ?? ""}`
      : typeof v === "boolean"
        ? v
          ? "Yes"
          : "—"
        : String(v);

const label = (dataset: Dataset, row: Record<string, Cell>) => String(row[dataset.labelKey] ?? "—");

export function KpiTiles({ dataset }: { dataset: Dataset }) {
  if (dataset.kpis.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fit,minmax(8rem,1fr))]">
      {dataset.kpis.map((k) => (
        <div key={k.label} className="min-w-0 rounded-lg border bg-background px-2.5 py-2">
          <div className="truncate text-[11px] text-muted-foreground">{k.label}</div>
          <div className="truncate font-heading text-lg font-semibold tabular-nums">{fmtCell(k.value)}</div>
          {k.hint && <div className="truncate text-[11px] text-muted-foreground">{k.hint}</div>}
        </div>
      ))}
    </div>
  );
}

export function SortableTable({
  dataset,
  rows,
  sort,
  onSort,
  onRow,
  maxRows,
}: {
  dataset: Dataset;
  rows: Array<Record<string, Cell>>;
  sort: SortState | null;
  onSort: (sort: SortState) => void;
  onRow?: (row: Record<string, Cell>) => void;
  maxRows?: number;
}) {
  const shown = maxRows ? rows.slice(0, maxRows) : rows;
  const kinds = Object.fromEntries(dataset.columns.map((c) => [c.key, columnKind(dataset.rows, c)]));
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            {dataset.columns.map((c) => {
              const active = sort?.key === c.key;
              const Icon = active ? (sort!.dir === "asc" ? LuArrowUp : LuArrowDown) : LuArrowUpDown;
              const right = kinds[c.key] === "number";
              return (
                <TableHead key={c.key} className={cn("whitespace-nowrap", right && "text-right")} aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}>
                  <button
                    type="button"
                    onClick={() => onSort({ key: c.key, dir: active ? (sort!.dir === "desc" ? "asc" : "desc") : kinds[c.key] === "text" ? "asc" : "desc" })}
                    className={cn("inline-flex items-center gap-1 outline-none hover:text-foreground focus-visible:underline", active && "text-foreground")}
                    title={`Sort by ${c.label}`}
                  >
                    {c.label}
                    <Icon className={cn("size-3", !active && "opacity-40")} aria-hidden />
                  </button>
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((row, r) => (
            <TableRow key={r} onClick={onRow ? () => onRow(row) : undefined} className={cn(onRow && "cursor-pointer")}>
              {dataset.columns.map((c, i) => (
                <TableCell
                  key={c.key}
                  className={cn("max-w-64 truncate", kinds[c.key] === "number" && "text-right tabular-nums")}
                  title={fmtCell(row[c.key], c.unit)}
                >
                  {fmtCell(row[c.key], c.unit)}
                  {i === 0 && row.lowVolume === true && (
                    <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground" title="Few tasks: the rate isn't comparable">
                      low volume
                    </span>
                  )}
                </TableCell>
              ))}
            </TableRow>
          ))}
          {shown.length === 0 && (
            <TableRow>
              <TableCell colSpan={dataset.columns.length} className="py-6 text-center text-muted-foreground">
                No rows for these filters.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {rows.length > shown.length && <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">{rows.length - shown.length} more rows — open the table view or narrow the filters.</p>}
    </div>
  );
}

function seriesConfig(dataset: Dataset, keys: string[]): ChartConfig {
  return Object.fromEntries(keys.map((k, i) => [k, { label: dataset.columns.find((c) => c.key === k)?.label ?? k, color: CHART_COLORS[i % CHART_COLORS.length] }]));
}

/** Chart series: the dataset's defaults, else the sorted column, else the first numeric column. */
function chartKeys(dataset: Dataset, sort: SortState | null): string[] {
  if (dataset.series.length) return dataset.series;
  const numeric = dataset.columns.filter((c) => columnKind(dataset.rows, c) === "number");
  const sorted = numeric.find((c) => c.key === sort?.key);
  return sorted ? [sorted.key] : numeric.slice(0, 1).map((c) => c.key);
}

export function DataChart({
  dataset,
  rows,
  view,
  sort,
  onRow,
}: {
  dataset: Dataset;
  rows: Array<Record<string, Cell>>;
  view: Exclude<BlockView, "table" | "kpis">;
  sort: SortState | null;
  onRow?: (row: Record<string, Cell>) => void;
}) {
  const keys = chartKeys(dataset, sort);
  if (keys.length === 0 || rows.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">Nothing to chart — switch to the table.</p>;
  const config = seriesConfig(dataset, keys);
  const unit = dataset.columns.find((c) => c.key === keys[0])?.unit ?? "";

  if (view === "pie") {
    const key = keys[0]!;
    const sorted = rows.filter((r) => typeof r[key] === "number" && (r[key] as number) > 0);
    const top = sorted.slice(0, MAX_SLICES - 1);
    const rest = sorted.slice(MAX_SLICES - 1).reduce((s, r) => s + (r[key] as number), 0);
    const slices = [...top.map((r, i) => ({ id: `p${i}`, name: label(dataset, r), value: r[key] as number, row: r })), ...(rest > 0 ? [{ id: "other", name: "Other", value: rest, row: null }] : [])];
    const pieConfig = Object.fromEntries(slices.map((s, i) => [s.id, { label: s.name, color: CHART_COLORS[i % CHART_COLORS.length] }])) satisfies ChartConfig;
    return (
      <ChartContainer config={pieConfig} className="mx-auto aspect-square h-64">
        <PieChart>
          <ChartTooltip content={<ChartTooltipContent nameKey="id" hideLabel />} />
          <Pie data={slices} dataKey="value" nameKey="id" innerRadius="45%" strokeWidth={2} onClick={(_d: unknown, index: number) => {
            const row = slices[index]?.row;
            if (row) onRow?.(row);
          }} className={cn(onRow && "cursor-pointer")}>
            {slices.map((s) => (
              <PieCell key={s.id} fill={`var(--color-${s.id})`} />
            ))}
          </Pie>
          <ChartLegend content={<ChartLegendContent nameKey="id" />} className="flex-wrap" />
        </PieChart>
      </ChartContainer>
    );
  }

  // Lines read in time order (oldest → newest); bars follow the table's sort.
  const ordered =
    view === "line" ? [...rows].sort((a, b) => (dateValue(a[dataset.labelKey]) ?? 0) - (dateValue(b[dataset.labelKey]) ?? 0)) : rows.slice(0, MAX_BARS);
  const data = ordered.map((r) => ({ label: label(dataset, r), row: r, ...Object.fromEntries(keys.map((k) => [k, typeof r[k] === "number" ? r[k] : null])) }));
  const axis = (
    <>
      <CartesianGrid vertical={false} />
      <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={8} interval="preserveStartEnd" tickFormatter={(v: string) => (v.length > 14 ? `${v.slice(0, 13)}…` : v)} />
      <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => `${v.toLocaleString("en-US", { notation: "compact" })}${unit}`} />
      <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
      {keys.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
    </>
  );
  if (view === "line") {
    return (
      <ChartContainer config={config} className="aspect-auto h-64 w-full">
        <LineChart data={data} accessibilityLayer margin={{ left: 0, right: 8, top: 8 }}>
          {axis}
          {keys.map((k) => (
            <Line key={k} dataKey={k} type="monotone" stroke={`var(--color-${k})`} strokeWidth={2} dot={data.length <= 16} connectNulls={false} />
          ))}
        </LineChart>
      </ChartContainer>
    );
  }
  const stacked = view === "stacked";
  return (
    <ChartContainer config={config} className="aspect-auto h-64 w-full">
      <BarChart data={data} accessibilityLayer margin={{ left: 0, right: 4 }} className={cn(onRow && "[&_.recharts-bar-rectangle]:cursor-pointer")}>
        {axis}
        {keys.map((k, i) => (
          <Bar key={k} dataKey={k} fill={`var(--color-${k})`} stackId={stacked ? "a" : undefined} radius={stacked ? (i === keys.length - 1 ? [4, 4, 0, 0] : 0) : [4, 4, 0, 0]} maxBarSize={40} onClick={(_d: unknown, index: number) => onRow?.(ordered[index]!)} />
        ))}
      </BarChart>
    </ChartContainer>
  );
}
