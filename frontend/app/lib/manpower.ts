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
  { key: "producer", label: "Producer" },
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
  return `${b} - ${n}`;
}

/** The part of a brand line's name after the brand ("Ajmal AA videos" → "AA videos"). */
export function brandLineSuffix(name: string, brandName: string): string {
  const full = brandLineName(name, brandName);
  return full.slice(brandName.trim().length).replace(/^[\s\-–_:|]+/, "");
}
