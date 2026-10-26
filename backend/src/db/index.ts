import mongoose from "mongoose";
import { refreshCompanySettings } from "../lib/companySettings.js";
import { refreshScopeUnits } from "../lib/scopeUnitSettings.js";
import { runDbMaintenance } from "../lib/dbMaintenance.js";

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Pool/timeouts, tunable per deployment (these override the same options in the
 * URI). retryWrites is left to the URI/driver default (on) unless MONGO_RETRY_WRITES is set.
 */
function connectionOptions(): mongoose.ConnectOptions {
  const retryWrites = process.env.MONGO_RETRY_WRITES?.trim().toLowerCase();
  return {
    ...(retryWrites ? { retryWrites: retryWrites !== "false" } : {}),
    maxPoolSize: envInt("MONGO_MAX_POOL", 50),
    minPoolSize: envInt("MONGO_MIN_POOL", 2),
    serverSelectionTimeoutMS: envInt("MONGO_SERVER_SELECTION_TIMEOUT_MS", 10_000),
    socketTimeoutMS: envInt("MONGO_SOCKET_TIMEOUT_MS", 45_000),
    autoIndex: process.env.MONGO_AUTO_INDEX?.trim().toLowerCase() !== "false",
  };
}

/** Pings the server with a timeout; false when disconnected/slow (health checks). */
export async function pingDB(timeoutMs = 1_000): Promise<boolean> {
  const db = mongoose.connection.db;
  if (mongoose.connection.readyState !== 1 || !db) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      db.admin().ping().then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Connects to MongoDB via Mongoose using the MONGO_URI environment variable.
 * Throws if the connection string is missing or the connection fails, so the
 * server can fail fast instead of serving requests against a dead database.
 */
export async function connectDB(): Promise<void> {
  const uri = process.env.MONGO_URI;

  if (!uri) {
    throw new Error("MONGO_URI is not set. Add it to backend/.env (see backend/.env.example).");
  }

  await mongoose.connect(uri, connectionOptions());
  console.log(`✅ MongoDB connected: ${mongoose.connection.name}`);
  if (process.env.NODE_ENV === "production" && connectionOptions().autoIndex) {
    console.warn(
      "[db] autoIndex is on: missing indexes are built in the background on boot. " +
        "On a large existing database, let the first deploy finish building them (or set MONGO_AUTO_INDEX=false after)."
    );
  }
  // Idempotent Cosmos-compat migrations (legacy index drop, key backfills).
  await runDbMaintenance();
  // Load company settings (timezone, app URL, branding) for request-less code:
  // jobs and scripts. Never throws — env fallbacks apply on failure.
  await refreshCompanySettings();
  // Settings → Scope units (validators and the scope reader use the list). Never throws.
  await refreshScopeUnits();
}

/** Disconnects from MongoDB — used for clean shutdowns and tests. */
export async function disconnectDB(): Promise<void> {
  await mongoose.disconnect();
  console.log("🔌 MongoDB disconnected");
}
