import "dotenv/config";
import { connectDB, disconnectDB } from "../db/index.js";
import { Task } from "../models/Task.js";

/**
 * One-off, idempotent migration (`bun run migrate:tasks`):
 * - `assignedTo` → `assignees: [assignedTo]`, then unsets `assignedTo`
 * - fills `position` (creation time, so existing order is kept), `labels`, `subtasks`
 *
 * Uses the raw collection: `assignedTo` is no longer in the schema, so mongoose
 * strictQuery would strip it from filters.
 */
async function migrate(): Promise<void> {
  await connectDB();
  const collection = Task.collection;

  // 1. assignedTo → assignees (keep an existing non-empty assignees array)
  const assignees = await collection.updateMany(
    { assignedTo: { $exists: true } },
    [
      {
        $set: {
          assignees: {
            $cond: [
              { $and: [{ $isArray: "$assignees" }, { $gt: [{ $size: "$assignees" }, 0] }] },
              "$assignees",
              { $cond: [{ $ifNull: ["$assignedTo", false] }, ["$assignedTo"], []] },
            ],
          },
        },
      },
      { $unset: "assignedTo" },
    ]
  );
  console.log(`✅ assignees: ${assignees.modifiedCount} task(s) converted`);

  // 2. position — creation time in ms keeps the current order
  const positions = await collection.updateMany({ position: { $exists: false } }, [
    { $set: { position: { $toDouble: { $toLong: { $ifNull: ["$createdAt", "$$NOW"] } } } } },
  ]);
  console.log(`✅ position: ${positions.modifiedCount} task(s) updated`);

  // 3. Array defaults so queries like { labels: id } behave consistently
  const labels = await collection.updateMany({ labels: { $exists: false } }, { $set: { labels: [] } });
  const subtasks = await collection.updateMany({ subtasks: { $exists: false } }, { $set: { subtasks: [] } });
  console.log(`✅ defaults: labels on ${labels.modifiedCount}, subtasks on ${subtasks.modifiedCount} task(s)`);

  // 4. Indexes — drop the old assignedTo index (if any) and build the new ones
  const indexes = await collection.indexes();
  for (const index of indexes) {
    if (index.name && index.key && "assignedTo" in index.key) {
      await collection.dropIndex(index.name);
      console.log(`🧹 dropped index ${index.name}`);
    }
  }
  await Task.syncIndexes();
  console.log("✅ indexes synced");

  const leftover = await collection.countDocuments({ assignedTo: { $exists: true } });
  if (leftover > 0) {
    console.warn(`⚠️  ${leftover} task(s) still have assignedTo — check them manually`);
  }
}

migrate()
  .then(() => disconnectDB())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("❌ Migration failed:", error);
    await disconnectDB().catch(() => undefined);
    process.exit(1);
  });
