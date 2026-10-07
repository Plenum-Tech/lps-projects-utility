import type { Schema } from "mongoose";

// ---------------------------------------------------------------------------
// Tiny in-process cache for hot, rarely-changing lookups (the signed-in user
// on every request, archived project ids, completed project statuses).
//
// Entries expire after their TTL and are dropped immediately when this process
// writes the underlying collection (see `invalidateOnWrite`). With several
// replicas a write on another replica is picked up within the TTL.
// ---------------------------------------------------------------------------

interface Entry {
  value: unknown;
  expires: number;
}

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
/** Bumped by invalidate() so a load that started before a write can't repopulate stale data. */
let generation = 0;

/** Returns the cached value for `key`, loading it (single-flight) when missing or expired. */
export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = entries.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const startGeneration = generation;
  const promise = load()
    .then((value) => {
      if (generation === startGeneration) entries.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/** Drops every entry whose key starts with `prefix`. */
export function invalidate(prefix: string): void {
  generation += 1;
  for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
  for (const key of inflight.keys()) if (key.startsWith(prefix)) inflight.delete(key);
}

/** Registers post-write hooks on `schema` (call before the model is compiled). */
export function invalidateOnWrite(schema: Schema<any>, prefix: string): void {
  const drop = () => invalidate(prefix);
  schema.post("save", drop);
  schema.post("insertMany", drop);
  schema.post("bulkWrite", drop);
  // Query writes; updateOne/deleteOne also as document methods (doc.updateOne()).
  schema.post(["updateOne", "deleteOne"], { document: true, query: true }, drop);
  schema.post(
    ["updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne", "deleteMany", "findOneAndDelete"],
    drop
  );
}
