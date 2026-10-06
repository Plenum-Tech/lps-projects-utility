import type { ActionItemOrigin, MeetingActionItem, TranscriptSegment } from "@/types";

/** Accepted transcript uploads (Teams exports + plain text). */
export const TRANSCRIPT_ACCEPT = ".vtt,.docx,.txt,text/vtt,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const TRANSCRIPT_EXTENSIONS = ["vtt", "docx", "txt"] as const;
export const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024;
export const MAX_TRANSCRIPT_CHARS = 300_000;
export const MAX_NOTES_CHARS = 20_000;
export const MAX_TASKS_PER_REQUEST = 50;

/** 751 → "12:31", 3725 → "1:02:05", null → "". */
export function formatTimestamp(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "";
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${String(m).padStart(2, "0")}:${ss}`;
}

/** "Weekly sync.vtt" → "Weekly sync". */
export function titleFromFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim().slice(0, 200);
}

export function fileExtension(filename: string): string {
  const match = /\.([^.]+)$/.exec(filename);
  return match ? match[1].toLowerCase() : "";
}

/** 1536 → "1.5 KB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ */
/* Speaker colours — theme tokens only (static class names)            */
/* ------------------------------------------------------------------ */

const SPEAKER_TONES = [
  { text: "text-chart-1", dot: "bg-chart-1" },
  { text: "text-chart-2", dot: "bg-chart-2" },
  { text: "text-chart-3", dot: "bg-chart-3" },
  { text: "text-chart-4", dot: "bg-chart-4" },
  { text: "text-chart-5", dot: "bg-chart-5" },
  { text: "text-primary", dot: "bg-primary" },
] as const;

export type SpeakerTone = (typeof SPEAKER_TONES)[number];

/**
 * Stable colour per speaker: speakers in order of first appearance cycle
 * through the chart palette, so neighbours in a meeting never share a colour
 * until there are more speakers than tones.
 */
export function speakerTones(names: (string | null)[]): Map<string, SpeakerTone> {
  const map = new Map<string, SpeakerTone>();
  for (const name of names) {
    if (!name || map.has(name)) continue;
    map.set(name, SPEAKER_TONES[map.size % SPEAKER_TONES.length]);
  }
  return map;
}

export const NEUTRAL_TONE = { text: "text-muted-foreground", dot: "bg-muted-foreground" };

/* ------------------------------------------------------------------ */
/* Action items                                                        */
/* ------------------------------------------------------------------ */

export const ORIGIN_META: Record<ActionItemOrigin, { label: string; className: string }> = {
  hint: { label: "Hint", className: "bg-chart-4/15 text-foreground border-chart-4/30" },
  ai: { label: "AI", className: "bg-chart-3/15 text-foreground border-chart-3/30" },
  manual: { label: "Manual", className: "bg-muted text-muted-foreground border-border" },
};

/** "WEB-12" / "#42" / "Task". */
export function taskRefLabel(task: { shortCode: string | null; number: number | null }): string {
  return task.shortCode ?? (task.number ? `#${task.number}` : "Task");
}

/** Segment idx → tasks created from it (for the transcript's link chips). */
export function tasksBySegment(items: MeetingActionItem[]) {
  const map = new Map<number, NonNullable<MeetingActionItem["task"]>[]>();
  for (const item of items) {
    if (item.status !== "task_created" || !item.task) continue;
    for (const idx of item.segmentIdxs) {
      const list = map.get(idx) ?? [];
      if (!list.some((task) => task._id === item.task!._id)) list.push(item.task);
      map.set(idx, list);
    }
  }
  return map;
}

/** Start time of an item's first segment. */
export function itemStart(item: Pick<MeetingActionItem, "segmentIdxs">, segments: TranscriptSegment[]) {
  const first = item.segmentIdxs[0];
  if (first === undefined) return null;
  const segment =
    segments[first]?.idx === first ? segments[first] : segments.find((item) => item.idx === first);
  return segment?.start ?? null;
}

/** Collapses whitespace in a text selection and caps it at the title limit. */
export function selectionTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 200);
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/** One-time Gemini privacy notice (per browser). */
export const AI_NOTICE_KEY = "ems.meetings.aiNotice";

export function hasSeenAiNotice(): boolean {
  try {
    return window.localStorage.getItem(AI_NOTICE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markAiNoticeSeen() {
  try {
    window.localStorage.setItem(AI_NOTICE_KEY, "1");
  } catch {
    // Storage unavailable — the notice shows again next time.
  }
}
