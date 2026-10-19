import type { Response } from "express";
import ExcelJS from "exceljs";
import { zonedParts } from "./appTime.js";
import { appDateKey } from "./taskJobs.js";

/** Hard cap on exported rows (the response says when it was hit). */
export const EXPORT_ROW_LIMIT = 5000;

export type CsvValue = string | number | boolean | Date | null | undefined;

/** "YYYY-MM-DD" of a stored date-only value (UTC midnight), "" when unset. */
export function csvDate(value: Date | null | undefined): string {
  return value ? value.toISOString().slice(0, 10) : "";
}

/** "YYYY-MM-DD HH:mm" of an instant in the app timezone, "" when unset. */
export function csvDateTime(value: Date | null | undefined): string {
  if (!value) return "";
  const p = zonedParts(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * Minutes → the duration as the app shows it: "2h 09m", "8h", "18m" ("" when null).
 * Text, not decimal hours — 2.15 read like "2h 15m" when it meant 2h 09m.
 */
export function csvHours(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "";
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${String(rest).padStart(2, "0")}m`;
}

/**
 * RFC 4180 field escaping. Fields with a comma, quote or line break are quoted
 * (inner quotes doubled). Text starting with = + - @ (or tab / CR) is prefixed
 * with ' so spreadsheet apps never evaluate it as a formula (CSV injection).
 */
export function escapeCsv(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV document (CRLF line endings) with a UTF-8 BOM so Excel detects the encoding. */
export function toCsv(headers: string[], rows: CsvValue[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(escapeCsv).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/** An Excel workbook (.xlsx) with one sheet: bold, frozen header row with filters, sized columns. */
export async function toXlsx(sheetName: string, headers: string[], rows: CsvValue[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName.replace(/[\/?*[\]:]/g, " ").slice(0, 31) || "Export", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.addRow(headers);
  // Cells are written as values (never formulas), so a leading "=" is just text.
  for (const row of rows) sheet.addRow(row.map((v) => (v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : v)));
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, headers.length) } };
  sheet.columns.forEach((column, i) => {
    let width = headers[i]?.length ?? 8;
    column.eachCell?.({ includeEmpty: false }, (cell) => {
      width = Math.max(width, Math.min(60, String(cell.value ?? "").length));
    });
    column.width = Math.max(8, width + 2);
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/**
 * Sends an Excel download named `{basename}-YYYY-MM-DD.xlsx` (app timezone date).
 * `X-Export-Total` = matching rows, `X-Export-Truncated` = "true" when capped.
 */
export async function sendSheet(
  res: Response,
  basename: string,
  headers: string[],
  rows: CsvValue[][],
  meta: { rows: number; total: number }
): Promise<void> {
  const body = await toXlsx(basename, headers, rows);
  const filename = `${basename}-${appDateKey()}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Export-Rows", String(meta.rows));
  res.setHeader("X-Export-Total", String(meta.total));
  res.setHeader("X-Export-Truncated", meta.total > meta.rows ? "true" : "false");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Disposition, X-Export-Rows, X-Export-Total, X-Export-Truncated"
  );
  res.send(body);
}

/** Parses `?ids=a,b,c` (or repeated `ids`) into unique strings; null when absent. */
export function parseIdList(raw: unknown): string[] | null {
  if (raw === undefined || raw === "") return null;
  const parts = (Array.isArray(raw) ? raw : [raw]).flatMap((v) => (typeof v === "string" ? v.split(",") : []));
  return [...new Set(parts.map((p) => p.trim()).filter(Boolean))];
}
