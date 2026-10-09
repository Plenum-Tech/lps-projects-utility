import "dotenv/config";
import { connectDB, disconnectDB } from "../db/index.js";
import { getOrCreateDeliverySettings } from "../lib/delivery/settings.js";
import { parseDateOnly } from "../lib/taskAccess.js";

/**
 * `bun run delivery:settings -- --team-map-start 2026-06-01`
 * Sets Delivery Pulse settings from the command line (creates the settings
 * document with the defaults when it doesn't exist yet). Only the team-map
 * start date is supported for now; everything else is edited in the app.
 */
async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--team-map-start");
  const value = idx >= 0 ? args[idx + 1] : undefined;
  const date = value ? parseDateOnly(value) : null;
  if (!date) {
    console.error("usage: bun run delivery:settings -- --team-map-start YYYY-MM-DD");
    process.exit(2);
  }
  await connectDB();
  const doc = await getOrCreateDeliverySettings();
  const before = doc.teamMapStartDate?.toISOString().slice(0, 10) ?? "unset";
  doc.teamMapStartDate = date;
  await doc.save();
  console.log(`✅ teamMapStartDate: ${before} → ${date.toISOString().slice(0, 10)} (takes effect within a minute; the analytics cache refreshes)`);
}

run()
  .then(() => disconnectDB())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("❌ Failed:", error);
    await disconnectDB().catch(() => undefined);
    process.exit(1);
  });
