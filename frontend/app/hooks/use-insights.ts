import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

import { api, API_BASE_URL } from "@/lib/api";
import type { BlockResult, BlockSpec, InsightBoard, InsightBoardSummary, InsightOptions, InsightSchedule, ToolTrace } from "@/lib/insights/types";

// ---------------------------------------------------------------------------
// Leadership Insights data hooks: the chat (POST /insights/ask streams
// Server-Sent Events — fetch, since axios can't stream), block data (POST
// /insights/tool, no AI call), filter options, the start-screen headline and
// the saved boards.
// ---------------------------------------------------------------------------

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  /** User: the question. Assistant: the OpenUI Lang answer (grows while streaming). */
  text: string;
  status: "streaming" | "done" | "error";
  tools: ToolTrace[];
  check?: { unmatchedNumbers: string[]; unmatchedTexts: string[] };
  /** Filters the tools used that the question didn't name (kept from earlier). */
  inherited?: string[];
  usage?: { prompt: number; completion: number; total: number };
  ms?: number;
  model?: string;
  error?: string;
  /** What the answer did to the board. */
  boardResults?: string[];
}

/** The FollowUps([...]) questions of an answer. */
export function followUpsOf(text: string): string[] {
  const match = /FollowUps\(\s*(\[[\s\S]*?\])\s*\)/.exec(text);
  if (!match) return [];
  try {
    const list = JSON.parse(match[1]!) as unknown;
    return Array.isArray(list) ? list.filter((q): q is string => typeof q === "string").slice(0, 4) : [];
  } catch {
    return [];
  }
}

const KEYS = {
  block: (spec: Pick<BlockSpec, "tool" | "params" | "list" | "only">) => ["insights", "block", spec.tool, spec.params, spec.list ?? null, spec.only ?? null] as const,
  options: ["insights", "options"] as const,
  headline: ["insights", "headline"] as const,
  boards: ["insights", "boards"] as const,
  board: (id: string) => ["insights", "board", id] as const,
};

/** Live data of one block (re-runs the tool server-side; refetched on refresh). */
export function useBlockData(spec: Pick<BlockSpec, "tool" | "params" | "list" | "only">) {
  return useQuery({
    queryKey: KEYS.block(spec),
    queryFn: async () => (await api.post<BlockResult>("/insights/tool", { tool: spec.tool, params: spec.params, list: spec.list, only: spec.only })).data,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

/** Re-fetches every block on screen. */
export function useRefreshBlocks() {
  const qc = useQueryClient();
  return useCallback(() => qc.invalidateQueries({ queryKey: ["insights", "block"] }), [qc]);
}

export function useInsightOptions() {
  return useQuery({ queryKey: KEYS.options, queryFn: async () => (await api.get<InsightOptions>("/insights/options")).data, staleTime: 10 * 60_000 });
}

export function useInsightHeadline() {
  return useQuery({
    queryKey: KEYS.headline,
    queryFn: async () => (await api.get<{ greeting: string; parts: string[] }>("/insights/headline")).data,
    staleTime: 5 * 60_000,
  });
}

export function useInsightBoards() {
  return useQuery({ queryKey: KEYS.boards, queryFn: async () => (await api.get<{ boards: InsightBoardSummary[] }>("/insights/boards")).data.boards });
}

export function useInsightBoard(id: string | null) {
  return useQuery({
    queryKey: KEYS.board(id ?? ""),
    queryFn: async () => (await api.get<{ board: InsightBoard }>(`/insights/boards/${id}`)).data.board,
    enabled: Boolean(id),
    staleTime: Infinity,
  });
}

export interface BoardPatch {
  title?: string;
  blocks?: BlockSpec[];
  messages?: Array<{ role: "user" | "assistant"; text: string }>;
  refresh?: InsightSchedule;
  report?: { schedule?: InsightSchedule; recipients?: string[]; sendUnchanged?: boolean };
}

export function useCreateBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: BoardPatch) => (await api.post<{ board: InsightBoard }>("/insights/boards", body)).data.board,
    onSuccess: (board) => {
      qc.setQueryData(KEYS.board(board._id), board);
      void qc.invalidateQueries({ queryKey: KEYS.boards });
    },
  });
}

export function useUpdateBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: BoardPatch & { id: string }) => (await api.put<{ board: InsightBoard }>(`/insights/boards/${id}`, body)).data.board,
    onSuccess: (board) => {
      qc.setQueryData(KEYS.board(board._id), board);
      void qc.invalidateQueries({ queryKey: KEYS.boards });
    },
  });
}

export function useDeleteBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.delete(`/insights/boards/${id}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.boards }),
  });
}

export function useSendReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, force }: { id: string; force?: boolean }) =>
      (await api.post<{ outcome: { sent: boolean; reason: string; recipients: number }; board: InsightBoard }>(`/insights/boards/${id}/report`, { force }, { timeout: 60_000 })).data,
    onSuccess: (data) => {
      qc.setQueryData(KEYS.board(data.board._id), data.board);
      void qc.invalidateQueries({ queryKey: KEYS.boards });
    },
  });
}

/** The conversation: streams answers and applies the board operations the model makes. */
export function useInsightChat(params: { blocks: BlockSpec[]; boardId: string | null; onBoard: (blocks: BlockSpec[]) => void; onDone: (messages: ChatMessage[]) => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const latest = useRef(params);
  latest.current = params;
  const busy = messages.some((m) => m.status === "streaming");

  const update = (id: number, patch: (m: ChatMessage) => Partial<ChatMessage>) =>
    setMessages((all) => all.map((m) => (m.id === id ? { ...m, ...patch(m) } : m)));

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || busy) return;
      const history: Array<{ question: string; answer: string }> = [];
      for (let i = 0; i < messages.length - 1; i++) {
        const [a, b] = [messages[i]!, messages[i + 1]!];
        if (a.role === "user" && b.role === "assistant" && b.status === "done") history.push({ question: a.text, answer: b.text });
      }
      const userMsg: ChatMessage = { id: nextId.current++, role: "user", text: q, status: "done", tools: [] };
      const id = nextId.current++;
      setMessages((all) => [...all, userMsg, { id, role: "assistant", text: "", status: "streaming", tools: [] }]);
      const controller = new AbortController();
      abortRef.current = controller;
      let final: ChatMessage | null = null;
      try {
        const res = await fetch(`${API_BASE_URL}/insights/ask`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: q, history: history.slice(-3), blocks: latest.current.blocks, boardId: latest.current.boardId }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Request failed with status ${res.status}.`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const event = /^event: (.+)$/m.exec(block)?.[1];
            const raw = /^data: (.*)$/m.exec(block)?.[1];
            if (!event || raw === undefined) continue;
            const data = JSON.parse(raw) as Record<string, unknown>;
            if (event === "tool") update(id, (m) => ({ tools: [...m.tools, data as unknown as ToolTrace] }));
            else if (event === "delta") update(id, (m) => ({ text: m.text + String(data.text ?? "") }));
            else if (event === "reset") update(id, () => ({ text: "" }));
            else if (event === "board") {
              latest.current.onBoard(data.blocks as BlockSpec[]);
              update(id, (m) => ({ boardResults: [...(m.boardResults ?? []), ...((data.results as string[]) ?? [])] }));
            } else if (event === "done") {
              const patch: Partial<ChatMessage> = {
                status: "done",
                text: String(data.answer ?? ""),
                tools: (data.tools as ToolTrace[]) ?? [],
                check: data.check as ChatMessage["check"],
                inherited: Array.isArray(data.inherited) ? (data.inherited as string[]) : [],
                usage: data.usage as ChatMessage["usage"],
                ms: Number(data.ms) || undefined,
                model: typeof data.model === "string" ? data.model : undefined,
              };
              update(id, () => patch);
              final = { id, role: "assistant", tools: [], ...patch } as ChatMessage;
            } else if (event === "error") update(id, () => ({ status: "error", error: String(data.error ?? "Something went wrong") }));
          }
        }
        update(id, (m) => (m.status === "streaming" ? { status: "error", error: "The answer was cut off. Try again." } : {}));
      } catch (err) {
        const aborted = err instanceof DOMException && err.name === "AbortError";
        update(id, () => ({
          status: "error",
          error: aborted ? "Stopped." : err instanceof Error && err.message !== "Failed to fetch" ? err.message : "Cannot reach the API server.",
        }));
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
      if (final) latest.current.onDone([...messages, userMsg, final]);
    },
    [busy, messages],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);
  /** Replaces the conversation (opening a saved board / starting a new one). */
  const load = useCallback((saved: Array<{ role: "user" | "assistant"; text: string }>) => {
    abortRef.current?.abort();
    setMessages(saved.map((m) => ({ id: nextId.current++, role: m.role, text: m.text, status: "done", tools: [] })));
  }, []);

  return { messages, ask, busy, stop, load };
}
