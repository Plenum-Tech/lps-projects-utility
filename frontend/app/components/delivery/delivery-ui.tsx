import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import type { IconType } from "react-icons";
import {
  LuArrowDown,
  LuArrowUp,
  LuArrowUpDown,
  LuChartColumn,
  LuInfo,
  LuMinus,
  LuTable2,
} from "react-icons/lu";

import { EmptyState, QueryError } from "@/components/globals/query-states";
import {
  DASH,
  TONE_BAR,
  TONE_PILL,
  deltaTone,
  fmtChange,
  type DeltaUnit,
  type Tone,
} from "@/components/delivery/delivery-format";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { DeliveryDelta } from "@/types";

/* ------------------------------------------------------------------ */
/* Section + panel chrome                                              */
/* ------------------------------------------------------------------ */

/** "1 · Results" section wrapper; `id` is the anchor the section nav links to. */
export function DeliverySection({
  id,
  index,
  title,
  description,
  children,
}: {
  id: string;
  index: number;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      data-pulse-section={id}
      className="space-y-4"
      style={{ scrollMarginTop: "calc(var(--pulse-offset, 0px) + 1rem)" }}
    >
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={`${id}-title`} className="font-heading text-xl font-semibold tracking-tight text-foreground">
          <span className="text-pulse-blue tabular-nums">{index}</span>
          <span aria-hidden className="mx-1.5 text-muted-foreground">
            ·
          </span>
          {title}
        </h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </header>
      {children}
    </section>
  );
}

/** Card with title, optional description/action, content scrolling inside. */
export function Panel({
  title,
  description,
  action,
  className,
  contentClassName,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <Card className={cn("min-w-0", className)}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {action && <CardAction className="flex flex-wrap items-center gap-2">{action}</CardAction>}
      </CardHeader>
      <CardContent className={cn("min-w-0", contentClassName)}>{children}</CardContent>
    </Card>
  );
}

/** Loading / error / empty states for one panel's query. */
export function PanelState({
  query,
  errorTitle,
  isEmpty,
  emptyIcon,
  emptyTitle,
  emptyDescription,
  skeletonHeight = "h-48",
  children,
}: {
  query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown; isFetching: boolean };
  errorTitle: string;
  isEmpty?: boolean;
  emptyIcon?: IconType;
  emptyTitle?: string;
  emptyDescription?: ReactNode;
  skeletonHeight?: string;
  children: () => ReactNode;
}) {
  if (query.isPending) {
    return <Skeleton className={cn("w-full rounded-lg", skeletonHeight)} aria-label="Loading" />;
  }
  if (query.isError) {
    return (
      <QueryError
        title={errorTitle}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  if (isEmpty) {
    return (
      <EmptyState
        icon={emptyIcon ?? LuChartColumn}
        title={emptyTitle ?? "Nothing here yet"}
        description={emptyDescription}
        className="py-8"
      />
    );
  }
  return (
    <div className={cn("transition-opacity duration-200", query.isFetching && "opacity-70")} aria-busy={query.isFetching}>
      {children()}
    </div>
  );
}

/** Chart card with a "Table view" toggle — the table is the accessible equivalent. */
export function ChartPanel({
  title,
  description,
  chart,
  table,
  isEmpty,
  emptyText = "No data for these filters.",
  className,
}: {
  title: string;
  description?: ReactNode;
  chart: () => ReactNode;
  table: () => ReactNode;
  isEmpty?: boolean;
  emptyText?: string;
  className?: string;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <Panel
      title={title}
      description={description}
      className={className}
      action={
        !isEmpty && (
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={showTable}
            onClick={() => setShowTable((value) => !value)}
          >
            {showTable ? <LuChartColumn aria-hidden /> : <LuTable2 aria-hidden />}
            {showTable ? "Chart view" : "Table view"}
          </Button>
        )
      }
    >
      {isEmpty ? (
        <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center">
          <LuChartColumn aria-hidden className="size-5 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{emptyText}</p>
        </div>
      ) : showTable ? (
        table()
      ) : (
        chart()
      )}
    </Panel>
  );
}

/** Small (i) with a tooltip. */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        }
      >
        <LuInfo aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{children}</TooltipContent>
    </Tooltip>
  );
}

/* ------------------------------------------------------------------ */
/* Delta pill + bars                                                   */
/* ------------------------------------------------------------------ */

/** Change vs the previous period, coloured by the API's good/bad flag. */
export function DeltaPill({
  delta,
  unit,
  compact,
}: {
  delta: DeliveryDelta | null | undefined;
  unit: DeltaUnit;
  compact?: boolean;
}) {
  if (!delta || delta.noPreviousData) {
    return (
      <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[0.7rem] text-muted-foreground">
        {compact ? DASH : "no data in previous period"}
      </span>
    );
  }
  if (delta.change === null) {
    return <span className="text-xs text-muted-foreground">{DASH}</span>;
  }
  const tone: Tone = delta.direction === "flat" ? "neutral" : deltaTone(delta);
  const Icon = delta.direction === "up" ? LuArrowUp : delta.direction === "down" ? LuArrowDown : LuMinus;
  const verdict = delta.good === true ? "better" : delta.good === false ? "worse" : "neutral";
  const text = delta.direction === "flat" ? "no change" : fmtChange(delta.change, unit);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[0.7rem] font-medium whitespace-nowrap tabular-nums ring-1 ring-inset",
        TONE_PILL[tone]
      )}
      title={`${text} vs previous period (${verdict})`}
    >
      <Icon aria-hidden className="size-3" />
      {text}
      <span className="sr-only"> vs previous period, {verdict}</span>
    </span>
  );
}

/** Small pill in a tone (brief scores, warning counts). */
export function TonePill({ tone, title, children }: { tone: Tone; title?: string; children: ReactNode }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[0.7rem] font-medium whitespace-nowrap tabular-nums ring-1 ring-inset",
        TONE_PILL[tone]
      )}
    >
      {children}
    </span>
  );
}

/** Brief score (0–100) pill: good ≥ 80, warn ≥ 50, critical below. */
export function ScorePill({ score, title }: { score: number | null; title?: string }) {
  if (score === null) return <span className="text-xs text-muted-foreground">{DASH}</span>;
  return (
    <TonePill tone={score >= 80 ? "good" : score >= 50 ? "warn" : "critical"} title={title}>
      {score}
    </TonePill>
  );
}

/** Horizontal bar relative to `max` (e.g. team volume). */
export function VolumeBar({ value, max, label, className }: { value: number; max: number; label: string; className?: string }) {
  const pct = max > 0 ? Math.max(value > 0 ? 3 : 0, Math.round((value / max) * 100)) : 0;
  return (
    <div
      role="img"
      aria-label={label}
      className={cn("h-2 w-full min-w-16 overflow-hidden rounded-full bg-muted", className)}
    >
      <div className="h-full rounded-full bg-pulse-blue transition-[width] duration-200" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Tiny pass-rate bar (0–100) with its value. */
export function RateBar({ pct, tone, title }: { pct: number | null; tone: Tone; title?: string }) {
  return (
    <div className="flex min-w-16 items-center gap-1.5" title={title}>
      <div className="h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-muted" aria-hidden>
        {pct !== null && <div className={cn("h-full rounded-full", TONE_BAR[tone])} style={{ width: `${Math.max(pct, 2)}%` }} />}
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">{pct === null ? "n/a" : `${Math.round(pct)}%`}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Client-side sortable table                                          */
/* ------------------------------------------------------------------ */

export interface SortColumn<T> {
  id: string;
  header: ReactNode;
  /** Tooltip / sr text explaining the column. */
  hint?: string;
  cell: (row: T) => ReactNode;
  /** Value to sort by; omit to make the column unsortable. Nulls sort last. */
  sortValue?: (row: T) => number | string | null;
  align?: "left" | "right";
  className?: string;
}

/**
 * Sortable table with a sticky header that scrolls inside its card (both
 * axes). Rows can be clickable (Enter/Space too).
 */
export function SortTable<T>({
  columns,
  rows,
  getRowId,
  defaultSort,
  defaultDir = "desc",
  onRowClick,
  rowLabel,
  rowClassName,
  caption,
  maxHeight = "max-h-[28rem]",
  footer,
}: {
  columns: SortColumn<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  defaultSort?: string;
  defaultDir?: "asc" | "desc";
  onRowClick?: (row: T) => void;
  rowLabel?: (row: T) => string;
  rowClassName?: (row: T) => string | undefined;
  caption: string;
  maxHeight?: string;
  footer?: ReactNode;
}) {
  const [sort, setSort] = useState<{ id: string | null; dir: "asc" | "desc" }>({
    id: defaultSort ?? null,
    dir: defaultDir,
  });

  const sorted = useMemo(() => {
    const column = columns.find((item) => item.id === sort.id);
    if (!column?.sortValue) return rows;
    const get = column.sortValue;
    const factor = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      if (typeof va === "string" || typeof vb === "string") {
        return String(va).localeCompare(String(vb), undefined, { sensitivity: "base" }) * factor;
      }
      return (va - vb) * factor;
    });
  }, [rows, columns, sort]);

  function toggle(id: string) {
    setSort((previous) =>
      previous.id === id
        ? { id, dir: previous.dir === "asc" ? "desc" : "asc" }
        : { id, dir: columns.find((c) => c.id === id)?.align === "right" ? "desc" : "asc" }
    );
  }

  function onKey(event: KeyboardEvent<HTMLTableRowElement>, row: T) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onRowClick?.(row);
    }
  }

  return (
    <div className="min-w-0">
      <div className={cn("relative overflow-auto rounded-lg border", maxHeight)}>
        <table className="w-full caption-bottom text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 z-10 bg-card shadow-[0_1px_0_var(--border)]">
            <tr>
              {columns.map((column) => {
                const active = sort.id === column.id;
                const ariaSort = active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined;
                const SortIcon = !active ? LuArrowUpDown : sort.dir === "asc" ? LuArrowUp : LuArrowDown;
                return (
                  <th
                    key={column.id}
                    scope="col"
                    aria-sort={column.sortValue ? (ariaSort ?? "none") : undefined}
                    className={cn(
                      "h-10 px-3 text-xs font-medium whitespace-nowrap text-muted-foreground",
                      column.align === "right" ? "text-right" : "text-left"
                    )}
                    title={column.hint}
                  >
                    {column.sortValue ? (
                      <button
                        type="button"
                        onClick={() => toggle(column.id)}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
                          active && "text-foreground",
                          column.align === "right" && "flex-row-reverse"
                        )}
                      >
                        {column.header}
                        <SortIcon aria-hidden className={cn("size-3", !active && "opacity-50")} />
                        {column.hint && <span className="sr-only">: {column.hint}</span>}
                      </button>
                    ) : (
                      <>
                        {column.header}
                        {column.hint && <span className="sr-only">: {column.hint}</span>}
                      </>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr
                key={getRowId(row)}
                tabIndex={onRowClick ? 0 : undefined}
                aria-label={onRowClick && rowLabel ? rowLabel(row) : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={onRowClick ? (event) => onKey(event, row) : undefined}
                className={cn(
                  "border-b transition-colors duration-150 last:border-0",
                  onRowClick &&
                    "cursor-pointer outline-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
                  rowClassName?.(row)
                )}
              >
                {columns.map((column) => (
                  <td
                    key={column.id}
                    className={cn(
                      "px-3 py-2 align-middle whitespace-nowrap",
                      column.align === "right" && "text-right tabular-nums",
                      column.className
                    )}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer}
    </div>
  );
}

/** "Show more" for long client-side lists. */
export function useShowMore<T>(rows: T[], step = 50) {
  const [limit, setLimit] = useState(step);
  const shown = rows.slice(0, limit);
  const more =
    rows.length > limit ? (
      <div className="mt-3 flex items-center justify-center gap-3 text-xs text-muted-foreground">
        <span>
          Showing {shown.length} of {rows.length}
        </span>
        <Button variant="outline" size="sm" onClick={() => setLimit((value) => value + step)}>
          Show {Math.min(step, rows.length - limit)} more
        </Button>
      </div>
    ) : null;
  return { shown, more, reset: () => setLimit(step) };
}
