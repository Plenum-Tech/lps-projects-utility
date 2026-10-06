import { useEffect, useState } from "react";
import { LuPlus, LuTrash2, LuTrophy } from "react-icons/lu";

import { ConfirmDialog } from "@/components/globals/confirm-dialog";
import { DataTablePagination } from "@/components/globals/data-table-pagination";
import { DataTableSearch } from "@/components/globals/data-table-search";
import { QueryError } from "@/components/globals/query-states";
import { AdminReviewDetailDialog } from "@/components/performance-reviews/admin-review-detail-dialog";
import { CreateReviewDialog } from "@/components/performance-reviews/create-review-dialog";
import {
  ADMIN_STATUS_FILTERS,
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
import { useCurrentUser } from "@/hooks/use-auth";
import { useDeleteReview, useReviews } from "@/hooks/use-performance-reviews";
import { usePagination } from "@/hooks/use-pagination";
import type { PerformanceReview, ReviewStatus, ReviewStatusFilter } from "@/types";

const PAGE_SIZE = 10;

const STATUS_FILTER_ITEMS = Object.fromEntries(
  ADMIN_STATUS_FILTERS.map((f) => [f.value, f.label])
);

/**
 * Admin/head performance reviews: write reviews (manually; AI drafting only
 * when enabled on the server), edit drafts, send them to employees and track
 * goals.
 */
export function TeamReviewsView({ embedded = false }: { embedded?: boolean }) {
  const [status, setStatus] = useState<ReviewStatusFilter>("all");
  const [search, setSearch] = useState("");
  const { page, setPage, offset, total, setTotal } = usePagination({
    limit: PAGE_SIZE,
    resetKey: `${search}|${status}`,
  });
  const { data, isPending, isError, error, refetch, isRefetching } = useReviews({
    status: status === "all" ? undefined : status,
    search: search || undefined,
    limit: PAGE_SIZE,
    offset,
  });
  const reviews = data?.reviews;
  const [createOpen, setCreateOpen] = useState(false);
  const [viewing, setViewing] = useState<PerformanceReview | null>(null);
  const [deleting, setDeleting] = useState<PerformanceReview | null>(null);
  const deleteReview = useDeleteReview();
  // Deleting reviews is admin-only on the API.
  const isAdmin = useCurrentUser().data?.role === "admin";

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
            Write reviews, send them to employees, and track their goals.
          </p>
          </div>
        )}
        <Button onClick={() => setCreateOpen(true)}>
          <LuPlus />
          Create review
        </Button>
      </header>

      <div className={embedded ? "mt-4 space-y-4" : "mt-8 space-y-4"}>
        {(total > 0 || search !== "" || status !== "all") && (
          <div className="flex flex-wrap items-center gap-3">
            <DataTableSearch
              value={search}
              onValueChange={setSearch}
              placeholder="Search by employee name…"
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
                  {ADMIN_STATUS_FILTERS.map((filter) => (
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
          <ReviewListSkeleton />
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
                  title={review.employee.name}
                  meta={
                    <>
                      {review.period} · {review.employee.email}
                    </>
                  }
                  onView={() => setViewing(review)}
                  onDelete={isAdmin ? () => setDeleting(review) : undefined}
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
              <EmptyDescription>No reviews match this status filter.</EmptyDescription>
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
              <EmptyTitle>No performance reviews</EmptyTitle>
              <EmptyDescription>
                Write your first review — rate each area, add feedback and goals, then send
                it to the employee.
              </EmptyDescription>
            </EmptyHeader>
            <Button onClick={() => setCreateOpen(true)}>
              <LuPlus />
              Create review
            </Button>
          </Empty>
        )}
      </div>

      <CreateReviewDialog open={createOpen} onOpenChange={setCreateOpen} />
      <AdminReviewDetailDialog
        review={viewing}
        onOpenChange={(open) => {
          if (!open) setViewing(null);
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete performance review?"
        description={
          deleting ? (
            <>
              The {deleting.period} review for {deleting.employee.name} will be permanently
              deleted. This can&apos;t be undone.
            </>
          ) : null
        }
        confirmLabel="Delete review"
        icon={<LuTrash2 />}
        destructive
        pending={deleteReview.isPending}
        onConfirm={() =>
          deleting &&
          deleteReview.mutate(deleting._id, { onSettled: () => setDeleting(null) })
        }
      />
    </div>
  );
}
