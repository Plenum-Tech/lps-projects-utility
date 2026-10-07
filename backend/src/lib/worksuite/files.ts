import { TASK_FILE_MIME_TYPES } from "../../models/TaskFile.js";
import { sanitizeSvg } from "../svgSanitize.js";

// ---------------------------------------------------------------------------
// Attachment validation for files streamed out of the Worksuite backup.
// The backup is untrusted (it contains malware), so a file is only stored
// when its extension maps to an allowed attachment type, its bytes don't look
// like a script/executable, and (for SVG) it survives the sanitizer.
// ---------------------------------------------------------------------------

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  csv: "text/csv",
  zip: "application/zip",
};

export function mimeForFilename(filename: string): string | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const mime = MIME_BY_EXTENSION[ext];
  return mime && TASK_FILE_MIME_TYPES.includes(mime) ? mime : null;
}

/** Signatures that must never be stored as an attachment. */
function looksDangerous(data: Buffer): boolean {
  const head = data.subarray(0, 4096).toString("latin1");
  if (head.startsWith("MZ") || head.startsWith("\x7fELF") || head.startsWith("#!")) return true;
  return /<\?php|<\?=|<script[\s>]/i.test(head);
}

/** Magic-number check for binary types (text types are only checked for script content). */
function matchesType(mime: string, data: Buffer): boolean {
  const b = data;
  switch (mime) {
    case "image/png":
      return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
    case "image/jpeg":
      return b[0] === 0xff && b[1] === 0xd8;
    case "image/gif":
      return b.subarray(0, 4).toString("latin1") === "GIF8";
    case "image/webp":
      return b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP";
    case "application/pdf":
      return b.subarray(0, 5).toString("latin1") === "%PDF-";
    case "application/zip":
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return b[0] === 0x50 && b[1] === 0x4b;
    case "application/msword":
    case "application/vnd.ms-excel":
    case "application/vnd.ms-powerpoint":
      return b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
    default:
      return true;
  }
}

export type FileCheck = { ok: true; mime: string; data: Buffer } | { ok: false; reason: "unsupported_type" | "rejected_content" };

/** Validates (and for SVG, sanitizes) an attachment taken from the backup. */
export function checkAttachment(filename: string, data: Buffer): FileCheck {
  const mime = mimeForFilename(filename);
  if (!mime) return { ok: false, reason: "unsupported_type" };
  if (mime === "image/svg+xml") {
    try {
      return { ok: true, mime, data: Buffer.from(sanitizeSvg(data), "utf8") };
    } catch {
      return { ok: false, reason: "rejected_content" };
    }
  }
  // Text types: no script content. Binary types: the bytes must match the claimed format.
  const bad = mime.startsWith("text/") ? looksDangerous(data) : !matchesType(mime, data);
  if (bad) return { ok: false, reason: "rejected_content" };
  return { ok: true, mime, data };
}
