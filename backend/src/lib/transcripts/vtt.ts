import { MEETING_LIMITS } from "../../models/Meeting.js";
import type { ParseResult, RawSegment } from "./common.js";
import { assertLength, cleanLine, cleanSpeaker, EXPORT_HINT, finalizeSegments, parseTimestamp, sanitizeText, TranscriptError } from "./common.js";

// ---------------------------------------------------------------------------
// WebVTT (Teams "Download .vtt"): WEBVTT header, NOTE/STYLE/REGION blocks,
// optional cue ids, "start --> end" timings, <v Speaker>text</v> voice spans,
// multi-line cues. Consecutive cues of one speaker < 2 s apart are merged.
// ---------------------------------------------------------------------------

const MERGE_GAP_SECONDS = 2;
const TIMING = /^\s*(\S+)\s+-->\s+(\S+)/;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
  "&lrm;": "",
  "&rlm;": "",
};

export function decodeEntities(input: string): string {
  return input
    .replace(/&(amp|lt|gt|quot|apos|nbsp|lrm|rlm|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d{1,6});/g, (_m, n: string) => {
      const code = Number(n);
      return code > 31 && code < 0x110000 ? String.fromCodePoint(code) : "";
    })
    .replace(/&#x([0-9a-f]{1,6});/gi, (_m, n: string) => {
      const code = parseInt(n, 16);
      return code > 31 && code < 0x110000 ? String.fromCodePoint(code) : "";
    });
}

/** Removes every markup tag except voice spans (<c>, <b>, <i>, <u>, <lang>, inline timestamps). */
function stripMarkup(input: string): string {
  return input.replace(/<\/?(?:c|b|i|u|ruby|rt|lang)(?:[.\s][^>]*)?>/gi, "").replace(/<\d[\d:.]*>/g, "");
}

interface VoicePart {
  speaker: string | null;
  text: string;
}

/** Splits a cue payload into voice spans; text outside any <v> keeps the cue's current voice. */
function splitVoices(payload: string): VoicePart[] {
  const parts: VoicePart[] = [];
  let current: string | null = null;
  const re = /<v(?:\.[^\s>]*)?(?:\s+([^>]*))?>|<\/v>/gi;
  let last = 0;
  let match: RegExpExecArray | null;
  const push = (text: string) => {
    const clean = text.replace(/\s*\n\s*/g, " ");
    if (clean.trim()) parts.push({ speaker: current, text: clean });
  };
  while ((match = re.exec(payload))) {
    push(payload.slice(last, match.index));
    if (match[0].toLowerCase() === "</v>") {
      // Keep `current`: a trailing line after </v> almost always continues the same voice in Teams exports.
    } else {
      current = cleanSpeaker(decodeEntities(match[1] ?? "")) ?? null;
    }
    last = match.index + match[0].length;
  }
  push(payload.slice(last));
  return parts;
}

/** "Name: text" fallback for VTTs without voice tags (Zoom-style). */
function colonSpeaker(text: string): VoicePart {
  const m = /^([A-Z][\p{L}'’.\- ]{0,58}[\p{L}.]):\s+(.+)$/u.exec(text);
  if (m && m[1]!.trim().split(/\s+/).length <= 5) return { speaker: cleanSpeaker(m[1]!), text: m[2]! };
  return { speaker: null, text };
}

export function looksLikeVtt(text: string): boolean {
  return /^﻿?WEBVTT/.test(text) || /^\s*\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s+-->\s+/m.test(text);
}

export function parseVtt(input: string): ParseResult {
  const text = sanitizeText(input);
  assertLength(text);
  const blocks = text.split(/\n[ \t]*\n+/);
  const raw: RawSegment[] = [];
  const warnings: string[] = [];
  let cues = 0;

  for (const block of blocks) {
    const lines = block.split("\n").filter((l, i, all) => !(i === 0 && !l.trim() && all.length > 1));
    if (lines.length === 0) continue;
    const first = lines[0]!.trim();
    if (/^WEBVTT/.test(first) && !lines.some((l) => TIMING.test(l))) continue;
    if (/^(NOTE|STYLE|REGION)(\s|$)/.test(first)) continue;

    const timingAt = lines.findIndex((l) => TIMING.test(l));
    if (timingAt === -1) continue; // stray text / header metadata
    const timing = TIMING.exec(lines[timingAt]!)!;
    const start = parseTimestamp(timing[1]!);
    const end = parseTimestamp(timing[2]!);
    const payload = lines.slice(timingAt + 1).join("\n");
    if (!payload.trim()) continue;
    cues += 1;

    const voices = splitVoices(stripMarkup(payload));
    for (const voice of voices) {
      let part: VoicePart = { speaker: voice.speaker, text: cleanLine(decodeEntities(voice.text)) };
      if (!part.speaker) part = colonSpeaker(part.text);
      if (!part.text) continue;

      const prev = raw[raw.length - 1];
      const gap = prev && prev.end !== null && start !== null ? start - prev.end : Infinity;
      if (
        prev &&
        (prev.speaker ?? "").toLowerCase() === (part.speaker ?? "").toLowerCase() &&
        gap < MERGE_GAP_SECONDS &&
        prev.text.length + part.text.length + 1 <= MEETING_LIMITS.segmentTextMax
      ) {
        prev.text = `${prev.text} ${part.text}`;
        prev.end = end ?? prev.end;
        continue;
      }
      raw.push({ start, end, speaker: part.speaker, text: part.text });
    }
  }

  if (cues === 0) {
    throw new TranscriptError(`No captions were found in this .vtt file. ${EXPORT_HINT}`);
  }
  return finalizeSegments(raw, warnings);
}
