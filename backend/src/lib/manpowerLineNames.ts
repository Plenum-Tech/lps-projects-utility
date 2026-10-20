import { Brand } from "../models/Brand.js";
import type { IManpowerRow } from "../models/ManpowerPlan.js";

// ---------------------------------------------------------------------------
// A manpower plan line linked to a brand is named after the brand: "Ajmal", or
// "Ajmal - Campaign" for one of its sub-projects (the " - …" / "_…" suffix is
// kept). Lines get the brand's current name when they are created, linked to a
// brand or renamed (every plan save, below), and follow a brand rename
// (lib/brandMove.ts followBrandRename). Lines saved before this rule keep their
// names until they are touched.
// ---------------------------------------------------------------------------

/** The suffix of a name that starts with `brand` ("Ajmal - Campaign" → " - Campaign"), "" for the brand itself, else null. */
function suffixAfter(name: string, brand: string): string | null {
  const n = name.replace(/\s+/g, " ").trim();
  const b = brand.replace(/\s+/g, " ").trim();
  if (!b) return null;
  const lower = n.toLowerCase();
  const key = b.toLowerCase();
  if (lower === key) return "";
  if (lower.startsWith(`${key} -`) || lower.startsWith(`${key}_`)) return n.slice(b.length);
  return null;
}

/** The line name for a brand: the brand's name, keeping a sub-project suffix already written after it. */
export function brandLineName(name: string, brandName: string): string {
  const suffix = suffixAfter(name, brandName);
  return `${brandName.trim()}${suffix ?? ""}`.slice(0, 120);
}

/** After a rename: "Old" → "New", "Old - Campaign" → "New - Campaign"; any other name of a linked line → "New". */
export function renamedLineName(name: string, oldBrand: string, newBrand: string): string {
  const suffix = suffixAfter(name, oldBrand);
  return suffix !== null ? `${newBrand.trim()}${suffix}`.slice(0, 120) : brandLineName(name, newBrand);
}

/**
 * Plan save: brand-linked lines that are new, newly linked to a brand or renamed get the
 * brand's current name (a typed name can't drift from the brand). Untouched lines stay as they are.
 */
export async function nameLinesAfterBrands(rows: IManpowerRow[], before: IManpowerRow[]): Promise<IManpowerRow[]> {
  const prev = new Map(before.map((r) => [r.key, r]));
  const touched = (r: IManpowerRow) => {
    const p = prev.get(r.key);
    return !p || String(p.brand ?? "") !== String(r.brand ?? "") || p.name !== r.name;
  };
  const ids = [...new Set(rows.filter((r) => r.brand && touched(r)).map((r) => String(r.brand)))];
  if (ids.length === 0) return rows;
  const names = new Map((await Brand.find({ _id: { $in: ids } }).select("name").lean()).map((b) => [String(b._id), b.name]));
  return rows.map((r) => {
    if (!r.brand || !touched(r)) return r;
    const brandName = names.get(String(r.brand));
    return brandName ? { ...r, name: brandLineName(r.name, brandName) } : r;
  });
}
