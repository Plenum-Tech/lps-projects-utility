import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { projectKeys } from "@/hooks/use-projects";
import { useToast } from "@/hooks/use-toast";
import { api, getErrorMessage } from "@/lib/api";
import type {
  Paginated,
  ProjectCategory,
  ProjectSettings,
  ProjectSettingsInput,
  ProjectStatus,
  ProjectStatusInput,
} from "@/types";

export const projectMetaKeys = {
  statuses: ["project-statuses"] as const,
  categories: ["project-categories"] as const,
  settings: ["project-settings"] as const,
  /** Public subset for every role (where time may be logged). */
  timeSettings: ["project-settings", "time"] as const,
};

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

export function useProjectStatuses() {
  return useQuery({
    queryKey: projectMetaKeys.statuses,
    queryFn: async () => {
      const { data } = await api.get<Paginated<"statuses", ProjectStatus>>(
        "/project-meta/statuses"
      );
      return data.statuses;
    },
    staleTime: 60_000,
  });
}

function useStatusMutation<V>(
  fn: (variables: V) => Promise<unknown>,
  message: string | ((variables: V) => string)
) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: projectMetaKeys.statuses });
      void queryClient.invalidateQueries({ queryKey: projectKeys.all });
      toast.success(typeof message === "function" ? message(variables) : message);
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useCreateProjectStatus() {
  return useStatusMutation(async (input: ProjectStatusInput) => {
    const { data } = await api.post<{ status: ProjectStatus }>("/project-meta/statuses", input);
    return data.status;
  }, "Status created");
}

export function useUpdateProjectStatus() {
  return useStatusMutation(async ({ id, input }: { id: string; input: ProjectStatusInput }) => {
    const { data } = await api.patch<{ status: ProjectStatus }>(
      `/project-meta/statuses/${id}`,
      input
    );
    return data.status;
  }, "Status updated");
}

export function useSetDefaultProjectStatus() {
  return useStatusMutation(async (id: string) => {
    const { data } = await api.post<{ status: ProjectStatus }>(
      `/project-meta/statuses/${id}/default`
    );
    return data.status;
  }, "Default status changed");
}

/**
 * Delete a status. A 409 (`projectCount`) is returned to the caller so it can
 * ask for a reassign target — no toast in that case.
 */
export function useDeleteProjectStatus() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async ({ id, reassignTo }: { id: string; reassignTo?: string }) => {
      const { data } = await api.delete<{ success: true; projectsReassigned: number }>(
        `/project-meta/statuses/${id}`,
        { params: reassignTo ? { reassignTo } : {} }
      );
      return data;
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: projectMetaKeys.statuses });
      void queryClient.invalidateQueries({ queryKey: projectKeys.all });
      toast.success(
        data.projectsReassigned > 0
          ? `Status deleted; ${data.projectsReassigned} project${data.projectsReassigned === 1 ? "" : "s"} reassigned`
          : "Status deleted"
      );
    },
    onError: (error: unknown) => {
      const status = (error as { response?: { status?: number } }).response?.status;
      if (status !== 409) toast.error(getErrorMessage(error));
    },
  });
}

/** Drag reorder — optimistic. */
export function useReorderProjectStatuses() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const { data } = await api.put<Paginated<"statuses", ProjectStatus>>(
        "/project-meta/statuses/order",
        { ids }
      );
      return data.statuses;
    },
    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: projectMetaKeys.statuses });
      const previous = queryClient.getQueryData<ProjectStatus[]>(projectMetaKeys.statuses);
      if (previous) {
        const byId = new Map(previous.map((status) => [status._id, status]));
        queryClient.setQueryData<ProjectStatus[]>(
          projectMetaKeys.statuses,
          ids
            .map((id, index) => {
              const status = byId.get(id);
              return status ? { ...status, order: index } : null;
            })
            .filter((status): status is ProjectStatus => status !== null)
        );
      }
      return { previous };
    },
    onError: (error: unknown, _ids, context) => {
      if (context?.previous) queryClient.setQueryData(projectMetaKeys.statuses, context.previous);
      toast.error(getErrorMessage(error));
    },
    onSuccess: (statuses) => {
      // Keep projectCount from the cached list (the order endpoint may omit it).
      const previous = queryClient.getQueryData<ProjectStatus[]>(projectMetaKeys.statuses);
      const counts = new Map(previous?.map((status) => [status._id, status.projectCount]));
      queryClient.setQueryData<ProjectStatus[]>(
        projectMetaKeys.statuses,
        statuses.map((status) => ({
          ...status,
          projectCount: status.projectCount ?? counts.get(status._id),
        }))
      );
    },
  });
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export function useProjectCategories() {
  return useQuery({
    queryKey: projectMetaKeys.categories,
    queryFn: async () => {
      const { data } = await api.get<Paginated<"categories", ProjectCategory>>(
        "/project-meta/categories"
      );
      return data.categories;
    },
    staleTime: 60_000,
  });
}

function useCategoryMutation<V>(fn: (variables: V) => Promise<unknown>, message: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectMetaKeys.categories });
      void queryClient.invalidateQueries({ queryKey: projectKeys.all });
      toast.success(message);
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useCreateProjectCategory() {
  return useCategoryMutation(async (name: string) => {
    const { data } = await api.post<{ category: ProjectCategory }>("/project-meta/categories", {
      name,
    });
    return data.category;
  }, "Category created");
}

export function useUpdateProjectCategory() {
  return useCategoryMutation(async ({ id, name }: { id: string; name: string }) => {
    const { data } = await api.patch<{ category: ProjectCategory }>(
      `/project-meta/categories/${id}`,
      { name }
    );
    return data.category;
  }, "Category renamed");
}

export function useDeleteProjectCategory() {
  return useCategoryMutation(async (id: string) => {
    await api.delete(`/project-meta/categories/${id}`);
  }, "Category deleted");
}

// ---------------------------------------------------------------------------
// Settings (admin)
// ---------------------------------------------------------------------------

export function useProjectSettings(enabled = true) {
  return useQuery({
    queryKey: projectMetaKeys.settings,
    queryFn: async () => {
      const { data } = await api.get<{ settings: ProjectSettings }>("/project-meta/settings");
      return data.settings;
    },
    enabled,
  });
}

/** Every role: `{ logTimeFor }` — whether time is logged against projects or tasks. */
export function useTimeLogSettings(enabled = true) {
  return useQuery({
    queryKey: projectMetaKeys.timeSettings,
    queryFn: async () => {
      const { data } = await api.get<{ settings: Pick<ProjectSettings, "logTimeFor"> }>(
        "/project-meta/settings/time"
      );
      return data.settings;
    },
    staleTime: 5 * 60_000,
    enabled,
  });
}

export function useUpdateProjectSettings() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (input: ProjectSettingsInput) => {
      const { data } = await api.patch<{ settings: ProjectSettings }>(
        "/project-meta/settings",
        input
      );
      return data.settings;
    },
    onSuccess: (settings) => {
      queryClient.setQueryData(projectMetaKeys.settings, settings);
      void queryClient.invalidateQueries({ queryKey: projectMetaKeys.timeSettings });
      toast.success("Settings saved");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}
