import { LuChevronLeft, LuChevronRight, LuEllipsis } from "react-icons/lu";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PAGE_SIZES } from "@/hooks/use-table-state";
import { cn } from "@/lib/utils";

/** Page numbers with ellipses: 1 … 4 5 6 … 12. */
export function pageWindow(page: number, totalPages: number): (number | "gap")[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
  const pages = new Set([1, totalPages, page - 1, page, page + 1]);
  if (page <= 3) [2, 3, 4].forEach((value) => pages.add(value));
  if (page >= totalPages - 2) [totalPages - 3, totalPages - 2, totalPages - 1].forEach((value) => pages.add(value));
  const sorted = [...pages].filter((value) => value >= 1 && value <= totalPages).sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  sorted.forEach((value, index) => {
    if (index > 0 && value - sorted[index - 1] > 1) out.push("gap");
    out.push(value);
  });
  return out;
}

/**
 * Footer for server-side tables: "Show [10|25|50|100] entries",
 * "Showing x to y of z entries" and Previous / page numbers / Next.
 */
export function DataTablePager({
  page,
  pageSize,
  total,
  shown,
  onPageChange,
  onPageSizeChange,
  noun = "entries",
  className,
}: {
  page: number;
  pageSize: number;
  total: number;
  /** Rows on the current page (y = offset + shown). */
  shown: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  noun?: string;
  className?: string;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = total === 0 ? 0 : (page - 1) * pageSize + shown;
  const items = Object.fromEntries(PAGE_SIZES.map((size) => [String(size), String(size)]));

  return (
    <div
      className={cn(
        "flex flex-col gap-3 border-t px-3 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-4",
        className
      )}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2">
          <span>Show</span>
          <Select
            value={String(pageSize)}
            onValueChange={(value) => value && onPageSizeChange(Number(value))}
            items={items}
          >
            <SelectTrigger size="sm" aria-label="Rows per page" className="w-18">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span>{noun}</span>
        </label>
        <p aria-live="polite" className="tabular-nums">
          Showing {from} to {to} of {total} {noun}
        </p>
      </div>

      {totalPages > 1 && (
        <nav aria-label="Pagination" className="flex items-center gap-1 self-end sm:self-auto">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
          >
            <LuChevronLeft aria-hidden />
            <span className="hidden sm:inline">Previous</span>
            <span className="sr-only sm:hidden">Previous page</span>
          </Button>
          <ul className="hidden items-center gap-1 sm:flex">
            {pageWindow(page, totalPages).map((item, index) =>
              item === "gap" ? (
                <li key={`gap-${index}`} aria-hidden className="flex size-8 items-center justify-center">
                  <LuEllipsis className="size-4" />
                </li>
              ) : (
                <li key={item}>
                  <Button
                    variant={item === page ? "outline" : "ghost"}
                    size="icon-sm"
                    aria-current={item === page ? "page" : undefined}
                    aria-label={`Page ${item}`}
                    className={cn("tabular-nums", item === page && "border-ring/60 text-foreground")}
                    onClick={() => onPageChange(item)}
                  >
                    {item}
                  </Button>
                </li>
              )
            )}
          </ul>
          <span className="px-2 text-xs tabular-nums sm:hidden">
            {page} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
          >
            <span className="hidden sm:inline">Next</span>
            <span className="sr-only sm:hidden">Next page</span>
            <LuChevronRight aria-hidden />
          </Button>
        </nav>
      )}
    </div>
  );
}
