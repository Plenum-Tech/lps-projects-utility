import "dotenv/config";
import mongoose from "mongoose";
import { connectDB, disconnectDB } from "../db/index.js";
import { applyBrandMove } from "../lib/brandMove.js";
import { isLeadershipActor } from "../lib/changeRequests.js";
import { logActivity } from "../lib/activityLog.js";
import { Brand } from "../models/Brand.js";
import { BrandScopeVersion } from "../models/BrandScopeVersion.js";
import { DeliverySettings } from "../models/DeliverySettings.js";
import { ManpowerPlan } from "../models/ManpowerPlan.js";
import { Project } from "../models/Project.js";
import { User, type IUser } from "../models/User.js";

/**
 * Merges duplicate brands into the brand to keep (run by hand; dry run by default):
 *
 *   bun src/scripts/mergeBrands.ts --pair "Daawat=>Dawat" --pair "Sketchers=>Skechers"
 *   bun src/scripts/mergeBrands.ts --pair ... --apply --by <leadership email>
 *
 * Open projects move with the app's "Move projects" (names, scope, plan lines follow);
 * archived ones are re-linked as they are; plan lines linked to the duplicate (every
 * version) point at the kept brand; the duplicate's leads are added to the kept brand;
 * then the duplicate is deleted (with its scope versions and delivery-settings entries).
 */
const argv = process.argv.slice(2);
const pairs: Array<[string, string]> = [];
let apply = false;
let by = "";
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--pair") {
    const [a, b] = (argv[++i] ?? "").split("=>").map((s) => s.trim());
    if (!a || !b) throw new Error(`Bad --pair (use "Duplicate=>Keep")`);
    pairs.push([a, b]);
  } else if (argv[i] === "--apply") apply = true;
  else if (argv[i] === "--by") by = (argv[++i] ?? "").trim().toLowerCase();
  else throw new Error(`Unknown argument: ${argv[i]}`);
}
if (!pairs.length) throw new Error('--pair "Duplicate=>Keep" is required');
if (apply && !by) throw new Error("--apply needs --by <leadership email>");

async function one(name: string) {
  const list = await Brand.find({ name });
  if (list.length !== 1) throw new Error(`"${name}": ${list.length} brands with that name`);
  return list[0]!;
}

await connectDB();
console.log(`Target database: "${mongoose.connection.name}"${apply ? "" : "  (DRY RUN — add --apply --by <email> to write)"}`);
let actor: IUser | null = null;
if (apply) {
  actor = await User.findOne({ email: by });
  if (!actor || !(await isLeadershipActor(actor))) throw new Error(`${by} is not a leadership user`);
}
try {
  for (const [dupName, keepName] of pairs) {
    const [dup, keep] = [await one(dupName), await one(keepName)];
    const open = await Project.find({ archivedAt: null, $or: [{ brand: dup._id }, { "naming.brand": dup._id }] }).select("code name").lean();
    const all = await Project.countDocuments({ $or: [{ brand: dup._id }, { "naming.brand": dup._id }] });
    const lines = await ManpowerPlan.countDocuments({ "rows.brand": dup._id });
    console.log(`\n${dup.name} => ${keep.name}: ${open.length} open project(s) [${open.map((p) => p.code).join(", ")}], ${all - open.length} archived, plan versions with its lines: ${lines}, leads: ${(dup.leads ?? []).length}, revenue: ${dup.revenue ?? "-"} (kept brand: ${keep.revenue ?? "-"}), scope rows: ${(dup.scopeItems ?? []).length}, files: ${(dup.scopeFiles ?? []).length}`);
    if (!apply || !actor) continue;
    if (open.length) {
      const r = await applyBrandMove(dup._id as mongoose.Types.ObjectId, keep._id as mongoose.Types.ObjectId, open.map((p) => String(p._id)), actor, undefined, { notify: false });
      if ("error" in r) throw new Error(`${dup.name}: ${r.error}`);
      console.log(`  moved ${r.moved}${r.errors.length ? `; errors: ${r.errors.join("; ")}` : ""}`);
    }
    await Project.updateMany({ brand: dup._id }, { $set: { brand: keep._id } });
    await Project.updateMany({ "naming.brand": dup._id }, { $set: { "naming.brand": keep._id } });
    await ManpowerPlan.updateMany({ "rows.brand": dup._id }, { $set: { "rows.$[r].brand": keep._id } }, { arrayFilters: [{ "r.brand": dup._id }] });
    const leads = (dup.leads ?? []).filter((l) => !(keep.leads ?? []).some((k) => String(k) === String(l)));
    if (leads.length) await Brand.updateOne({ _id: keep._id }, { $addToSet: { leads: { $each: leads } } });
    // A pitch's potential revenue is kept when the kept brand has none.
    if (dup.revenue != null && keep.revenue == null) await Brand.updateOne({ _id: keep._id }, { $set: { revenue: dup.revenue, revenueTbc: Boolean(dup.revenueTbc) } });
    if ((dup.scopeItems ?? []).length || (dup.scopeFiles ?? []).length) console.log(`  note: ${dup.name} had scope rows/files; they are not copied (the kept brand's scope stays)`);
    await BrandScopeVersion.deleteMany({ brand: dup._id });
    await DeliverySettings.updateOne({ key: "delivery" }, { $pull: { sameDayBrands: dup._id, brandTeamMap: { brand: dup._id } } });
    await dup.deleteOne();
    logActivity({ action: "settings_updated", actor, targetType: "brand", targetId: dup._id as mongoose.Types.ObjectId, targetName: dup.name, details: { brand: "merged", into: keep.name } });
    console.log(`  merged; ${dup.name} deleted`);
  }
} finally {
  await disconnectDB();
}
