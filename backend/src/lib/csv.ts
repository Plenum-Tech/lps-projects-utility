import type { Response } from "express";
import { appDateKey } from "./taskJobs.js";

/** Hard cap on exported rows (the response says when it was hit). */
export const EXPORT_ROW_LIMIT = 5000;

export type CsvValue = string | number | boolean | Date | null | undefined;

/** "YYYY-MM-DD" of a stored date-only value (UTC midnight), "" when unset. */
export function csvDate(value: Date | null | undefined): string {
  return value ? value.toISOString().slice(0, 10) : "";
}

/** Minutes → decimal hours with 2 decimals ("" when null). */
export function csvHours(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "";
  return (Math.round((minutes / 60) * 100) / 100).toFixed(2);
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

/**
 * Sends a CSV download named `{basename}-YYYY-MM-DD.csv` (app timezone date).
 * `X-Export-Total` = matching rows, `X-Export-Truncated` = "true" when capped.
 */
export function sendCsv(
  res: Response,
  basename: string,
  csv: string,
  meta: { rows: number; total: number }
): void {
  const filename = `${basename}-${appDateKey()}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Export-Rows", String(meta.rows));
  res.setHeader("X-Export-Total", String(meta.total));
  res.setHeader("X-Export-Truncated", meta.total > meta.rows ? "true" : "false");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Disposition, X-Export-Rows, X-Export-Total, X-Export-Truncated"
  );
  res.send(csv);
}

/** Parses `?ids=a,b,c` (or repeated `ids`) into unique strings; null when absent. */
export function parseIdList(raw: unknown): string[] | null {
  if (raw === undefined || raw === "") return null;
  const parts = (Array.isArray(raw) ? raw : [raw]).flatMap((v) => (typeof v === "string" ? v.split(",") : []));
  return [...new Set(parts.map((p) => p.trim()).filter(Boolean))];
}
