import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { MANPOWER_ROLES } from "../manpowerRoles.js";
import type { ManpowerSection } from "../../models/ManpowerPlan.js";
import { matchBrand, parseCell, PersonIndex, type BrandRef, type PersonRef } from "./match.js";

// ---------------------------------------------------------------------------
// Reads one month sheet of the manpower planning workbook ("Sep 26"): a header
// row with "Brands/ Projects" followed by role columns, then one line per
// brand/project. A "PITCHES …" line starts the pitch section.
// ---------------------------------------------------------------------------

/** Sheet header → role key. */
const HEADER_ROLES: Array<[RegExp, string]> = [
  [/^program\s*lead/i, "programLead"],
  [/^s?pm\b|^spm\s*\/\s*pm/i, "pm"],
  [/^program\s*execution/i, "programExecution"],
  [/^social\s*media/i, "socialMedia"],
  [/^videographer/i, "videographer"],
  [/^junior\s*video/i, "juniorVideo"],
  [/^editor/i, "editor"],
  [/^creative\s*lead/i, "creativeLead"],
  [/^english\s*copy/i, "englishCopy"],
  [/^arabic\s*copy/i, "arabicCopy"],
  [/^art(\s*director)?$/i, "artDirector"],
  [/^design(er)?$/i, "designer"],
  [/^animator/i, "animator"],
  [/^producer/i, "producer"],
  [/^production lead/i, "producer"],
  [/^cm\s*lead/i, "cmLead"],
  [/^community\s*manager/i, "communityManager"],
];

export interface SheetRow {
  key: string;
  section: ManpowerSection;
  brand: string | null;
  type: null;
  name: string;
  cells: Array<{ role: string; users: string[]; placeholders: string[]; notNeeded: boolean; note: string }>;
}

export interface SheetResult {
  rows: SheetRow[];
  /** Header columns that aren't plan roles (ignored). */
  ignoredColumns: string[];
  /** Plan lines whose brand couldn't be found. */
  unbrandedRows: string[];
  /** Name → how often it was written without matching a user. */
  unmatchedNames: Map<string, number>;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "object") {
    const v = value as { result?: unknown; text?: unknown; richText?: Array<{ text: string }> };
    if (v.richText) return v.richText.map((t) => t.text).join("");
    if (v.result != null) return String(v.result);
    if (v.text != null) return String(v.text);
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return "";
  }
  return String(value);
}

const tidy = (s: string) => s.replace(/\s+/g, " ").trim();

export async function readPlanSheet(
  file: string,
  sheetName: string,
  people: PersonRef[],
  brands: BrandRef[]
): Promise<SheetResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) throw new Error(`Sheet "${sheetName}" not found. Sheets: ${wb.worksheets.map((w) => w.name).join(", ")}`);

  // Header row: the one with "Brands/ Projects".
  let headerRow = 0;
  let nameCol = 0;
  for (let r = 1; r <= Math.min(ws.rowCount, 15) && !headerRow; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= ws.columnCount; c++) {
      if (/brands\s*\/\s*projects/i.test(tidy(cellText(row.getCell(c).value)))) {
        headerRow = r;
        nameCol = c;
        break;
      }
    }
  }
  if (!headerRow) throw new Error(`No "Brands/ Projects" header in sheet "${sheetName}"`);

  const roleCols: Array<{ col: number; role: string }> = [];
  const ignoredColumns: string[] = [];
  const header = ws.getRow(headerRow);
  for (let c = nameCol + 1; c <= ws.columnCount; c++) {
    const label = tidy(cellText(header.getCell(c).value));
    if (!label) continue;
    const hit = HEADER_ROLES.find(([re]) => re.test(label));
    if (hit && !roleCols.some((rc) => rc.role === hit[1])) roleCols.push({ col: c, role: hit[1] });
    else ignoredColumns.push(label);
  }

  const index = new PersonIndex(people);
  const order = new Map<string, number>(MANPOWER_ROLES.map((r, i) => [r.key, i]));
  const rows: SheetRow[] = [];
  const unbrandedRows: string[] = [];
  const unmatchedNames = new Map<string, number>();
  let section: ManpowerSection = "active";

  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const name = tidy(cellText(row.getCell(nameCol).value));
    if (!name) continue;
    if (/^pitch/i.test(name)) {
      section = "pitch";
      continue;
    }
    const cells: SheetRow["cells"] = [];
    for (const { col, role } of roleCols) {
      const parsed = parseCell(cellText(row.getCell(col).value), index);
      if (!parsed) continue;
      for (const u of parsed.unmatched) unmatchedNames.set(u, (unmatchedNames.get(u) ?? 0) + 1);
      cells.push({ role, users: parsed.users, placeholders: parsed.placeholders, notNeeded: parsed.notNeeded, note: parsed.note });
    }
    cells.sort((a, b) => order.get(a.role)! - order.get(b.role)!);
    const brand = matchBrand(name, brands);
    if (!brand) unbrandedRows.push(name);
    rows.push({ key: randomUUID(), section, brand, type: null, name: name.slice(0, 120), cells });
  }
  return { rows, ignoredColumns, unbrandedRows, unmatchedNames };
}
