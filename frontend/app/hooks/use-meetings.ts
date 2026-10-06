import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import { toast as toastManager } from "@/components/ui/toast";
import { invalidateTaskCollections } from "@/hooks/use-tasks";
import { useToast } from "@/hooks/use-toast";
import { api, getErrorMessage } from "@/lib/api";
import { downloadFromApi } from "@/lib/download";
import type {
  ActionItemInput,
  ActionItemUpdateInput,
  MeetingActionItem,
  MeetingCreateInput,
  MeetingDetailResponse,
  MeetingListResponse,
  MeetingPreviewResponse,
  MeetingTaskDraft,
  MeetingTasksResponse,
  MeetingUpdateInput,
  TranscriptInput,
  UserRef,
} from "@/types";

// ---------------------------------------------------------------------------
// Keys & params
// ---------------------------------------------------------------------------

export interface MeetingListParams {
  /** Project id, or "none" for meetings without a project. */
  project?: string;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export const meetingKeys = {
  all: ["meetings"] as const,
  config: ["meetings", "config"] as const,
  lists: ["meetings", "list"] as const,
  list: (params: MeetingListParams) => ["meetings", "list", params] as const,
  detail: (id: string) => ["meetings", "detail", id] as const,
  assignees: (id: string) => ["meetings", "assignees", id] as const,
};

function listParams(params: MeetingListParams): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const key of ["project", "from", "to", "search"] as const) {
    const value = params[key];
    if (value) out[key] = value;
  }
  if (params.limit !== undefined) {
    out.limit = params.limit;
    out.offset = params.offset ?? 0;
  }
  return out;
}

const noRetryOnAccess = (count: number, error: unknown) => {
  const status = (error as { response?: { status?: number } }).response?.status;
  return status !== 403 && status !== 404 && count < 2;
};

/** Caches a fresh detail and refreshes the lists. */
function applyDetail(queryClient: QueryClient, data: MeetingDetailResponse) {
  queryClient.setQueryData(meetingKeys.detail(data.meeting._id), {
    meeting: data.meeting,
    permissions: data.permissions,
    aiEnabled: data.aiEnabled,
  } satisfies MeetingDetailResponse);
  void queryClient.invalidateQueries({ queryKey: meetingKeys.lists });
}

/** Replaces one action item inside the cached detail. */
function applyItem(queryClient: QueryClient, meetingId: string, item: MeetingActionItem) {
  queryClient.setQueryData<MeetingDetailResponse>(meetingKeys.detail(meetingId), (current) =>
    current
      ? {
          ...current,
          meeting: {
            ...current.meeting,
            actionItems: current.meeting.actionItems.some((entry) => entry._id === item._id)
              ? current.meeting.actionItems.map((entry) => (entry._id === item._id ? item : entry))
              : [...current.meeting.actionItems, item],
          },
        }
      : current
  );
  void queryClient.invalidateQueries({ queryKey: meetingKeys.lists });
}

/** Builds the multipart / JSON body for preview + create. */
function transcriptBody(transcript: TranscriptInput, fields: Record<string, string | undefined>) {
  if (transcript.file) {
    const form = new FormData();
    form.append("file", transcript.file);
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== "") form.append(key, value);
    }
    return {
      body: form as FormData | Record<string, string>,
      config: { headers: { "Content-Type": "multipart/form-data" }, timeout: 120_000 },
    };
  }
  const body: Record<string, string> = { text: transcript.text ?? "" };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== "") body[key] = value;
  }
  return { body, config: { timeout: 60_000 } };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** `{ aiEnabled }` — the "Extract with AI" button is hidden when off. */
export function useMeetingConfig(enabled = true) {
  return useQuery({
    queryKey: meetingKeys.config,
    queryFn: async () => {
      const { data } = await api.get<{ aiEnabled: boolean }>("/meetings/config");
      return data;
    },
    staleTime: 5 * 60_000,
    enabled,
  });
}

export function useMeetings(params: MeetingListParams, enabled = true) {
  return useQuery({
    queryKey: meetingKeys.list(params),
    queryFn: async () => {
      const { data } = await api.get<MeetingListResponse>("/meetings", {
        params: listParams(params),
      });
      return data;
    },
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useMeeting(id: string | null | undefined) {
  return useQuery({
    queryKey: meetingKeys.detail(id ?? ""),
    queryFn: async () => {
      const { data } = await api.get<MeetingDetailResponse>(`/meetings/${id}`);
      return data;
    },
    enabled: Boolean(id),
    retry: noRetryOnAccess,
  });
}

/** People for the speaker-mapping and item assignee pickers. */
export function useMeetingAssignees(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: meetingKeys.assignees(id ?? ""),
    queryFn: async () => {
      const { data } = await api.get<{ users: UserRef[] }>(`/meetings/${id}/assignees`);
      return data.users;
    },
    enabled: enabled && Boolean(id),
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Meeting mutations
// ---------------------------------------------------------------------------

/** Parses without saving (upload dialog step 1). Errors are shown inline by the caller. */
export function usePreviewMeeting() {
  return useMutation({
    mutationFn: async ({ transcript, project }: { transcript: TranscriptInput; project?: string }) => {
      const { body, config } = transcriptBody(transcript, { project });
      const { data } = await api.post<MeetingPreviewResponse>("/meetings/preview", body, config);
      return data;
    },
  });
}

export function useCreateMeeting() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (input: MeetingCreateInput) => {
      const { body, config } = transcriptBody(input.transcript, {
        title: input.title,
        meetingDate: input.meetingDate,
        project: input.project,
        notes: input.notes,
        speakers: input.speakers ? JSON.stringify(input.speakers) : undefined,
      });
      // JSON bodies take the mapping as an array, multipart as a JSON string.
      if (!(body instanceof FormData) && input.speakers) {
        (body as Record<string, unknown>).speakers = input.speakers;
      }
      const { data } = await api.post<MeetingDetailResponse & { warnings: string[] }>(
        "/meetings",
        body,
        config
      );
      return data;
    },
    onSuccess: (data) => {
      applyDetail(queryClient, data);
      const hints = data.meeting.actionItems.filter((item) => item.status === "suggested").length;
      toast.success(
        hints > 0
          ? `Meeting added — ${hints} suggested action item${hints === 1 ? "" : "s"}`
          : "Meeting added"
      );
    },
  });
}

export function useUpdateMeeting(id: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (input: MeetingUpdateInput) => {
      const { data } = await api.patch<MeetingDetailResponse>(`/meetings/${id}`, input);
      return data;
    },
    onSuccess: (data) => {
      applyDetail(queryClient, data);
      void queryClient.invalidateQueries({ queryKey: meetingKeys.assignees(id) });
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useDeleteMeeting() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.delete<{ success: true; tasksUnlinked: number }>(`/meetings/${id}`);
      return { id, ...data };
    },
    onSuccess: ({ id, tasksUnlinked }) => {
      queryClient.removeQueries({ queryKey: meetingKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: meetingKeys.lists });
      toast.success(
        tasksUnlinked > 0
          ? `Meeting deleted — ${tasksUnlinked} task${tasksUnlinked === 1 ? " was" : "s were"} kept`
          : "Meeting deleted"
      );
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useRegenerateHints(id: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.post<MeetingDetailResponse & { added: number; removed: number }>(
        `/meetings/${id}/hints`
      );
      return data;
    },
    onSuccess: (data) => {
      applyDetail(queryClient, data);
      toast.success(
        data.added === 0
          ? "No new smart hints found"
          : `${data.added} smart hint${data.added === 1 ? "" : "s"} suggested`
      );
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

/** Synchronous Gemini call (up to 60 s) — never creates tasks. */
export function useExtractWithAi(id: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.post<MeetingDetailResponse & { added: number; proposed: number }>(
        `/meetings/${id}/extract-ai`,
        undefined,
        { timeout: 90_000 }
      );
      return data;
    },
    onSuccess: (data) => {
      applyDetail(queryClient, data);
      if (data.added === 0) {
        toast.info(
          data.proposed === 0
            ? "AI found no action items"
            : "AI found nothing new — its items overlap existing suggestions"
        );
      } else {
        toast.success(`AI suggested ${data.added} action item${data.added === 1 ? "" : "s"}`);
      }
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export async function downloadMeetingTranscript(id: string, fallbackName: string) {
  await downloadFromApi(`/meetings/${id}/file`, {}, fallbackName);
}

export function useDownloadTranscript() {
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id, filename }: { id: string; filename: string }) =>
      downloadMeetingTranscript(id, filename),
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

// ---------------------------------------------------------------------------
// Action items
// ---------------------------------------------------------------------------

export function useAddActionItem(meetingId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (input: ActionItemInput) => {
      const { data } = await api.post<{ item: MeetingActionItem }>(
        `/meetings/${meetingId}/items`,
        input
      );
      return data.item;
    },
    onSuccess: (item) => {
      applyItem(queryClient, meetingId, item);
      toast.success("Action item added");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

/** Edits an item; the cache updates optimistically and rolls back on error. */
export function useUpdateActionItem(meetingId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async ({ itemId, input }: { itemId: string; input: ActionItemUpdateInput }) => {
      const { data } = await api.patch<{ item: MeetingActionItem }>(
        `/meetings/${meetingId}/items/${itemId}`,
        input
      );
      return data.item;
    },
    onSuccess: (item) => applyItem(queryClient, meetingId, item),
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
      void queryClient.invalidateQueries({ queryKey: meetingKeys.detail(meetingId) });
    },
  });
}

export function useDismissActionItem(meetingId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (itemId: string) => {
      const { data } = await api.delete<{ item: MeetingActionItem }>(
        `/meetings/${meetingId}/items/${itemId}`
      );
      return data.item;
    },
    onSuccess: (item) => applyItem(queryClient, meetingId, item),
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

/** Shows "4 created, 1 skipped (reason)". */
export function toastMeetingTasksResult(result: MeetingTasksResponse) {
  const created = result.created.length;
  const skipped = result.skipped.length;
  const reasons = [...new Set(result.skipped.map((item) => item.reason))];
  toastManager.add({
    type: created === 0 ? "error" : skipped > 0 ? "warning" : "success",
    title:
      skipped > 0
        ? `${created} created, ${skipped} skipped (${result.skipped[0].reason})`
        : `${created} task${created === 1 ? "" : "s"} created`,
    description:
      reasons.length > 1 ? `Other reasons: ${reasons.slice(1, 3).join(" · ")}` : undefined,
  });
}

export function useCreateMeetingTasks(meetingId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (items: MeetingTaskDraft[]) => {
      const { data } = await api.post<MeetingTasksResponse>(
        `/meetings/${meetingId}/tasks`,
        { items },
        { timeout: 60_000 }
      );
      return data;
    },
    onSuccess: (result) => {
      toastMeetingTasksResult(result);
      void queryClient.invalidateQueries({ queryKey: meetingKeys.detail(meetingId) });
      void queryClient.invalidateQueries({ queryKey: meetingKeys.lists });
      invalidateTaskCollections(queryClient);
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}
