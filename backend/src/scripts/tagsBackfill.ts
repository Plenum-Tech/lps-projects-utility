/**
 * Gives every project and task its tag (BRAND-MONTH-TYPE-NAME / …-UNITQTY).
 *
 *   bun run tags:backfill [--dry-run] [--refresh]
 *
 * Without --refresh only items without a tag are tagged. --refresh recomputes
 * all tags, except tasks Pearity already uses (their tag never changes).
 */
import "dotenv/config";
import { connectDB, disconnectDB } from "../db/index.js";
import { backfillTags } from "../lib/tagAssign.js";

const dryRun = process.argv.includes("--dry-run");
const refresh = process.argv.includes("--refresh");
await connectDB();
try {
  const result = await backfillTags({ dryRun, refresh });
  console.log(`${dryRun ? "Would tag" : "Tagged"} ${result.projects} projects and ${result.tasks} tasks.`);
} finally {
  await disconnectDB();
}
