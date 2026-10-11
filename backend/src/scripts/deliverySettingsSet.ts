import "dotenv/config";
import { connectDB, disconnectDB } from "../db/index.js";
import { getOrCreateDeliverySettings } from "../lib/delivery/settings.js";
import { parseDateOnly } from "../lib/taskAccess.js";
import { User } from "../models/User.js";

/**
 * Sets Delivery Pulse settings from the command line (creates the settings
 * document with the defaults when it doesn't exist yet):
 *
 *   bun run delivery:settings -- --team-map-start 2026-06-01
 *   bun run delivery:settings -- --traffic-managers nazeer@lps-me.com[,other@lps-me.com]
 *
 * Everything else is edited in the app (Settings → Delivery).
 */
function arg(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const start = arg(args, "--team-map-start");
  const traffic = arg(args, "--traffic-managers");
  const date = start ? parseDateOnly(start) : null;
  if ((start && !date) || (!start && !traffic)) {
    console.error("usage: bun run delivery:settings -- [--team-map-start YYYY-MM-DD] [--traffic-managers email,email]");
    process.exit(2);
  }
  await connectDB();
  const doc = await getOrCreateDeliverySettings();
  if (date) {
    const before = doc.teamMapStartDate?.toISOString().slice(0, 10) ?? "unset";
    doc.teamMapStartDate = date;
    console.log(`teamMapStartDate: ${before} -> ${date.toISOString().slice(0, 10)}`);
  }
  if (traffic) {
    const emails = traffic.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    const users = await User.find({ email: { $in: emails } }).select("name email").lean();
    const missing = emails.filter((e) => !users.some((u) => u.email.toLowerCase() === e));
    if (missing.length) throw new Error(`No user with email: ${missing.join(", ")}`);
    doc.trafficManagers = users.map((u) => u._id);
    console.log(`trafficManagers: ${users.map((u) => u.name).join(", ")}`);
  }
  await doc.save();
  console.log("Saved (the analytics cache refreshes within a minute).");
}

run()
  .then(() => disconnectDB())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("Failed:", error);
    await disconnectDB().catch(() => undefined);
    process.exit(1);
  });
