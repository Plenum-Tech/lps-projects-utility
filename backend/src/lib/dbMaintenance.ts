import mongoose from "mongoose";
import { Brand, brandNameKey } from "../models/Brand.js";
import { backfillPearityTagNumbers } from "./pearity.js";

// ---------------------------------------------------------------------------
// Idempotent startup migrations (run by connectDB after connecting). Each step
// is best-effort: failures are logged, never thrown, so boot isn't blocked.
// ---------------------------------------------------------------------------

/**
 * Brands: drop the legacy locale-aware index "name_unique_ci" (Cosmos vCore can't
 * hold/create locale-aware (ICU) indexes) and backfill `nameKey` (the case-insensitive
 * uniqueness key that replaced it) on docs written before it existed.
 */
async function migrateBrandNameKey(): Promise<void> {
  const collection = Brand.collection;
  try {
    const indexes = await collection.indexes();
    if (indexes.some((ix) => ix.name === "name_unique_ci")) {
      await collection.dropIndex("name_unique_ci");
      console.log("[db] dropped legacy brands index name_unique_ci");
    }
  } catch {
    // Collection missing / index already gone — nothing to do.
  }
  try {
    const missing = await collection
      .find({ $or: [{ nameKey: { $exists: false } }, { nameKey: null }] }, { projection: { _id: 1, name: 1 } })
      .toArray();
    let updated = 0;
    for (const doc of missing) {
      if (typeof doc.name !== "string") continue;
      try {
        await collection.updateOne({ _id: doc._id }, { $set: { nameKey: brandNameKey(doc.name) } });
        updated += 1;
      } catch (err) {
        console.warn(`[db] brands nameKey backfill skipped ${String(doc._id)}: ${(err as Error).message}`);
      }
    }
    if (updated) console.log(`[db] backfilled nameKey on ${updated} brand(s)`);
  } catch (err) {
    console.warn(`[db] brands nameKey backfill failed: ${(err as Error).message}`);
  }
}

/** Pearity tags: give tags created before `tagNo` existed a sequential number. */
async function migratePearityTagNumbers(): Promise<void> {
  try {
    const numbered = await backfillPearityTagNumbers();
    if (numbered) console.log(`[db] numbered ${numbered} Pearity tag(s)`);
  } catch (err) {
    console.warn(`[db] Pearity tag number backfill failed: ${(err as Error).message}`);
  }
}

export async function runDbMaintenance(): Promise<void> {
  if (mongoose.connection.readyState !== 1) return;
  await migrateBrandNameKey();
  await migratePearityTagNumbers();
}
