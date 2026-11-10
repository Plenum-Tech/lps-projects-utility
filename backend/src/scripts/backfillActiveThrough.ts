import "dotenv/config";
import mongoose from "mongoose";
import { connectDB, disconnectDB } from "../db/index.js";
import { carryOpenProjects } from "../lib/projectCarry.js";
import { currentAppMonth } from "../lib/projectExpiry.js";
import { Project } from "../models/Project.js";

/**
 * Continuous projects (lib/projectCarry.ts) for existing data:
 *
 *   1. activeThrough = the project's own month (naming month) where it's empty;
 *   2. --carry: projects of last month that still have open tasks carry on into this month
 *      (the step the 1st does from now on). Projects already copied into this month by an
 *      earlier migration are left alone.
 *
 *   bun src/scripts/backfillActiveThrough.ts --dry-run
 *   bun src/scripts/backfillActiveThrough.ts --confirm [--carry]
 */
async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const confirm = process.argv.includes("--confirm");
  const carry = process.argv.includes("--carry");
  if (dryRun === confirm) throw new Error("Pass exactly one of --dry-run or --confirm");
  await connectDB();
  console.log(`Database: ${mongoose.connection.name}`);

  const missing = await Project.countDocuments({ activeThrough: null, "naming.month": { $type: "string" } });
  if (dryRun) {
    console.log(`Would set activeThrough on ${missing} projects (their own month).${carry ? " The carry step runs only with --confirm." : ""}`);
  } else {
    const res = await Project.updateMany({ activeThrough: null, "naming.month": { $type: "string" } }, [{ $set: { activeThrough: "$naming.month" } }], { updatePipeline: true });
    console.log(`Set activeThrough on ${res.modifiedCount} projects (their own month).`);
    if (carry) {
      const month = currentAppMonth();
      const result = await carryOpenProjects(month, null);
      console.log(`Carried ${result.carried.length} projects with open tasks into ${month}; ${result.stayed} stayed in their month.`);
      for (const name of result.carried) console.log(`  → ${name}`);
    }
  }
  await disconnectDB();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await disconnectDB().catch(() => undefined);
  process.exit(1);
});
