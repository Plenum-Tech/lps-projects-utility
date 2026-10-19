import type { Request, Response } from "express";
import ExcelJS from "exceljs";
import { brandLabel, currentQuarter, loadPitchRows, quarterMonths, shortDate, type PitchRow } from "../lib/pitches.js";
import { projectVisibilityFilter } from "../lib/projectAccess.js";

// ---------------------------------------------------------------------------
// Brands → Pitches: GET /api/brands/pitches?quarter=2026-Q4 (rows + automatic
// status) and /pitches/export (the tracker sheet's layout as .xlsx). Only the
// projects the user may see (same rule as the projects list).
// ---------------------------------------------------------------------------

function quarterOf(req: Request): string | null {
  const raw = typeof req.query.quarter === "string" && req.query.quarter ? req.query.quarter : currentQuarter();
  return quarterMonths(raw) ? raw : null;
}

/** "2026-Q4" → "Q4 2026". */
const quarterLabel = (q: string) => `${q.slice(5)} ${q.slice(0, 4)}`;

function totals(rows: PitchRow[]) {
  return { count: rows.length, revenue: rows.reduce((sum, r) => sum + (r.revenue ?? 0), 0) };
}

/** GET /api/brands/pitches */
export async function listPitches(req: Request, res: Response): Promise<void> {
  const quarter = quarterOf(req);
  if (!quarter) {
    res.status(400).json({ error: "quarter must be YYYY-Q1..Q4" });
    return;
  }
  const rows = await loadPitchRows(projectVisibilityFilter(req.user!), quarter);
  res.json({ quarter, label: quarterLabel(quarter), rows, totals: totals(rows) });
}

const fmtRevenue = (r: PitchRow) => (r.revenue === null ? "TBC" : `AED ${r.revenue.toLocaleString("en-US")}`);
const fmtDate = (d: string | null) => (d ? shortDate(d) : "");

/** GET /api/brands/pitches/export — title row, the sheet's 8 headers, one row per pitch, totals. */
export async function exportPitches(req: Request, res: Response): Promise<void> {
  const quarter = quarterOf(req);
  if (!quarter) {
    res.status(400).json({ error: "quarter must be YYYY-Q1..Q4" });
    return;
  }
  const rows = await loadPitchRows(projectVisibilityFilter(req.user!), quarter);
  const label = quarterLabel(quarter);

  const wb = new ExcelJS.Workbook();
  wb.creator = req.user!.name;
  wb.created = new Date();
  const sheet = wb.addWorksheet(`Pitches ${label}`);
  sheet.columns = [
    { width: 28 },
    { width: 36 },
    { width: 18 },
    { width: 13 },
    { width: 13 },
    { width: 13 },
    { width: 60 },
    { width: 24 },
  ];

  sheet.mergeCells("A1:H1");
  const title = sheet.getCell("A1");
  title.value = `PITCHES/PROACTIVE PROJECTS  ${label}`;
  title.font = { bold: true, size: 14 };
  title.alignment = { horizontal: "center", vertical: "middle" };
  sheet.getRow(1).height = 24;

  const header = sheet.addRow(["Client Name", "Campaign/Idea", "Revenue Potential", "Client Pres", "Milestone 1", "Milestone 2", "Status", "Lead"]);
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE6F4EA" } };
    cell.border = { bottom: { style: "thin" } };
    cell.alignment = { vertical: "middle", wrapText: true };
  });

  const toneFill: Record<string, string> = { missed: "FFFDE2E1", soon: "FFFFF4D6", ok: "FFE6F4EA", done: "FFE6F4EA" };
  for (const r of rows) {
    const status = r.note ? `${r.status.text}\n${r.note}` : r.status.text;
    const row = sheet.addRow([
      brandLabel(r),
      r.title,
      fmtRevenue(r),
      fmtDate(r.clientPresentation),
      fmtDate(r.milestone1),
      fmtDate(r.milestone2),
      status,
      r.leads.map((l) => l.name).join(", "),
    ]);
    row.alignment = { vertical: "top", wrapText: true };
    row.getCell(7).fill = { type: "pattern", pattern: "solid", fgColor: { argb: toneFill[r.status.tone] ?? "FFFFFFFF" } };
  }

  const t = totals(rows);
  const total = sheet.addRow([`${t.count} pitch${t.count === 1 ? "" : "es"}`, "", `AED ${t.revenue.toLocaleString("en-US")}`]);
  total.font = { bold: true };
  total.eachCell((cell) => (cell.border = { top: { style: "thin" } }));

  const filename = `Proactive & Pitches Status_${quarter.slice(5)}_${quarter.slice(0, 4)}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="Pitches_${quarter.slice(5)}_${quarter.slice(0, 4)}.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  res.setHeader("X-Export-Rows", String(rows.length));
  await wb.xlsx.write(res);
  res.end();
}
