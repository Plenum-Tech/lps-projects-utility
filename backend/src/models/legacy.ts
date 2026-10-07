import { Schema } from "mongoose";

/**
 * Where an imported document came from (e.g. `{ source: "worksuite", table: "tasks", id: 123 }`).
 * Imports upsert by this reference, so re-running one never creates duplicates.
 * `table` is part of the key because one collection can be fed by several
 * source tables (e.g. task comments from `task_comments` and link-only `task_files`).
 */
export interface ILegacyRef {
  source: string;
  table: string;
  id: number;
  /** True when the import matched a document that already existed (e.g. a user by email). */
  matched?: boolean;
}

export const legacyRefSchema = new Schema<ILegacyRef>(
  {
    source: { type: String, required: true },
    table: { type: String, required: true },
    id: { type: Number, required: true },
    matched: { type: Boolean },
  },
  { _id: false }
);

/** Adds the optional `legacy` field plus its sparse lookup index to an imported model's schema. */
export function addLegacyRef(schema: Schema): void {
  schema.add({ legacy: { type: legacyRefSchema, default: undefined } });
  schema.index({ "legacy.id": 1, "legacy.table": 1, "legacy.source": 1 }, { sparse: true, name: "legacy_ref" });
}
