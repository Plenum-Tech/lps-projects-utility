import { Brand } from "../models/Brand.js";
import type { IManpowerRow } from "../models/ManpowerPlan.js";

// ---------------------------------------------------------------------------
// A manpower plan line linked to a brand starts with the brand's name; what follows
// tells the brand's lines apart and is kept: "Ajmal", "Ajmal Social Retainer - GCC +
// Qatar", "Ajmal AA videos". A name that doesn't start with the brand gets it in
// front ("HRU Safa Collection" → "Homes R Us - HRU Safa Collection"); a name that is
// just another spelling of the brand ("HomesRus", "Hershey's") becomes the brand.
// Applied to lines that are new, newly linked or renamed on a save (untouched lines
// keep their names), and on a brand rename only the brand part changes.
// ---------------------------------------------------------------------------

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Where a name starts with the brand written differently ("Mom Store - Occasionwear" for
 * "MomStore"): the index just after that brand part, else -1. Letters and digits only are compared.
 */
function afterBrandSpelling(name: string, brand: string): number {
  const target = squash(brand);
  if (!target) return -1;
  let got = "";
  for (let i = 0; i < name.length; i++) {
    const ch = name[i]!;
    if (/[\p{L}\p{N}]/u.test(ch)) got += ch.toLowerCase();
    if (got.length === target.length) return got === target && !/[\p{L}\p{N}]/u.test(name[i + 1] ?? " ") ? i + 1 : -1;
  }
  return -1;
}

/** What follows the brand at the start of a name ("Ajmal AA videos" → " AA videos"), "" for the brand itself, else null. */
function suffixAfter(name: string, brand: string): string | null {
  const n = name.replace(/\s+/g, " ").trim();
  const b = brand.replace(/\s+/g, " ").trim();
  if (!b) return null;
  const lower = n.toLowerCase();
  const key = b.toLowerCase();
  if (lower === key) return "";
  if (lower.startsWith(key) && /^[\s\-–_:|(]/.test(n.slice(b.length))) return n.slice(b.length);
  return null;
}

/** The line name for a brand: the brand's name first, keeping what tells this line apart. */
export function brandLineName(name: string, brandName: string): string {
  const b = brandName.replace(/\s+/g, " ").trim();
  const n = name.replace(/\s+/g, " ").trim();
  if (!n) return b.slice(0, 120);
  const suffix = suffixAfter(n, b);
  if (suffix !== null) return `${b}${suffix}`.slice(0, 120);
  // Another spelling of the brand ("HomesRus"), or of its start ("SpontiniUAELaunch").
  if (squash(n) === squash(b) || squash(b).startsWith(squash(n))) return b.slice(0, 120);
  // Starts with the brand spelt differently: "Mom Store - Occasionwear" → "MomStore - Occasionwear".
  const at = afterBrandSpelling(n, b);
  if (at > 0) return `${b}${n.slice(at)}`.slice(0, 120);
  return `${b} - ${n}`.slice(0, 120);
}

/** After a brand rename: only the brand part changes ("Old AA videos" → "New AA videos"). */
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
