import type { ParseResult, RawSegment } from "./common.js";
import { assertLength, cleanLine, cleanSpeaker, finalizeSegments, parseTimestamp, sanitizeText } from "./common.js";
import { looksLikeVtt, parseVtt } from "./vtt.js";

// ---------------------------------------------------------------------------
// Plain-text transcripts (pasted or .txt), also used for the text mammoth
// extracts from a Teams .docx. Recognised layouts, auto-detected:
//
//  1. Teams header style   "Priya Sharma   0:01:23" then the spoken lines
//  2. Teams arrow style    "0:0:3.12 --> 0:0:5.48" / "Priya Sharma" / text
//  3. "[00:01:02] Name: text" (or "[00:01:02] text")
//  4. "Name (00:01:02): text"
//  5. "Name: text"
//  6. plain lines (no speaker)
// ---------------------------------------------------------------------------

const TIME = String.raw`\d{1,3}:\d{1,2}(?::\d{1,2})?(?:[.,]\d{1,3})?`;
const HEADER = new RegExp(String.raw`^(.{1,80}?)(\s{2,}|\t+|\s)(${TIME})$`);
const ARROW = new RegExp(String.raw`^\s*(${TIME})\s*-->\s*(${TIME})\s*$`);
const BRACKET = new RegExp(String.raw`^\[(${TIME})\]\s*(.*)$`);
const PAREN = new RegExp(String.raw`^(.{1,80}?)\s*\((${TIME})\)\s*:?\s*(.*)$`);
const COLON = /^([^:]{1,60}):\s+(.+)$/;
const TRANSCRIPTION_EVENT = /\b(started|stopped) transcription\b/i;

/** Labels that look like "Name:" but aren't speakers. */
const NOT_SPEAKERS = new Set([
  "note", "notes", "action item", "action items", "action", "todo", "to do", "to-do", "agenda", "summary",
  "decision", "decisions", "next steps", "next step", "subject", "re", "fyi", "ps", "q", "a", "question",
  "answer", "update", "follow up", "follow-up", "attendees", "date", "time", "location", "meeting", "title",
  "http", "https", "warning", "error", "important", "reminder", "owner", "due", "status", "priority",
]);

/** 1-5 words of letters (with ' . - and accents), not a known label. */
export function isNameLike(input: string): boolean {
  const name = cleanLine(input);
  if (!name || name.length > 60) return false;
  if (NOT_SPEAKERS.has(name.toLowerCase())) return false;
  if (/[0-9@#/\\?!;,"()[\]{}<>=+*_|~]/.test(name)) return false;
  const words = name.split(/\s+/);
  if (words.length > 5) return false;
  // Every word starts with a letter; at least the first is capitalised (Teams names are).
  if (!words.every((w) => /^\p{L}/u.test(w))) return false;
  return /^\p{Lu}/u.test(words[0]!);
}

function headerOf(line: string): { speaker: string; start: number } | null {
  const m = HEADER.exec(line);
  if (!m) return null;
  const start = parseTimestamp(m[3]!);
  if (start === null || !isNameLike(m[1]!)) return null;
  // With a single space ("We meet at 10:30") only Title Case names count.
  if (m[2] === " " && !m[1]!.trim().split(/\s+/).every((w) => /^\p{Lu}/u.test(w))) return null;
  return { speaker: m[1]!.trim(), start };
}

/** Teams header style: each "Name   0:01:23" line starts a segment. */
function parseHeaderStyle(lines: string[]): RawSegment[] {
  const raw: RawSegment[] = [];
  let current: RawSegment | null = null;
  for (const line of lines) {
    if (!line) continue;
    const header = headerOf(line);
    if (header) {
      current = { start: header.start, end: null, speaker: header.speaker, text: "" };
      raw.push(current);
      continue;
    }
    if (!current || TRANSCRIPTION_EVENT.test(line)) continue; // title/date metadata before the first speaker
    current.text = current.text ? `${current.text} ${line}` : line;
  }
  return closeEnds(raw);
}

/** Older Teams .docx: "0:0:3.12 --> 0:0:5.48", then the speaker, then the text. */
function parseArrowStyle(lines: string[]): RawSegment[] {
  const raw: RawSegment[] = [];
  let cue: { start: number | null; end: number | null; lines: string[] } | null = null;
  const flush = () => {
    if (!cue || cue.lines.length === 0) return;
    let speaker: string | null = null;
    let body = cue.lines;
    if (body.length >= 2 && isNameLike(body[0]!)) {
      speaker = body[0]!;
      body = body.slice(1);
    } else if (body.length === 1) {
      const m = COLON.exec(body[0]!);
      if (m && isNameLike(m[1]!)) {
        speaker = m[1]!;
        body = [m[2]!];
      }
    }
    raw.push({ start: cue.start, end: cue.end, speaker, text: body.join(" ") });
  };
  for (const line of lines) {
    if (!line) continue;
    const m = ARROW.exec(line);
    if (m) {
      flush();
      cue = { start: parseTimestamp(m[1]!), end: parseTimestamp(m[2]!), lines: [] };
      continue;
    }
    if (!cue) continue;
    cue.lines.push(line);
  }
  flush();
  return raw;
}

/** Line formats 3-6. Un-prefixed lines directly under a speaker line continue that speaker. */
function parseLineStyle(lines: string[]): RawSegment[] {
  const raw: RawSegment[] = [];
  let previous: RawSegment | null = null;
  for (const line of lines) {
    if (!line) {
      previous = null; // blank line ends a continuation
      continue;
    }
    let seg: RawSegment | null = null;
    const bracket = BRACKET.exec(line);
    if (bracket) {
      const rest = bracket[2]!;
      const colon = COLON.exec(rest);
      seg =
        colon && isNameLike(colon[1]!)
          ? { start: parseTimestamp(bracket[1]!), end: null, speaker: colon[1]!, text: colon[2]! }
          : { start: parseTimestamp(bracket[1]!), end: null, speaker: null, text: rest };
    } else {
      const paren = PAREN.exec(line);
      if (paren && isNameLike(paren[1]!) && parseTimestamp(paren[2]!) !== null) {
        seg = { start: parseTimestamp(paren[2]!), end: null, speaker: paren[1]!, text: paren[3]! };
      } else {
        const colon = COLON.exec(line);
        if (colon && isNameLike(colon[1]!)) {
          seg = { start: null, end: null, speaker: colon[1]!, text: colon[2]! };
        }
      }
    }
    if (seg) {
      if (!seg.text.trim()) {
        // "Name (00:01:02):" alone on a line — text follows on the next lines.
        raw.push(seg);
        previous = seg;
        continue;
      }
      raw.push(seg);
      previous = seg;
      continue;
    }
    // "Agenda: …" style labels are their own line, never a continuation.
    const label = COLON.exec(line);
    if (previous && previous.speaker && !(label && label[1]!.trim().split(/\s+/).length <= 3)) {
      previous.text = previous.text ? `${previous.text} ${line}` : line;
      continue;
    }
    const plain: RawSegment = { start: null, end: null, speaker: null, text: line };
    raw.push(plain);
    previous = null;
  }
  return raw;
}

/** Each timed segment ends where the next one starts. */
function closeEnds(raw: RawSegment[]): RawSegment[] {
  for (let i = 0; i < raw.length - 1; i++) {
    const next = raw[i + 1]!;
    if (raw[i]!.end === null && raw[i]!.start !== null && next.start !== null && next.start >= raw[i]!.start!) {
      raw[i]!.end = next.start;
    }
  }
  return raw;
}

export type TextLayout = "vtt" | "teams-header" | "teams-arrow" | "lines";

/** Picks the layout for already-sanitised text. */
export function detectLayout(text: string): TextLayout {
  if (/^WEBVTT/.test(text)) return "vtt";
  const lines = text.split("\n").map((l) => cleanLine(l)).filter(Boolean);
  const arrows = lines.filter((l) => ARROW.test(l)).length;
  if (arrows > 0 && looksLikeVtt(text) && /<v[\s.]/.test(text)) return "vtt";
  if (arrows >= 1 && arrows >= lines.length / 6) return "teams-arrow";
  const headers = lines.filter((l) => headerOf(l)).length;
  if (headers >= 2 || (headers === 1 && lines.length <= 3)) return "teams-header";
  return "lines";
}

/** Parses pasted text / .txt / docx-extracted text (any of the layouts above). */
export function parseText(input: string): ParseResult {
  const text = sanitizeText(input);
  assertLength(text);
  const layout = detectLayout(text.trimStart());
  if (layout === "vtt") return parseVtt(text);
  const lines = text.split("\n").map((l) => cleanLine(l));
  const raw =
    layout === "teams-arrow" ? parseArrowStyle(lines) : layout === "teams-header" ? parseHeaderStyle(lines) : parseLineStyle(lines);
  for (const seg of raw) seg.speaker = cleanSpeaker(seg.speaker);
  return finalizeSegments(closeEnds(raw));
}
