import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { taskKeys } from "@/hooks/use-tasks";
import { useToast } from "@/hooks/use-toast";
import { api, getErrorMessage } from "@/lib/api";
import type {
  AssignableUsersResponse,
  SendTestEmailResponse,
  SmtpStatus,
  TaskCategory,
  TaskLabel,
  TaskLabelInput,
  TaskSettings,
  TaskSettingsInput,
} from "@/types";

export const taskMetaKeys = {
  labels: ["task-labels"] as const,
  categories: ["task-categories"] as const,
  settings: ["task-settings"] as const,
  assignable: (search: string) => ["task-assignable-users", search] as const,
  emailStatus: ["admin-email-status"] as const,
};

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export function useTaskLabels() {
  return useQuery({
    queryKey: taskMetaKeys.labels,
    queryFn: async () => {
      const { data } = await api.get<{ labels: TaskLabel[] }>("/task-labels");
      return data.labels;
    },
    staleTime: 60_000,
  });
}

export function useCreateTaskLabel() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async (input: TaskLabelInput) => {
      const { data } = await api.post<{ label: TaskLabel }>("/task-labels", input);
      return data.label;
    },
    onSuccess: (label) => {
      void queryClient.invalidateQueries({ queryKey: taskMetaKeys.labels });
      toast.success(`Label "${label.name}" created`);
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useUpdateTaskLabel() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: TaskLabelInput }) => {
      const { data } = await api.patch<{ label: TaskLabel }>(`/task-labels/${id}`, input);
      return data.label;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskMetaKeys.labels });
      void queryClient.invalidateQueries({ queryKey: taskKeys.all });
      toast.success("Label updated");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useDeleteTaskLabel() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.delete<{ success: true; tasksUpdated: number }>(
        `/task-labels/${id}`
      );
      return data;
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: taskMetaKeys.labels });
      void queryClient.invalidateQueries({ queryKey: taskKeys.all });
      toast.success(
        data.tasksUpdated > 0
          ? `Label deleted and removed from ${data.tasksUpdated} task${data.tasksUpdated === 1 ? "" : "s"}`
          : "Label deleted"
      );
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export function useTaskCategories() {
  return useQuery({
    queryKey: taskMetaKeys.categories,
    queryFn: async () => {
      const { data } = await api.get<{ categories: TaskCategory[] }>("/task-categories");
      return data.categories;
    },
    staleTime: 60_000,
  });
}

export function useCreateTaskCategory() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async (name: string) => {
      const { data } = await api.post<{ category: TaskCategory }>("/task-categories", { name });
      return data.category;
    },
    onSuccess: (category) => {
      void queryClient.invalidateQueries({ queryKey: taskMetaKeys.categories });
      toast.success(`Category "${category.name}" created`);
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useUpdateTaskCategory() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const { data } = await api.patch<{ category: TaskCategory }>(`/task-categories/${id}`, {
        name,
      });
      return data.category;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskMetaKeys.categories });
      void queryClient.invalidateQueries({ queryKey: taskKeys.all });
      toast.success("Category renamed");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useDeleteTaskCategory() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.delete<{ success: true; tasksUpdated: number }>(
        `/task-categories/${id}`
      );
      return data;
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: taskMetaKeys.categories });
      void queryClient.invalidateQueries({ queryKey: taskKeys.all });
      toast.success(
        data.tasksUpdated > 0
          ? `Category deleted and cleared on ${data.tasksUpdated} task${data.tasksUpdated === 1 ? "" : "s"}`
          : "Category deleted"
      );
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

// ---------------------------------------------------------------------------
// Reminder settings (admin)
// ---------------------------------------------------------------------------

export function useTaskSettings(enabled = true) {
  return useQuery({
    queryKey: taskMetaKeys.settings,
    queryFn: async () => {
      const { data } = await api.get<{ settings: TaskSettings }>("/task-settings");
      return data.settings;
    },
    enabled,
  });
}

export function useUpdateTaskSettings() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async (input: TaskSettingsInput) => {
      const { data } = await api.patch<{ settings: TaskSettings }>("/task-settings", input);
      return data.settings;
    },
    onSuccess: (settings) => {
      queryClient.setQueryData(taskMetaKeys.settings, settings);
      toast.success("Reminder settings saved");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

// ---------------------------------------------------------------------------
// Assignable users (everyone, for any signed-in user)
// ---------------------------------------------------------------------------

export function useAssignableUsers(enabled = true, search = "") {
  return useQuery({
    queryKey: taskMetaKeys.assignable(search),
    queryFn: async () => {
      const { data } = await api.get<AssignableUsersResponse>("/tasks/assignable-users", {
        params: search ? { search } : {},
      });
      return data.users;
    },
    enabled,
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------
// SMTP (admin)
// ---------------------------------------------------------------------------

/** Runs an SMTP verify on the server — can take a few seconds. */
export function useEmailStatus(enabled = true) {
  return useQuery({
    queryKey: taskMetaKeys.emailStatus,
    queryFn: async () => {
      const { data } = await api.get<{ status: SmtpStatus }>("/admin/email/status", {
        timeout: 30_000,
      });
      return data.status;
    },
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useSendTestEmail() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async (to?: string) => {
      const { data } = await api.post<SendTestEmailResponse>(
        "/admin/email/test",
        to ? { to } : {},
        { timeout: 30_000 }
      );
      return data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(taskMetaKeys.emailStatus, data.status);
      toast.success(`Test email sent to ${data.deliveredTo}`);
    },
    onError: (error: unknown) => {
      const status = (error as { response?: { data?: { status?: SmtpStatus } } }).response?.data
        ?.status;
      if (status) queryClient.setQueryData(taskMetaKeys.emailStatus, status);
      toast.error(getErrorMessage(error));
    },
  });
}
