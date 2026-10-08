// ---------------------------------------------------------------------------
// Structured project names: `Brand_Type_MonYYYY_Name`, e.g.
// "Wasl_Campaign_Oct2026_JGE Launch". Pure helpers (no DB) shared by the
// projects controller, the Excel import and the legacy-name detection.
// ---------------------------------------------------------------------------

import { cleanSegment, isDateToken, normaliseKey, splitSegments } from "./worksuite/brandSuggest.js";

export const PROJECT_NAMING_LIMITS = { titleMax: 80, typeMax: 30, maxTypes: 30 } as const;

/** Default Type list (admins manage it in Settings → Projects). */
export const DEFAULT_PROJECT_TYPES = ["Campaign", "Program", "Project"] as const;

/** Parts are joined with this; it is not allowed inside any part. */
export const NAMING_SEPARATOR = "_";

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Whitespace collapsed and trimmed. */
export function tidy(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** "2026-10" → "Oct2026". */
export function formatNamingMonth(month: string): string {
  const [year, mm] = month.split("-");
  return `${MONTH_ABBR[Number(mm) - 1] ?? "???"}${year}`;
}

/** The composed name. */
export function composeProjectName(brandName: string, type: string, month: string, title: string): string {
  return [tidy(brandName), tidy(type), formatNamingMonth(month), tidy(title)].join(NAMING_SEPARATOR);
}

function monthIndex(word: string): number {
  const w = word.toLowerCase().replace(/[.,]$/, "");
  if (w.length < 3) return -1;
  const full = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const idx = full.findIndex((m) => m.startsWith(w) || (w === "sept" && m === "september"));
  return idx;
}

function yearOf(text: string): number | null {
  const t = text.replace(/^['’@]/, "");
  if (/^20\d{2}$/.test(t)) return Number(t);
  if (/^\d{2}$/.test(t)) return 2000 + Number(t);
  return null;
}

function monthKey(year: number, monthIdx: number): string {
  return `${year}-${String(monthIdx + 1).padStart(2, "0")}`;
}

/**
 * Month input → "YYYY-MM": "2026-10", "Oct2026", "Oct 2026", "October 2026",
 * "Oct'26", "10/2026", a Date (Excel cell) or "2026-10-01". null = not a month.
 */
export function parseMonthInput(raw: unknown): string | null {
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    return monthKey(raw.getUTCFullYear(), raw.getUTCMonth());
  }
  if (typeof raw !== "string") return null;
  const text = tidy(raw);
  if (MONTH_KEY.test(text)) return text;
  let m = /^(\d{4})-(0[1-9]|1[0-2])-\d{2}(?:T.*)?$/.exec(text);
  if (m) return `${m[1]}-${m[2]}`;
  m = /^(0?[1-9]|1[0-2])[/.-](20\d{2})$/.exec(text);
  if (m) return monthKey(Number(m[2]), Number(m[1]) - 1);
  m = /^([A-Za-z]+)\.?[\s'’@-]*(\d{2}|\d{4})$/.exec(text);
  if (m) {
    const idx = monthIndex(m[1]!);
    const year = yearOf(m[2]!);
    if (idx >= 0 && year !== null) return monthKey(year, idx);
  }
  return null;
}

/** "Campaigns" / "Programme" → the configured type it names ("Campaign" / "Program"), or null. */
export function matchType(word: string, types: readonly string[]): string | null {
  const w = normaliseKey(word);
  if (!w) return null;
  const variants = (t: string) => {
    const k = normaliseKey(t);
    return [k, `${k}s`, `${k}es`, k === "program" ? "programme" : "", k === "program" ? "programmes" : ""].filter(Boolean);
  };
  return types.find((t) => variants(t).includes(w)) ?? null;
}

export interface ParsedStructuredName {
  brand: string;
  type: string;
  month: string;
  title: string;
}

/** "Wasl_Campaign_Oct2026_JGE Launch" → its four parts (exactly four, valid month); else null. */
export function parseStructuredName(name: string): ParsedStructuredName | null {
  const parts = name.split(NAMING_SEPARATOR).map(tidy);
  if (parts.length !== 4 || parts.some((p) => !p)) return null;
  const month = parseMonthInput(parts[2]!);
  if (!month) return null;
  return { brand: parts[0]!, type: parts[1]!, month, title: parts[3]! };
}

export interface NamingDetection {
  type: string | null;
  month: string | null;
  title: string;
}

/**
 * Best-effort type / month / title from a legacy (Worksuite) name, using the
 * same segment + date heuristics as brand suggestions. E.g.
 * "June 2025 | Program | Wasl | 360 Social" (brand Wasl) → Program / 2025-06 / "360 Social".
 * A month without a year ("Ajmal | March | Social") takes a year found elsewhere
 * in the name, else `fallbackYear` (the project's start year).
 */
export function detectLegacyNaming(
  name: string,
  types: readonly string[],
  brandName?: string | null,
  fallbackYear?: number | null
): NamingDetection {
  const structured = parseStructuredName(name);
  if (structured) {
    return {
      type: matchType(structured.type, types),
      month: structured.month,
      title: structured.title.slice(0, PROJECT_NAMING_LIMITS.titleMax),
    };
  }

  const words = tidy(name.replace(/[\u200B-\u200D\uFEFF]/g, " "))
    .split(/[\s|_/,()[\]–—-]+/)
    .filter(Boolean);

  // Month: "June 2025", "June 25", "Jun'25", "Oct2026", "Q3 Oct 2026".
  let month: string | null = null;
  let monthNoYear = -1;
  const segments = new Set(splitSegments(name).map((seg) => seg.toLowerCase()));
  for (let i = 0; i < words.length && !month; i++) {
    const word = words[i]!;
    const glued = /^([A-Za-z]{3,9})['’@.]?(\d{2}|20\d{2})$/.exec(word);
    if (glued) {
      const idx = monthIndex(glued[1]!);
      if (idx >= 0) {
        month = monthKey(yearOf(glued[2]!)!, idx);
        break;
      }
    }
    const idx = /^[A-Za-z]{3,9}\.?$/.test(word) ? monthIndex(word) : -1;
    if (idx < 0) continue;
    // "May" / "March" are also plain words: without a year only as a segment of their own.
    const next = words[i + 1];
    const year = next ? yearOf(next) : null;
    if (year !== null) month = monthKey(year, idx);
    else if (monthNoYear < 0 && word.length >= 3 && (!/^(may|march)$/i.test(word) || segments.has(word.toLowerCase()))) {
      monthNoYear = idx;
    }
  }
  if (!month && monthNoYear >= 0) {
    const yearWord = words.find((w) => /^20\d{2}$/.test(w));
    const year = yearWord ? Number(yearWord) : fallbackYear;
    if (year) month = monthKey(year, monthNoYear);
  }

  // Type: the first word naming a configured type.
  let type: string | null = null;
  for (const word of words) {
    type = matchType(word, types);
    if (type) break;
  }

  // Title: segments that aren't only dates / the type / the brand.
  const brandKey = brandName ? normaliseKey(brandName) : "";
  const isType = (t: string) => Boolean(type && matchType(t, [type]));
  const keep: string[] = [];
  const undated: string[] = [];
  for (const segment of splitSegments(name)) {
    let rest = segment.split(/\s+/).filter((t) => t && !isDateToken(t));
    if (rest.length > 0) undated.push(rest.join(" "));
    // The type goes when it is the whole segment or its last word ("Video Production Project").
    if (rest.length > 0 && isType(rest[rest.length - 1]!)) rest = rest.slice(0, -1);
    if (rest.length === 0) continue;
    const segKey = normaliseKey(segment);
    const cleaned = cleanSegment(segment);
    if (brandKey && (segKey === brandKey || (cleaned && normaliseKey(cleaned) === brandKey))) continue;
    keep.push(rest.join(" "));
  }
  // Nothing but brand / type / dates ("May 25 | Mashreq | Projects") → the undated segments.
  let title = tidy((keep.length > 0 ? keep : undated).join(" ").replaceAll(NAMING_SEPARATOR, " "));
  if (!title) title = tidy(name.replace(/[|_]+/g, " "));
  return { type, month, title: title.slice(0, PROJECT_NAMING_LIMITS.titleMax).trim() };
}

/** Suggested short code from brand + type: "Wasl" + "Campaign" → "WASLC". */
export function suggestNamingCode(brandShortOrName: string, type: string): string {
  const brand = brandShortOrName.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  const initial = type.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 1);
  const code = `${brand}${initial}`;
  return code.length >= 2 ? code : `${code}PR`.slice(0, 2);
}
