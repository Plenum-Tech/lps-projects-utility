import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

import { DASH, shortDay } from "@/components/delivery/delivery-format";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatDateOnly } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DeliveryWeekRow } from "@/types";

type WeekKey = "completed" | "meanDays" | "startToDoneDays" | "overduePct" | "reworkPct" | "created" | "onTimePct";

const LABELS: Record<WeekKey, string> = {
  completed: "Completed",
  created: "Created",
  meanDays: "Mean days",
  startToDoneDays: "Start → done",
  overduePct: "Overdue %",
  reworkPct: "Rework %",
  onTimePct: "On time %",
};

function rows(weeks: DeliveryWeekRow[], key: WeekKey) {
  return weeks.map((week) => ({ week: week.weekStart, label: shortDay(week.weekStart), value: week[key] }));
}

/** Weekly bars (counts). */
export function WeeklyBars({
  weeks,
  dataKey,
  color = "var(--pulse-blue)",
  className = "h-56",
}: {
  weeks: DeliveryWeekRow[];
  dataKey: WeekKey;
  color?: string;
  className?: string;
}) {
  const config = { value: { label: LABELS[dataKey], color } } satisfies ChartConfig;
  return (
    <ChartContainer config={config} className={cn("aspect-auto w-full", className)}>
      <BarChart data={rows(weeks, dataKey)} accessibilityLayer margin={{ left: 0, right: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={16} />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent labelFormatter={(_, payload) => weekLabel(payload)} />}
        />
        <Bar dataKey="value" fill="var(--color-value)" radius={[4, 4, 0, 0]} maxBarSize={36} />
      </BarChart>
    </ChartContainer>
  );
}

/** Weekly line (rates / days); null weeks leave a gap. */
export function WeeklyLine({
  weeks,
  dataKey,
  color = "var(--chart-2)",
  unit = "",
  className = "h-56",
}: {
  weeks: DeliveryWeekRow[];
  dataKey: WeekKey;
  color?: string;
  unit?: string;
  className?: string;
}) {
  const config = { value: { label: LABELS[dataKey], color } } satisfies ChartConfig;
  return (
    <ChartContainer config={config} className={cn("aspect-auto w-full", className)}>
      <LineChart data={rows(weeks, dataKey)} accessibilityLayer margin={{ left: 0, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={16} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={36}
          tickFormatter={(value: number) => `${value}${unit}`}
          domain={unit === "%" ? [0, (max: number) => Math.min(100, Math.ceil(max / 10) * 10 || 10)] : [0, "auto"]}
        />
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent labelFormatter={(_, payload) => weekLabel(payload)} />}
        />
        <Line
          dataKey="value"
          type="monotone"
          stroke="var(--color-value)"
          strokeWidth={2}
          dot={weeks.length <= 16 ? { r: 3, fill: "var(--color-value)" } : false}
          connectNulls={false}
        />
      </LineChart>
    </ChartContainer>
  );
}

/** Several weekly lines on one axis (e.g. brief → done and start → done); null weeks leave gaps. */
export function WeeklyLines({
  weeks,
  series,
  unit = "",
  className = "h-56",
}: {
  weeks: DeliveryWeekRow[];
  series: { key: WeekKey; label: string; color: string }[];
  unit?: string;
  className?: string;
}) {
  const config = Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }])) satisfies ChartConfig;
  const data = weeks.map((week) => ({
    week: week.weekStart,
    label: shortDay(week.weekStart),
    ...Object.fromEntries(series.map((s) => [s.key, week[s.key]])),
  }));
  return (
    <ChartContainer config={config} className={cn("aspect-auto w-full", className)}>
      <LineChart data={data} accessibilityLayer margin={{ left: 0, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={16} />
        <YAxis tickLine={false} axisLine={false} width={36} tickFormatter={(value: number) => `${value}${unit}`} domain={[0, "auto"]} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(_, payload) => weekLabel(payload)} />} />
        <ChartLegend content={<ChartLegendContent />} />
        {series.map((s) => (
          <Line
            key={s.key}
            dataKey={s.key}
            type="monotone"
            stroke={`var(--color-${s.key})`}
            strokeWidth={2}
            dot={weeks.length <= 16 ? { r: 3, fill: `var(--color-${s.key})` } : false}
            connectNulls={false}
          />
        ))}
      </LineChart>
    </ChartContainer>
  );
}

function weekLabel(payload: unknown): string {
  const week = (payload as { payload?: { week?: string } }[] | undefined)?.[0]?.payload?.week;
  return week ? `Week of ${formatDateOnly(week)}` : "";
}

/** Table equivalent of the weekly charts. */
export function WeeklyTable({
  weeks,
  columns,
}: {
  weeks: DeliveryWeekRow[];
  columns: { key: WeekKey; format: (value: number | null) => string }[];
}) {
  return (
    <div className="max-h-64 overflow-auto rounded-lg border">
      <table className="w-full text-sm">
        <caption className="sr-only">Weekly values</caption>
        <thead className="sticky top-0 bg-card shadow-[0_1px_0_var(--border)]">
          <tr>
            <th scope="col" className="h-9 px-3 text-left text-xs font-medium text-muted-foreground">
              Week of
            </th>
            {columns.map((column) => (
              <th key={column.key} scope="col" className="h-9 px-3 text-right text-xs font-medium text-muted-foreground">
                {LABELS[column.key]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...weeks].reverse().map((week) => (
            <tr key={week.weekStart} className="border-b last:border-0">
              <th scope="row" className="px-3 py-1.5 text-left font-normal whitespace-nowrap">
                {formatDateOnly(week.weekStart)}
              </th>
              {columns.map((column) => (
                <td key={column.key} className="px-3 py-1.5 text-right tabular-nums">
                  {week[column.key] === null ? DASH : column.format(week[column.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
