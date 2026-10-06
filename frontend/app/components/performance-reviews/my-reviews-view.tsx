import { useEffect, useState } from "react";
import { LuTrophy } from "react-icons/lu";

import { DataTablePagination } from "@/components/globals/data-table-pagination";
import { DataTableSearch } from "@/components/globals/data-table-search";
import { QueryError } from "@/components/globals/query-states";
import { EmployeeReviewDialog } from "@/components/performance-reviews/employee-review-dialog";
import {
  EMPLOYEE_STATUS_FILTERS,
  REVIEW_STATUS_META,
} from "@/components/performance-reviews/review-meta";
import { ReviewCard, ReviewListSkeleton } from "@/components/performance-reviews/review-list";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMyReviews } from "@/hooks/use-performance-reviews";
import { usePagination } from "@/hooks/use-pagination";
import type { PerformanceReview, ReviewStatus, ReviewStatusFilter } from "@/types";


const PAGE_SIZE = 10;

const STATUS_FILTER_ITEMS = Object.fromEntries(
  EMPLOYEE_STATUS_FILTERS.map((f) => [f.value, f.label])
);


/**
 * Employee performance reviews: read reviews your manager has sent you,
 * acknowledge them, and follow your goals.
 */
export function MyReviewsView({ embedded = false }: { embedded?: boolean }) {
  const [status, setStatus] = useState<ReviewStatusFilter>("all");
  const [search, setSearch] = useState("");
  const { page, setPage, offset, total, setTotal } = usePagination({
    limit: PAGE_SIZE,
    resetKey: `${search}|${status}`,
  });
  const { data, isPending, isError, error, refetch, isRefetching } = useMyReviews({
    status: status === "all" ? undefined : status,
    search: search || undefined,
    limit: PAGE_SIZE,
    offset,
  });
  const reviews = data?.reviews;
  const [viewing, setViewing] = useState<PerformanceReview | null>(null);

  useEffect(() => {
    setTotal(data?.total ?? 0);
  }, [data?.total, setTotal]);

  return (
    <div className={embedded ? undefined : "mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-8"}>
      <header className={embedded ? "flex flex-wrap items-end justify-end gap-4" : "flex flex-wrap items-end justify-between gap-4"}>
        {!embedded && (
          <div>
          <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground">
            Performance Reviews
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Read your performance feedback, track goals, and acknowledge reviews.
          </p>
          </div>
        )}
      </header>

      <div className={embedded ? "mt-4 space-y-4" : "mt-8 space-y-4"}>
        {(total > 0 || search !== "" || status !== "all") && (
          <div className="flex flex-wrap items-center gap-3">
            <DataTableSearch
              value={search}
              onValueChange={setSearch}
              placeholder="Search reviews…"
              className="flex-1"
            />
            <div className="w-full sm:w-56">
              <Select
                value={status}
                onValueChange={(value) => setStatus((value ?? "all") as ReviewStatusFilter)}
                items={STATUS_FILTER_ITEMS}
              >
                <SelectTrigger aria-label="Filter by status" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EMPLOYEE_STATUS_FILTERS.map((filter) => (
                    <SelectItem key={filter.value} value={filter.value}>
                      {filter.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {isPending ? (
          <ReviewListSkeleton withChips />
        ) : isError ? (
          <QueryError
            title="Couldn't load reviews"
            error={error}
            onRetry={() => void refetch()}
            retrying={isRefetching}
          />
        ) : total > 0 ? (
          <>
            <div className="grid gap-4">
              {reviews?.map((review) => (
                <ReviewCard
                  key={review._id}
                  review={review}
                  title={review.period}
                  meta={<>Reviewed by {review.reviewer.name}</>}
                  showRatings
                  onView={() => setViewing(review)}
                />
              ))}
            </div>
            <DataTablePagination
              page={page}
              limit={PAGE_SIZE}
              total={total}
              onPageChange={setPage}
            />
          </>
        ) : search !== "" ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <LuTrophy />
              </EmptyMedia>
              <EmptyTitle>No matching reviews</EmptyTitle>
              <EmptyDescription>
                Nothing matches &ldquo;{search}&rdquo;. Try a different keyword.
              </EmptyDescription>
            </EmptyHeader>
            <Button variant="outline" onClick={() => setSearch("")}>
              Clear search
            </Button>
          </Empty>
        ) : status !== "all" ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <LuTrophy />
              </EmptyMedia>
              <EmptyTitle>No {REVIEW_STATUS_META[status as ReviewStatus].label.toLowerCase()} reviews</EmptyTitle>
              <EmptyDescription>
                You don&apos;t have any reviews with this status right now.
              </EmptyDescription>
            </EmptyHeader>
            <Button variant="outline" onClick={() => setStatus("all")}>
              Show all reviews
            </Button>
          </Empty>
        ) : (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <LuTrophy />
              </EmptyMedia>
              <EmptyTitle>No performance reviews yet</EmptyTitle>
              <EmptyDescription>
                Reviews appear here once your manager sends them to you.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>

      <EmployeeReviewDialog
        review={viewing}
        onOpenChange={(open) => {
          if (!open) setViewing(null);
        }}
      />
    </div>
  );
}
