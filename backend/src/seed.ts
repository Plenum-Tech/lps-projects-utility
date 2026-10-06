import "dotenv/config";
import { connectDB, disconnectDB } from "./db/index.js";
import { User } from "./models/User.js";

/** Creates the initial admin from ADMIN_* env vars. Idempotent — skips if the email already exists. */
async function seedAdmin(): Promise<void> {
  await connectDB();

  try {
    const name = process.env.ADMIN_NAME ?? "LPS Admin";
    const email = (process.env.ADMIN_EMAIL ?? "admin@ems.local").trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD;

    if (!password) {
      throw new Error("ADMIN_PASSWORD is not set. Add it to backend/.env (see backend/.env.example).");
    }

    const existing = await User.findOne({ email });
    if (existing) {
      console.log(`⚠️  Admin already exists for ${email} — skipping.`);
      return;
    }

    await User.create({ name, email, password, role: "admin" });
    console.log(`✅ Seeded admin user: ${email} (role: admin)`);
  } finally {
    await disconnectDB();
  }
}

if (import.meta.main) {
  seedAdmin().catch((error) => {
    console.error("❌ Seed failed:", error);
    process.exit(1);
  });
}
