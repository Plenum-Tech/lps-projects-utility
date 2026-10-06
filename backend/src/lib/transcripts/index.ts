import type { ParseResult } from "./common.js";
import { EXPORT_HINT, TranscriptError } from "./common.js";
import { parseDocx } from "./docx.js";
import { parseText } from "./text.js";
import { parseVtt } from "./vtt.js";

export type { ParsedSegment, ParseResult } from "./common.js";
export { formatTimestamp, TranscriptError } from "./common.js";

export const TRANSCRIPT_EXTENSIONS = ["vtt", "docx", "txt"] as const;
export type TranscriptExtension = (typeof TRANSCRIPT_EXTENSIONS)[number];

export function fileExtension(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

/** Decodes an uploaded text file (UTF-8, or UTF-16 with a BOM). Rejects binary data. */
function decodeTextFile(buffer: Buffer): string {
  let text: string;
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) text = buffer.subarray(2).toString("utf16le");
  else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    text = swapped.toString("utf16le");
  } else text = buffer.toString("utf8");
  // Lots of NULs / replacement characters → a binary file renamed to .txt/.vtt.
  const sample = text.slice(0, 4000);
  const bad = (sample.match(/[\u0000\uFFFD]/g) ?? []).length;
  if (sample.length > 0 && bad / sample.length > 0.05) {
    throw new TranscriptError(`This file doesn't look like a text transcript. ${EXPORT_HINT}`);
  }
  return text;
}

/** Parses an uploaded transcript by extension (.vtt / .docx / .txt). */
export async function parseTranscriptFile(buffer: Buffer, filename: string): Promise<ParseResult> {
  const ext = fileExtension(filename);
  if (ext === "docx") return parseDocx(buffer);
  if (ext === "vtt") return parseVtt(decodeTextFile(buffer));
  if (ext === "txt") return parseText(decodeTextFile(buffer));
  throw new TranscriptError(`Unsupported file type ".${ext}". ${EXPORT_HINT}`, 415);
}

/** Parses pasted text (any supported layout, including pasted WebVTT). */
export function parseTranscriptText(text: string): ParseResult {
  return parseText(text);
}
