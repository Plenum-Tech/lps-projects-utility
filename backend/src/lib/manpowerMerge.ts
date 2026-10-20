import mongoose from "mongoose";
import type { IManpowerCell, IManpowerRow, ManpowerSection } from "../models/ManpowerPlan.js";

// ---------------------------------------------------------------------------
// Manpower plan merges. A save is turned into a delta (what it changed against
// the rows it was made on) so it can be laid onto another version:
//  - a non-leader saving while a version is already pending: their delta goes
//    onto the pending rows, so the changes waiting for approval add up instead
//    of the newest save replacing the earlier ones;
//  - leadership saving (approved at once) while a version is pending: the
//    pending version's delta is re-applied on the new approved rows (a rebase),
//    so the work waiting for approval survives.
// Granularity: per line (added / removed), per line field (name, brand, type,
// section) and per role cell (people, open slots, not needed, note as a whole).
// ---------------------------------------------------------------------------

const FIELDS = ["name", "brand", "type", "section"] as const;
type Field = (typeof FIELDS)[number];
type RowFields = Partial<{ name: string; brand: mongoose.Types.ObjectId | null; type: string | null; section: ManpowerSection }>;

export interface PlanDelta {
  /** Lines the save added (whole rows). */
  added: IManpowerRow[];
  /** Keys of lines the save removed. */
  removed: string[];
  /** Per line key: the line fields that changed (new values). */
  fields: Record<string, RowFields>;
  /** Per line key → role: the new cell, or null when the cell was cleared. */
  cells: Record<string, Record<string, IManpowerCell | null>>;
}

const idOf = (v: unknown): string => (v && typeof v === "object" && "_id" in (v as object) ? String((v as { _id: unknown })._id) : v ? String(v) : "");
const oid = (v: unknown): mongoose.Types.ObjectId | null => {
  const s = idOf(v);
  return s && mongoose.isValidObjectId(s) ? new mongoose.Types.ObjectId(s) : null;
};

/** A plain copy of a cell (works for lean rows, documents and populated ones). */
export function cloneCell(c: IManpowerCell): IManpowerCell {
  return {
    role: c.role,
    users: (c.users ?? []).map(oid).filter((u): u is mongoose.Types.ObjectId => Boolean(u)),
    placeholders: [...(c.placeholders ?? [])],
    notNeeded: Boolean(c.notNeeded),
    note: c.note ?? "",
  };
}

/** A plain copy of a row (works for lean rows, documents and populated ones). */
export function cloneRow(r: IManpowerRow): IManpowerRow {
  return {
    key: r.key,
    section: r.section ?? "active",
    brand: oid(r.brand),
    type: r.type ?? null,
    name: r.name,
    cells: (r.cells ?? []).map(cloneCell),
  };
}

const cellKey = (c: IManpowerCell | undefined | null): string =>
  c ? JSON.stringify([(c.users ?? []).map(idOf).sort(), [...(c.placeholders ?? [])], Boolean(c.notNeeded), c.note ?? ""]) : "";

const fieldValue = (r: IManpowerRow, f: Field): string => (f === "brand" ? idOf(r.brand) : String(r[f] ?? ""));

/** What `after` changed against `before`, by line key. */
export function planDelta(before: IManpowerRow[], after: IManpowerRow[]): PlanDelta {
  const delta: PlanDelta = { added: [], removed: [], fields: {}, cells: {} };
  const old = new Map(before.map((r) => [r.key, r]));
  const now = new Set(after.map((r) => r.key));
  for (const r of after) {
    const prev = old.get(r.key);
    if (!prev) {
      delta.added.push(cloneRow(r));
      continue;
    }
    for (const f of FIELDS) {
      if (fieldValue(prev, f) !== fieldValue(r, f)) {
        const next = cloneRow(r);
        (delta.fields[r.key] ??= {})[f] = next[f] as never;
      }
    }
    const roles = new Set([...(prev.cells ?? []), ...(r.cells ?? [])].map((c) => c.role));
    for (const role of roles) {
      const b = (prev.cells ?? []).find((c) => c.role === role);
      const a = (r.cells ?? []).find((c) => c.role === role);
      if (cellKey(b) !== cellKey(a)) (delta.cells[r.key] ??= {})[role] = a ? cloneCell(a) : null;
    }
  }
  for (const r of before) if (!now.has(r.key)) delta.removed.push(r.key);
  return delta;
}

export function deltaIsEmpty(d: PlanDelta): boolean {
  return !d.added.length && !d.removed.length && !Object.keys(d.fields).length && !Object.keys(d.cells).length;
}

/**
 * Lays a delta onto `target`: removed lines go, changed fields / cells are set on
 * the target's lines with the same key, added lines are appended (or replace the
 * target's line with the same key). The target's line order is kept.
 */
export function applyPlanDelta(target: IManpowerRow[], delta: PlanDelta): IManpowerRow[] {
  const removed = new Set(delta.removed);
  const out = target.filter((r) => !removed.has(r.key)).map(cloneRow);
  for (const row of out) {
    const fields = delta.fields[row.key];
    if (fields) for (const f of Object.keys(fields) as Field[]) (row as unknown as Record<string, unknown>)[f] = fields[f] ?? null;
    if (fields && "section" in fields && !fields.section) row.section = "active";
    const cells = delta.cells[row.key];
    if (!cells) continue;
    for (const [role, cell] of Object.entries(cells)) {
      const i = row.cells.findIndex((c) => c.role === role);
      if (cell === null) {
        if (i >= 0) row.cells.splice(i, 1);
      } else if (i >= 0) row.cells[i] = cloneCell(cell);
      else row.cells.push(cloneCell(cell));
    }
  }
  // Added lines are appended; one the target already has (same key) takes the saved content in place.
  for (const r of delta.added) {
    const i = out.findIndex((x) => x.key === r.key);
    if (i >= 0) out[i] = cloneRow(r);
    else out.push(cloneRow(r));
  }
  return out;
}

/**
 * `delta` without what `winner` also changed (same line field, same role cell,
 * same added line; a removal of a line `winner` changed). Used when rebasing a
 * pending version on leadership's newer approved save: leadership's direct
 * edit of a cell wins over the older proposal for that cell.
 */
export function withoutConflicts(delta: PlanDelta, winner: PlanDelta): PlanDelta {
  const winnerAdded = new Set(winner.added.map((r) => r.key));
  const touched = (key: string) => winnerAdded.has(key) || key in winner.fields || key in winner.cells;
  const fields: PlanDelta["fields"] = {};
  for (const [key, f] of Object.entries(delta.fields)) {
    const keep = Object.fromEntries(Object.entries(f).filter(([name]) => !(winner.fields[key] && name in winner.fields[key]!)));
    if (Object.keys(keep).length) fields[key] = keep as RowFields;
  }
  const cells: PlanDelta["cells"] = {};
  for (const [key, c] of Object.entries(delta.cells)) {
    const keep = Object.fromEntries(Object.entries(c).filter(([role]) => !(winner.cells[key] && role in winner.cells[key]!)));
    if (Object.keys(keep).length) cells[key] = keep;
  }
  return {
    added: delta.added.filter((r) => !winnerAdded.has(r.key)),
    removed: delta.removed.filter((key) => !touched(key)),
    fields,
    cells,
  };
}

/** "MomStore: 4 team changes" + "Tasjeel: 12 team changes" → "MomStore: 4 team changes; Tasjeel: 12 team changes". */
export function combineNotes(earlier: string, later: string, max: number): string {
  const parts = [...earlier.split(/;\s*/), ...later.split(/;\s*/)].map((p) => p.trim()).filter(Boolean);
  const text = [...new Set(parts)].join("; ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
