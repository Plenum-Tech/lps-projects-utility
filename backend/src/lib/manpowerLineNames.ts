import { Brand } from "../models/Brand.js";
import type { IManpowerRow } from "../models/ManpowerPlan.js";

// ---------------------------------------------------------------------------
// A manpower plan line linked to a brand starts with the brand's name; what follows
// tells the brand's lines apart and is kept: "Ajmal", "Ajmal Social Retainer - GCC +
// Qatar", "Ajmal AA videos". A name that doesn't start with the brand gets it in
// front; the brand written another way becomes the brand's exact name ("HomesRus",
// "HRU Safa Collection" → "Homes R Us - Safa Collection", "Sketchers - Ramadan" →
// "Skechers - Ramadan"). Applied to every brand-linked line on every save, so the plan,
// Brands overview and Allocation show the same name; a brand rename changes the brand part.
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

/** Edit distance between two short strings. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * Where a name starts with the brand abbreviated ("HRU" for "Homes R Us") or misspelt before a
 * " - " or as the whole name ("Sketchers - Ramadan", "Dxb Commerce City"): the index after it, else -1.
 */
function nearBrandPrefix(n: string, b: string): number {
  const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const words = b.split(/[\s|&]+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  const first = n.match(/^[\p{L}\p{N}]+/u)?.[0] ?? "";
  if (words.length >= 2 && first.toLowerCase() === words.map((w) => w[0]!.toLowerCase()).join("")) return first.length;
  const target = squash(b);
  const allowed = Math.floor(target.length * 0.3);
  if (allowed < 1) return -1;
  const cuts = [...n.matchAll(/\s[-–|:]\s/g)].map((m) => m.index!).concat(n.length);
  // Common short forms of places: "Dxb Commerce City" for "Dubai Commercity".
  const long = (s: string) => s.replace(/\bdxb\b/gi, "dubai").replace(/\bauh\b/gi, "abu dhabi");
  for (const k of cuts) if (editDistance(squash(long(n.slice(0, k))), target) <= allowed) return k;
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
export function brandLineName(name: string, brandName: string, organisation = ""): string {
  const b = brandName.replace(/\s+/g, " ").trim();
  let n = name.replace(/\s+/g, " ").trim();
  if (!n) return b.slice(0, 120);
  // "ENOC - Zoom" for brand Zoom (organisation ENOC): the brand is one of the name's parts —
  // keep the brand first and drop the organisation part ("Zoom"), never "Zoom - ENOC - Zoom".
  const parts = n.split(/\s+[-–|]\s+/);
  if (parts.length > 1 && parts.some((p) => squash(p) === squash(b))) {
    // What comes before the brand is its organisation ("ENOC - EPPCO"); what follows tells lines apart.
    const at = parts.map((p) => squash(p) === squash(b)).lastIndexOf(true);
    const org = squash(organisation);
    const rest = parts.slice(at + 1).filter((p) => squash(p) !== squash(b) && !(org && squash(p) === org));
    return (rest.length ? `${b} - ${rest.join(" - ")}` : b).slice(0, 120);
  }
  const suffix = suffixAfter(n, b);
  if (suffix !== null) return `${b}${suffix}`.slice(0, 120);
  // Another spelling of the brand ("HomesRus"), or of its start ("SpontiniUAELaunch").
  if (squash(n) === squash(b) || squash(b).startsWith(squash(n))) return b.slice(0, 120);
  // Starts with the brand spelt differently: "Mom Store - Occasionwear" → "MomStore - Occasionwear".
  const at = afterBrandSpelling(n, b);
  if (at > 0) return `${b}${n.slice(at)}`.slice(0, 120);
  // The brand abbreviated or misspelt: "HRU Safa Collection" → "Homes R Us - Safa Collection".
  const near = nearBrandPrefix(n, b);
  if (near >= 0) {
    const rest = n.slice(near).replace(/^[\s\-–_:|]+/, "");
    return (rest ? `${b} - ${rest}` : b).slice(0, 120);
  }
  return `${b} - ${n}`.slice(0, 120);
}

/** After a brand rename: only the brand part changes ("Old AA videos" → "New AA videos"). */
export function renamedLineName(name: string, oldBrand: string, newBrand: string): string {
  const suffix = suffixAfter(name, oldBrand);
  return suffix !== null ? `${newBrand.trim()}${suffix}`.slice(0, 120) : brandLineName(name, newBrand);
}

/**
 * Every plan save: each brand-linked line starts with the brand's exact current name, so the
 * plan, Brands overview and Allocation never show a different spelling ("HomesRus" → "Homes R Us",
 * "Mom Store - Occasionwear" → "MomStore - Occasionwear"); what tells a brand's lines apart is kept.
 */
export async function nameLinesAfterBrands(rows: IManpowerRow[], _before: IManpowerRow[] = []): Promise<IManpowerRow[]> {
  // A line with no brand whose name is a brand's name ("Doshfx") is linked to that brand.
  if (rows.some((r) => !r.brand)) {
    const all = await Brand.find({}).select("name").lean();
    const byName = new Map<string, (typeof all)[number]>();
    for (const x of all) {
      const k = squash(x.name);
      // Only an unambiguous name links (two brands spelt alike: left alone).
      byName.set(k, byName.has(k) ? (null as never) : x);
    }
    rows = rows.map((r) => {
      const hit = r.brand ? null : byName.get(squash(r.name));
      return hit ? { ...r, brand: hit._id as IManpowerRow["brand"] } : r;
    });
  }
  const ids = [...new Set(rows.filter((r) => r.brand).map((r) => String(r.brand)))];
  if (ids.length === 0) return rows;
  const found = await Brand.find({ _id: { $in: ids } }).select("name organisation").lean();
  const names = new Map(found.map((b) => [String(b._id), b.name]));
  const orgs = new Map(found.map((b) => [String(b._id), b.organisation ?? ""]));
  return rows.map((r) => {
    if (!r.brand) return r;
    const brandName = names.get(String(r.brand));
    return brandName ? { ...r, name: brandLineName(r.name, brandName, orgs.get(String(r.brand)) ?? "") } : r;
  });
}
