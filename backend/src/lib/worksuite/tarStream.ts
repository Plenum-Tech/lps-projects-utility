import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";

// ---------------------------------------------------------------------------
// Minimal streaming reader for a .tar.gz (ustar + GNU long names + pax paths).
// Nothing is written to disk and nothing is executed: for each regular-file
// entry the caller's `want(path, size)` decides whether its bytes are collected
// in memory (returned to `onFile`); every other entry is skipped unread.
// ---------------------------------------------------------------------------

export interface TarEntryInfo {
  path: string;
  size: number;
  type: string;
}

function cString(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function octal(buf: Buffer, start: number, len: number): number {
  const field = buf.subarray(start, start + len);
  // GNU base-256 encoding for large sizes.
  if (field[0]! & 0x80) {
    let value = 0;
    for (let i = 1; i < field.length; i++) value = value * 256 + field[i]!;
    return value;
  }
  const text = cString(buf, start, len).trim();
  return text ? parseInt(text, 8) : 0;
}

function paxPath(data: Buffer): string | null {
  const text = data.toString("utf8");
  let i = 0;
  while (i < text.length) {
    const space = text.indexOf(" ", i);
    if (space < 0) break;
    const len = Number(text.slice(i, space));
    if (!len) break;
    const record = text.slice(space + 1, i + len - 1);
    const eq = record.indexOf("=");
    if (eq > 0 && record.slice(0, eq) === "path") return record.slice(eq + 1);
    i += len;
  }
  return null;
}

/**
 * Walks the archive once. `want` sees every regular file (path, size); return
 * true to receive its bytes in `onFile`. `onEntry` (optional) sees every entry.
 */
export async function scanTarGz(
  file: string,
  want: (info: TarEntryInfo) => boolean,
  onFile: (info: TarEntryInfo, data: Buffer) => void | Promise<void>,
  onEntry?: (info: TarEntryInfo) => void
): Promise<void> {
  const source = createReadStream(file).pipe(createGunzip());

  let pending: Buffer = Buffer.alloc(0);
  // Current entry state.
  let remaining = 0; // data bytes left in the current entry
  let padding = 0; // padding bytes after the data
  let collecting: Buffer[] | null = null;
  let current: TarEntryInfo | null = null;
  let special: "longname" | "pax" | null = null;
  let specialChunks: Buffer[] = [];
  let nextLongName: string | null = null;
  let ended = false;

  const finishEntry = async () => {
    if (special === "longname") {
      nextLongName = cString(Buffer.concat(specialChunks), 0, Buffer.concat(specialChunks).length);
    } else if (special === "pax") {
      const p = paxPath(Buffer.concat(specialChunks));
      if (p) nextLongName = p;
    } else if (collecting && current) {
      await onFile(current, Buffer.concat(collecting));
    }
    special = null;
    specialChunks = [];
    collecting = null;
    current = null;
  };

  for await (const chunk of source as AsyncIterable<Buffer>) {
    if (ended) break;
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let offset = 0;
    while (offset < pending.length) {
      if (remaining > 0) {
        const take = Math.min(remaining, pending.length - offset);
        const piece = pending.subarray(offset, offset + take);
        if (special) specialChunks.push(Buffer.from(piece));
        else if (collecting) collecting.push(Buffer.from(piece));
        remaining -= take;
        offset += take;
        if (remaining === 0) await finishEntry();
        continue;
      }
      if (padding > 0) {
        const skip = Math.min(padding, pending.length - offset);
        padding -= skip;
        offset += skip;
        continue;
      }
      if (pending.length - offset < 512) break;
      const header = pending.subarray(offset, offset + 512);
      offset += 512;
      if (header.every((b) => b === 0)) {
        // End-of-archive marker (two zero blocks); tolerate trailing data.
        continue;
      }
      const name = cString(header, 0, 100);
      const size = octal(header, 124, 12);
      const typeflag = String.fromCharCode(header[156] || 48);
      const magic = cString(header, 257, 6);
      const prefix = magic.startsWith("ustar") ? cString(header, 345, 155) : "";
      let path = prefix ? `${prefix}/${name}` : name;
      if (nextLongName && typeflag !== "L" && typeflag !== "x" && typeflag !== "K") {
        path = nextLongName;
        nextLongName = null;
      }
      remaining = size;
      padding = size % 512 === 0 ? 0 : 512 - (size % 512);

      if (typeflag === "L") special = "longname";
      else if (typeflag === "x") special = "pax";
      else {
        special = null;
        const info: TarEntryInfo = { path, size, type: typeflag };
        onEntry?.(info);
        if ((typeflag === "0" || typeflag === "\0" || typeflag === "7") && want(info)) {
          current = info;
          collecting = [];
        }
      }
      if (remaining === 0) await finishEntry();
    }
    pending = offset < pending.length ? pending.subarray(offset) : Buffer.alloc(0);
  }
}
