import ExcelJS from "exceljs";
import type { IImportJob, ImportType } from "../../models/ImportJob.js";
import { fieldsFor } from "./fields.js";

// ---------------------------------------------------------------------------
// Generated workbooks: import templates and error reports.
// ---------------------------------------------------------------------------

/** Text starting with = + - @ (or tab/CR) gets a leading ' so it's never treated as a formula. */
export function safeCellText(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function styleHeader(ws: ExcelJS.Worksheet): void {
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF2F7" } };
  ws.views = [{ state: "frozen", ySplit: 1 }];
}

/** Template: the expected headers, one example row, and an Instructions sheet. */
export async function buildTemplate(type: ImportType): Promise<Buffer> {
  const fields = fieldsFor(type);
  const wb = new ExcelJS.Workbook();
  wb.creator = "LPS – Projects Utility";
  const sheet = wb.addWorksheet(type === "projects" ? "Projects" : "Tasks");
  sheet.columns = fields.map((f) => ({ header: f.label, key: f.key, width: Math.max(14, f.label.length + 4) }));
  const example: Record<string, unknown> = {};
  for (const f of fields) {
    example[f.key] = /date|deadline/i.test(f.key) && typeof f.example === "string"
      ? new Date(`${f.example}T00:00:00.000Z`)
      : f.example;
  }
  const row = sheet.addRow(example);
  for (const f of fields) {
    if (/date|deadline/i.test(f.key)) row.getCell(f.key).numFmt = "yyyy-mm-dd";
  }
  styleHeader(sheet);

  const info = wb.addWorksheet("Instructions");
  info.columns = [
    { header: "Column", key: "label", width: 20 },
    { header: "Required", key: "required", width: 22 },
    { header: "Accepts", key: "accepts", width: 70 },
    { header: "Example", key: "example", width: 30 },
  ];
  for (const f of fields) {
    info.addRow({
      label: f.label,
      required: f.required === true ? "Yes" : f.required === "create" ? "Yes (new records)" : "No",
      accepts: f.accepts,
      example: String(f.example),
    });
  }
  info.addRow({});
  const notes = [
    "Keep the header row. Columns can be in any order; unknown columns are ignored.",
    "Up to 2,000 rows and 5 MB per file (.xlsx or .csv). Empty rows are skipped.",
    "People are matched by email (preferred) or exact full name; a name shared by two users is an error.",
    type === "projects"
      ? "Existing project codes are skipped or updated (only the mapped columns change), as chosen during import."
      : "Projects are matched by code (preferred) or exact name; you must be allowed to add tasks to them.",
    "Delete the example row before importing.",
  ];
  for (const n of notes) info.addRow({ label: "Note", accepts: n });
  styleHeader(info);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Error report: failing rows with their original values plus a Reason column. */
export async function buildErrorReport(job: IImportJob): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Errors");
  const headers = job.columns.map((c) => c.header);
  ws.columns = [
    { header: "Row", key: "row", width: 8 },
    ...headers.map((h, i) => ({ header: safeCellText(h), key: `c${i}`, width: Math.min(40, Math.max(12, h.length + 2)) })),
    { header: "Status", key: "status", width: 10 },
    { header: "Reason", key: "reason", width: 80 },
  ];
  for (const r of job.rowsResult) {
    if (r.status !== "error") continue;
    const values: Record<string, unknown> = { row: r.row, status: r.status, reason: safeCellText(r.messages.join("; ")) };
    (r.values ?? []).forEach((v, i) => {
      values[`c${i}`] = safeCellText(v);
    });
    ws.addRow(values);
  }
  ws.getColumn("reason").alignment = { wrapText: true, vertical: "top" };
  styleHeader(ws);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
