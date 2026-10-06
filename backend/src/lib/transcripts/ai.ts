import { MEETING_LIMITS } from "../../models/Meeting.js";
import { TASK_PRIORITIES } from "../../models/Task.js";
import type { TaskPriority } from "../../models/Task.js";
import { formatTimestamp } from "./common.js";

// ---------------------------------------------------------------------------
// Optional AI extraction (MEETING_AI_EXTRACTION=true + GEMINI_API_KEY).
// Same Gemini REST call as inngest/functions/generateInsight.ts, but run
// synchronously (no Inngest) with a 60 s budget. The transcript is chunked to
// ~12k characters; the model returns strict JSON; malformed items are dropped.
// Never creates tasks.
// ---------------------------------------------------------------------------

const GEMINI_MODEL = "gemini-3.6-flash";
const CHUNK_CHARS = 12_000;
export const AI_TIMEOUT_MS = 60_000;

export function aiEnabled(): boolean {
  return process.env.MEETING_AI_EXTRACTION === "true" && Boolean(process.env.GEMINI_API_KEY?.trim());
}

/** Failure surfaced to the client as 502 with `message`. */
export class AiExtractionError extends Error {}

export interface AiSegment {
  idx: number;
  start?: number | null;
  speaker?: string | null;
  text: string;
}

export interface AiItem {
  segmentIdxs: number[];
  title: string;
  /** Owner name as the model wrote it (resolved against speakers by the caller). */
  owner: string | null;
  dueDate: Date | null;
  priority: TaskPriority;
}

/** Splits the transcript into prompt chunks of ~12k characters (whole segments). */
export function chunkSegments(segments: AiSegment[]): Array<{ text: string; idxs: Set<number> }> {
  const chunks: Array<{ text: string; idxs: Set<number> }> = [];
  let lines: string[] = [];
  let idxs = new Set<number>();
  let size = 0;
  for (const seg of segments) {
    const time = formatTimestamp(seg.start);
    let line = `[${seg.idx}]${time ? ` (${time})` : ""} ${seg.speaker ?? "Unknown"}: ${seg.text.replace(/\s+/g, " ")}`;
    if (line.length > CHUNK_CHARS) line = line.slice(0, CHUNK_CHARS);
    if (size + line.length + 1 > CHUNK_CHARS && lines.length > 0) {
      chunks.push({ text: lines.join("\n"), idxs });
      lines = [];
      idxs = new Set();
      size = 0;
    }
    lines.push(line);
    idxs.add(seg.idx);
    size += line.length + 1;
  }
  if (lines.length > 0) chunks.push({ text: lines.join("\n"), idxs });
  return chunks;
}

function buildPrompt(meeting: { title: string; meetingDateKey: string; weekday: string }, chunk: string, part: number, parts: number): string {
  return `You extract action items from a meeting transcript.

Meeting: ${meeting.title}
Meeting date: ${meeting.meetingDateKey} (${meeting.weekday})
Transcript part ${part} of ${parts}. Each line is "[segmentIndex] (timestamp) Speaker: text".

Return ONLY a JSON array (no prose, no markdown). Each element:
{"segmentIdxs": [<segment indexes the item comes from>], "title": "<imperative task title, max 120 chars>", "owner": "<speaker or person name exactly as written in the transcript, or null>", "dueDate": "<YYYY-MM-DD resolved relative to the meeting date, or null>", "priority": "low" | "medium" | "high" | "urgent"}

Rules:
- Only concrete commitments or requests someone must act on. Skip small talk, status updates and decisions with no follow-up work.
- segmentIdxs must use the bracketed numbers from this part only.
- Use null when the owner or due date is not clear. Default priority is "medium".
- Return [] when there are no action items.

Transcript:
${chunk}`;
}

/** Pulls a readable message out of a Gemini error body (never echoes the key). */
function geminiErrorMessage(status: number, body: string): string {
  let detail = "";
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    detail = parsed.error?.message ?? "";
  } catch {
    detail = "";
  }
  detail = detail.replace(/\s+/g, " ").trim().slice(0, 300).replace(/[.\s]+$/, "");
  if (status === 400 || status === 401 || status === 403) {
    return `Gemini rejected the request (${status})${detail ? `: ${detail}` : ""}. Check GEMINI_API_KEY.`;
  }
  if (status === 429) return "Gemini rate limit reached. Try again in a minute.";
  return `Gemini returned an error (${status})${detail ? `: ${detail}` : ""}.`;
}

async function callGemini(prompt: string, signal: AbortSignal): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new AiExtractionError("GEMINI_API_KEY is not configured");
  let response: Response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      // Header, not ?key=: keeps the key out of URLs and error messages.
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 8192, responseMimeType: "application/json" },
      }),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw new AiExtractionError(`AI extraction timed out after ${AI_TIMEOUT_MS / 1000} seconds.`);
    const message = err instanceof Error ? err.message : String(err);
    throw new AiExtractionError(`Couldn't reach Gemini: ${message.split(apiKey).join("***").slice(0, 200)}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new AiExtractionError(geminiErrorMessage(response.status, body.split(apiKey).join("***")));
  }
  const data = (await response.json().catch(() => null)) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  } | null;
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text.trim()) throw new AiExtractionError("Gemini returned an empty response.");
  return text;
}

/** Strict-ish JSON array parsing: tolerates a code fence, drops malformed items. */
export function parseAiItems(text: string, validIdxs: Set<number>, meetingDate: Date): AiItem[] {
  const match = /\[[\s\S]*\]/.exec(text.trim());
  if (!match) throw new AiExtractionError("The AI response wasn't a JSON array.");
  let raw: unknown;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    throw new AiExtractionError("The AI response wasn't valid JSON.");
  }
  if (!Array.isArray(raw)) throw new AiExtractionError("The AI response wasn't a JSON array.");

  const items: AiItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (!Array.isArray(e.segmentIdxs)) continue;
    const idxs = [...new Set(e.segmentIdxs.filter((n): n is number => Number.isInteger(n) && validIdxs.has(n as number)))]
      .sort((a, b) => a - b)
      .slice(0, MEETING_LIMITS.maxSegmentsPerItem);
    if (idxs.length === 0) continue;
    if (typeof e.title !== "string" || !e.title.trim()) continue;
    const title = e.title.replace(/\s+/g, " ").trim().slice(0, MEETING_LIMITS.itemTitleMax);
    const owner = typeof e.owner === "string" && e.owner.trim() ? e.owner.trim().slice(0, MEETING_LIMITS.speakerNameMax) : null;
    let dueDate: Date | null = null;
    if (typeof e.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.dueDate)) {
      const d = new Date(`${e.dueDate}T00:00:00.000Z`);
      if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === e.dueDate && d.getTime() >= meetingDate.getTime()) {
        dueDate = d;
      }
    }
    const priority = TASK_PRIORITIES.includes(e.priority as TaskPriority) ? (e.priority as TaskPriority) : "medium";
    items.push({ segmentIdxs: idxs, title, owner, dueDate, priority });
  }
  return items;
}

/** Runs extraction over every chunk within the 60 s budget. Throws AiExtractionError on any failure. */
export async function extractActionItems(meeting: { title: string; meetingDate: Date; segments: AiSegment[] }): Promise<AiItem[]> {
  const chunks = chunkSegments(meeting.segments);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  const meetingDateKey = meeting.meetingDate.toISOString().slice(0, 10);
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(meeting.meetingDate);
  try {
    const all: AiItem[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const text = await callGemini(buildPrompt({ title: meeting.title, meetingDateKey, weekday }, chunk.text, i + 1, chunks.length), controller.signal);
      all.push(...parseAiItems(text, chunk.idxs, meeting.meetingDate));
    }
    return all;
  } finally {
    clearTimeout(timer);
  }
}
