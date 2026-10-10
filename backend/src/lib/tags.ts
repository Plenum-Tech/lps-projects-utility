// ---------------------------------------------------------------------------
// Project and task tags (shared with Pearity).
//
//   project tag = BRAND-MONTH-TYPE-NAME          e.g. AJMA-OCT26-PRG-GH
//   task tag    = <project tag>-<UNIT><QTY>       e.g. AJMA-OCT26-PRG-GH-VID3
//
// Each part is an uppercase abbreviation. Tags are unique: a clash gets "-2",
// "-3" … appended. Tasks without a controlled name use T<number> for the last
// part; tasks without a project use TASK-<number>.
// ---------------------------------------------------------------------------

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** Known project types → three letters. */
const TYPE_ABBR: Record<string, string> = {
  campaign: "CMP",
  program: "PRG",
  programme: "PRG",
  project: "PRJ",
  retainer: "RET",
  pitch: "PIT",
};

const words = (s: string): string[] =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);

const splitCamel = (w: string): string[] => w.replace(/([a-z])([A-Z])/g, "$1 $2").split(" ");
const isAcronym = (w: string, maxLen: number) => /^[A-Z0-9]+$/.test(w) && w.length <= maxLen;

/**
 * Abbreviation, uppercase:
 *  - one word: an acronym stays whole ("GITEX", "ENOC"); camel case gives initials
 *    ("TikTok" → "TT"); otherwise its first `single` letters ("Ajmal" → "AJMA");
 *  - several words: initials, with numbers and short acronyms kept whole
 *    ("GenAI Hub" → "GH", "UK Retainer Social Media" → "UKRSM", "Social 360" → "S360").
 */
export function abbreviate(text: string | null | undefined, single = 4, max = 6): string {
  const w = words(text ?? "");
  if (w.length === 0) return "";
  if (w.length === 1) {
    const x = w[0]!;
    if (/^\d+$/.test(x) || isAcronym(x, 5)) return x.toUpperCase();
    const parts = splitCamel(x);
    if (parts.length > 1) return parts.map((p) => p[0]!).join("").toUpperCase();
    return x.slice(0, single).toUpperCase();
  }
  return w
    .map((x) => (/^\d+$/.test(x) || isAcronym(x, 3) ? x : x[0]!))
    .join("")
    .slice(0, max)
    .toUpperCase();
}

/** Brand part: the brand's short name when set (letters/digits only), else an abbreviation. */
export function brandTag(name: string | null | undefined, shortName?: string | null): string {
  const short = (shortName ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8);
  return short || abbreviate(name, 4, 5);
}

/** "2026-10" → "OCT26"; "" when not a month. */
export function monthTag(month: string | null | undefined): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month ?? "");
  if (!m || Number(m[1]) < 2020 || Number(m[1]) > 2040) return "";
  return `${MONTHS[Number(m[2]) - 1]}${m[1]!.slice(2)}`;
}

export function typeTag(type: string | null | undefined): string {
  const t = (type ?? "").trim().toLowerCase();
  if (!t) return "";
  return TYPE_ABBR[t] ?? abbreviate(type, 3, 4);
}

export interface ProjectTagParts {
  brandName?: string | null;
  brandShortName?: string | null;
  month?: string | null;
  type?: string | null;
  title?: string | null;
}

/** BRAND-MONTH-TYPE-NAME (missing parts are left out); "PROJECT" when nothing is known. */
export function buildProjectTag(parts: ProjectTagParts): string {
  const pieces = [
    brandTag(parts.brandName, parts.brandShortName),
    monthTag(parts.month),
    typeTag(parts.type),
    abbreviate(parts.title, 4, 6),
  ].filter(Boolean);
  return pieces.length ? pieces.join("-") : "PROJECT";
}

/** Scope unit + quantity: "Video", 3 → "VID3". */
export function unitTag(unit: string | null | undefined, quantity: number | null | undefined): string {
  const u = abbreviate(unit, 3, 4);
  const q = quantity && quantity > 0 ? String(quantity) : "";
  return `${u}${q}`;
}

export interface TaskTagParts {
  projectTag: string | null;
  titleParts?: { unit?: string; quantity?: number } | null;
  number?: number | null;
}

/** <project tag>-<UNIT><QTY>; T<number> without a controlled name; TASK-<number> without a project. */
export function buildTaskTag(parts: TaskTagParts): string {
  const n = parts.number ? String(parts.number) : "";
  if (!parts.projectTag) return n ? `TASK-${n}` : "TASK";
  const unit = parts.titleParts?.unit ? unitTag(parts.titleParts.unit, parts.titleParts.quantity) : "";
  return `${parts.projectTag}-${unit || (n ? `T${n}` : "T")}`;
}

/** Escapes a tag for an anchored regex. */
function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * First free tag for `base` given the tags already taken that start with it:
 * base, base-2, base-3 …
 */
export function firstFreeTag(base: string, taken: Iterable<string>): string {
  const set = new Set([...taken].map((t) => t.toUpperCase()));
  if (!set.has(base.toUpperCase())) return base;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base}-${i}`;
    if (!set.has(candidate.toUpperCase())) return candidate;
  }
  return `${base}-${Date.now().toString(36).toUpperCase()}`;
}

/** Mongo filter matching `base` and its numbered variants (base-2, base-3 …). */
export function tagFamilyFilter(base: string): { $regex: RegExp } {
  return { $regex: new RegExp(`^${escape(base)}(-\\d+)?$`, "i") };
}
