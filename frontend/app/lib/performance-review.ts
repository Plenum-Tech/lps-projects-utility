import { api } from "./api";
import type {
  AcknowledgeReviewInput,
  CreateReviewInput,
  CreateReviewResponse,
  ReviewConfig,
  ReviewListResponse,
  UpdateGoalInput,
  UpdateReviewInput,
  ReviewResponse,
} from "@/types";

// ---------------------------------------------------------------------------
// API client functions for performance reviews
// ---------------------------------------------------------------------------

/** Employee: fetch their own reviews. */
export async function getMyReviews(params?: {
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<ReviewListResponse> {
  const { data } = await api.get<ReviewListResponse>("/performance-reviews/mine", {
    params,
  });
  return data;
}

/** Admin/head: fetch all reviews with filters. */
export async function getReviews(params?: {
  status?: string;
  employeeId?: string;
  period?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<ReviewListResponse> {
  const { data } = await api.get<ReviewListResponse>("/performance-reviews", {
    params,
  });
  return data;
}

/** Fetch a single review by ID. */
export async function getReview(id: string): Promise<ReviewResponse> {
  const { data } = await api.get<ReviewResponse>(`/performance-reviews/${id}`);
  return data;
}

/** Admin/head: whether optional AI drafting is enabled on the server. */
export async function getReviewConfig(): Promise<ReviewConfig> {
  const { data } = await api.get<ReviewConfig>("/performance-reviews/config");
  return data;
}

/** Admin/head: create a review (manual; AI drafts only when `aiDraft` is set and enabled). */
export async function createReview(
  input: CreateReviewInput
): Promise<CreateReviewResponse> {
  const { data } = await api.post<CreateReviewResponse>(
    "/performance-reviews",
    input
  );
  return data;
}

/** Admin/head: update a review (ratings, goals, feedback). */
export async function updateReview(
  id: string,
  input: UpdateReviewInput
): Promise<ReviewResponse> {
  const { data } = await api.patch<ReviewResponse>(
    `/performance-reviews/${id}`,
    input
  );
  return data;
}

/** Employee: acknowledge a review. */
export async function acknowledgeReview(
  id: string,
  input?: AcknowledgeReviewInput
): Promise<ReviewResponse> {
  const { data } = await api.post<ReviewResponse>(
    `/performance-reviews/${id}/acknowledge`,
    input ?? {}
  );
  return data;
}

/** Admin/head: update a specific goal within a review. */
export async function updateGoal(
  reviewId: string,
  goalIndex: number,
  input: UpdateGoalInput
): Promise<ReviewResponse> {
  const { data } = await api.patch<ReviewResponse>(
    `/performance-reviews/${reviewId}/goals/${goalIndex}`,
    input
  );
  return data;
}

/** Admin: delete a performance review. */
export async function deleteReview(id: string): Promise<{ message: string }> {
  const { data } = await api.delete<{ message: string }>(
    `/performance-reviews/${id}`
  );
  return data;
}
