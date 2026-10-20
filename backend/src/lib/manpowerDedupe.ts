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
// as before (no guessing). Existing lines are never merged or dropped here.
//
// The dedupe helpers below (keep a brand's latest line) are only used by the
// dry-run script scripts/dedupeBrandLines.ts; nothing in the app calls them.
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

/** Brand id → line indexes, for brands with more than one line. */
export function duplicateBrandLines(rows: Array<{ brand?: unknown }>): Map<string, number[]> {
  const byBrand = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const b = brandOf(r);
    if (b) byBrand.set(b, [...(byBrand.get(b) ?? []), i]);
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
  for (const [brand, indexes] of dupes) {
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
