import zlib from "node:zlib";
import ExcelJS from "exceljs";
import { IMPORT_LIMITS } from "../../models/ImportJob.js";

// ---------------------------------------------------------------------------
// Spreadsheet parsing for imports (.xlsx via exceljs, .csv via a small
// RFC 4180 parser). Safety: size/row/column/cell caps, a zip-bomb guard that
// inflates every .xlsx entry with a hard output budget BEFORE exceljs sees it,
// formulas read as their cached result (never evaluated), values kept as text.
// ---------------------------------------------------------------------------

export type CellValue = string | number | boolean | Date | null;

export interface ParsedRow {
  /** Spreadsheet row number (1-based). */
  row: number;
  cells: CellValue[];
  /** Column indexes whose text exceeded the per-cell cap (truncated). */
  oversize: number[];
}

export interface ParsedTable {
  format: "xlsx" | "csv";
  sheets: string[];
  sheet: string | null;
  headers: string[];
  rows: ParsedRow[];
}

/** User-facing parse failure (status + message). */
export class ImportFileError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function fileFormat(fileName: string): "xlsx" | "csv" | null {
  const ext = fileName.split(".").pop()?.toLowerCase();
  if (ext === "xlsx") return "xlsx";
  if (ext === "csv") return "csv";
  return null;
}

// --- zip-bomb guard ---------------------------------------------------------

/**
 * Walks the zip central directory and inflates every entry with a shared
 * output budget (maxUnzippedBytes), so declared sizes can't lie. Rejects
 * encrypted entries, unknown compression methods and ZIP64 archives.
 */
export function assertSafeZip(buf: Buffer): void {
  const bad = (msg: string) => new ImportFileError(400, msg);
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw bad("This is not a valid .xlsx file");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad("This is not a valid .xlsx file");
  const entries = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || offset === 0xffffffff) throw bad("ZIP64 workbooks are not supported");
  if (entries > IMPORT_LIMITS.maxZipEntries) throw bad("The workbook contains too many parts");

  let budget: number = IMPORT_LIMITS.maxUnzippedBytes;
  const tooBig = () =>
    new ImportFileError(413, `The workbook unpacks to more than ${IMPORT_LIMITS.maxUnzippedBytes / 1024 / 1024} MB`);
  for (let n = 0; n < entries; n++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) throw bad("This is not a valid .xlsx file");
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const local = buf.readUInt32LE(offset + 42);
    offset += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw bad("Encrypted workbooks are not supported");
    if (size === 0xffffffff || compSize === 0xffffffff) throw bad("ZIP64 workbooks are not supported");
    if (size > budget) throw tooBig();
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw bad("This is not a valid .xlsx file");
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (dataStart + compSize > buf.length) throw bad("This is not a valid .xlsx file");
    const data = buf.subarray(dataStart, dataStart + compSize);
    let actual: number;
    if (method === 0) actual = compSize;
    else if (method === 8) {
      try {
        actual = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, budget) }).length;
      } catch (err) {
        if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw tooBig();
        throw bad("This is not a valid .xlsx file");
      }
    } else throw bad("The workbook uses an unsupported compression method");
    budget -= actual;
    if (budget < 0) throw tooBig();
  }
}

// --- helpers ----------------------------------------------------------------

function columnLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function isEmpty(v: CellValue): boolean {
  return v === null || (typeof v === "string" && v.trim() === "");
}

/** Display text of a parsed cell (dates as YYYY-MM-DD). */
export function cellText(v: CellValue | undefined): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  return String(v);
}

function capText(text: string, col: number, oversize: number[]): string {
  if (text.length <= IMPORT_LIMITS.maxCellChars) return text;
  oversize.push(col);
  return text.slice(0, IMPORT_LIMITS.maxCellChars);
}

/** Builds headers + data rows from raw rows (empty rows dropped, caps enforced). */
function toTable(
  raw: Array<{ row: number; cells: CellValue[]; oversize: number[] }>,
  headerRow: boolean
): { headers: string[]; rows: ParsedRow[] } {
  const nonEmpty = raw.filter((r) => r.cells.some((c) => !isEmpty(c)));
  let width = 0;
  for (const r of nonEmpty) {
    for (let i = r.cells.length - 1; i >= 0; i--) {
      if (!isEmpty(r.cells[i] ?? null)) {
        width = Math.max(width, i + 1);
        break;
      }
    }
  }
  if (width > IMPORT_LIMITS.maxColumns) {
    throw new ImportFileError(422, `The sheet has ${width} columns; at most ${IMPORT_LIMITS.maxColumns} are supported`);
  }
  const head = headerRow ? nonEmpty.shift() : undefined;
  if (nonEmpty.length > IMPORT_LIMITS.maxRows) {
    throw new ImportFileError(422, `The sheet has ${nonEmpty.length} data rows; at most ${IMPORT_LIMITS.maxRows} can be imported at once`);
  }
  const seen = new Map<string, number>();
  const headers = Array.from({ length: width }, (_, i) => {
    let h = head ? cellText(head.cells[i] ?? null).replace(/\s+/g, " ").trim().slice(0, 100) : "";
    if (!h) h = `Column ${columnLetter(i)}`;
    const count = (seen.get(h.toLowerCase()) ?? 0) + 1;
    seen.set(h.toLowerCase(), count);
    return count > 1 ? `${h} (${count})` : h;
  });
  const rows = nonEmpty.map((r) => ({
    row: r.row,
    cells: Array.from({ length: width }, (_, i) => r.cells[i] ?? null),
    oversize: r.oversize.filter((i) => i < width),
  }));
  return { headers, rows };
}

// --- xlsx -------------------------------------------------------------------

/** exceljs cell value → plain value. Formulas → cached result only; errors → empty. */
function xlsxValue(value: ExcelJS.CellValue): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    const v = value as unknown as Record<string, unknown>;
    if ("formula" in v || "sharedFormula" in v) {
      const result = v.result as ExcelJS.CellValue | undefined;
      return result === undefined ? null : xlsxValue(result);
    }
    if ("error" in v) return null;
    if (Array.isArray(v.richText)) return (v.richText as Array<{ text?: string }>).map((t) => t.text ?? "").join("");
    if ("text" in v) {
      const text = v.text as unknown;
      if (typeof text === "string") return text;
      if (text && typeof text === "object" && Array.isArray((text as { richText?: unknown }).richText)) {
        return ((text as { richText: Array<{ text?: string }> }).richText).map((t) => t.text ?? "").join("");
      }
    }
  }
  return null;
}

async function parseXlsx(buffer: Buffer, sheetName: string | null, headerRow: boolean): Promise<ParsedTable> {
  assertSafeZip(buffer);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer, {
      ignoreNodes: ["dataValidations", "conditionalFormatting", "hyperlinks", "drawing", "picture", "legacyDrawing"],
    } as never);
  } catch {
    throw new ImportFileError(400, "The workbook could not be read. Save it again as .xlsx and retry.");
  }
  const visible = workbook.worksheets.filter((ws) => ws.state !== "veryHidden");
  const sheets = visible.map((ws) => ws.name);
  if (sheets.length === 0) throw new ImportFileError(422, "The workbook has no sheets");
  const ws = sheetName ? visible.find((s) => s.name === sheetName) : visible[0];
  if (!ws) throw new ImportFileError(400, `Sheet "${sheetName}" not found`);

  if (ws.actualRowCount > IMPORT_LIMITS.maxRows + 1) {
    throw new ImportFileError(
      422,
      `The sheet has ${ws.actualRowCount - (headerRow ? 1 : 0)} data rows; at most ${IMPORT_LIMITS.maxRows} can be imported at once`
    );
  }
  const raw: Array<{ row: number; cells: CellValue[]; oversize: number[] }> = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells: CellValue[] = [];
    const oversize: number[] = [];
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      if (col > IMPORT_LIMITS.maxColumns + 1) {
        cells[col - 1] = "x"; // only counts toward the column cap
        return;
      }
      let v = xlsxValue(cell.value);
      if (typeof v === "string") v = capText(v, col - 1, oversize);
      cells[col - 1] = v;
    });
    raw.push({ row: rowNumber, cells: Array.from(cells, (c) => c ?? null), oversize });
  });
  return { format: "xlsx", sheets, sheet: ws.name, ...toTable(raw, headerRow) };
}

// --- csv --------------------------------------------------------------------

function decodeText(buffer: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    text = new TextDecoder("windows-1252").decode(buffer);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Comma unless the first line has more semicolons or tabs (outside quotes). */
function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const ch of text.slice(0, 10_000)) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && ch in counts) counts[ch]! += 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]![1] > 0
    ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0]![0]
    : ",";
}

/** RFC 4180 parser: quoted fields, doubled quotes, CR/LF/CRLF, line breaks inside quotes. */
export function parseCsvText(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const maxRecords = IMPORT_LIMITS.maxRows + 50;
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      i += 1;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
      i += 1;
    } else if (ch === "\r" || ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      if (rows.length > maxRecords) {
        throw new ImportFileError(422, `The file has more than ${IMPORT_LIMITS.maxRows} data rows`);
      }
    } else {
      field += ch;
      i += 1;
    }
    if (row.length > IMPORT_LIMITS.maxColumns + 1) {
      // Keep scanning the record but stop growing it: the column cap rejects it below.
      row.length = IMPORT_LIMITS.maxColumns + 1;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseCsv(buffer: Buffer, headerRow: boolean): ParsedTable {
  const records = parseCsvText(decodeText(buffer));
  const raw = records.map((cells, idx) => {
    const oversize: number[] = [];
    return { row: idx + 1, cells: cells.map((c, col) => capText(c, col, oversize) as CellValue), oversize };
  });
  return { format: "csv", sheets: [], sheet: null, ...toTable(raw, headerRow) };
}

/** Parses an uploaded .xlsx / .csv into headers + rows (throws ImportFileError). */
export async function parseSpreadsheet(
  buffer: Buffer,
  fileName: string,
  options: { sheet?: string | null; headerRow?: boolean } = {}
): Promise<ParsedTable> {
  if (buffer.length > IMPORT_LIMITS.maxBytes) {
    throw new ImportFileError(413, `Files can be at most ${IMPORT_LIMITS.maxBytes / 1024 / 1024} MB`);
  }
  const format = fileFormat(fileName);
  if (!format) throw new ImportFileError(415, "Upload an .xlsx or .csv file");
  const headerRow = options.headerRow !== false;
  return format === "xlsx" ? parseXlsx(buffer, options.sheet ?? null, headerRow) : parseCsv(buffer, headerRow);
}
