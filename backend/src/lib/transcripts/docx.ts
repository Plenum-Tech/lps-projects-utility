import mammoth from "mammoth";
import type { ParseResult } from "./common.js";
import { EXPORT_HINT, TranscriptError } from "./common.js";
import { parseText } from "./text.js";

// ---------------------------------------------------------------------------
// Teams "Download as .docx": mammoth extracts the raw text, then the text
// parser's Teams layouts ("Name   0:01:23" headers or "start --> end" cues)
// turn it into segments.
// ---------------------------------------------------------------------------

/** .docx files are zip archives ("PK\x03\x04"). */
export function isZip(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
}

export async function parseDocx(buffer: Buffer): Promise<ParseResult> {
  if (!isZip(buffer)) {
    throw new TranscriptError(`This file isn't a valid .docx document. ${EXPORT_HINT}`);
  }
  let text: string;
  try {
    const result = await mammoth.extractRawText({ buffer });
    text = result.value;
  } catch {
    throw new TranscriptError(`The .docx file couldn't be read. ${EXPORT_HINT}`);
  }
  if (!text.trim()) {
    throw new TranscriptError(`The .docx file has no text. ${EXPORT_HINT}`);
  }
  return parseText(text);
}
