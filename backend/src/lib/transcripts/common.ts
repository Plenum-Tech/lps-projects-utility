import { MEETING_LIMITS } from "../../models/Meeting.js";

// ---------------------------------------------------------------------------
// Shared transcript types + helpers used by every parser.
// ---------------------------------------------------------------------------

export interface ParsedSegment {
  idx: number;
  start: number | null;
  end: number | null;
  speaker: string | null;
  text: string;
}

export interface ParseResult {
  segments: ParsedSegment[];
  /** Distinct speaker names in order of first appearance. */
  speakers: string[];
  /** Non-fatal issues (e.g. long segments truncated). */
  warnings: string[];
}

/** A parse failure carried back to the client as a 400. */
export class TranscriptError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export const EXPORT_HINT = "Export the transcript from Teams as .vtt or .docx, or paste the text.";

/** Raw segment before indexing (parsers emit these). */
export interface RawSegment {
  start: number | null;
  end: number | null;
  speaker: string | null;
  text: string;
}

/** Strips control characters (keeps \n and \t), BOM and zero-width characters; normalizes newlines. */
export function sanitizeText(input: string): string {
  return input
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/[​-‍⁠﻿]/g, "");
}

/** Collapses whitespace inside one segment's text. */
export function cleanLine(input: string): string {
  return input.replace(/[ \t ]+/g, " ").trim();
}

/** Normalises a speaker label ("  Priya   Sharma " → "Priya Sharma"). Null when empty. */
export function cleanSpeaker(input: string | null | undefined): string | null {
  if (!input) return null;
  const name = cleanLine(input).replace(/^[-–—:]+|[-–—:]+$/g, "").trim();
  if (!name) return null;
  return name.slice(0, MEETING_LIMITS.speakerNameMax);
}

/**
 * Parses a timestamp: "1:23", "01:23", "0:01:23", "00:01:23.456", "00:01:23,456" → seconds.
 * Null when not a timestamp.
 */
export function parseTimestamp(input: string): number | null {
  const m = /^\s*(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?\s*$/.exec(input);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const sec = Number(m[3]);
  if (min > 59 || sec > 59) return null;
  const frac = m[4] ? Number(`0.${m[4]}`) : 0;
  return Math.round((h * 3600 + min * 60 + sec + frac) * 1000) / 1000;
}

/** "mm:ss" or "h:mm:ss" for display (task descriptions, prompts). */
export function formatTimestamp(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "";
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * Indexes raw segments and enforces the limits: empty text dropped, text
 * truncated to 5000 chars (warning), > 5000 segments → 400.
 */
export function finalizeSegments(raw: RawSegment[], warnings: string[] = []): ParseResult {
  const segments: ParsedSegment[] = [];
  let truncated = 0;
  for (const seg of raw) {
    let text = seg.text.trim();
    if (!text) continue;
    if (text.length > MEETING_LIMITS.segmentTextMax) {
      text = text.slice(0, MEETING_LIMITS.segmentTextMax);
      truncated += 1;
    }
    segments.push({
      idx: segments.length,
      start: seg.start ?? null,
      end: seg.end ?? null,
      speaker: cleanSpeaker(seg.speaker),
      text,
    });
  }
  if (segments.length === 0) {
    throw new TranscriptError(`The transcript is empty. ${EXPORT_HINT}`);
  }
  if (segments.length > MEETING_LIMITS.maxSegments) {
    throw new TranscriptError(
      `The transcript has ${segments.length} segments; the limit is ${MEETING_LIMITS.maxSegments}. Split the meeting into parts.`
    );
  }
  if (truncated > 0) warnings.push(`${truncated} long segment${truncated === 1 ? " was" : "s were"} truncated to ${MEETING_LIMITS.segmentTextMax} characters.`);

  const speakers: string[] = [];
  const seen = new Set<string>();
  for (const seg of segments) {
    if (!seg.speaker) continue;
    const key = seg.speaker.toLowerCase();
    if (seen.has(key)) {
      // Use the first spelling consistently.
      seg.speaker = speakers.find((s) => s.toLowerCase() === key) ?? seg.speaker;
      continue;
    }
    seen.add(key);
    speakers.push(seg.speaker);
  }
  if (speakers.length > MEETING_LIMITS.maxSpeakers) {
    throw new TranscriptError(`The transcript has more than ${MEETING_LIMITS.maxSpeakers} speakers. ${EXPORT_HINT}`);
  }
  return { segments, speakers, warnings };
}

/** Enforces the character limit on extracted text. */
export function assertLength(text: string): void {
  if (text.length > MEETING_LIMITS.maxChars) {
    throw new TranscriptError(
      `The transcript is too long (${text.length.toLocaleString("en-US")} characters; the limit is ${MEETING_LIMITS.maxChars.toLocaleString("en-US")}).`
    );
  }
}
