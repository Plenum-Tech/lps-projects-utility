import mongoose from "mongoose";
import { ManpowerPlan, type IManpowerCell, type IManpowerRow } from "../models/ManpowerPlan.js";
import { brandLineName } from "./manpowerLineNames.js";
import { MANPOWER_ROLE_KEYS } from "./manpowerRoles.js";

// ---------------------------------------------------------------------------
// Duplicate manpower plan lines.
//
// Prevention (used by every path that would ADD a line): a brand's line is reused
// instead of adding another when it is the same brand AND the same line name
// (case / spaces ignored), or when the brand has exactly one line in the month.
// A brand with several distinctly named lines and no name match gets a new line
// as before (no guessing).
//
// Clean-up on every plan save (dropDuplicateLinesOnSave): a brand's lines with the
// SAME name are merged into one — the line edited in this save, else the one edited
// most recently, is kept with its own people; the others are dropped and projects
// pinned to them move to the kept line. Differently named lines of one brand
// (ENOC - Tasjeel / ENOC - EPPCO) always stay. scripts/dedupeBrandLines.ts does the
// same for a month on demand.
// ---------------------------------------------------------------------------

const brandOf = (r: { brand?: unknown }): string | null => {
  const b = r.brand as unknown;
  if (!b) return null;
  const id = typeof b === "object" && b !== null && "_id" in (b as object) ? (b as { _id: unknown })._id : b;
  return String(id);
};

/** A line name for comparing: lower case, spaces collapsed. */
export function lineNameKey(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The existing line of `brand` a new line would duplicate: the brand's line with the same
 * name (case / spaces ignored), else the brand's only line. Null: add a new line.
 */
export function reusableLine<R extends { key: string; brand?: unknown; name: string }>(rows: R[], brand: unknown, name: string): R | null {
  const id = brand ? String((brand as { _id?: unknown })._id ?? brand) : null;
  if (!id) return null;
  const lines = rows.filter((r) => brandOf(r) === id);
  return lines.find((r) => lineNameKey(r.name) === lineNameKey(name)) ?? (lines.length === 1 ? lines[0]! : null);
}

/** The line's cells with the team's people added (per plan role; nobody is taken off). */
export function cellsWithTeam(current: IManpowerCell[], team: Array<{ role: string; users: Array<mongoose.Types.ObjectId | string> }>): IManpowerCell[] {
  const out = current.map((c) => ({ ...c, users: [...(c.users ?? [])], placeholders: [...(c.placeholders ?? [])] }));
  for (const t of team) {
    if (!MANPOWER_ROLE_KEYS.includes(t.role) || !t.users.length) continue;
    let cell = out.find((c) => c.role === t.role);
    if (!cell) {
      cell = { role: t.role, users: [], placeholders: [], notNeeded: false, note: "" };
      out.push(cell);
    }
    const have = new Set(cell.users.map(String));
    for (const u of t.users) if (!have.has(String(u))) cell.users.push(new mongoose.Types.ObjectId(String(u)));
    if (cell.users.length) cell.notNeeded = false;
  }
  return out;
}

// ------------------------------------------------ dedupe (script only, dry run)

export interface DroppedBrandLines {
  brand: string;
  keptKey: string;
  keptName: string;
  droppedKeys: string[];
  droppedNames: string[];
}

/** The line to keep among one brand's lines (indexes into `rows`): latest first-seen version, then later row order. */
export function latestLineIndex(rows: Array<{ key: string }>, indexes: number[], firstSeen?: Map<string, number>): number {
  const age = (i: number) => firstSeen?.get(rows[i]!.key) ?? Number.POSITIVE_INFINITY;
  let best = indexes[0]!;
  for (const i of indexes.slice(1)) if (age(i) >= age(best)) best = i;
  return best;
}

/** Brand id → line indexes, for a brand with several lines of the SAME name (differently named lines, e.g. ENOC - Tasjeel / ENOC - EPPCO, stay). */
export function duplicateBrandLines(rows: Array<{ brand?: unknown; name: string }>): Map<string, number[]> {
  const byBrand = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const b = brandOf(r);
    if (b) {
      const k = `${b}|${lineNameKey(r.name)}`;
      byBrand.set(k, [...(byBrand.get(k) ?? []), i]);
    }
  });
  for (const [b, list] of byBrand) if (list.length < 2) byBrand.delete(b);
  return byBrand;
}

/** One line per brand: the latest line of each brand is kept (in its place, its own people), the others dropped. */
export function dedupeBrandLines<R extends IManpowerRow>(
  rows: R[],
  options: { firstSeen?: Map<string, number>; brandNames?: Map<string, string> } = {}
): { rows: R[]; dropped: DroppedBrandLines[] } {
  const dupes = duplicateBrandLines(rows);
  if (dupes.size === 0) return { rows, dropped: [] };
  const drop = new Set<number>();
  const rename = new Map<number, string>();
  const dropped: DroppedBrandLines[] = [];
  for (const [group, indexes] of dupes) {
    const brand = group.split("|")[0]!;
    const keep = latestLineIndex(rows, indexes, options.firstSeen);
    const brandName = options.brandNames?.get(brand);
    const keptName = brandName ? brandLineName(rows[keep]!.name, brandName) : rows[keep]!.name;
    if (keptName !== rows[keep]!.name) rename.set(keep, keptName);
    const others = indexes.filter((i) => i !== keep);
    for (const i of others) drop.add(i);
    dropped.push({ brand, keptKey: rows[keep]!.key, keptName, droppedKeys: others.map((i) => rows[i]!.key), droppedNames: others.map((i) => rows[i]!.name) });
  }
  const out = rows.flatMap((r, i) => (drop.has(i) ? [] : rename.has(i) ? [{ ...r, name: rename.get(i)! }] : [r]));
  return { rows: out, dropped };
}

/** Line key → the version of `month` it first appeared in (all versions, oldest → newest). */
export async function firstSeenVersion(month: string): Promise<Map<string, number>> {
  const versions = await ManpowerPlan.find({ month }).sort({ version: 1 }).select("version rows.key").lean();
  const seen = new Map<string, number>();
  for (const v of versions) for (const r of v.rows ?? []) if (!seen.has(r.key)) seen.set(r.key, v.version);
  return seen;
}

/** Line key → the version of `month` in which the line's people last changed: the most recently edited line wins a dedupe. */
export async function lastChangedVersion(month: string): Promise<Map<string, number>> {
  const versions = await ManpowerPlan.find({ month }).sort({ version: 1 }).select("version rows.key rows.name rows.cells").lean();
  const sig = new Map<string, string>();
  const changed = new Map<string, number>();
  for (const v of versions)
    for (const r of v.rows ?? []) {
      const s = JSON.stringify((r.cells ?? []).map((c) => [c.role, (c.users ?? []).map(String).sort()]));
      if (sig.get(r.key) !== s) {
        sig.set(r.key, s);
        changed.set(r.key, v.version);
      }
    }
  return changed;
}

/**
 * A plan save's rows without same-named duplicate lines of one brand. The line edited in
 * this save (name or people differ from `previous`, or new) wins; else the one edited most
 * recently in the month's history; a tie keeps the later line. `repin`: dropped key → kept key.
 */
export async function dropDuplicateLinesOnSave(
  month: string,
  previous: IManpowerRow[],
  rows: IManpowerRow[]
): Promise<{ rows: IManpowerRow[]; repin: Map<string, string> }> {
  const repin = new Map<string, string>();
  // Brand-linked lines carry the brand's exact name first (lines spelt differently can then meet).
  const { nameLinesAfterBrands } = await import("./manpowerLineNames.js");
  rows = await nameLinesAfterBrands(rows);
  if (duplicateBrandLines(rows).size === 0) return { rows, repin };
  // "Edited in this save": its people changed (a name only re-spelt to the brand's doesn't count).
  const sig = (r: IManpowerRow) => JSON.stringify([(r.cells ?? []).map((c) => [c.role, (c.users ?? []).map(String).sort(), Boolean(c.notNeeded)])]);
  const before = new Map(previous.map((r) => [r.key, sig(r)]));
  const changed = await lastChangedVersion(month);
  for (const r of rows) if (before.get(r.key) !== sig(r)) changed.set(r.key, Number.MAX_SAFE_INTEGER);
  const out = dedupeBrandLines(rows, { firstSeen: changed });
  for (const d of out.dropped) for (const k of d.droppedKeys) repin.set(k, d.keptKey);
  return { rows: out.rows, repin };
}

