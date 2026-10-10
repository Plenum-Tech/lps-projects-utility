import "dotenv/config";
import { connectDB, disconnectDB } from "../db/index.js";
import { briefCheckConfigured, briefCheckModel, checkTaskBrief } from "../lib/briefCheck.js";
import { Task } from "../models/Task.js";

/**
 * `bun run brief:check [-- --days 90] [--force]`
 * Runs the AI brief check over tasks created in the last N days (default 90)
 * that have a description and no current verdict. --force re-checks all.
 */
async function run(): Promise<void> {
  if (!briefCheckConfigured()) {
    console.error("OPENAI_API_KEY is not set — nothing to do.");
    process.exit(2);
  }
  const args = process.argv.slice(2);
  const daysArg = args.indexOf("--days");
  const days = daysArg >= 0 ? Number(args[daysArg + 1]) : 90;
  const force = args.includes("--force");
  if (!Number.isFinite(days) || days < 1) {
    console.error("usage: bun run brief:check -- --days 90 [--force]");
    process.exit(2);
  }
  await connectDB();
  const since = new Date(Date.now() - days * 86_400_000);
  const filter: Record<string, unknown> = { createdAt: { $gte: since }, description: { $nin: [null, ""] } };
  if (!force) filter.briefCheck = { $exists: false };
  const ids = (await Task.find(filter).select("_id").lean()).map((t) => t._id);
  console.log(`checking ${ids.length} brief(s) from the last ${days} days with ${briefCheckModel()}…`);
  const counts: Record<string, number> = { ok: 0, weak: 0, flagged: 0, skipped: 0 };
  for (let i = 0; i < ids.length; i += 3) {
    const batch = await Promise.all(ids.slice(i, i + 3).map((id) => checkTaskBrief(id, force)));
    for (const v of batch) counts[v ?? "skipped"]!++;
    if ((i / 3) % 20 === 0) console.log(`  ${Math.min(i + 3, ids.length)}/${ids.length}`);
  }
  console.log(`✅ ok=${counts.ok} weak=${counts.weak} flagged=${counts.flagged} skipped=${counts.skipped}`);
}

run()
  .then(() => disconnectDB())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("❌ Failed:", error);
    await disconnectDB().catch(() => undefined);
    process.exit(1);
  });
