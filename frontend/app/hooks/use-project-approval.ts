import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { projectKeys } from "@/hooks/use-projects";
import { useToast } from "@/hooks/use-toast";
import { api, getErrorMessage } from "@/lib/api";
import type { ProjectApprovalLinkResponse, ProjectApprovalView } from "@/types";

/** Approvers: approve / reject a pending project from the app. */
export function useDecideProjectApproval() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async ({ id, decision, reason }: { id: string; decision: "approve" | "reject"; reason?: string }) =>
      (await api.post<{ approval: ProjectApprovalView }>(`/projects/${id}/approval`, { decision, reason })).data,
    onSuccess: (_data, { decision }) => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.all });
      toast.success(decision === "approve" ? "Project approved" : "Project rejected");
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });
}

/** Manager / creator / admin: send a rejected (or pending) project for approval again. */
export function useRequestProjectApproval() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.post<{ approval: ProjectApprovalView }>(`/projects/${id}/approval/request`)).data,
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.all });
      toast.success(data.approval.status === "approved" ? "Project approved" : "Sent for approval");
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });
}

/** Public approval page (emailed link): the project behind a token. */
export function useApprovalLink(token: string) {
  return useQuery({
    queryKey: ["project-approval", token],
    queryFn: async () => (await api.get<ProjectApprovalLinkResponse>(`/project-approval/${token}`)).data,
    retry: false,
  });
}

export function useDecideByLink(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ decision, reason }: { decision: "approve" | "reject"; reason?: string }) =>
      (await api.post<{ project: ProjectApprovalLinkResponse["project"] }>(`/project-approval/${token}`, { decision, reason })).data,
    onSuccess: (data) => {
      queryClient.setQueryData<ProjectApprovalLinkResponse | undefined>(["project-approval", token], (old) =>
        old ? { ...old, project: data.project } : old,
      );
    },
  });
}
