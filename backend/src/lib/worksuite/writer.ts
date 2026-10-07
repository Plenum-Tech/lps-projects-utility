import mongoose from "mongoose";
import type { ImportReport } from "./report.js";

// ---------------------------------------------------------------------------
// Upsert-by-legacy-id writer. Every document is validated through its
// Mongoose model (so schema limits/enums apply), then written with the native
// driver in unordered batches of 500: inserts for new documents, `$set` of the
// mapped fields for documents a previous run created. Native writes keep the
// source createdAt/updatedAt and skip model hooks (no notifications, SSE or
// activity entries).
// ---------------------------------------------------------------------------

export const LEGACY_SOURCE = "worksuite";
export const BATCH_SIZE = 500;

type AnyModel = mongoose.Model<any>;

export function legacyKey(table: string, id: number): string {
  return `${table}:${id}`;
}

/** legacy "table:id" → _id for every document of `model` created/matched by a previous run. */
export async function loadLegacyIds(model: AnyModel): Promise<Map<string, mongoose.Types.ObjectId>> {
  const map = new Map<string, mongoose.Types.ObjectId>();
  const cursor = model.collection.find(
    { "legacy.source": LEGACY_SOURCE },
    { projection: { _id: 1, "legacy.table": 1, "legacy.id": 1 } }
  );
  for await (const doc of cursor) {
    const legacy = doc.legacy as { table?: string; id?: number } | undefined;
    if (legacy?.table && typeof legacy.id === "number") map.set(legacyKey(legacy.table, legacy.id), doc._id as mongoose.Types.ObjectId);
  }
  return map;
}

export interface PlannedDoc {
  table: string;
  legacyId: number;
  _id: mongoose.Types.ObjectId;
  /** True when a previous run already created this document (update instead of insert). */
  exists: boolean;
  /** Fields written on insert and refreshed on re-runs. */
  set: Record<string, unknown>;
  /** Fields written only when the document is created (codes, numbers, passwords …). */
  insertOnly?: Record<string, unknown>;
  /** Pre-existing document matched by a natural key (e.g. user email): flagged in `legacy.matched`. */
  matched?: boolean;
}

export interface WriteResult {
  /** Legacy ids written successfully (or that would be, in a dry run). */
  ok: Set<number>;
  created: number;
  updated: number;
}

function firstValidationProblem(error: mongoose.Error.ValidationError): string {
  const [path, detail] = Object.entries(error.errors)[0] ?? ["unknown", undefined];
  const kind = (detail as { kind?: string } | undefined)?.kind ?? "invalid";
  return `invalid_${path.replace(/\.\d+\./g, ".")}_${kind}`;
}

/**
 * Validates and writes `docs`. Invalid documents and write errors are reported
 * as skipped (`entity`, reason, legacy id) and left out of `ok`.
 */
export async function writePlanned(
  model: AnyModel,
  entity: string,
  docs: PlannedDoc[],
  report: ImportReport,
  dryRun: boolean
): Promise<WriteResult> {
  const result: WriteResult = { ok: new Set(), created: 0, updated: 0 };
  type Op = { legacyId: number; insert: boolean; op: Record<string, unknown> };
  const ops: Op[] = [];

  for (const doc of docs) {
    const draft = new model({ _id: doc._id, ...(doc.insertOnly ?? {}), ...doc.set });
    // Updates only touch `set`, so only those paths must be valid (e.g. no password on re-runs).
    try {
      if (doc.exists) await draft.validate(Object.keys(doc.set));
      else await draft.validate();
    } catch (error) {
      if (!(error instanceof mongoose.Error.ValidationError)) throw error;
      report.skip(entity, firstValidationProblem(error), doc.legacyId);
      continue;
    }
    const casted = draft.toObject({ depopulate: true, virtuals: false, versionKey: false, minimize: false }) as Record<string, unknown>;
    const legacy = { source: LEGACY_SOURCE, table: doc.table, id: doc.legacyId, ...(doc.matched ? { matched: true } : {}) };
    if (doc.exists) {
      const $set: Record<string, unknown> = { legacy };
      for (const key of Object.keys(doc.set)) if (key in casted) $set[key] = casted[key];
      ops.push({ legacyId: doc.legacyId, insert: false, op: { updateOne: { filter: { _id: doc._id }, update: { $set } } } });
    } else {
      ops.push({ legacyId: doc.legacyId, insert: true, op: { insertOne: { document: { ...casted, legacy, __v: 0 } } } });
    }
  }

  if (dryRun) {
    for (const op of ops) {
      result.ok.add(op.legacyId);
      if (op.insert) result.created++;
      else result.updated++;
    }
  } else {
    for (let i = 0; i < ops.length; i += BATCH_SIZE) {
      const batch = ops.slice(i, i + BATCH_SIZE);
      const failed = new Map<number, string>();
      try {
        await model.collection.bulkWrite(batch.map((b) => b.op) as any, { ordered: false });
      } catch (error) {
        const writeErrors = (error as { writeErrors?: Array<{ index: number; code?: number }> | { index: number; code?: number } }).writeErrors;
        const list = Array.isArray(writeErrors) ? writeErrors : writeErrors ? [writeErrors] : null;
        if (!list) throw error;
        for (const we of list) failed.set(we.index, `write_error_${we.code ?? "unknown"}`);
      }
      batch.forEach((b, index) => {
        const reason = failed.get(index);
        if (reason) {
          report.skip(entity, reason, b.legacyId);
          return;
        }
        result.ok.add(b.legacyId);
        if (b.insert) result.created++;
        else result.updated++;
      });
    }
  }

  const counts = report.entity(entity);
  counts.created += result.created;
  counts.updated += result.updated;
  return result;
}

/** Splits `items` into chunks of `size`. */
export function chunks<T>(items: T[], size = BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
