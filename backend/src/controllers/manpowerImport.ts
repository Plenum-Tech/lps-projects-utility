import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type ExcelJS from "exceljs";
import multer from "multer";
import { isLeadershipActor } from "../lib/changeRequests.js";
import { lineNameKey } from "../lib/manpowerDedupe.js";
import { brandLineName } from "../lib/manpowerLineNames.js";
import { MANPOWER_LIMITS, MANPOWER_ROLES } from "../lib/manpowerRoles.js";
import { personNameKey } from "../lib/manpower/match.js";
import { listSheets, loadWorkbook, readPlanSheet, sheetForMonth, type SheetRow } from "../lib/manpower/sheet.js";
import { isInvalidObjectId } from "../lib/projectAccess.js";
import { Brand } from "../models/Brand.js";
import { APPROVED_PLAN, ManpowerPlan, type IManpowerRow, type ManpowerSection } from "../models/ManpowerPlan.js";
import { STAFF_FILTER, User } from "../models/User.js";
import { parseRows, writePlanVersion } from "./manpower.js";

// ---------------------------------------------------------------------------
// /api/manpower/import — a month of the planning workbook (.xlsx) into the plan,
// from the Manpower plan page (plan editors and leadership):
//   POST /import/sheets   file (+ month)                        → the workbook's sheets
//   POST /import/preview  file + sheet + month + mappings        → the lines, nothing saved
//   POST /import          file + sheet + month + mappings + note → the next version
// Stateless: the browser sends the file with each step (a planning workbook is a few
// hundred KB). The upload lives only in this request's memory — never stored — so it
// works the same on every server instance and nothing needs cleaning up.
// The import saves through writePlanVersion like an edit on the page: leadership's is
// approved at once (quietly; "Send email" later), anyone else's waits ("Send for approval").
// ---------------------------------------------------------------------------

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_BYTES = 10 * 1024 * 1024;

function fail(res: Response, status: number, error: string): void {
  res.status(status).json({ error });
}

// --- upload ------------------------------------------------------------------

class UnsupportedTypeError extends Error {}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 10, fieldSize: 256 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/\.xlsx$/i.test(file.originalname)) cb(null, true);
    else cb(new UnsupportedTypeError("Upload the planning workbook as an .xlsx file"));
  },
});

/** The `file` field (memory only); multipart errors → 413 / 415 / 400 JSON. */
export function manpowerImportUpload(req: Request, res: Response, next: NextFunction): void {
  upload.single("file")(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof UnsupportedTypeError) return fail(res, 415, err.message);
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") return fail(res, 413, "The file can be at most 10 MB");
      return fail(res, 400, err.message);
    }
    next(err);
  });
}

/** The uploaded workbook, or a 400 / 422 sent (null). */
async function workbookOf(req: Request, res: Response): Promise<ExcelJS.Workbook | null> {
  const file = req.file;
  if (!file?.buffer?.length) {
    fail(res, 400, "Choose the planning workbook (.xlsx)");
    return null;
  }
  // An .xlsx is a zip: "PK".
  if (file.buffer[0] !== 0x50 || file.buffer[1] !== 0x4b) {
    fail(res, 415, "This isn't an .xlsx workbook");
    return null;
  }
  try {
    return await loadWorkbook(file.buffer);
  } catch {
    fail(res, 422, "Couldn't read this workbook — save it again as .xlsx and retry");
    return null;
  }
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

// --- POST /import/sheets ---------------------------------------------------------

/** `file` (+ `month`, the page's month): the sheets, and the sheet + month to start with. */
export async function importSheets(req: Request, res: Response): Promise<void> {
  const wb = await workbookOf(req, res);
  if (!wb) return;
  const sheets = listSheets(wb);
  const pageMonth = MONTH.test(text(req.body?.month)) ? text(req.body.month) : null;
  // The page's month when the workbook has it; else the newest month sheet.
  let sheet = pageMonth ? sheetForMonth(sheets, pageMonth) : null;
  let month = sheet ? pageMonth : null;
  if (!sheet) {
    const newest = sheets
      .filter((s) => s.readable && s.month)
      .sort((a, b) => b.month!.localeCompare(a.month!) || Number(a.hidden) - Number(b.hidden) || a.name.length - b.name.length)[0];
    sheet = newest?.name ?? sheets.find((s) => s.readable)?.name ?? null;
    month = newest?.month ?? pageMonth;
  }
  res.json({ fileName: req.file!.originalname, sheets, suggested: { sheet, month } });
}

// --- preview / import ------------------------------------------------------------

interface Mappings {
  /** Sheet row number → brand id, or null = no brand. */
  brands: Map<number, string | null>;
  /** personNameKey(name) → user id, or null = keep as an open slot. */
  names: Map<string, string | null>;
}

function parseMappings(raw: unknown): Mappings | string {
  const out: Mappings = { brands: new Map(), names: new Map() };
  if (raw === undefined || raw === "") return out;
  let value: unknown;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return "mappings must be JSON";
  }
  const { brands = {}, names = {} } = (value ?? {}) as { brands?: unknown; names?: unknown };
  if (typeof brands !== "object" || typeof names !== "object" || !brands || !names) return "mappings must be { brands, names }";
  const brandEntries = Object.entries(brands as Record<string, unknown>);
  const nameEntries = Object.entries(names as Record<string, unknown>);
  if (brandEntries.length > MANPOWER_LIMITS.maxRows || nameEntries.length > 500) return "Too many mappings";
  for (const [line, id] of brandEntries) {
    const n = Number(line);
    if (!Number.isInteger(n) || n < 1) return "Invalid line in the brand mappings";
    if (id !== null && (typeof id !== "string" || isInvalidObjectId(id))) return "Invalid brand in the brand mappings";
    out.brands.set(n, id as string | null);
  }
  for (const [name, id] of nameEntries) {
    const key = personNameKey(name);
    if (!key || key.length > 80) return "Invalid name in the name mappings";
    if (id !== null && (typeof id !== "string" || isInvalidObjectId(id))) return "Invalid person in the name mappings";
    out.names.set(key, id as string | null);
  }
  return out;
}

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** Brands spelt (almost) like this one: the same letters, or one or two letters apart. */
function lookalikes(brand: { _id: string; name: string }, all: Array<{ _id: string; name: string }>): string[] {
  const a = squash(brand.name);
  if (a.length < 3) return [];
  return all
    .filter((o) => {
      if (o._id === brand._id) return false;
      const b = squash(o.name);
      if (a === b) return true;
      const shorter = Math.min(a.length, b.length);
      if (shorter < 5 || Math.abs(a.length - b.length) > 2) return false;
      return editDistance(a, b) <= (shorter >= 8 ? 2 : 1);
    })
    .map((o) => o.name);
}

/** A cell's content for comparing versions. */
function cellsSignature(row: Pick<IManpowerRow, "cells">): string {
  return JSON.stringify(
    [...row.cells]
      .map((c) => ({
        r: c.role,
        u: (c.users ?? []).map(String).sort(),
        p: [...(c.placeholders ?? [])].map((p) => p.toLowerCase()).sort(),
        x: Boolean(c.notNeeded),
        n: c.note ?? "",
      }))
      .sort((x, y) => x.r.localeCompare(y.r))
  );
}

type Warning = { kind: "no_brand" | "brand_pending" | "brand_lookalike" | "unknown_names" | "same_line"; text: string };

interface Built {
  month: string;
  sheet: string;
  rows: IManpowerRow[];
  base: { version: number; status: "approved" | "pending"; maxProjectsPerPerson: number } | null;
  approvedVersion: number | null;
  baseRows: IManpowerRow[];
  savesApproved: boolean;
  preview: Record<string, unknown>;
}

/**
 * Reads the sheet with the mappings applied and lines it up with the month's current
 * version (the base): lines already on the plan keep their key and name (same brand and
 * line name, else a brand's only line), so the new version shows only what really changed
 * and projects linked to those lines stay linked.
 */
async function buildImport(req: Request, res: Response, wb: ExcelJS.Workbook): Promise<Built | null> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const sheet = text(body.sheet);
  const month = text(body.month);
  if (!sheet) return void fail(res, 400, "Pick a sheet"), null;
  if (!MONTH.test(month)) return void fail(res, 400, "month must be YYYY-MM"), null;
  const mappings = parseMappings(body.mappings);
  if (typeof mappings === "string") return void fail(res, 400, mappings), null;

  const [users, brands] = await Promise.all([
    User.find(STAFF_FILTER).select("name").lean(),
    Brand.find({ status: { $ne: "rejected" } }).select("name shortName status active organisation").lean(),
  ]);
  const userName = new Map(users.map((u) => [String(u._id), u.name]));
  const brandById = new Map(brands.map((b) => [String(b._id), b]));
  for (const id of mappings.names.values()) {
    if (id && !userName.has(id)) return void fail(res, 400, "A person picked for a name isn't in the app"), null;
  }
  for (const id of mappings.brands.values()) {
    const b = id ? brandById.get(id) : null;
    if (id && (!b || (b.status ?? "approved") !== "approved")) return void fail(res, 400, "A brand picked for a line isn't an approved brand"), null;
  }

  let result;
  try {
    result = await readPlanSheet(
      wb,
      sheet,
      users.map((u) => ({ _id: String(u._id), name: u.name })),
      brands.map((b) => ({ _id: String(b._id), name: b.name, shortName: b.shortName })),
      mappings.names
    );
  } catch (err) {
    return void fail(res, 422, (err as Error).message.replace(/\. Sheets: .*/, "")), null;
  }
  if (result.rows.length === 0) return void fail(res, 422, `No plan lines in sheet "${sheet}"`), null;
  if (result.rows.length > MANPOWER_LIMITS.maxRows) return void fail(res, 422, `The sheet has more than ${MANPOWER_LIMITS.maxRows} lines`), null;

  // Brand per line: the automatic match unless picked by hand.
  const sheetRows: Array<SheetRow & { brandAuto: boolean }> = result.rows.map((r) => {
    const picked = mappings.brands.has(r.line);
    return { ...r, brand: picked ? mappings.brands.get(r.line)! : r.brand, brandAuto: !picked };
  });

  // The base: leadership builds on the approved plan; anyone else on the version waiting
  // for approval when there is one (the import replaces what it holds).
  const savesApproved = await isLeadershipActor(req.user!);
  const [approved, pending] = await Promise.all([
    ManpowerPlan.findOne({ month, ...APPROVED_PLAN }).sort({ version: -1 }).select("version status rows maxProjectsPerPerson").lean(),
    ManpowerPlan.findOne({ month, status: "pending" }).sort({ version: -1 }).select("version status rows maxProjectsPerPerson").lean(),
  ]);
  const baseDoc = !savesApproved && pending ? pending : approved;
  const baseRows = (baseDoc?.rows ?? []) as IManpowerRow[];
  const brandOf = (r: { brand?: unknown }) => (r.brand ? String(r.brand) : null);

  // Line up with the base.
  const used = new Set<string>();
  const finalName = (r: SheetRow) => {
    const b = r.brand ? brandById.get(r.brand) : null;
    return b ? brandLineName(r.name, b.name, (b as { organisation?: string }).organisation ?? "") : r.name;
  };
  const matchOf = new Map<number, IManpowerRow>();
  for (const r of sheetRows) {
    const key = lineNameKey(finalName(r));
    const hit = baseRows.find((b) => !used.has(b.key) && brandOf(b) === r.brand && lineNameKey(b.name) === key);
    if (hit) {
      used.add(hit.key);
      matchOf.set(r.line, hit);
    }
  }
  const countBy = <T>(list: T[], f: (x: T) => string | null) => {
    const m = new Map<string, number>();
    for (const x of list) {
      const k = f(x);
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const sheetPerBrand = countBy(sheetRows, (r) => r.brand);
  const basePerBrand = countBy(baseRows, brandOf);
  for (const r of sheetRows) {
    if (matchOf.has(r.line) || !r.brand || sheetPerBrand.get(r.brand) !== 1 || basePerBrand.get(r.brand) !== 1) continue;
    const hit = baseRows.find((b) => !used.has(b.key) && brandOf(b) === r.brand);
    if (hit) {
      used.add(hit.key);
      matchOf.set(r.line, hit);
    }
  }

  // A new line's key comes from the month, section, brand and name: importing the same sheet
  // again (or by two people) gives the same keys, so their versions line up instead of doubling.
  const newKey = (r: SheetRow) =>
    `imp-${createHash("sha1").update(`${month}|${r.section}|${r.brand ?? ""}|${lineNameKey(finalName(r))}`).digest("hex").slice(0, 32)}`;
  const slice = (list: string[], n: number) => list.slice(0, n);
  const input = sheetRows.map((r) => {
    const hit = matchOf.get(r.line);
    return {
      key: hit?.key ?? newKey(r),
      section: r.section,
      brand: r.brand,
      type: hit?.type ?? null,
      // A matched line keeps its name, tidied by the same brand rule ("AutoPro - ENOC - Autopro" → "AutoPro").
      name: (hit && r.brand && brandById.get(r.brand) ? brandLineName(hit.name, brandById.get(r.brand)!.name, (brandById.get(r.brand) as { organisation?: string }).organisation ?? "") : hit ? hit.name : finalName(r)).slice(0, MANPOWER_LIMITS.nameMax),
      cells: r.cells.map((c) => ({
        role: c.role,
        users: slice(c.users, MANPOWER_LIMITS.maxUsersPerCell),
        placeholders: slice(
          c.placeholders.map((p) => p.slice(0, MANPOWER_LIMITS.placeholderMax)),
          MANPOWER_LIMITS.maxPlaceholdersPerCell
        ),
        notNeeded: c.notNeeded,
        note: c.note.slice(0, MANPOWER_LIMITS.noteMax),
      })),
    };
  });
  const rows = await parseRows(input);
  if (!Array.isArray(rows)) return void fail(res, rows.status, rows.error), null;

  // Preview lines.
  const unmatchedKeys = new Set([...result.unmatchedNames.keys()].map(personNameKey));
  const sameLine = countBy(rows, (r) => (r.brand ? `${String(r.brand)}|${lineNameKey(r.name)}` : null));
  const baseByKey = new Map(baseRows.map((b) => [b.key, b]));
  let changed = 0;
  let added = 0;
  const lines = rows.map((row, i) => {
    const r = sheetRows[i]!;
    const brand = r.brand ? brandById.get(r.brand) : null;
    const warnings: Warning[] = [];
    if (!brand) warnings.push({ kind: "no_brand", text: "No brand found" });
    else {
      if ((brand.status ?? "approved") === "pending") warnings.push({ kind: "brand_pending", text: "Matched to a brand waiting for approval" });
      const alike = lookalikes({ _id: String(brand._id), name: brand.name }, brands.map((b) => ({ _id: String(b._id), name: b.name })));
      if (alike.length) warnings.push({ kind: "brand_lookalike", text: `Possible duplicate brand: ${[brand.name, ...alike].join(" / ")}` });
    }
    const unknown = [...new Set(row.cells.flatMap((c) => c.placeholders).filter((p) => unmatchedKeys.has(personNameKey(p))))];
    // A name that fits several people ("Nabil": Omar Nabil, Mohamed Nabil) says so — pick one in the names list.
    for (const name of unknown) {
      const key = personNameKey(name);
      const fits = users.filter((u) => personNameKey(u.name).split(" ").includes(key)).map((u) => u.name);
      warnings.push({
        kind: "unknown_names",
        text: fits.length > 1 ? `${name} could be ${fits.join(" or ")} — pick one in the names list` : `No user for ${name}`,
      });
    }
    if (row.brand && (sameLine.get(`${String(row.brand)}|${lineNameKey(row.name)}`) ?? 0) > 1) {
      warnings.push({ kind: "same_line", text: "Another line has the same brand and name — only one of them is kept. Pick another brand for one." });
    }
    const before = baseByKey.get(row.key);
    let status: "added" | "changed" | "same" = "added";
    if (before) {
      status = before.section !== row.section || cellsSignature(before) !== cellsSignature(row) ? "changed" : "same";
    }
    if (status === "added") added++;
    if (status === "changed") changed++;
    return {
      line: r.line,
      sheetName: r.name,
      name: row.name,
      section: row.section as ManpowerSection,
      brand: brand ? { _id: String(brand._id), name: brand.name, status: brand.status ?? "approved" } : null,
      brandAuto: r.brandAuto,
      status,
      cells: row.cells.map((c) => ({
        role: c.role,
        people: c.users.map((u) => ({ _id: String(u), name: userName.get(String(u)) ?? "?" })),
        slots: c.placeholders.map((p) => ({ label: p, unknown: unmatchedKeys.has(personNameKey(p)) })),
        notNeeded: c.notNeeded,
        note: c.note,
      })),
      warnings,
    };
  });
  const keep = new Set(rows.map((r) => r.key));
  const removedLines = baseRows.filter((b) => !keep.has(b.key)).map((b) => b.name);
  const people = new Set(rows.flatMap((r) => r.cells.flatMap((c) => c.users.map(String))));

  return {
    month,
    sheet,
    rows,
    base: baseDoc
      ? {
          version: baseDoc.version,
          status: baseDoc.status === "pending" ? "pending" : "approved",
          maxProjectsPerPerson: baseDoc.maxProjectsPerPerson ?? MANPOWER_LIMITS.defaultMaxProjectsPerPerson,
        }
      : null,
    approvedVersion: approved?.version ?? null,
    baseRows,
    savesApproved,
    preview: {
      month,
      sheet,
      roles: MANPOWER_ROLES,
      lines,
      names: [...result.unmatchedNames]
        .map(([name, count]) => ({ key: personNameKey(name), name, count }))
        .reduce<Array<{ key: string; name: string; count: number }>>((acc, n) => {
          const same = acc.find((x) => x.key === n.key);
          if (same) same.count += n.count;
          else acc.push(n);
          return acc;
        }, [])
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        // People the name could be ("Nabil" → Omar Nabil, Mohamed Nabil): the dialog asks to pick one.
        .map((n) => ({
          ...n,
          candidates: users
            .filter((u) => personNameKey(u.name).split(" ").includes(n.key))
            .map((u) => ({ _id: String(u._id), name: u.name })),
        })),
      ignoredColumns: result.ignoredColumns,
      summary: {
        lines: rows.length,
        pitches: rows.filter((r) => r.section === "pitch").length,
        people: people.size,
        openSlots: rows.reduce((n, r) => n + r.cells.reduce((m, c) => m + c.placeholders.length, 0), 0),
        noBrand: lines.filter((l) => !l.brand).length,
        warnings: lines.filter((l) => l.warnings.length).length,
      },
      base: baseDoc ? { version: baseDoc.version, status: baseDoc.status === "pending" ? "pending" : "approved" } : null,
      diff: { changed, added, removed: removedLines.length, same: rows.length - changed - added, removedLines },
      savesApproved,
      nextVersion: ((await ManpowerPlan.findOne({ month }).sort({ version: -1 }).select("version").lean())?.version ?? 0) + 1,
    },
  };
}

/** POST /import/preview — the sheet's lines as they would be saved; nothing is saved. */
export async function importPreview(req: Request, res: Response): Promise<void> {
  const wb = await workbookOf(req, res);
  if (!wb) return;
  const built = await buildImport(req, res, wb);
  if (built) res.json(built.preview);
}

/**
 * POST /import — saves the sheet as the month's next version (as the signed-in user).
 * `baseVersion`: the version the preview was compared with ("" = none); a save in
 * between returns 409 so the preview is looked at again.
 */
export async function importPlan(req: Request, res: Response): Promise<void> {
  const wb = await workbookOf(req, res);
  if (!wb) return;
  const built = await buildImport(req, res, wb);
  if (!built) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const expected = text(body.baseVersion) === "" ? null : Number(text(body.baseVersion));
  if (body.baseVersion !== undefined && expected !== (built.base?.version ?? null)) {
    fail(res, 409, "The plan for this month changed since the preview. Check the preview again, then import.");
    return;
  }
  const diff = built.preview.diff as { changed: number; added: number; removed: number };
  if (built.base && diff.changed + diff.added + diff.removed === 0) {
    fail(res, 409, `Nothing to import — the sheet matches version ${built.base.version}`);
    return;
  }
  const extra = text(body.note);
  const fileName = (req.file!.originalname ?? "workbook.xlsx").replace(/[\r\n]+/g, " ").slice(0, 120);
  const note = `Imported from ${fileName} · ${built.sheet}${extra ? ` — ${extra}` : ""}`.slice(0, MANPOWER_LIMITS.versionNoteMax);
  try {
    const saved = await writePlanVersion({
      month: built.month,
      before: built.baseRows,
      latestVersion: built.approvedVersion,
      baseVersion: built.base?.version ?? null,
      rows: built.rows,
      note,
      maxProjectsPerPerson: built.base?.maxProjectsPerPerson ?? MANPOWER_LIMITS.defaultMaxProjectsPerPerson,
      source: "import",
      actor: req.user!,
      ip: req.ip,
    });
    res.status(201).json({
      month: built.month,
      version: saved.version,
      status: saved.pendingApproval ? "pending" : "approved",
      ...(saved.pendingApproval ? { pendingApproval: saved.pendingApproval } : {}),
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      fail(res, 409, "Someone saved this month at the same moment. Check the preview again, then import.");
      return;
    }
    throw err;
  }
}
