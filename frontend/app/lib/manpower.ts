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
