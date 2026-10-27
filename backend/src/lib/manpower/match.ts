import { projectMonth } from "../projectExpiry.js";

// ---------------------------------------------------------------------------
// Matching helpers for the manpower plan:
//  - people written as first names in the planning sheet → users
//  - brand/project lines ("ENOC - Zoom") → brands
//  - plan rows → the month's projects (brand + type + month + name)
// ---------------------------------------------------------------------------

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const squash = (s: string): string => words(s).join("");

/** A name written in the sheet, for comparing and for name mappings ("Yassimin" → "yassimin"). */
export const personNameKey = (s: string): string => words(s).join(" ");

// ----------------------------------------------------------------- people

/** Spellings used in the sheet → the spelling in the user's name. */
const PERSON_ALIASES: Record<string, string> = {
  maghoub: "mahgoub",
  zahad: "zahadali",
  aisha: "aishah",
  thuraiya: "thouraia",
  mazen: "mazin",
  aniaira: "anaira",
  abdalla: "abdallah",
};

export interface PersonRef {
  _id: string;
  name: string;
  active?: boolean;
}

export type PersonMatch = { kind: "user"; id: string } | { kind: "ambiguous"; ids: string[] } | { kind: "none" };

export class PersonIndex {
  private byFull = new Map<string, string[]>();
  private byFirst = new Map<string, string[]>();
  private byLast = new Map<string, string[]>();

  /**
   * `mappings`: names fixed by hand at import (personNameKey → user id, or null =
   * keep it as an open slot). They win over the automatic match.
   */
  constructor(people: PersonRef[], private mappings: Map<string, string | null> = new Map()) {
    // Active people first, so they win ties against former staff.
    const sorted = [...people].sort((a, b) => Number(b.active !== false) - Number(a.active !== false));
    for (const p of sorted) {
      const w = words(p.name);
      if (w.length === 0) continue;
      push(this.byFull, w.join(" "), p._id);
      push(this.byFirst, w[0]!, p._id);
      if (w.length > 1) push(this.byLast, w[w.length - 1]!, p._id);
    }
  }

  /** The hand-made mapping for a name: a user id, null (an open slot) or undefined (none). */
  mapped(raw: string): string | null | undefined {
    const key = personNameKey(raw);
    return this.mappings.has(key) ? this.mappings.get(key)! : undefined;
  }

  match(raw: string): PersonMatch {
    const w = words(raw).map((x) => PERSON_ALIASES[x] ?? x);
    if (w.length === 0) return { kind: "none" };
    const full = this.byFull.get(w.join(" "));
    if (full?.length === 1) return { kind: "user", id: full[0]! };
    if (w.length > 1) {
      // "Iyad Zidan" style: first + last
      const first = this.byFirst.get(w[0]!) ?? [];
      const last = new Set(this.byLast.get(w[w.length - 1]!) ?? []);
      const both = first.filter((id) => last.has(id));
      if (both.length === 1) return { kind: "user", id: both[0]! };
      return { kind: "none" };
    }
    const one = w[0]!;
    for (const map of [this.byFirst, this.byLast]) {
      const ids = map.get(one);
      if (ids?.length === 1) return { kind: "user", id: ids[0]! };
      if (ids && ids.length > 1) return { kind: "ambiguous", ids };
    }
    return { kind: "none" };
  }
}

function push(map: Map<string, string[]>, key: string, id: string): void {
  const list = map.get(key) ?? [];
  if (!list.includes(id)) list.push(id);
  map.set(key, list);
}

// -------------------------------------------------------------- sheet cells

export interface ParsedCell {
  users: string[];
  placeholders: string[];
  notNeeded: boolean;
  note: string;
  /** Tokens that looked like names but matched nobody (or several people). */
  unmatched: string[];
}

const NOT_NEEDED = /^(x|na|n\/a|nil|none|-|–)$/i;
/** Tokens that describe an open slot rather than a person. */
const SLOT_WORDS = /\b(new|replacement|freelancer|external|availability|tbc|tbd|hire|hiring|ai|egypt|pm)\b/i;

/** "Samer/New PM", "Iyad (Izzat till nov)", "Zakaria/Thuraiya & new", "x". */
export function parseCell(text: string, people: PersonIndex): ParsedCell | null {
  const raw = text.replace(/\s+/g, " ").trim();
  if (!raw) return null;
  if (NOT_NEEDED.test(raw)) return { users: [], placeholders: [], notNeeded: true, note: "", unmatched: [] };
  const notes: string[] = [];
  const body = raw.replace(/\(([^)]*)\)/g, (_m, inner: string) => {
    if (inner.trim()) notes.push(inner.trim());
    return " ";
  });
  const out: ParsedCell = { users: [], placeholders: [], notNeeded: false, note: notes.join("; "), unmatched: [] };
  for (const part of body.split(/\s*(?:\/|\+|&|,|\band\b)\s*/i)) {
    const token = part.replace(/[<>]/g, "").replace(/\.+$/, "").trim();
    if (!token || !/[\p{L}\p{N}]/u.test(token)) continue;
    if (NOT_NEEDED.test(token)) continue;
    const mapped = people.mapped(token);
    if (mapped === null) {
      // Kept as an open slot on purpose (import mapping): not "a name with no user".
      const label = token.charAt(0).toUpperCase() + token.slice(1);
      if (!out.placeholders.includes(label)) out.placeholders.push(label);
      continue;
    }
    const m: PersonMatch =
      mapped !== undefined ? { kind: "user", id: mapped } : SLOT_WORDS.test(token) ? { kind: "none" } : people.match(token);
    if (m.kind === "user") {
      if (!out.users.includes(m.id)) out.users.push(m.id);
      continue;
    }
    const label = token.charAt(0).toUpperCase() + token.slice(1);
    if (!out.placeholders.includes(label)) out.placeholders.push(label);
    if (!SLOT_WORDS.test(token)) out.unmatched.push(token);
  }
  if (out.users.length === 0 && out.placeholders.length === 0 && !out.note) return null;
  return out;
}

// ------------------------------------------------------------------ brands

export interface BrandRef {
  _id: string;
  name: string;
  shortName?: string;
}

/** Spellings in the sheet → brand names. */
const BRAND_ALIASES: Array<[RegExp, string]> = [
  [/\bhru\b/i, "Homes R Us"],
  [/\bdxb commerce ?city\b/i, "Dubai Commercity"],
  [/\bjolibee\b/i, "Jollibee"],
  [/\bjyothi labs\b/i, "Jyothy Labs"],
  [/\bsketchers\b/i, "Skechers"],
];

/** Best brand for a plan line: the longest brand name found in it (later wins a tie, so "ENOC - Zoom" → ZOOM). */
export function matchBrand(label: string, brands: BrandRef[]): string | null {
  let text = label;
  for (const [re, name] of BRAND_ALIASES) text = text.replace(re, name);
  const w = words(text);
  let best: { id: string; len: number; pos: number } | null = null;
  for (const b of brands) {
    for (const candidate of [b.name, b.shortName ?? ""]) {
      const target = squash(candidate);
      if (target.length < 2) continue;
      for (let i = 0; i < w.length; i++) {
        let acc = "";
        for (let j = i; j < w.length && acc.length < target.length; j++) {
          acc += w[j];
          if (acc === target) {
            if (!best || target.length > best.len || (target.length === best.len && i > best.pos)) {
              best = { id: b._id, len: target.length, pos: i };
            }
          }
        }
      }
    }
  }
  if (best) return best.id;
  // "Afnan" → "Afnan Perfumes": the line starts with a brand's first word.
  const first = w[0];
  if (first && first.length >= 4) {
    const hits = brands.filter((b) => words(b.name)[0] === first);
    if (hits.length === 1) return hits[0]!._id;
  }
  return null;
}

// --------------------------------------------------- plan rows → projects

export interface LinkRow {
  key: string;
  brand: string | null;
  type: string | null;
  name: string;
}

export interface LinkProject {
  _id: string;
  name: string;
  brand: string | null;
  naming?: { type?: string; month?: string; title?: string } | null;
  deadline?: Date | null;
  /** Row chosen on the project (wins over the automatic match). */
  manpowerRow?: string | null;
}

const STOP = new Set([
  "project", "projects", "program", "campaign", "retainer", "the", "and", "of", "for", "x",
  "social", "media", "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december",
]);

/** Short forms used in plan lines and project names. */
const SYNONYMS: Record<string, string> = { tt: "tiktok", ig: "instagram", insta: "instagram" };
const norm = (w: string) => SYNONYMS[w] ?? w;

/** Words that set a line apart: not the brand, not another brand's name, not filler. */
function specificWords(text: string, brandName: string, brandSquashes: Set<string>): string[] {
  let t = text;
  for (const [re, name] of BRAND_ALIASES) t = t.replace(re, name);
  const brandWords = new Set(words(brandName));
  const own = squash(brandName);
  return [...new Set(words(t).map(norm))].filter(
    (w) => !STOP.has(w) && !brandWords.has(w) && w !== own && !brandSquashes.has(w) && !/^\d+$/.test(w)
  );
}

/**
 * Links the month's projects to plan rows: same brand, same month (naming month,
 * month in the name, or deadline month), same type when both have one, and the
 * row's distinctive words found in the project name. A brand's only row takes all
 * its projects; otherwise a project matching no row stays unlinked (brand level).
 */
export function linkProjectsToRows(
  month: string,
  rows: LinkRow[],
  projects: LinkProject[],
  brandNames: Map<string, string>
): Map<string, string> {
  const links = new Map<string, string>();
  const rowKeys = new Set(rows.map((r) => r.key));
  const brandSquashes = new Set([...brandNames.values()].map(squash).filter((x) => x.length >= 3));
  const rowsByBrand = new Map<string, LinkRow[]>();
  for (const r of rows) {
    if (!r.brand) continue;
    rowsByBrand.set(r.brand, [...(rowsByBrand.get(r.brand) ?? []), r]);
  }
  for (const p of projects) {
    if (projectMonth({ name: p.name, naming: p.naming as never, deadline: p.deadline ?? null }) !== month) continue;
    // Chosen on the project: always that row.
    if (p.manpowerRow && rowKeys.has(p.manpowerRow)) {
      links.set(p._id, p.manpowerRow);
      continue;
    }
    if (!p.brand) continue;
    const candidates = rowsByBrand.get(p.brand);
    if (!candidates?.length) continue;
    const brandName = brandNames.get(p.brand) ?? "";
    const projectWords = new Set([...words(p.name), ...words(p.naming?.title ?? ""), ...words(p.naming?.type ?? "")].map(norm));
    let best: { key: string; score: number } | null = null;
    for (const r of candidates) {
      if (r.type && p.naming?.type && r.type.toLowerCase() !== p.naming.type.toLowerCase()) continue;
      const specific = specificWords(r.name, brandName, brandSquashes);
      const score = specific.length === 0 ? 0.4 : specific.filter((w) => projectWords.has(w)).length / specific.length;
      if (!best || score > best.score) best = { key: r.key, score };
    }
    if (best && best.score >= 0.4) links.set(p._id, best.key);
    else if (candidates.length === 1) links.set(p._id, candidates[0]!.key);
  }
  return links;
}
