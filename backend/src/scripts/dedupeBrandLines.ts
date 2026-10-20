import "dotenv/config";
import mongoose from "mongoose";
import { connectDB, disconnectDB } from "../db/index.js";
import { rebasePendingPlan } from "../controllers/manpower.js";
import { isLeadershipActor } from "../lib/changeRequests.js";
import { dedupeBrandLines, lastChangedVersion } from "../lib/manpowerDedupe.js";
import { cloneRow } from "../lib/manpowerMerge.js";
import { MANPOWER_LIMITS, MANPOWER_ROLE_KEYS } from "../lib/manpowerRoles.js";
import { projectMonth } from "../lib/projectExpiry.js";
import { Brand } from "../models/Brand.js";
import { APPROVED_PLAN, ManpowerPlan, type IManpowerRow } from "../models/ManpowerPlan.js";
import { Project } from "../models/Project.js";
import { User, type IUser } from "../models/User.js";

/**
 * Run by hand only (nothing in the app or the deploy calls it); dry run by default.
 *
 * Reports (and with --apply, fixes) months where a brand has several plan lines of the
 * SAME name (differently named lines, e.g. ENOC - Tasjeel / ENOC - EPPCO, stay) by keeping
 * only the most recently EDITED one — the line whose name or people changed in the latest
 * plan version (a tie: the later line in row order) — with its own people.
 *
 *   bun src/scripts/dedupeBrandLines.ts --month 2027-03                 # dry run (default)
 *   bun src/scripts/dedupeBrandLines.ts --all-months                    # dry run, every month
 *   bun src/scripts/dedupeBrandLines.ts --month 2027-03 --apply --by <leadership email>
 *
 * --apply writes ONE new approved version (source "edit"), re-pins projects pinned to a
 * dropped line to the brand's kept line, and rebases a pending version on it. Project
 * teams are not changed by the script.
 */

interface Args {
  months: string[];
  all: boolean;
  apply: boolean;
  by: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { months: [], all: false, apply: false, by: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") continue;
    if (a === "--apply") out.apply = true;
    else if (a === "--dry-run") out.apply = false;
    else if (a === "--all-months") out.all = true;
    else if (a === "--month") out.months.push(argv[++i] ?? "");
    else if (a === "--by") out.by = (argv[++i] ?? "").trim().toLowerCase();
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!out.all && !out.months.length) throw new Error("--month YYYY-MM (or --all-months) is required");
  for (const m of out.months) if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new Error(`Bad month "${m}" (YYYY-MM)`);
  if (out.apply && !out.by) throw new Error("--apply needs --by <leadership user's email>");
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await connectDB();
  const conn = mongoose.connection;
  console.log(`Target database: "${conn.name}"${args.apply ? "" : "  (DRY RUN — nothing is written; add --apply --by <email> to write)"}`);

  let actor: IUser | null = null;
  if (args.apply) {
    actor = await User.findOne({ email: args.by });
    if (!actor) throw new Error(`No user with email ${args.by}`);
    if (!(await isLeadershipActor(actor))) throw new Error(`${args.by} is not leadership: the new version must be written by leadership`);
    console.log(`Writing as ${actor.name}`);
  }

  const [brands, users] = await Promise.all([Brand.find({}).select("name").lean(), User.find({}).select("name").lean()]);
  const brandName = new Map(brands.map((b) => [String(b._id), b.name]));
  const userName = new Map(users.map((u) => [String(u._id), u.name]));
  const months = args.all ? ((await ManpowerPlan.distinct("month")) as string[]).sort() : args.months;
  let total = 0;
  for (const month of months) total += await runMonth(month, args, actor, { brandName, userName });
  console.log(`\n${args.apply ? "Done" : "Dry run done"}: ${total} brand(s) ${args.apply ? "fixed" : "to fix"} in ${months.length} month(s).`);
}

type Ctx = { brandName: Map<string, string>; userName: Map<string, string> };

async function runMonth(month: string, args: Args, actor: IUser | null, ctx: Ctx): Promise<number> {
  const { brandName, userName } = ctx;
  console.log(`\n=================== ${month}`);
  const approved = await ManpowerPlan.findOne({ month, ...APPROVED_PLAN }).sort({ version: -1 }).lean();
  const pending = await ManpowerPlan.findOne({ month, status: "pending" }).sort({ version: -1 }).lean();
  if (!approved) {
    console.log(`No approved version${pending ? ` (pending v${pending.version} left as it is)` : ""} — skipped.`);
    return 0;
  }
  console.log(`Latest approved: v${approved.version} (${approved.rows.length} lines)${pending ? `; pending: v${pending.version} (base v${pending.baseVersion ?? "?"})` : ""}`);
  const approvedRows = (approved.rows as IManpowerRow[]).map(cloneRow);
  const people = (r: IManpowerRow) => {
    const parts = r.cells
      .filter((c) => (c.users ?? []).length && MANPOWER_ROLE_KEYS.includes(c.role))
      .map((c) => `${c.role}: ${c.users.map((u) => (userName.get(String(u)) ?? "?").split(" ")[0]).join("/")}`);
    return parts.length ? parts.join(", ") : "(nobody)";
  };

  // The dedupe (of a brand's same-named lines, the one edited most recently is kept).
  const firstSeen = await lastChangedVersion(month);
  const { rows, dropped } = dedupeBrandLines(approvedRows.map(cloneRow), { firstSeen, brandNames: brandName });
  const byKey = new Map(approvedRows.map((r) => [r.key, r]));
  for (const d of dropped) {
    console.log(`
  ${brandName.get(d.brand) ?? d.brand}: ${d.droppedKeys.length + 1} lines -> 1`);
    console.log(`    KEEP  "${d.keptName}" [${d.keptKey}] last changed v${firstSeen.get(d.keptKey) ?? "new"} - ${people(byKey.get(d.keptKey)!)}`);
    for (const k of d.droppedKeys) console.log(`    DROP  "${byKey.get(k)!.name}" [${k}] last changed v${firstSeen.get(k) ?? "new"} - ${people(byKey.get(k)!)}`);
  }
  if (!dropped.length) {
    console.log("  No brand has more than one line.");
    return 0;
  }

  // Projects pinned to a dropped line → the brand's kept line (project teams are not changed).
  const repin = new Map<string, string>();
  for (const d of dropped) for (const k of d.droppedKeys) repin.set(k, d.keptKey);
  const projects = (await Project.find({ archivedAt: null, manpowerRow: { $in: [...repin.keys()] } }).select("name code naming deadline manpowerRow").lean()).filter(
    (p) => projectMonth({ name: p.name, naming: p.naming as never, deadline: p.deadline ?? null } as never) === month
  );
  console.log(`
  Projects to re-pin: ${projects.length || "none"}`);
  for (const p of projects) console.log(`    ${p.code} ${p.name}: [${p.manpowerRow}] -> [${repin.get(p.manpowerRow!)}]`);
  if (pending) console.log(`
  Pending v${pending.version} would be rebased on the new version (its own changes kept).`);

  const note = `No duplicate lines (kept the latest edited line of ${dropped.length} brand${dropped.length === 1 ? "" : "s"})`.slice(0, MANPOWER_LIMITS.versionNoteMax);
  const highest = await ManpowerPlan.findOne({ month }).sort({ version: -1 }).select("version").lean();
  console.log(`
  Would write v${(highest?.version ?? 0) + 1} (approved): ${rows.length} lines (${approvedRows.length} before) - "${note}"`);
  if (!args.apply || !actor) return dropped.length;

  const saved = await ManpowerPlan.create({
    month,
    version: (highest?.version ?? 0) + 1,
    rows,
    note,
    maxProjectsPerPerson: approved.maxProjectsPerPerson,
    source: "edit",
    status: "approved",
    createdBy: actor._id,
  });
  console.log(`  Wrote v${saved.version} (${String(saved._id)}).`);
  for (const p of projects) await Project.updateOne({ _id: p._id }, { $set: { manpowerRow: repin.get(p.manpowerRow!)! } });
  if (pending) {
    const rebased = await rebasePendingPlan(month, { version: saved.version, rows }, actor, undefined, approvedRows);
    console.log(rebased ? `  Pending v${pending.version} rebased as v${rebased} (pending).` : `  Pending v${pending.version} had nothing left on top: superseded.`);
  }
  return dropped.length;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) await disconnectDB();
  });
