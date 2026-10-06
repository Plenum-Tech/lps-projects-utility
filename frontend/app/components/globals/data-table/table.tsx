import type { ReactNode } from "react";
import { LuArrowDown, LuArrowUp, LuArrowUpDown } from "react-icons/lu";

import { QueryError } from "@/components/globals/query-states";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { RowSelection, SortDir } from "@/hooks/use-table-state";
import { cn } from "@/lib/utils";

export interface DataTableColumn<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Server sort field — makes the header a sort button. */
  sortKey?: string;
  /** Several sort buttons in one header (e.g. "Progress / Status"); overrides `header`. */
  sortKeys?: { key: string; label: string }[];
  className?: string;
  headClassName?: string;
}

/**
 * Server-driven data table: selectable rows (header checkbox selects the
 * page), sortable headers (↑/↓, `aria-sort`), sticky header with scrolling
 * inside the card, designed loading / error / empty states, and stacked cards
 * below `md` (same actions, no horizontal page scroll).
 */
export function DataTable<T>({
  columns,
  rows,
  getRowId,
  getRowLabel,
  selection,
  sort,
  dir,
  onSort,
  loading,
  error,
  onRetry,
  retrying,
  errorTitle = "Couldn't load the list",
  empty,
  mobileCard,
  footer,
  dimmed,
  caption,
  rowClassName,
}: {
  columns: DataTableColumn<T>[];
  rows: T[] | undefined;
  getRowId: (row: T) => string;
  /** Accessible name for the row checkbox ("Select PEAR-12"). */
  getRowLabel: (row: T) => string;
  selection?: RowSelection;
  sort?: string;
  dir?: SortDir;
  onSort?: (field: string) => void;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  errorTitle?: string;
  /** Rendered (inside the card) when there are no rows. */
  empty: ReactNode;
  /** Stacked card for small screens. */
  mobileCard: (row: T) => ReactNode;
  /** Pagination footer. */
  footer?: ReactNode;
  /** Placeholder data is showing while the next page loads. */
  dimmed?: boolean;
  caption: string;
  rowClassName?: (row: T) => string | undefined;
}) {
  const pageIds = (rows ?? []).map(getRowId);
  const selectedOnPage = selection ? pageIds.filter((id) => selection.selected.has(id)).length : 0;
  const allOnPage = pageIds.length > 0 && selectedOnPage === pageIds.length;
  const someOnPage = selectedOnPage > 0 && !allOnPage;
  const colSpan = columns.length + (selection ? 1 : 0);

  return (
    <div className="overflow-hidden rounded-xl border bg-card text-card-foreground">
      {error ? (
        <div className="p-4">
          <QueryError title={errorTitle} error={error} onRetry={onRetry} retrying={retrying} />
        </div>
      ) : (
        <>
          {/* Desktop / tablet table */}
          <div
            className={cn(
              "hidden max-h-[70vh] overflow-auto transition-opacity duration-150 md:block",
              dimmed && "opacity-70"
            )}
          >
            <table className="w-full caption-bottom text-sm">
              <caption className="sr-only">{caption}</caption>
              <TableHeader className="sticky top-0 z-10 bg-muted/80 backdrop-blur supports-[backdrop-filter]:bg-muted/60">
                <TableRow className="hover:bg-transparent">
                  {selection && (
                    <TableHead className="w-10 pl-4">
                      <Checkbox
                        checked={allOnPage}
                        indeterminate={someOnPage}
                        onCheckedChange={(checked) => selection.setMany(pageIds, Boolean(checked))}
                        disabled={pageIds.length === 0}
                        aria-label={allOnPage ? "Deselect all rows on this page" : "Select all rows on this page"}
                      />
                    </TableHead>
                  )}
                  {columns.map((column) => {
                    const keys =
                      column.sortKeys ??
                      (column.sortKey ? [{ key: column.sortKey, label: "" }] : []);
                    const activeKey = keys.find((item) => item.key === sort);
                    return (
                      <TableHead
                        key={column.id}
                        className={cn("text-xs font-semibold text-muted-foreground", column.headClassName)}
                        aria-sort={
                          keys.length > 0
                            ? activeKey
                              ? dir === "desc"
                                ? "descending"
                                : "ascending"
                              : "none"
                            : undefined
                        }
                      >
                        {keys.length > 0 && onSort ? (
                          <span className="inline-flex items-center gap-1">
                            {keys.map((item, index) => (
                              <span key={item.key} className="inline-flex items-center gap-1">
                                {index > 0 && <span aria-hidden>/</span>}
                                <SortButton
                                  active={sort === item.key}
                                  dir={dir}
                                  onClick={() => onSort(item.key)}
                                >
                                  {item.label || column.header}
                                </SortButton>
                              </span>
                            ))}
                          </span>
                        ) : (
                          column.header
                        )}
                      </TableHead>
                    );
                  })}
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  Array.from({ length: 6 }).map((_, index) => (
                    <TableRow key={index} className="hover:bg-transparent" aria-hidden>
                      {selection && (
                        <TableCell className="pl-4">
                          <Skeleton className="size-4" />
                        </TableCell>
                      )}
                      {columns.map((column, columnIndex) => (
                        <TableCell key={column.id} className="py-3">
                          <Skeleton className={cn("h-4", columnIndex === 1 ? "w-40" : "w-16")} />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : (rows ?? []).length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={colSpan} className="p-4 whitespace-normal">
                      {empty}
                    </TableCell>
                  </TableRow>
                ) : (
                  (rows ?? []).map((row) => {
                    const id = getRowId(row);
                    const selected = selection?.selected.has(id) ?? false;
                    return (
                      <TableRow
                        key={id}
                        data-state={selected ? "selected" : undefined}
                        className={cn("align-top", rowClassName?.(row))}
                      >
                        {selection && (
                          <TableCell className="w-10 pt-3 pl-4">
                            <Checkbox
                              checked={selected}
                              onCheckedChange={(checked) => selection.toggle(id, Boolean(checked))}
                              aria-label={`Select ${getRowLabel(row)}`}
                            />
                          </TableCell>
                        )}
                        {columns.map((column) => (
                          <TableCell key={column.id} className={cn("py-2.5", column.className)}>
                            {column.cell(row)}
                          </TableCell>
                        ))}
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </table>
          </div>

          {/* Phones: stacked cards */}
          <div className={cn("md:hidden", dimmed && "opacity-70")}>
            {selection && (rows ?? []).length > 0 && !loading && (
              <div className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={allOnPage}
                  indeterminate={someOnPage}
                  onCheckedChange={(checked) => selection.setMany(pageIds, Boolean(checked))}
                  aria-label="Select all on this page"
                />
                Select page
              </div>
            )}
            {loading ? (
              <ul aria-busy="true" aria-label="Loading" className="divide-y">
                {Array.from({ length: 4 }).map((_, index) => (
                  <li key={index} className="space-y-2 p-3">
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="h-3 w-1/2" />
                    <Skeleton className="h-6 w-24" />
                  </li>
                ))}
              </ul>
            ) : (rows ?? []).length === 0 ? (
              <div className="p-3">{empty}</div>
            ) : (
              <ul className="divide-y">
                {(rows ?? []).map((row) => {
                  const id = getRowId(row);
                  const selected = selection?.selected.has(id) ?? false;
                  return (
                    <li
                      key={id}
                      className={cn(
                        "flex gap-3 p-3 transition-colors duration-150",
                        selected && "bg-muted"
                      )}
                    >
                      {selection && (
                        <Checkbox
                          className="mt-0.5"
                          checked={selected}
                          onCheckedChange={(checked) => selection.toggle(id, Boolean(checked))}
                          aria-label={`Select ${getRowLabel(row)}`}
                        />
                      )}
                      <div className="min-w-0 flex-1">{mobileCard(row)}</div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
      {!error && footer}
    </div>
  );
}

function SortButton({
  active,
  dir,
  onClick,
  children,
}: {
  active: boolean;
  dir?: SortDir;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "-mx-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
        active && "text-foreground"
      )}
    >
      {children}
      {active ? (
        dir === "desc" ? (
          <LuArrowDown aria-hidden className="size-3.5 text-primary" />
        ) : (
          <LuArrowUp aria-hidden className="size-3.5 text-primary" />
        )
      ) : (
        <LuArrowUpDown aria-hidden className="size-3.5 opacity-50" />
      )}
      {active && (
        <span className="sr-only">{dir === "desc" ? "(sorted descending)" : "(sorted ascending)"}</span>
      )}
    </button>
  );
}

/** Label/value pair used inside the stacked mobile cards. */
export function MobileField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="mt-0.5 text-xs text-foreground">{children}</dd>
    </div>
  );
}
