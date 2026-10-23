import { useMutation } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { TaskUpdateInput } from "@/types";

// ---------------------------------------------------------------------------
// Voice task assistant (POST /api/voice/transcribe + /api/voice/understand).
// The server reads each message into a draft and asks for what's missing;
// saving goes through the existing task / time endpoints after the confirm tap.
// ---------------------------------------------------------------------------

export type VoiceField =
  | "action"
  | "project"
  | "iteration"
  | "reworkOf"
  | "reworkSource"
  | "unit"
  | "quantity"
  | "shortName"
  | "brief"
  | "assignees"
  | "dates"
  | "existing"
  | "briefReview"
  | "changes"
  | "task"
  | "final"
  | "note"
  | "time";

export interface VoiceTaskRef {
  id: string;
  code: string;
  title: string;
  status: string;
  projectId: string | null;
  loggedMinutes: number;
  hasFinal: boolean;
  direct: boolean;
  reviewer: string | null;
}

export interface VoiceDraft {
  action: "create" | "close" | "log_time" | "update" | null;
  asking: VoiceField | null;
  project: { id: string; name: string; code: string } | null;
  iteration: "new" | "rework" | null;
  unit: string | null;
  quantity: number | null;
  shortName: string | null;
  brief: string | null;
  assignees: Array<{ id: string; name: string }>;
  dueDate: string | null;
  startDate: string | null;
  reworkOf: VoiceTaskRef | null;
  reworkSource: "internal" | "external" | null;
  task: VoiceTaskRef | null;
  minutes: number | null;
  start: string | null;
  end: string | null;
  note: string | null;
  finalUrl: string | null;
  finalFile: { name: string; size: number } | null;
  existingFor: string | null;
  focusTaskId: string | null;
  briefTidy: { objective: string; bullets: string[] } | null;
  briefChoice: "tidy" | "plain" | null;
  /** The chosen brief as simple HTML — what is saved as the description. */
  briefHtml: string | null;
  priority: "low" | "medium" | "high" | "urgent" | null;
  status: "todo" | "in_progress" | null;
  /** Update: the task as it is now (server-side), and which task the fields came from. */
  baseline: Record<string, unknown> | null;
  baseFor: string | null;
  /** Update: the PATCH /api/tasks/:id body and the status move to send after "Update task". */
  updatePatch: TaskUpdateInput | null;
  updateStatus: "todo" | "in_progress" | null;
}

export interface VoiceExistingTask {
  id: string;
  code: string;
  title: string;
  status: string;
}

export interface VoiceCard {
  title: string;
  rows: Array<[string, string]>;
  confirm: string;
}

export interface VoiceReply {
  reply: string;
  chips: string[];
  draft: VoiceDraft;
  action: "create" | "rework" | "close" | "log_time" | "update" | "none";
  missing: VoiceField[];
  ready: boolean;
  ask: VoiceField | null;
  card: VoiceCard | null;
  /** ask = "existing": the project's tasks to pick from. */
  existing?: VoiceExistingTask[];
  ai: boolean;
}

export interface VoiceUnderstandInput {
  messages: Array<{ role: "user" | "assistant"; text: string }>;
  context?: { taskId?: string; recentTaskIds?: string[] };
  draft?: VoiceDraft | null;
}

export function useVoiceUnderstand() {
  return useMutation({
    mutationFn: async (input: VoiceUnderstandInput) => {
      const { data } = await api.post<VoiceReply>("/voice/understand", input, { timeout: 30_000 });
      return data;
    },
  });
}

/** Recording → text. 503 `voice_unavailable` when the server has no speech-to-text key. */
export function useVoiceTranscribe() {
  return useMutation({
    mutationFn: async (audio: Blob) => {
      const form = new FormData();
      const ext = audio.type.includes("mp4") ? "m4a" : audio.type.includes("ogg") ? "ogg" : "webm";
      form.append("audio", audio, `voice-note.${ext}`);
      const { data } = await api.post<{ text: string }>("/voice/transcribe", form, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 60_000,
      });
      return data.text;
    },
  });
}
