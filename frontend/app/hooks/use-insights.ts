import { useCallback, useRef, useState } from "react";

import { API_BASE_URL } from "@/lib/api";

// ---------------------------------------------------------------------------
// Leadership Insights: POST /insights/ask streams Server-Sent Events (tool,
// delta, reset, done, error). Axios can't stream, so this uses fetch with the
// session cookie. Q&A history lives in this page session only.
// ---------------------------------------------------------------------------

export interface InsightToolTrace {
  name: string;
  params: Record<string, unknown>;
  ok: boolean;
  ms: number;
  rows: number;
  error?: string;
}

export interface InsightTurn {
  id: number;
  question: string;
  /** OpenUI Lang answer (grows while streaming). */
  text: string;
  status: "streaming" | "done" | "error";
  tools: InsightToolTrace[];
  /** Figures / table cells the server couldn't match to the data. */
  check?: { unmatchedNumbers: string[]; unmatchedTexts: string[] };
  usage?: { prompt: number; completion: number; total: number };
  ms?: number;
  model?: string;
  error?: string;
}

/** The FollowUps([...]) questions of an answer (rendered as chips by the page). */
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

export function useInsights() {
  const [turns, setTurns] = useState<InsightTurn[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const busy = turns.some((t) => t.status === "streaming");

  const update = (id: number, patch: (t: InsightTurn) => Partial<InsightTurn>) =>
    setTurns((all) => all.map((t) => (t.id === id ? { ...t, ...patch(t) } : t)));

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || busy) return;
      const id = nextId.current++;
      const history = turns
        .filter((t) => t.status === "done")
        .slice(-3)
        .map((t) => ({ question: t.question, answer: t.text }));
      setTurns((all) => [...all, { id, question: q, text: "", status: "streaming", tools: [] }]);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(`${API_BASE_URL}/insights/ask`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: q, history }),
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
            if (event === "tool") update(id, (t) => ({ tools: [...t.tools, data as unknown as InsightToolTrace] }));
            else if (event === "delta") update(id, (t) => ({ text: t.text + String(data.text ?? "") }));
            else if (event === "reset") update(id, () => ({ text: "" }));
            else if (event === "done")
              update(id, () => ({
                status: "done",
                text: String(data.answer ?? ""),
                tools: (data.tools as InsightToolTrace[]) ?? [],
                check: data.check as InsightTurn["check"],
                usage: data.usage as InsightTurn["usage"],
                ms: Number(data.ms) || undefined,
                model: typeof data.model === "string" ? data.model : undefined,
              }));
            else if (event === "error") update(id, () => ({ status: "error", error: String(data.error ?? "Something went wrong") }));
          }
        }
        update(id, (t) => (t.status === "streaming" ? { status: "error", error: "The answer was cut off. Try again." } : {}));
      } catch (err) {
        const aborted = err instanceof DOMException && err.name === "AbortError";
        update(id, () => ({
          status: "error",
          error: aborted ? "Stopped." : err instanceof Error && err.message !== "Failed to fetch" ? err.message : "Cannot reach the API server.",
        }));
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [busy, turns],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const clear = useCallback(() => setTurns([]), []);

  return { turns, ask, busy, stop, clear };
}
