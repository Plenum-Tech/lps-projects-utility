import type { ManpowerRow, ManpowerRowInput } from "@/types";

/** Fallback role columns (the server sends the same list with GET /manpower). */
export const MANPOWER_ROLE_FALLBACK = [
  { key: "programLead", label: "Program Lead" },
  { key: "pm", label: "SPM / PM" },
  { key: "programExecution", label: "Program Execution" },
  { key: "socialMedia", label: "Social Media Manager / Creator" },
  { key: "videographer", label: "Videographer" },
  { key: "juniorVideo", label: "Junior Video" },
  { key: "editor", label: "Editor" },
  { key: "creativeLead", label: "Creative Lead" },
  { key: "englishCopy", label: "English Copy" },
  { key: "arabicCopy", label: "Arabic Copy" },
  { key: "artDirector", label: "Art Director" },
  { key: "designer", label: "Designer" },
  { key: "animator", label: "Animator" },
  { key: "producer", label: "Production Lead" },
  { key: "cmLead", label: "CM Lead" },
  { key: "communityManager", label: "Community Manager" },
];

/** Project team roles: the plan roles plus "Others". */
export const TEAM_OTHERS = { key: "others", label: "Others" };

/** "2026-10" ± n months. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** First name for compact cells ("Zahadali Tinwala" → "Zahadali"). */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** Populated plan row → the shape POST /manpower/:month takes. */
export function rowToInput(row: ManpowerRow): ManpowerRowInput {
  return {
    key: row.key,
    section: row.section,
    brand: row.brand?._id ?? null,
    type: row.type,
    name: row.name,
    cells: row.cells.map((c) => ({
      role: c.role,
      users: c.users.map((u) => u._id),
      placeholders: [...c.placeholders],
      notNeeded: c.notNeeded,
      note: c.note,
    })),
  };
}

export function newRowKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `row-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

/**
 * A brand-linked plan line starts with the brand's name; what follows tells the brand's
 * lines apart and is kept ("Ajmal AA videos"). A name without the brand gets it in front
 * ("HRU Safa Collection" → "Homes R Us - HRU Safa Collection"); another spelling of the
 * brand becomes the brand. Same rule as the server (backend lib/manpowerLineNames.ts).
 */
export function brandLineName(name: string, brandName: string): string {
  const b = brandName.replace(/\s+/g, " ").trim();
  const n = name.replace(/\s+/g, " ").trim();
  if (!n) return b;
  const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const lower = n.toLowerCase();
  const key = b.toLowerCase();
  if (lower === key) return b;
  if (lower.startsWith(key) && /^[\s\-–_:|(]/.test(n.slice(b.length))) return `${b}${n.slice(b.length)}`;
  if (squash(n) === squash(b) || squash(b).startsWith(squash(n))) return b;
  // Starts with the brand spelt differently: "Mom Store - Occasionwear" → "MomStore - Occasionwear".
  const target = squash(b);
  let got = "";
  for (let i = 0; i < n.length; i++) {
    const ch = n[i]!;
    if (/[\p{L}\p{N}]/u.test(ch)) got += ch.toLowerCase();
    if (got.length === target.length) {
      if (got === target && !/[\p{L}\p{N}]/u.test(n[i + 1] ?? " ")) return `${b}${n.slice(i + 1)}`;
      break;
    }
  }
  // The brand abbreviated or misspelt: "HRU Safa Collection" → "Homes R Us - Safa Collection".
  const near = nearBrandPrefix(n, b);
  if (near >= 0) {
    const rest = n.slice(near).replace(/^[\s\-–_:|]+/, "");
    return rest ? `${b} - ${rest}` : b;
  }

  return `${b} - ${n}`;
}

/** The part of a brand line's name after the brand ("Ajmal AA videos" → "AA videos"). */
export function brandLineSuffix(name: string, brandName: string): string {
  const full = brandLineName(name, brandName);
  return full.slice(brandName.trim().length).replace(/^[\s\-–_:|]+/, "");
}
