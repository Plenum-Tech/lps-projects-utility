import "dotenv/config";
import mongoose from "mongoose";
import { connectDB, disconnectDB } from "../db/index.js";
import { Project, PROJECT_LIMITS } from "../models/Project.js";
import { ProjectActivity } from "../models/ProjectActivity.js";
import { User } from "../models/User.js";

/**
 * Two fills for existing projects (new projects get both on create):
 *
 *   1. migratedFrom — projects the month migration created (their "created" activity says
 *      via: month_migration, from: <last month's project>), so the list shows "Migrated".
 *   2. manager — projects without one get last month's manager (migrated ones), else their creator;
 *      the manager joins the members when there is room.
 *
 *   bun src/scripts/backfillProjectMeta.ts --dry-run    # counts only, nothing written
 *   bun src/scripts/backfillProjectMeta.ts --confirm    # writes
 *   … --app-only                                        # managers: skip projects imported from Worksuite
 *
 * Idempotent: only empty fields are filled, and each write re-checks they are still empty.
 */

type Id = mongoose.Types.ObjectId;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const confirm = process.argv.includes("--confirm");
  if (dryRun === confirm) throw new Error("Pass exactly one of --dry-run or --confirm");
  await connectDB();
  console.log(`Database: ${mongoose.connection.name}`);

  // 1. Migrated projects.
  const migrations = await ProjectActivity.find({ action: "created", "details.via": "month_migration" })
    .select("project details")
    .lean<Array<{ project: Id; details?: { from?: string } }>>();
  let migrated = 0;
  for (const a of migrations) {
    const from = a.details?.from;
    if (!from || !mongoose.isValidObjectId(from)) continue;
    if (dryRun) {
      if (await Project.exists({ _id: a.project, migratedFrom: null })) migrated++;
      continue;
    }
    const res = await Project.updateOne({ _id: a.project, migratedFrom: null }, { $set: { migratedFrom: new mongoose.Types.ObjectId(from) } });
    migrated += res.modifiedCount;
  }
  console.log(`${dryRun ? "Would mark" : "Marked"} ${migrated} projects as migrated (${migrations.length} month-migration creations logged).`);

  // 2. Managers.
  const appOnly = process.argv.includes("--app-only");
  const projects = await Project.find({ manager: null, ...(appOnly ? { legacy: null } : {}) })
    .select("createdBy members")
    .lean<Array<{ _id: Id; createdBy?: Id | null; members?: Array<{ user: Id }> }>>();
  const sources = new Map(migrations.map((a) => [String(a.project), a.details?.from ?? null]));
  const sourceManagers = new Map(
    (
      await Project.find({ _id: { $in: [...sources.values()].filter((v): v is string => !!v && mongoose.isValidObjectId(v)) }, manager: { $ne: null } })
        .select("manager")
        .lean<Array<{ _id: Id; manager: Id }>>()
    ).map((p) => [String(p._id), p.manager])
  );
  const candidates = projects.map((p) => {
    const from = sources.get(String(p._id));
    return { p, manager: (from && sourceManagers.get(from)) || p.createdBy || null, fromLastMonth: !!(from && sourceManagers.get(from)) };
  });
  const existing = new Set(
    (await User.find({ _id: { $in: candidates.flatMap((c) => (c.manager ? [c.manager] : [])) } }).select("_id").lean()).map((u) => String(u._id))
  );

  let updated = 0;
  let lastMonth = 0;
  let joined = 0;
  let skipped = 0;
  for (const { p, manager, fromLastMonth } of candidates) {
    if (!manager || !existing.has(String(manager))) {
      skipped++;
      continue;
    }
    const members = p.members ?? [];
    const join = !members.some((m) => String(m.user) === String(manager)) && members.length < PROJECT_LIMITS.maxMembers;
    if (!dryRun) {
      const res = await Project.updateOne(
        { _id: p._id, manager: null },
        { $set: { manager }, ...(join ? { $push: { members: { user: manager, hourlyRate: 0 } } } : {}) }
      );
      if (res.modifiedCount === 0) continue;
    }
    updated++;
    if (fromLastMonth) lastMonth++;
    if (join) joined++;
  }
  console.log(
    `${dryRun ? "Would set" : "Set"} a manager on ${updated} of ${projects.length} projects without one ` +
      `(${lastMonth} last month's manager, ${updated - lastMonth} the creator; ${joined} join the members; ${skipped} skipped: no such user).`
  );
  await disconnectDB();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await disconnectDB().catch(() => undefined);
  process.exit(1);
});
