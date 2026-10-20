import "dotenv/config";
import mongoose from "mongoose";
import { connectDB, disconnectDB } from "../db/index.js";
import { planChanges } from "../controllers/manpower.js";
import { applyPlanDelta, combineNotes, deltaIsEmpty, planDelta, type PlanDelta } from "../lib/manpowerMerge.js";
import { MANPOWER_LIMITS } from "../lib/manpowerRoles.js";
import { ChangeRequest } from "../models/ChangeRequest.js";
import { APPROVED_PLAN, ManpowerPlan, type IManpowerRow } from "../models/ManpowerPlan.js";

/**
 * Recovers manpower plan changes lost to the old "newest pending save replaces the
 * pending one" rule: each listed (superseded) pending version only held its own
 * changes on top of the approved plan, so the earlier ones stopped being pending.
 *
 *   bun src/scripts/rebuildPendingPlan.ts --month 2026-10 --versions 11,12,13            # dry run (default)
 *   bun src/scripts/rebuildPendingPlan.ts --month 2026-10 --versions 11,12,13 --apply    # writes
 *
 * - Prints the target database, the latest approved version and, for each listed
 *   version, its changes against the approved version it was made on (its recorded
 *   `baseVersion`, else the latest approved version below it).
 * - The rebuilt rows = the latest approved rows + each version's delta, in the order
 *   given (a later version wins where two changed the same cell / line field).
 * - --apply writes ONE new pending version (next number, base = the latest approved,
 *   author = the last listed version's author, notes combined), supersedes any other
 *   pending version of the month, and moves the month's pending manpower_plan change
 *   request to it (version, payload, title, change lines). With no pending request,
 *   one is created (no email is sent). Nothing else is touched; projects only change
 *   when leadership approves the request.
 */

interface Args {
  month: string;
  versions: number[];
  apply: boolean;
}

function parseArgs(argv: string[]): Args {
  let month = "";
  let versions: number[] = [];
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") continue;
    if (a === "--apply") apply = true;
    else if (a === "--dry-run") apply = false;
    else if (a === "--month") month = argv[++i] ?? "";
    else if (a === "--versions") versions = (argv[++i] ?? "").split(",").map((v) => Number(v.trim()));
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("--month YYYY-MM is required");
  if (!versions.length || versions.some((v) => !Number.isInteger(v) || v < 1)) throw new Error("--versions 11,12,13 is required");
  return { month, versions, apply };
}

function summary(d: PlanDelta): string {
  const cells = Object.values(d.cells).reduce((n, c) => n + Object.keys(c).length, 0);
  return `${d.added.length} line(s) added, ${d.removed.length} removed, ${Object.keys(d.fields).length} renamed / relinked, ${cells} cell(s) changed`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await connectDB();
  const conn = mongoose.connection;
  console.log(`Target database: "${conn.name}" on ${conn.host}:${conn.port}${args.apply ? "" : " (DRY RUN — nothing is written; add --apply to write)"}`);
  const { month } = args;

  const approved = await ManpowerPlan.findOne({ month, ...APPROVED_PLAN }).sort({ version: -1 }).lean();
  if (!approved) throw new Error(`${month} has no approved version`);
  const approvedRows = approved.rows as IManpowerRow[];
  console.log(`\n${month}: latest approved version ${approved.version} (${approvedRows.length} lines)`);

  let rows = approvedRows;
  const notes: string[] = [];
  let last: { createdBy: mongoose.Types.ObjectId | null; maxProjectsPerPerson: number; version: number } | null = null;
  for (const version of args.versions) {
    const doc = await ManpowerPlan.findOne({ month, version }).lean();
    if (!doc) throw new Error(`Version ${version} not found`);
    const baseVersion =
      doc.baseVersion ??
      (await ManpowerPlan.findOne({ month, ...APPROVED_PLAN, version: { $lt: version } }).sort({ version: -1 }).select("version").lean())?.version ??
      null;
    const base = baseVersion != null ? ((await ManpowerPlan.findOne({ month, version: baseVersion }).select("rows").lean())?.rows ?? []) : [];
    const delta = planDelta(base as IManpowerRow[], doc.rows as IManpowerRow[]);
    console.log(`\n— Version ${version} (${doc.status ?? "approved"}, ${doc.createdAt?.toISOString?.() ?? ""}) "${doc.note ?? ""}" — made on version ${baseVersion ?? "none"}: ${summary(delta)}`);
    if (doc.status === "approved" || !doc.status) console.log("  ! this version is approved: its changes are already live (re-applying them is harmless)");
    for (const c of await planChanges(base as IManpowerRow[], doc.rows as IManpowerRow[])) console.log(`  · ${c.label}: ${c.before} → ${c.after}`);
    if (deltaIsEmpty(delta)) continue;
    rows = applyPlanDelta(rows, delta);
    if (doc.note) notes.push(doc.note);
    last = { createdBy: (doc.createdBy as mongoose.Types.ObjectId | null) ?? null, maxProjectsPerPerson: doc.maxProjectsPerPerson, version };
  }

  const changes = await planChanges(approvedRows, rows);
  console.log(`\n== Rebuilt pending plan vs approved version ${approved.version}: ${changes.length} change line(s)`);
  for (const c of changes) console.log(`  · ${c.label}: ${c.before} → ${c.after}`);
  if (!last || changes.length === 0) {
    console.log("\nNothing to rebuild (no changes against the approved plan).");
    return;
  }
  const note = notes.reduce((acc, n) => combineNotes(acc, n, MANPOWER_LIMITS.versionNoteMax), "");
  const highest = await ManpowerPlan.findOne({ month }).sort({ version: -1 }).select("version").lean();
  const next = (highest?.version ?? approved.version) + 1;
  const pendingNow = await ManpowerPlan.find({ month, status: "pending" }).select("version").lean();
  const request = await ChangeRequest.findOne({ kind: "manpower_plan", status: "pending", month }).sort({ createdAt: -1 });
  console.log(`\nWould write version ${next} (pending, base ${approved.version}) — note "${note}"`);
  console.log(`  pending versions to supersede: ${pendingNow.map((p) => p.version).join(", ") || "none"}`);
  console.log(`  change request: ${request ? `move ${String(request._id)} (v${request.version}) to v${next}` : "none pending — a new one is created (no email)"}`);
  if (!args.apply) return;

  const plan = await ManpowerPlan.create({
    month,
    version: next,
    rows,
    note: note || `Rebuilt from versions ${args.versions.join(", ")}`,
    maxProjectsPerPerson: last.maxProjectsPerPerson,
    source: "edit",
    status: "pending",
    baseVersion: approved.version,
    createdBy: last.createdBy,
  });
  await ManpowerPlan.updateMany({ month, status: "pending", version: { $ne: plan.version } }, { $set: { status: "superseded" } });
  const title = `Manpower plan ${month} — version ${plan.version}`;
  if (request) {
    request.version = plan.version;
    request.payload = { ...(request.payload ?? {}), month, version: plan.version };
    request.markModified("payload");
    request.title = title;
    request.changes = changes.slice(0, 300);
    await request.save();
    console.log(`\nWrote version ${plan.version} (${String(plan._id)}); moved request ${String(request._id)} to it.`);
  } else {
    if (!last.createdBy) throw new Error("The last listed version has no author to request the change as");
    const created = await ChangeRequest.create({
      kind: "manpower_plan",
      title,
      month,
      version: plan.version,
      changes: changes.slice(0, 300),
      payload: { month, version: plan.version },
      requestedBy: last.createdBy,
    });
    console.log(`\nWrote version ${plan.version} (${String(plan._id)}); created request ${String(created._id)}.`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) await disconnectDB();
  });
