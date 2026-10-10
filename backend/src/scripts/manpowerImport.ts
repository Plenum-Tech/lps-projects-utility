/**
 * Imports one month of the manpower planning workbook as a new plan version.
 *
 *   bun run manpower:import -- --file "<workbook.xlsx>" --sheet "Sep 26" --month 2026-09 [--dry-run]
 *
 * People are matched by name (first names, with a few known spellings); names
 * that match nobody stay on the plan as placeholders. Brands are matched from
 * the line ("ENOC - Zoom" → ZOOM). Admins fix the rest on the Manpower page.
 */
import "dotenv/config";
import { connectDB, disconnectDB } from "../db/index.js";
import { Brand } from "../models/Brand.js";
import { ManpowerPlan } from "../models/ManpowerPlan.js";
import { User } from "../models/User.js";
import { readPlanSheet } from "../lib/manpower/sheet.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const file = arg("file");
const sheet = arg("sheet");
const month = arg("month");
const dryRun = process.argv.includes("--dry-run");
if (!file || !sheet || !month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
  console.error('Usage: bun run manpower:import -- --file "<workbook.xlsx>" --sheet "Sep 26" --month 2026-09 [--dry-run]');
  process.exit(1);
}

await connectDB();
try {
  const [users, brands] = await Promise.all([
    User.find({}).select("name").lean(),
    Brand.find({}).select("name shortName active").lean(),
  ]);
  const result = await readPlanSheet(
    file,
    sheet,
    users.map((u) => ({ _id: String(u._id), name: u.name })),
    brands.map((b) => ({ _id: String(b._id), name: b.name, shortName: (b as { shortName?: string }).shortName }))
  );
  const brandName = new Map(brands.map((b) => [String(b._id), b.name]));
  const userName = new Map(users.map((u) => [String(u._id), u.name]));

  console.log(`Sheet "${sheet}" → ${month}: ${result.rows.length} lines (${result.rows.filter((r) => r.section === "pitch").length} pitches)`);
  for (const r of result.rows) {
    const people = new Set(r.cells.flatMap((c) => c.users));
    console.log(
      `  ${r.section === "pitch" ? "[pitch] " : ""}${r.name}  →  ${r.brand ? brandName.get(r.brand) : "NO BRAND"}  ·  ${people.size} people` +
        (people.size ? `: ${[...people].map((id) => userName.get(id)?.split(" ")[0]).join(", ")}` : "")
    );
  }
  if (result.ignoredColumns.length) console.log(`Ignored columns: ${result.ignoredColumns.join(", ")}`);
  if (result.unbrandedRows.length) console.log(`No brand found: ${result.unbrandedRows.join("; ")}`);
  if (result.unmatchedNames.size) {
    console.log(
      `Names with no user (kept as placeholders): ${[...result.unmatchedNames].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ×${c}`).join(", ")}`
    );
  }

  if (dryRun) {
    console.log("Dry run — nothing saved.");
  } else {
    const latest = await ManpowerPlan.findOne({ month }).sort({ version: -1 }).select("version").lean();
    const plan = await ManpowerPlan.create({
      month,
      version: (latest?.version ?? 0) + 1,
      rows: result.rows,
      note: `Imported from "${sheet}"`,
      source: "import",
      createdBy: null,
    });
    console.log(`Saved ${month} version ${plan.version}.`);
  }
} finally {
  await disconnectDB();
}
