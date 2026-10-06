import type { ReviewStatus, ReviewStatusFilter } from "@/types";

/** Badge label + variant per review status (shared by admin and employee views). */
export const REVIEW_STATUS_META: Record<
  ReviewStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  draft: { label: "Draft", variant: "secondary" },
  pending_acknowledgment: { label: "Pending", variant: "outline" },
  acknowledged: { label: "Acknowledged", variant: "default" },
  completed: { label: "Completed", variant: "default" },
};

export const ADMIN_STATUS_FILTERS: { value: ReviewStatusFilter; label: string }[] = [
  { value: "all", label: "All reviews" },
  { value: "draft", label: "Draft" },
  { value: "pending_acknowledgment", label: "Pending acknowledgment" },
  { value: "acknowledged", label: "Acknowledged" },
  { value: "completed", label: "Completed" },
];

/** Employees never see drafts — those stay with the reviewer until sent. */
export const EMPLOYEE_STATUS_FILTERS = ADMIN_STATUS_FILTERS.filter(
  (filter) => filter.value !== "draft"
);

/** Pre-filled categories for a new review; reviewers can rename, add or remove. */
export const DEFAULT_REVIEW_CATEGORIES = [
  "Communication",
  "Technical Skills",
  "Teamwork",
  "Leadership",
];

/** Limits mirrored from the API (controllers/performanceReviews.ts). */
export const REVIEW_LIMITS = {
  ratings: 10,
  category: 100,
  ratingComment: 1000,
  goals: 20,
  goalTitle: 200,
  goalDescription: 2000,
  text: 5000,
  period: 50,
} as const;

export const SCORE_LABELS: Record<number, string> = {
  1: "Needs significant improvement",
  2: "Below expectations",
  3: "Meets expectations",
  4: "Exceeds expectations",
  5: "Outstanding",
};

/** Average of category scores, one decimal — same rule as the API. */
export function averageScore(scores: number[]): number | undefined {
  if (scores.length === 0) return undefined;
  const total = scores.reduce((sum, s) => sum + s, 0);
  return Math.round((total / scores.length) * 10) / 10;
}
