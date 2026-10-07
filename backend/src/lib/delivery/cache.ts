import type { Schema } from "mongoose";

// ---------------------------------------------------------------------------
// Delivery Pulse response cache: 60 s per (endpoint, filters, scope), bounded
// LRU. Writes to the source collections (tasks, projects, brands, users, task
// files/comments/notes, delivery settings) clear it — debounced, so a bulk
// import or a burst of board moves costs one clear, not hundreds.
//
// Kept separate from lib/refCache.ts on purpose: its invalidate() bumps a
// global generation that would also discard unrelated in-flight loads.
// No model imports here (models import this module).
// ---------------------------------------------------------------------------

export const DELIVERY_CACHE_TTL_MS = 60_000;
const MAX_ENTRIES = 500;
/** Trailing debounce after the last write, and the longest a burst can postpone the clear. */
const DEBOUNCE_MS = 500;
const MAX_WAIT_MS = 3_000;

interface Entry {
  value: unknown;
  expires: number;
}

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
let generation = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let firstPendingAt = 0;

/** Cached value for `key` (single-flight load when missing/expired). */
export async function deliveryCached<T>(key: string, load: () => Promise<T>, ttlMs = DELIVERY_CACHE_TTL_MS): Promise<T> {
  const hit = entries.get(key);
  if (hit && hit.expires > Date.now()) {
    // LRU: move to the back.
    entries.delete(key);
    entries.set(key, hit);
    return hit.value as T;
  }
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const startGeneration = generation;
  const promise = load()
    .then((value) => {
      if (generation === startGeneration) {
        entries.set(key, { value, expires: Date.now() + ttlMs });
        while (entries.size > MAX_ENTRIES) {
          const oldest = entries.keys().next().value;
          if (oldest === undefined) break;
          entries.delete(oldest);
        }
      }
      return value;
    })
    .finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

/** Clears everything now (settings saves call this directly). */
export function clearDeliveryCache(): void {
  generation += 1;
  entries.clear();
  inflight.clear();
  if (timer) clearTimeout(timer);
  timer = null;
  firstPendingAt = 0;
}

/** Schedules a debounced clear (trailing DEBOUNCE_MS, at most MAX_WAIT_MS after the first write). */
export function scheduleDeliveryInvalidation(): void {
  const now = Date.now();
  if (!firstPendingAt) firstPendingAt = now;
  if (timer) clearTimeout(timer);
  const wait = Math.max(0, Math.min(DEBOUNCE_MS, firstPendingAt + MAX_WAIT_MS - now));
  timer = setTimeout(clearDeliveryCache, wait);
  timer.unref?.();
}

/** Registers post-write hooks on `schema` (call before the model is compiled). */
export function deliveryInvalidateOnWrite(schema: Schema<any>): void {
  const drop = () => scheduleDeliveryInvalidation();
  schema.post("save", drop);
  schema.post("insertMany", drop);
  schema.post("bulkWrite", drop);
  schema.post(["updateOne", "deleteOne"], { document: true, query: true }, drop);
  schema.post(
    ["updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne", "deleteMany", "findOneAndDelete"],
    drop
  );
}

/** Test helper: number of live entries. */
export function deliveryCacheSize(): number {
  return entries.size;
}
