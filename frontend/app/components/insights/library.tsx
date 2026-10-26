import type { ComponentRenderProps, ElementNode } from "@openuidev/react-lang";
import type { ReactNode } from "react";
import { LuCircleAlert, LuCircleCheck, LuInfo, LuTriangleAlert } from "react-icons/lu";
import { Bar, BarChart as RBarChart, CartesianGrid, Cell, Line, LineChart as RLineChart, Pie, PieChart as RPieChart, XAxis, YAxis } from "recharts";

import { Card as UiCard, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Table as UiTable, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { buildInsightsLibrary } from "@/lib/insights/schema";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Renderers of the Leadership Insights OpenUI library (schemas in
// lib/insights/schema.ts), built on the Utility's own Card / Table / chart UI
// so model answers look native. Props arrive while streaming, so every
// renderer tolerates missing or partial values.
// ---------------------------------------------------------------------------

type P<T> = ComponentRenderProps<T>;

const COLORS = ["var(--chart-3)", "var(--chart-1)", "var(--chart-4)", "var(--chart-5)", "var(--chart-2)", "var(--pulse-blue)"];
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const fmt = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 1 }) : str(v) || "—");

/** Series(name, values) / Slice(label, value) children are element nodes: read their props. */
const nodeProps = (v: unknown) => ((v as ElementNode | null)?.props ?? {}) as Record<string, unknown>;

const TONE_TEXT: Record<string, string> = {
  good: "text-good",
  warn: "text-warn",
  bad: "text-critical",
  default: "text-foreground",
};

function Report({ props, renderNode }: P<{ title?: string; summary?: string; children?: unknown[] }>) {
  return (
    <article className="space-y-4">
      <header className="space-y-1">
        {props.title && <h2 className="font-heading text-xl font-semibold tracking-tight">{props.title}</h2>}
        {props.summary && <p className="text-sm text-muted-foreground">{props.summary}</p>}
      </header>
      <div className="space-y-4">{renderNode(props.children)}</div>
    </article>
  );
}

function Card({ props, renderNode }: P<{ title?: string; children?: unknown[]; description?: string }>) {
  return (
    <UiCard size="sm">
      <CardHeader>
        <CardTitle>{props.title}</CardTitle>
        {props.description && <CardDescription>{props.description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">{renderNode(props.children)}</CardContent>
    </UiCard>
  );
}

function StatRow({ props, renderNode }: P<{ stats?: unknown[] }>) {
  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]">{renderNode(props.stats)}</div>;
}

function Stat({ props }: P<{ label?: string; value?: string | number; hint?: string; tone?: string }>) {
  return (
    <div className="rounded-xl border bg-card px-3 py-2.5">
      <div className="truncate text-xs text-muted-foreground">{props.label}</div>
      <div className={cn("font-heading text-2xl font-semibold tabular-nums", TONE_TEXT[props.tone ?? "default"])}>{fmt(props.value)}</div>
      {props.hint && <div className="truncate text-xs text-muted-foreground">{props.hint}</div>}
    </div>
  );
}

function Table({ props }: P<{ columns?: string[]; rows?: unknown[][]; caption?: string }>) {
  const columns = arr<string>(props.columns);
  const rows = arr<unknown[]>(props.rows);
  // Number columns (every filled cell a number) are right-aligned, header included.
  const numeric = columns.map((_, i) => rows.length > 0 && rows.every((r) => r?.[i] == null || typeof r[i] === "number"));
  return (
    <div className="overflow-hidden rounded-xl border">
      <UiTable>
        <TableHeader>
          <TableRow>
            {columns.map((c, i) => (
              <TableHead key={i} className={cn("whitespace-nowrap", numeric[i] && "text-right")}>
                {c}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, r) => (
            <TableRow key={r}>
              {arr<unknown>(row).map((cell, i) => (
                <TableCell key={i} className={cn("max-w-72 truncate", numeric[i] && "text-right tabular-nums")} title={str(cell)}>
                  {fmt(cell)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </UiTable>
      {props.caption && <p className="border-t px-3 py-2 text-xs text-muted-foreground">{props.caption}</p>}
    </div>
  );
}

function ChartFrame({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <figure className="space-y-2 rounded-xl border p-3">
      {title && <figcaption className="text-sm font-medium">{title}</figcaption>}
      {children}
    </figure>
  );
}

/** labels + Series(...) → recharts rows and a chart config. */
function seriesData(labelsRaw: unknown, seriesRaw: unknown) {
  const labels = arr<string>(labelsRaw).map(str);
  const series = arr<unknown>(seriesRaw).map((s, i) => {
    const p = nodeProps(s);
    return { key: `s${i}`, name: str(p.name) || `Series ${i + 1}`, values: arr<number>(p.values) };
  });
  const data = labels.map((label, li) => ({ label, ...Object.fromEntries(series.map((s) => [s.key, s.values[li] ?? null])) }));
  const config = Object.fromEntries(series.map((s, i) => [s.key, { label: s.name, color: COLORS[i % COLORS.length] }])) satisfies ChartConfig;
  return { data, series, config };
}

type ChartProps = P<{ title?: string; labels?: string[]; series?: unknown[]; unit?: string }>;

function Bars({ props, stacked }: ChartProps & { stacked?: boolean }) {
  const { data, series, config } = seriesData(props.labels, props.series);
  const unit = props.unit ?? "";
  return (
    <ChartFrame title={props.title}>
      <ChartContainer config={config} className="aspect-auto h-64 w-full">
        <RBarChart data={data} accessibilityLayer margin={{ left: 0, right: 4 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={8} interval="preserveStartEnd" />
          <YAxis tickLine={false} axisLine={false} width={40} tickFormatter={(v: number) => `${v}${unit}`} />
          <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
          {series.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              fill={`var(--color-${s.key})`}
              stackId={stacked ? "a" : undefined}
              radius={stacked ? (i === series.length - 1 ? [4, 4, 0, 0] : 0) : [4, 4, 0, 0]}
              maxBarSize={40}
            />
          ))}
        </RBarChart>
      </ChartContainer>
    </ChartFrame>
  );
}

function LineChart({ props }: ChartProps) {
  const { data, series, config } = seriesData(props.labels, props.series);
  const unit = props.unit ?? "";
  return (
    <ChartFrame title={props.title}>
      <ChartContainer config={config} className="aspect-auto h-64 w-full">
        <RLineChart data={data} accessibilityLayer margin={{ left: 0, right: 8, top: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={16} />
          <YAxis tickLine={false} axisLine={false} width={40} tickFormatter={(v: number) => `${v}${unit}`} />
          <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
          {series.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
          {series.map((s) => (
            <Line key={s.key} dataKey={s.key} type="monotone" stroke={`var(--color-${s.key})`} strokeWidth={2} dot={data.length <= 16} connectNulls={false} />
          ))}
        </RLineChart>
      </ChartContainer>
    </ChartFrame>
  );
}

function PieChart({ props }: P<{ title?: string; slices?: unknown[] }>) {
  const slices = arr<unknown>(props.slices).map((s, i) => {
    const p = nodeProps(s);
    return { key: `p${i}`, label: str(p.label), value: typeof p.value === "number" ? p.value : 0 };
  });
  const config = Object.fromEntries(slices.map((s, i) => [s.key, { label: s.label, color: COLORS[i % COLORS.length] }])) satisfies ChartConfig;
  return (
    <ChartFrame title={props.title}>
      <ChartContainer config={config} className="mx-auto aspect-square h-60">
        <RPieChart>
          <ChartTooltip content={<ChartTooltipContent nameKey="key" hideLabel />} />
          <Pie data={slices} dataKey="value" nameKey="key" innerRadius="45%" strokeWidth={2}>
            {slices.map((s) => (
              <Cell key={s.key} fill={`var(--color-${s.key})`} />
            ))}
          </Pie>
          <ChartLegend content={<ChartLegendContent nameKey="key" />} className="flex-wrap" />
        </RPieChart>
      </ChartContainer>
    </ChartFrame>
  );
}

function List({ props }: P<{ items?: string[]; title?: string }>) {
  return (
    <div className="space-y-1.5">
      {props.title && <h3 className="text-sm font-medium">{props.title}</h3>}
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {arr<string>(props.items).map((item, i) => (
          <li key={i}>{str(item)}</li>
        ))}
      </ul>
    </div>
  );
}

const CALLOUT = {
  info: { icon: LuInfo, cls: "border-border bg-muted/40" },
  good: { icon: LuCircleCheck, cls: "border-good/30 bg-good/10 [&_svg]:text-good" },
  warn: { icon: LuTriangleAlert, cls: "border-warn/30 bg-warn/10 [&_svg]:text-warn" },
  bad: { icon: LuCircleAlert, cls: "border-critical/30 bg-critical/10 [&_svg]:text-critical" },
} as const;

function Callout({ props }: P<{ text?: string; tone?: keyof typeof CALLOUT; title?: string }>) {
  const { icon: Icon, cls } = CALLOUT[props.tone ?? "info"] ?? CALLOUT.info;
  return (
    <div className={cn("flex gap-2.5 rounded-xl border px-3 py-2.5 text-sm", cls)}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div>
        {props.title && <div className="font-medium">{props.title}</div>}
        <p>{props.text}</p>
      </div>
    </div>
  );
}

function Text({ props }: P<{ text?: string }>) {
  return <p className="text-sm leading-relaxed">{props.text}</p>;
}

/** Follow-ups are shown as chips under the answer (insights-page.tsx reads them from the text). */
const Hidden = () => null;

export const insightsLibrary = buildInsightsLibrary({
  Report,
  Card,
  StatRow,
  Stat,
  Table,
  BarChart: (p: ChartProps) => <Bars {...p} />,
  StackedBar: (p: ChartProps) => <Bars {...p} stacked />,
  LineChart,
  PieChart,
  Series: Hidden,
  Slice: Hidden,
  List,
  Callout,
  Text,
  FollowUps: Hidden,
});
