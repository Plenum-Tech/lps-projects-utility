import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useToast } from "@/hooks/use-toast";
import { API_BASE_URL, api, getErrorMessage } from "@/lib/api";
import type {
  AdminTraining,
  MyTraining,
  RequiredTraining,
  TrainingDetailResponse,
  TrainingInput,
  TrainingProgressRow,
  TrainingSummary,
} from "@/types";

export const trainingKeys = {
  all: ["trainings"] as const,
  mine: ["trainings", "mine"] as const,
  admin: (archived: boolean) => ["trainings", "admin", { archived }] as const,
  detail: (id: string) => ["trainings", "detail", id] as const,
  progress: (id: string) => ["trainings", "progress", id] as const,
};

/** Slide image URL (1-based). `v` busts the browser cache when the deck is replaced. */
export function trainingSlideUrl(
  id: string,
  slide: number,
  version: number,
): string {
  return `${API_BASE_URL}/trainings/${id}/slides/${slide}?v=${version}`;
}

export function trainingSourceUrl(id: string): string {
  return `${API_BASE_URL}/trainings/${id}/source`;
}

/** Mandatory trainings still to complete (drives the sign-in pop-up). */
export function useRequiredTrainings(enabled = true) {
  return useQuery({
    queryKey: [...trainingKeys.all, "required"] as const,
    queryFn: async () => {
      const { data } = await api.get<{ trainings: RequiredTraining[] }>("/trainings/required");
      return data.trainings;
    },
    enabled,
    staleTime: 60_000,
  });
}

export function useMyTrainings() {
  return useQuery({
    queryKey: trainingKeys.mine,
    queryFn: async () => {
      const { data } = await api.get<{ trainings: MyTraining[] }>(
        "/trainings/mine",
      );
      return data.trainings;
    },
  });
}

export function useTraining(id: string | undefined) {
  return useQuery({
    queryKey: trainingKeys.detail(id ?? ""),
    queryFn: async () => {
      const { data } = await api.get<TrainingDetailResponse>(
        `/trainings/${id}`,
      );
      return data;
    },
    enabled: Boolean(id),
  });
}

export function useAdminTrainings(archived: boolean, enabled = true) {
  return useQuery({
    queryKey: trainingKeys.admin(archived),
    queryFn: async () => {
      const { data } = await api.get<{ trainings: AdminTraining[] }>(
        "/trainings",
        {
          params: archived ? { archived: "true" } : {},
        },
      );
      return data.trainings;
    },
    enabled,
  });
}

export function useTrainingProgress(id: string | null) {
  return useQuery({
    queryKey: trainingKeys.progress(id ?? ""),
    queryFn: async () => {
      const { data } = await api.get<{
        training: TrainingSummary;
        rows: TrainingProgressRow[];
      }>(`/trainings/${id}/progress`);
      return data;
    },
    enabled: Boolean(id),
  });
}

/** Records slides seen (fire-and-forget; the server de-duplicates). */
export function useRecordTrainingProgress(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (slides: number[]) => {
      const { data } = await api.post<{
        progress: TrainingDetailResponse["progress"];
      }>(`/trainings/${id}/progress`, { slides });
      return data.progress;
    },
    onSuccess: (progress) => {
      queryClient.setQueryData<TrainingDetailResponse>(
        trainingKeys.detail(id),
        (current) => (current ? { ...current, progress } : current),
      );
      void queryClient.invalidateQueries({ queryKey: trainingKeys.mine });
    },
  });
}

export function useCompleteTraining(id: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    /** `slides`: slides read in this session (saved with the completion). */
    mutationFn: async (slides: number[] = []) => {
      const { data } = await api.post<{
        progress: TrainingDetailResponse["progress"];
      }>(`/trainings/${id}/complete`, { acknowledged: true, slides });
      return data.progress;
    },
    onSuccess: (progress) => {
      queryClient.setQueryData<TrainingDetailResponse>(
        trainingKeys.detail(id),
        (current) => (current ? { ...current, progress } : current),
      );
      void queryClient.invalidateQueries({ queryKey: trainingKeys.all });
      toast.success("Training completed");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

function toFormData(input: Partial<TrainingInput>): FormData {
  const form = new FormData();
  if (input.title !== undefined) form.append("title", input.title);
  if (input.description !== undefined)
    form.append("description", input.description);
  if (input.dueDate !== undefined) form.append("dueDate", input.dueDate);
  if (input.assignAll !== undefined)
    form.append("assignAll", String(input.assignAll));
  if (input.departments !== undefined)
    form.append("departments", JSON.stringify(input.departments));
  if (input.users !== undefined)
    form.append("users", JSON.stringify(input.users));
  if (input.resetProgress !== undefined)
    form.append("resetProgress", String(input.resetProgress));
  if (input.archived !== undefined)
    form.append("archived", String(input.archived));
  if (input.mandatory !== undefined)
    form.append("mandatory", String(input.mandatory));
  if (input.completeWithinDays !== undefined)
    form.append("completeWithinDays", String(input.completeWithinDays));
  if (input.file) form.append("file", input.file);
  return form;
}

/** Converting a large deck can take a while. */
const UPLOAD_TIMEOUT_MS = 300_000;

export function useCreateTraining() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (input: TrainingInput) => {
      const { data } = await api.post<{
        training: TrainingSummary;
        notified: number;
      }>("/trainings", toFormData(input), { headers: { "Content-Type": "multipart/form-data" }, timeout: UPLOAD_TIMEOUT_MS });
      return data;
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: trainingKeys.all });
      toast.success(`Training published · ${data.training.slideCount} slides`);
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useUpdateTraining() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async ({
      id,
      input,
    }: {
      id: string;
      input: Partial<TrainingInput>;
    }) => {
      const { data } = await api.patch<{ training: TrainingSummary }>(
        `/trainings/${id}`,
        toFormData(input),
        {
          headers: { "Content-Type": "multipart/form-data" },
        timeout: UPLOAD_TIMEOUT_MS,
        },
      );
      return data.training;
    },
    onSuccess: (training, { input }) => {
      void queryClient.invalidateQueries({ queryKey: trainingKeys.all });
      toast.success(
        input.archived === true
          ? "Training archived"
          : input.archived === false
            ? "Training restored"
            : `Saved "${training.title}"`,
      );
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useDeleteTraining() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/trainings/${id}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: trainingKeys.all });
      toast.success("Training deleted");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useRemindTraining() {
  const toast = useToast();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.post<{ notified: number }>(
        `/trainings/${id}/remind`,
      );
      return data.notified;
    },
    onSuccess: (notified) =>
      toast.success(
        notified === 0
          ? "Everyone has completed it"
          : `Reminder sent to ${notified} people`,
      ),
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}
