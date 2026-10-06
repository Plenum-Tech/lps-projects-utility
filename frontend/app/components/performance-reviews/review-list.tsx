import type { ReactNode } from "react";
import { LuEye, LuTarget, LuTrash2 } from "react-icons/lu";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { PerformanceReview } from "@/types";
import { ReviewBadges } from "./review-content";

/** One review in a list — title, badges, a meta line, rating chips and goal progress. */
export function ReviewCard({
  review,
  title,
  meta,
  showRatings,
  onView,
  onDelete,
}: {
  review: PerformanceReview;
  title: ReactNode;
  meta: ReactNode;
  showRatings?: boolean;
  onView: () => void;
  /** Omitted when the viewer may not delete. */
  onDelete?: () => void;
}) {
  const completedGoals = review.goals.filter((g) => g.status === "completed").length;
  return (
    <Card className="transition-colors duration-150 hover:bg-muted/30">
      <CardContent className="flex flex-wrap items-center gap-4 p-4 sm:p-6">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-heading text-lg font-semibold text-foreground">{title}</h3>
            <ReviewBadges review={review} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {meta}
            {review.overallScore !== undefined && (
              <> · Overall {review.overallScore.toFixed(1)}/5</>
            )}
          </p>
          {showRatings && review.ratings.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-2" aria-label="Category scores">
              {review.ratings.map((rating) => (
                <li
                  key={rating.category}
                  className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                >
                  {rating.category}: {rating.score}/5
                </li>
              ))}
            </ul>
          )}
          {review.goals.length > 0 && (
            <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
              <LuTarget aria-hidden className="size-3" />
              {completedGoals}/{review.goals.length} goals completed
            </p>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onView}>
            <LuEye />
            View
          </Button>
          {onDelete && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              className="text-destructive hover:text-destructive"
            >
              <LuTrash2 />
              Delete
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function ReviewListSkeleton({ withChips }: { withChips?: boolean }) {
  return (
    <div className="grid gap-4" aria-busy="true" aria-label="Loading reviews">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="space-y-3 p-4 sm:p-6">
            <div className="flex items-center gap-2">
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-5 w-20" />
            </div>
            <Skeleton className="h-4 w-48" />
            {withChips && (
              <div className="flex gap-2">
                <Skeleton className="h-5 w-20" />
                <Skeleton className="h-5 w-20" />
                <Skeleton className="h-5 w-20" />
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
