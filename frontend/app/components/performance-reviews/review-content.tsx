import type { ReactNode } from "react";
import {
  LuCircleCheck,
  LuCircleDashed,
  LuClock,
  LuFileText,
  LuSparkles,
  LuTarget,
  LuTrendingUp,
  LuTrophy,
} from "react-icons/lu";

import { formatDate } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import type { PerformanceReview, ReviewGoal } from "@/types";
import { REVIEW_STATUS_META } from "./review-meta";
import { StarRating } from "./star-rating";

/** Status badge plus an "AI drafted" badge only when the AI actually wrote content. */
export function ReviewBadges({ review }: { review: PerformanceReview }) {
  const meta = REVIEW_STATUS_META[review.status];
  return (
    <>
      <Badge variant={meta.variant}>{meta.label}</Badge>
      {review.aiGenerated && (
        <Badge variant="secondary" className="gap-1">
          <LuSparkles aria-hidden className="size-3" />
          AI drafted
        </Badge>
      )}
    </>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h4 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        {icon}
        {title}
      </h4>
      {children}
    </section>
  );
}

function Prose({ children }: { children: ReactNode }) {
  return (
    <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}

function GoalStatusIcon({ status }: { status: ReviewGoal["status"] }) {
  if (status === "completed") {
    return <LuCircleCheck aria-label="Completed" className="size-4 text-primary" />;
  }
  if (status === "in_progress") {
    return <LuClock aria-label="In progress" className="size-4 text-foreground" />;
  }
  return <LuCircleDashed aria-label="Not started" className="size-4 text-muted-foreground" />;
}

/**
 * Read-only body of a review — overall score, ratings, written feedback and
 * goals. `goalAction` renders per-goal controls (status select or badge).
 */
export function ReviewContent({
  review,
  goalAction,
}: {
  review: PerformanceReview;
  goalAction?: (goal: ReviewGoal, index: number) => ReactNode;
}) {
  const hasText = review.summary || review.strengths || review.improvements;
  const isEmpty =
    review.overallScore === undefined &&
    review.ratings.length === 0 &&
    !hasText &&
    review.goals.length === 0;

  if (isEmpty) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        <LuFileText aria-hidden className="size-5 shrink-0" />
        Nothing has been written for this review yet.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {review.overallScore !== undefined && (
        <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-4">
          <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <span className="text-xl font-bold">{review.overallScore.toFixed(1)}</span>
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">Overall score</p>
            <StarRating score={review.overallScore} />
          </div>
        </div>
      )}

      {review.ratings.length > 0 && (
        <Section title="Category ratings">
          <ul className="grid gap-2">
            {review.ratings.map((rating) => (
              <li
                key={rating.category}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{rating.category}</p>
                  {rating.comment && (
                    <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">
                      {rating.comment}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <StarRating score={rating.score} size="sm" />
                  <span className="text-sm font-semibold text-foreground">
                    {rating.score}/5
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {review.summary && (
        <Section title="Summary">
          <Prose>{review.summary}</Prose>
        </Section>
      )}

      {review.strengths && (
        <Section
          title="Strengths"
          icon={<LuTrophy aria-hidden className="size-4 text-primary" />}
        >
          <Prose>{review.strengths}</Prose>
        </Section>
      )}

      {review.improvements && (
        <Section
          title="Areas for improvement"
          icon={<LuTrendingUp aria-hidden className="size-4 text-muted-foreground" />}
        >
          <Prose>{review.improvements}</Prose>
        </Section>
      )}

      {review.goals.length > 0 && (
        <Section
          title="Goals"
          icon={<LuTarget aria-hidden className="size-4 text-primary" />}
        >
          <ul className="space-y-2">
            {review.goals.map((goal, idx) => (
              <li key={idx} className="flex flex-wrap items-start gap-3 rounded-md border p-3">
                <div className="mt-0.5">
                  <GoalStatusIcon status={goal.status} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{goal.title}</p>
                  {goal.description && (
                    <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">
                      {goal.description}
                    </p>
                  )}
                  {goal.dueDate && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Due {formatDate(goal.dueDate)}
                    </p>
                  )}
                </div>
                {goalAction?.(goal, idx)}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
