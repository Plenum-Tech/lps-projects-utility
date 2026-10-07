import "dotenv/config";
import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import mongoose from "mongoose";
import { connectDB, disconnectDB } from "../db/index.js";
import { Project } from "../models/Project.js";
import { suggestBrands, type Confidence } from "../lib/worksuite/brandSuggest.js";

/**
 * Step 1 of "brands from project names" — READ-ONLY on the database.
 *
 *   bun run brands:suggest -- [--out <file.xlsx | dir>]
 *
 * Writes a review workbook (Projects / Brands / Instructions). Edit FINAL_BRAND
 * (and Brands.rename_to) in Excel, then run step 2:
 *   bun run brands:apply -- --in <file.xlsx> [--dry-run] --confirm
 * Prints aggregate stats only.
 */

const DEFAULT_DIR = "C:/Users/balap/Documents/projectutility";
const LOW_FILL = "FFFFF2CC"; // amber: low confidence
const NONE_FILL = "FFF8CBAD"; // salmon: no suggestion

const PROJECT_COLUMNS = [
  "project_id",
  "legacy_id",
  "project_name",
  "suggested_brand",
  "confidence",
  "reason",
  "FINAL_BRAND",
] as const;
const BRAND_COLUMNS = ["suggested_brand", "project_count", "rename_to", "segments_seen"] as const;

function parseArgs(argv: string[]): { out?: string } {
  const args: { out?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (a === "--out") {
      const v = argv[++i];
      if (!v) throw new Error("--out needs a value");
      args.out = v;
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function resolveOut(out: string | undefined): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = `brand-review-${stamp}.xlsx`;
  if (!out) return path.join(DEFAULT_DIR, file);
  if (existsSync(out) && statSync(out).isDirectory()) return path.join(out, file);
  return out.toLowerCase().endsWith(".xlsx") ? out : `${out}.xlsx`;
}

function styleSheet(ws: ExcelJS.Worksheet, columns: number): void {
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF2F7" } };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns } };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const outPath = resolveOut(args.out);

  await connectDB();
  const conn = mongoose.connection;
  console.log(`Source database: "${conn.name}" on ${conn.host}:${conn.port} (read-only)`);

  const docs = await Project.find({}).select("_id name legacy").sort({ createdAt: 1, _id: 1 }).lean();
  const projects = docs.map((d) => {
    const legacy = (d as unknown as { legacy?: { id?: unknown } }).legacy;
    return { id: String(d._id), legacyId: legacy?.id != null ? String(legacy.id) : "", name: d.name ?? "" };
  });
  const { rows, brands, learnedGeneric } = suggestBrands(projects);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Projects Utility — brands:suggest";
  wb.created = new Date();

  // Projects
  const ps = wb.addWorksheet("Projects");
  ps.columns = [
    { header: "project_id", key: "project_id", width: 27 },
    { header: "legacy_id", key: "legacy_id", width: 10 },
    { header: "project_name", key: "project_name", width: 60 },
    { header: "suggested_brand", key: "suggested_brand", width: 24 },
    { header: "confidence", key: "confidence", width: 12 },
    { header: "reason", key: "reason", width: 70 },
    { header: "FINAL_BRAND", key: "FINAL_BRAND", width: 26 },
  ];
  const order: Record<Confidence, number> = { none: 0, low: 1, medium: 2, high: 3 };
  const sorted = [...rows].sort(
    (a, b) => order[a.confidence] - order[b.confidence] || a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name)
  );
  for (const r of sorted) {
    const row = ps.addRow({
      project_id: r.id,
      legacy_id: r.legacyId,
      project_name: r.name,
      suggested_brand: r.brand,
      confidence: r.confidence,
      reason: r.reason,
      FINAL_BRAND: r.brand,
    });
    if (r.confidence === "low" || r.confidence === "none") {
      row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: r.confidence === "none" ? NONE_FILL : LOW_FILL } };
    }
  }
  ps.getColumn("FINAL_BRAND").font = { bold: true };
  styleSheet(ps, PROJECT_COLUMNS.length);
  ps.getRow(1).font = { bold: true };

  // Brands
  const bs = wb.addWorksheet("Brands");
  bs.columns = [
    { header: "suggested_brand", key: "suggested_brand", width: 28 },
    { header: "project_count", key: "project_count", width: 14 },
    { header: "rename_to", key: "rename_to", width: 28 },
    { header: "segments_seen", key: "segments_seen", width: 90 },
  ];
  for (const b of brands) {
    bs.addRow({ suggested_brand: b.brand, project_count: b.projects, rename_to: "", segments_seen: b.variants.join(" · ") });
  }
  styleSheet(bs, BRAND_COLUMNS.length);

  // Instructions
  const is = wb.addWorksheet("Instructions");
  is.getColumn(1).width = 120;
  const lines = [
    "Brand review — derived from project names",
    "",
    "Projects sheet",
    "• FINAL_BRAND is what will be applied. It is prefilled with suggested_brand — edit it freely.",
    "• Blank FINAL_BRAND = the project gets no brand (an existing brand on that project is cleared).",
    "• Amber rows = low confidence, salmon rows = no suggestion. Sorted none → low → medium → high.",
    "• Do not edit project_id (it identifies the project). Other columns are informational.",
    "",
    "Brands sheet",
    "• One row per suggested brand with the number of projects and the original name segments it came from.",
    "• Fill rename_to to rename/merge: every FINAL_BRAND equal to suggested_brand (case-insensitive) becomes rename_to.",
    "  Example: rename_to \"Ajmal Perfumes\" on the \"Ajmal\" row; or merge \"Hey Dude\" into \"Crocs\".",
    "• Leave rename_to blank to keep the name.",
    "",
    "Apply (step 2)",
    "• Save this file (keep .xlsx), then run in backend/:",
    "    bun run brands:apply -- --in \"<this file>\" --dry-run --confirm   (preview counts)",
    "    bun run brands:apply -- --in \"<this file>\" --confirm             (write)",
    "• Missing brands are created (theme colours assigned round-robin); existing brands are reused by name",
    "  (case-insensitive). Brands are never deleted. Re-running is safe (idempotent).",
    "",
    "How suggestions were made",
    "• Names are split on \"|\" (and clear separators like \" - \", \"_\", \"/\"); month/year/quarter tokens and generic",
    "  words (Program, Pitch, Project(s), 360 Social, Social Media, TikTok, Campaign, Influencers, …) are dropped,",
    "  as are market suffixes (KSA, MENA, US, UK, GCC…). The segment that recurs across most projects wins.",
    "• Variants are merged ignoring case/spaces/punctuation, and \"Brand X\" folds into a recurring \"Brand\".",
    `• Learned generic segments (ignored): ${learnedGeneric.length ? learnedGeneric.join(", ") : "none"}`,
    "• Onboarding/training/test/LPS-internal projects get no brand.",
  ];
  lines.forEach((text, i) => {
    const cell = is.getCell(i + 1, 1);
    cell.value = text;
    if (i === 0) cell.font = { bold: true, size: 14 };
    else if (["Projects sheet", "Brands sheet", "Apply (step 2)", "How suggestions were made"].includes(text)) cell.font = { bold: true };
  });

  await mkdir(path.dirname(outPath), { recursive: true });
  await wb.xlsx.writeFile(outPath);

  const byConfidence: Record<Confidence, number> = { high: 0, medium: 0, low: 0, none: 0 };
  for (const r of rows) byConfidence[r.confidence] += 1;
  console.log(`\nProjects: ${rows.length}`);
  console.log(`  high ${byConfidence.high} · medium ${byConfidence.medium} · low ${byConfidence.low} · none ${byConfidence.none}`);
  console.log(`Distinct suggested brands: ${brands.length} (${brands.filter((b) => b.projects >= 2).length} on 2+ projects)`);
  console.log(`Learned generic segments: ${learnedGeneric.join(", ") || "none"}`);
  console.log("Top brands:");
  for (const b of brands.slice(0, 30)) console.log(`  ${String(b.projects).padStart(4)}  ${b.brand}`);
  console.log(`\nReview sheet: ${outPath}`);
  return 0;
}

main()
  .then(async (code) => {
    await disconnectDB().catch(() => undefined);
    process.exit(code);
  })
  .catch(async (error) => {
    console.error("❌ brands:suggest failed:", error instanceof Error ? error.message : String(error));
    await disconnectDB().catch(() => undefined);
    process.exit(1);
  });
