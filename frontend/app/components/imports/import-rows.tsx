import { useCallback, useMemo, useState } from "react";
import { LuCircleAlert, LuCircleCheck, LuCircleMinus, LuSearchX, LuTriangleAlert } from "react-icons/lu";
import type { IconType } from "react-icons";
import { Link } from "react-router";

import { VirtualList } from "@/components/meetings/virtual-list";
import { ROW_STATUS_META, recordHref, rowBucket, type RowFilter } from "@/lib/imports";
import { cn } from "@/lib/utils";
import type { ImportRow, ImportRowStatus, ImportType } from "@/types";

const STATUS_ICON: Record<ImportRowStatus, IconType> = {
  ready: LuCircleCheck,
  created: LuCircleCheck,
  updated: LuCircleCheck,
  warning: LuTriangleAlert,
  skipped: LuCircleMinus,
  error: LuCircleAlert,
};

/** ✅ / ⚠️ / ❌ chip for one row. */
export function RowStatusChip({ status, hasNotes }: { status: ImportRowStatus; hasNotes?: boolean }) {
  // An imported row that carries notes reads as a warning.
  const effective: ImportRowStatus =
    hasNotes && (status === "created" || status === "updated") ? "warning" : status;
  const meta = ROW_STATUS_META[effective];
  const Icon = STATUS_ICON[effective];
  const label = effective === "warning" && status !== "warning" ? `${ROW_STATUS_META[status].label} · note` : meta.label;
  return (
    <span
      className={cn(
        "inline-flex h-6 w-fit items-center gap-1 rounded-full border px-2 text-xs font-medium whitespace-nowrap",
        meta.className
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {label}
    </span>
  );
}

const ACTION_LABEL = {
  preview: { create: "Will create", update: "Will update", skip: "Will skip (exists)" },
  run: { create: "Created", update: "Updated", skip: "Skipped" },
} as const;

const FILTERS: { value: RowFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "ok", label: "Ready" },
  { value: "warning", label: "Warnings" },
  { value: "error", label: "Errors" },
  { value: "skipped", label: "Skipped" },
];

/**
 * Virtualised list of row results with filter chips. `mode="run"` turns
 * created/updated rows into links to the new records.
 */
export function ImportRowsGrid({
  rows,
  type,
  mode,
  onNavigate,
  linkRecords = true,
  className,
}: {
  rows: ImportRow[];
  type: ImportType;
  mode: "preview" | "run";
  /** Called when a record link is followed (closes the dialog). */
  onNavigate?: () => void;
  /** False after an undo — the records are gone. */
  linkRecords?: boolean;
  className?: string;
}) {
  const [filter, setFilter] = useState<RowFilter>("all");

  const counts = useMemo(() => {
    const out: Record<RowFilter, number> = { all: rows.length, ok: 0, warning: 0, error: 0, skipped: 0 };
    for (const row of rows) out[rowBucket(row)] += 1;
    return out;
  }, [rows]);

  const visible = useMemo(
    () => (filter === "all" ? rows : rows.filter((row) => rowBucket(row) === filter)),
    [rows, filter]
  );
  const getKey = useCallback((index: number) => visible[index]?.row ?? index, [visible]);

  const renderItem = useCallback(
    (index: number) => {
      const row = visible[index];
      if (!row) return null;
      const href = mode === "run" && linkRecords ? recordHref(type, row) : null;
      // After a run the chip already says Created / Updated — only spell out skips.
      const action = row.action && (mode === "preview" || row.action === "skip") ? ACTION_LABEL[mode][row.action] : null;
      const isError = row.status === "error";
      return (
        <div className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-b px-3 py-2.5 sm:grid-cols-[3.5rem_8.5rem_minmax(0,1fr)]">
          <span className="pt-0.5 text-xs text-muted-foreground tabular-nums">#{row.row}</span>
          <span className="sm:pt-0">
            <RowStatusChip status={row.status} hasNotes={mode === "run" && row.messages.length > 0} />
          </span>
          <div className="col-span-2 min-w-0 space-y-1 sm:col-span-1">
            {(href || row.recordRef || (action && !isError)) && (
              <p className="flex flex-wrap items-center gap-x-2 text-sm">
                {href ? (
                  <Link
                    to={href}
                    onClick={onNavigate}
                    className="font-medium text-primary underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
                  >
                    {row.recordRef ?? "Open"}
                  </Link>
                ) : row.recordRef ? (
                  <span className="font-medium text-foreground">{row.recordRef}</span>
                ) : null}
                {action && !isError && <span className="text-muted-foreground">{action}</span>}
              </p>
            )}
            {row.messages.length > 0 ? (
              <ul className="space-y-0.5">
                {row.messages.map((message, messageIndex) => (
                  <li
                    key={messageIndex}
                    className={cn("text-xs break-words", isError ? "text-destructive" : "text-muted-foreground")}
                  >
                    {message}
                  </li>
                ))}
              </ul>
            ) : (
              !href && !row.recordRef && !action && <p className="text-xs text-muted-foreground">No issues.</p>
            )}
          </div>
        </div>
      );
    },
    [visible, mode, type, onNavigate, linkRecords]
  );

  return (
    <div className={cn("flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card", className)}>
      <div
        role="radiogroup"
        aria-label="Filter rows"
        className="flex flex-wrap gap-1.5 border-b bg-muted/30 p-2"
      >
        {FILTERS.map((option) => {
          const active = filter === option.value;
          const count = counts[option.value];
          if (option.value !== "all" && count === 0 && !active) return null;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setFilter(option.value)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors duration-150 ease-out focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                active
                  ? "border-primary/30 bg-primary/10 text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              {option.label}
              <span className="tabular-nums text-muted-foreground">{count.toLocaleString()}</span>
            </button>
          );
        })}
      </div>
      <div
        aria-hidden
        className="hidden grid-cols-[3.5rem_8.5rem_minmax(0,1fr)] gap-x-3 border-b px-3 py-1.5 text-xs font-medium text-muted-foreground sm:grid"
      >
        <span>Row</span>
        <span>Status</span>
        <span>{mode === "run" ? "Record · notes" : "Details"}</span>
      </div>
      {visible.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <LuSearchX aria-hidden className="size-5 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No rows match this filter.</p>
        </div>
      ) : (
        <VirtualList
          count={visible.length}
          estimate={58}
          getKey={getKey}
          renderItem={renderItem}
          aria-label="Import rows"
          className="h-[min(22rem,45dvh)]"
        />
      )}
    </div>
  );
}

/** "142 ready · 6 warnings · 3 errors" with tone dots. */
export function TotalsLine({ parts }: { parts: { label: string; count: number; dot: string }[] }) {
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" aria-live="polite">
      {parts.map((part) => (
        <span key={part.label} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={cn("size-2 rounded-full", part.dot)} />
          <span className="font-semibold text-foreground tabular-nums">{part.count.toLocaleString()}</span>
          <span className="text-muted-foreground">{part.label}</span>
        </span>
      ))}
    </p>
  );
}
