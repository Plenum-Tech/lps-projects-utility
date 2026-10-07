import "dotenv/config";
import { existsSync } from "node:fs";
import ExcelJS from "exceljs";
import mongoose from "mongoose";
import { connectDB, disconnectDB } from "../db/index.js";
import { Brand, BRAND_COLORS, BRAND_LIMITS, brandNameKey, type BrandColor } from "../models/Brand.js";
import { Project } from "../models/Project.js";

/**
 * Step 2 of "brands from project names" (step 1: bun run brands:suggest).
 *
 *   bun run brands:apply -- --in <brand-review.xlsx> [--dry-run] --confirm
 *
 * - Reads Projects.FINAL_BRAND per project_id, after applying Brands.rename_to
 *   (case-insensitive on the brand name). Blank FINAL_BRAND → project brand cleared.
 * - Creates missing Brand docs (theme colours round-robin); reuses existing ones by
 *   name (case-insensitive). Never deletes brands.
 * - Idempotent: projects already on the target brand are left untouched.
 * - Refuses to run without --confirm; prints the target database first.
 */

/** Distinct, non-alarming theme tokens for new brands ("destructive"/"muted" read as error/disabled). */
const PALETTE: BrandColor[] = BRAND_COLORS.filter((c) => c !== "destructive" && c !== "muted");

interface Args {
  in?: string;
  dryRun: boolean;
  confirm: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, confirm: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (a === "--in") {
      const v = argv[++i];
      if (!v) throw new Error("--in needs a value");
      args.in = v;
    } else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--confirm") args.confirm = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

/** Plain text of an exceljs cell (rich text, formula results, hyperlinks, numbers). */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) return value.richText.map((r) => r.text).join("");
    if ("result" in value) return cellText((value as { result?: ExcelJS.CellValue }).result ?? null);
    if ("text" in value) return String((value as { text: unknown }).text ?? "");
  }
  return "";
}

const tidy = (s: string) => s.replace(/[​-‍﻿ ]/g, " ").replace(/\s+/g, " ").trim();
const ciKey = (s: string) => tidy(s).toLowerCase();

function headerIndex(ws: ExcelJS.Worksheet): Map<string, number> {
  const map = new Map<string, number>();
  ws.getRow(1).eachCell((cell, col) => map.set(tidy(cellText(cell.value)).toLowerCase(), col));
  return map;
}

async function readSheet(file: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ps = wb.getWorksheet("Projects");
  if (!ps) throw new Error('Sheet "Projects" not found');
  const ph = headerIndex(ps);
  const idCol = ph.get("project_id");
  const finalCol = ph.get("final_brand");
  if (!idCol || !finalCol) throw new Error('"Projects" needs project_id and FINAL_BRAND columns');

  const renames = new Map<string, string>();
  const bs = wb.getWorksheet("Brands");
  if (bs) {
    const bh = headerIndex(bs);
    const fromCol = bh.get("suggested_brand");
    const toCol = bh.get("rename_to");
    if (fromCol && toCol) {
      bs.eachRow((row, n) => {
        if (n === 1) return;
        const from = tidy(cellText(row.getCell(fromCol).value));
        const to = tidy(cellText(row.getCell(toCol).value));
        if (from && to) renames.set(ciKey(from), to);
      });
    }
  }

  const rows: Array<{ line: number; id: string; brand: string }> = [];
  ps.eachRow((row, n) => {
    if (n === 1) return;
    const id = tidy(cellText(row.getCell(idCol).value));
    const raw = tidy(cellText(row.getCell(finalCol).value));
    if (!id && !raw) return;
    rows.push({ line: n, id, brand: raw ? (renames.get(ciKey(raw)) ?? raw) : "" });
  });
  return { rows, renames };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.in) {
    console.error("Usage: bun run brands:apply -- --in <brand-review.xlsx> [--dry-run] --confirm");
    return 2;
  }
  if (!existsSync(args.in)) {
    console.error(`Workbook not found: ${args.in}`);
    return 2;
  }
  const { rows, renames } = await readSheet(args.in);

  await connectDB();
  const conn = mongoose.connection;
  console.log(`Target database: "${conn.name}" on ${conn.host}:${conn.port}${args.dryRun ? " (DRY RUN — nothing is written)" : ""}`);
  if (!args.confirm) {
    console.error("Refusing to run without --confirm. Check the target above, then re-run with --confirm.");
    return 2;
  }
  if (!args.dryRun) await Brand.init(); // unique (case-insensitive) nameKey index

  // Validate rows; last row wins for a repeated project_id.
  const errors: string[] = [];
  const target = new Map<string, string>(); // projectId → brand name ("" = none)
  let duplicates = 0;
  for (const r of rows) {
    if (!mongoose.isValidObjectId(r.id) || !/^[0-9a-f]{24}$/i.test(r.id)) {
      errors.push(`row ${r.line}: invalid project_id`);
      continue;
    }
    if (r.brand.length > BRAND_LIMITS.nameMax) {
      errors.push(`row ${r.line}: brand name longer than ${BRAND_LIMITS.nameMax} characters`);
      continue;
    }
    if (target.has(r.id)) duplicates += 1;
    target.set(r.id, r.brand);
  }

  // Brands: reuse existing (case-insensitive), create the rest.
  const existing = await Brand.find({}).select("_id name active").lean();
  const byName = new Map(existing.map((b) => [ciKey(b.name), b]));
  const wanted = new Map<string, string>(); // ci key → first spelling seen
  for (const name of target.values()) if (name && !wanted.has(ciKey(name))) wanted.set(ciKey(name), name);
  const brandId = new Map<string, mongoose.Types.ObjectId | null>(); // ci key → id (null in dry run for new)
  let reused = 0;
  let reusedInactive = 0;
  let created = 0;
  let colorIndex = existing.length;
  for (const [key, name] of wanted) {
    const hit = byName.get(key);
    if (hit) {
      reused += 1;
      if (hit.active === false) reusedInactive += 1;
      brandId.set(key, hit._id as mongoose.Types.ObjectId);
      continue;
    }
    created += 1;
    const color = PALETTE[colorIndex++ % PALETTE.length];
    if (args.dryRun) {
      brandId.set(key, null);
      continue;
    }
    try {
      const doc = await Brand.create({ name, nameKey: brandNameKey(name), color, active: true });
      brandId.set(key, doc._id as mongoose.Types.ObjectId);
    } catch (error) {
      // Created concurrently (duplicate key) → reuse it.
      const again = await Brand.findOne({ nameKey: brandNameKey(name) }).select("_id").lean();
      if (!again) throw error;
      created -= 1;
      reused += 1;
      brandId.set(key, again._id as mongoose.Types.ObjectId);
    }
  }

  // Projects.
  const ids = [...target.keys()].map((id) => new mongoose.Types.ObjectId(id));
  const projects = await Project.find({ _id: { $in: ids } }).select("_id brand").lean();
  const current = new Map(projects.map((p) => [String(p._id), p.brand ? String(p.brand) : ""]));
  let notFound = 0;
  let set = 0;
  let cleared = 0;
  let unchanged = 0;
  const ops: Parameters<typeof Project.bulkWrite>[0] = [];
  for (const [id, name] of target) {
    if (!current.has(id)) {
      notFound += 1;
      continue;
    }
    const before = current.get(id) ?? "";
    if (!name) {
      if (!before) unchanged += 1;
      else {
        cleared += 1;
        ops.push({ updateOne: { filter: { _id: new mongoose.Types.ObjectId(id) }, update: { $set: { brand: null } } } });
      }
      continue;
    }
    const bid = brandId.get(ciKey(name));
    if (bid && String(bid) === before) {
      unchanged += 1;
      continue;
    }
    set += 1;
    if (bid) ops.push({ updateOne: { filter: { _id: new mongoose.Types.ObjectId(id) }, update: { $set: { brand: bid } } } });
  }
  if (!args.dryRun && ops.length) {
    for (let i = 0; i < ops.length; i += 500) await Project.bulkWrite(ops.slice(i, i + 500), { ordered: false });
  }

  const verb = args.dryRun ? "would be " : "";
  console.log("");
  console.log(`Sheet rows: ${rows.length} (renames from Brands sheet: ${renames.size}, duplicate project rows: ${duplicates}, invalid: ${errors.length})`);
  for (const e of errors.slice(0, 20)) console.log(`  ${e}`);
  console.log(`Brands: ${wanted.size} referenced · ${reused} existing reused${reusedInactive ? ` (${reusedInactive} inactive)` : ""} · ${created} ${verb}created`);
  console.log(`Projects: ${set} ${verb}set · ${cleared} ${verb}cleared · ${unchanged} unchanged · ${notFound} not found`);
  if (!args.dryRun && (set || cleared || created)) {
    console.log("Note: a running API server picks this up within 60 s (Delivery Pulse cache TTL; it is in-process, so a script can't clear it). Restart the server to see it immediately.");
  }
  console.log(args.dryRun ? "Dry run complete — nothing was written." : "Done.");
  return errors.length ? 1 : 0;
}

main()
  .then(async (code) => {
    await disconnectDB().catch(() => undefined);
    process.exit(code);
  })
  .catch(async (error) => {
    const message = (error instanceof Error ? error.message : String(error)).replace(/dup key: \{.*?\}/g, "dup key: {…}");
    console.error("❌ brands:apply failed:", message);
    await disconnectDB().catch(() => undefined);
    process.exit(1);
  });
