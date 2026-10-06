import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  acknowledgeReview,
  createReview,
  deleteReview,
  getMyReviews,
  getReview,
  getReviewConfig,
  getReviews,
  updateGoal,
  updateReview,
} from "@/lib/performance-review";
import { useToast } from "@/hooks/use-toast";
import { useSSE } from "@/hooks/use-sse";
import { getErrorMessage } from "@/lib/api";
import type {
  AcknowledgeReviewInput,
  CreateReviewInput,
  UpdateGoalInput,
  UpdateReviewInput,
} from "@/types";

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const reviewKeys = {
  all: ["performance-reviews"] as const,
  mine: () => [...reviewKeys.all, "mine"] as const,
  mineList: (params?: Record<string, unknown>) =>
    [...reviewKeys.mine(), params] as const,
  list: (params?: Record<string, unknown>) =>
    [...reviewKeys.all, "list", params] as const,
  detail: (id: string) => [...reviewKeys.all, id] as const,
  /** Outside `all` so list invalidations don't refetch it. */
  config: () => ["performance-review-config"] as const,
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Employee: fetch their own reviews. */
export function useMyReviews(params?: {
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const queryClient = useQueryClient();

  // Real-time: invalidate review queries when any review-updated or review-ready event arrives.
  useSSE({
    event: "review-updated",
    onEvent: () => {
      void queryClient.invalidateQueries({ queryKey: reviewKeys.all });
    },
  });
  useSSE({
    event: "review-ready",
    onEvent: () => {
      void queryClient.invalidateQueries({ queryKey: reviewKeys.all });
    },
  });

  return useQuery({
    queryKey: reviewKeys.mineList(params),
    queryFn: () => getMyReviews(params),
  });
}

/** Admin/head: fetch all reviews with filters. */
export function useReviews(params?: {
  status?: string;
  employeeId?: string;
  period?: string;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const queryClient = useQueryClient();

  // Real-time: refresh when a review changes or an AI draft lands.
  useSSE({
    event: "review-updated",
    onEvent: () => {
      void queryClient.invalidateQueries({ queryKey: reviewKeys.all });
    },
  });
  useSSE({
    event: "review-ready",
    onEvent: () => {
      void queryClient.invalidateQueries({ queryKey: reviewKeys.all });
    },
  });

  return useQuery({
    queryKey: reviewKeys.list(params),
    queryFn: () => getReviews(params),
  });
}

/** Admin/head: server truth for whether "Draft with AI" is offered. */
export function useReviewConfig(enabled = true) {
  return useQuery({
    queryKey: reviewKeys.config(),
    queryFn: getReviewConfig,
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** Fetch a single review by ID. */
export function useReview(id: string | null) {
  return useQuery({
    queryKey: reviewKeys.detail(id ?? ""),
    queryFn: () => getReview(id!),
    enabled: !!id,
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Admin/head: create a new review. */
export function useCreateReview() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: (input: CreateReviewInput) => createReview(input),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: reviewKeys.all });
      toast.success("Review created as a draft");
      for (const warning of data.warnings ?? []) toast.warning(warning);
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/** Admin/head: update a review. */
export function useUpdateReview() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateReviewInput }) =>
      updateReview(id, input),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: reviewKeys.detail(variables.id),
      });
      void queryClient.invalidateQueries({ queryKey: reviewKeys.all });
      toast.success("Review updated");
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/** Employee: acknowledge a review. */
export function useAcknowledgeReview() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: ({ id, input }: { id: string; input?: AcknowledgeReviewInput }) =>
      acknowledgeReview(id, input),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: reviewKeys.detail(variables.id),
      });
      void queryClient.invalidateQueries({ queryKey: reviewKeys.mine() });
      toast.success("Review acknowledged");
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/** Admin/head: update a goal within a review. */
export function useUpdateGoal() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: ({
      reviewId,
      goalIndex,
      input,
    }: {
      reviewId: string;
      goalIndex: number;
      input: UpdateGoalInput;
    }) => updateGoal(reviewId, goalIndex, input),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: reviewKeys.detail(variables.reviewId),
      });
      void queryClient.invalidateQueries({ queryKey: reviewKeys.all });
      toast.success("Goal updated");
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/** Admin: delete a performance review. */
export function useDeleteReview() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: (id: string) => deleteReview(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: reviewKeys.all });
      toast.success("Review deleted");
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}
