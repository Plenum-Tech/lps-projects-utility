import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { briefCheckConfigured, briefCheckModel } from "./briefCheck.js";
import { SCOPE_LANGUAGES, SCOPE_LIMITS, SCOPE_UNITS } from "./scopeUnits.js";

// ---------------------------------------------------------------------------
// Brand flow, step 2: read the brief / SOW the user gives (images, PDFs, Word /
// Excel files, typed text) and pull out the scope, the project name, platforms and the
// pitch dates. With OPENAI_API_KEY an OpenAI vision model reads every file
// (images and PDFs included); without it, Word / text files and typed text are
// read with simple rules and images / PDFs are reported as unreadable.
// ---------------------------------------------------------------------------

export interface ExtractInputFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}

export interface ExtractedScopeRow {
  unit: string;
  what: string;
  quantity: number;
  languageList: string[];
  sizes: number;
  source: string;
}

/**
 * The agreement's own total ("96 content pieces per month", "Total: 62"): a check the rows
 * should add up to, never a row. `phases`: the "Total: N" of each phase (counts per phase).
 */
export interface StatedTotal {
  quantity: number;
  per: "month" | null;
  text: string;
  phases?: Array<{ phase: string; quantity: number }>;
}

export interface ExtractedLead {
  name: string;
  source: string;
  weak?: boolean;
}

export interface ScopeExtraction {
  /** The text read from each input ("Typed text" for the text box). */
  texts: Array<{ source: string; text: string; read: boolean }>;
  projectName: string | null;
  platforms: string[];
  revenue: number | null;
  /** Presentation / milestones (the lead's tasks) and the work period (project start / end). */
  dates: {
    clientPresentation: string | null;
    milestone1: string | null;
    milestone2: string | null;
    startDate: string | null;
    endDate: string | null;
  };
  scope: ExtractedScopeRow[];
  notes: string[];
  /** The total the agreement states (a check for the rows, advice only); null when none. */
  statedTotal: StatedTotal | null;
  /**
   * The rest of the scope part of the documents, not itemised as rows or notes (paragraphs,
   * exclusions, " * " items…), tidied, as one text. Saved on the brand as scopeText.
   */
  otherScope: string;
  /**
   * The agency-side lead(s) named in the documents ("Account Lead: X", "Project Lead",
   * "Point of contact"…). `weak` = only a "Prepared by" line: shown only when it matches a user.
   */
  leads: ExtractedLead[];
  /** true when the AI model read the files. */
  usedAI: boolean;
}

const TIMEOUT_MS = 90_000;
const TEXT_MAX = 6000;
/** Max length of the "other scope" text (Brand.scopeText allows 10000). */
export const OTHER_SCOPE_MAX = 8000;
const TYPED = "Typed text";

const isImage = (f: ExtractInputFile) => f.mimetype.startsWith("image/");
const isPdf = (f: ExtractInputFile) => f.mimetype === "application/pdf" || /\.pdf$/i.test(f.originalname);
const isDocx = (f: ExtractInputFile) => /\.docx$/i.test(f.originalname) || f.mimetype.includes("wordprocessingml");
const isXlsx = (f: ExtractInputFile) => /\.xlsx$/i.test(f.originalname) || f.mimetype.includes("spreadsheetml");
const isPlain = (f: ExtractInputFile) => f.mimetype.startsWith("text/") || /\.(txt|csv|md)$/i.test(f.originalname);

/** An Excel workbook as text: one line per row (non-empty cells joined by " · "), sheet by sheet. */
async function workbookText(buffer: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const lines: string[] = [];
  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row) => {
      const cells = (row.values as ExcelJS.CellValue[]).map(cellText).filter(Boolean);
      if (!cells.length) return;
      // A deliverable row ("Engagement posts | 8") reads as "8 x Engagement posts" for the rules.
      const numbers = cells.filter((c) => /^\d{1,3}$/.test(c));
      const words = cells.filter((c) => !/^[\d.,\s%]+$/.test(c));
      if (numbers.length === 1 && words.length >= 1) lines.push(`${numbers[0]} x ${words.join(" ")}`);
      else lines.push(cells.join(" · "));
    });
  }
  return lines.join("\n");
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const v = value as { text?: unknown; result?: unknown; richText?: Array<{ text: string }> };
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join("").trim();
    if (v.result !== undefined) return cellText(v.result as ExcelJS.CellValue);
    if (typeof v.text === "string") return v.text.trim();
    return "";
  }
  return String(value).trim();
}

/** Text the server can read without the model (Word, Excel, plain text), else null. */
async function localText(f: ExtractInputFile): Promise<string | null> {
  try {
    if (isXlsx(f)) return (await workbookText(f.buffer)).trim().slice(0, TEXT_MAX);
    if (isDocx(f)) return (await mammoth.extractRawText({ buffer: f.buffer })).value.trim().slice(0, TEXT_MAX);
    if (isPlain(f)) return f.buffer.toString("utf8").trim().slice(0, TEXT_MAX);
  } catch (err) {
    console.error("[scope-extract] couldn't read", f.originalname, err);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared normalising (AI and rule results go through the same checks)
// ---------------------------------------------------------------------------

const UNIT_WORDS: Array<[RegExp, string]> = [
  [/\breels?\b/, "Reel"],
  [/\bstor(?:y|ies)\b/, "Story"],
  [/\bcarousels?\b/, "Carousel"],
  [/\b(?:videos?|films?|tiktoks?|shorts|youtube|motion|animations?|gifs?)\b/, "Video"],
  [/\b(?:posts?|statics?|images?|visuals?|designs?|banners?|creatives?|artworks?|key ?visuals?|kv|graphics?|infographics?)\b/, "Static"],
];

/**
 * The scope unit a deliverable name belongs to: the unit word that comes first
 * ("Statics/ motion graphics" → Static, "Reels/Motion Graphics" → Reel, "Native TikTok videos" → Video).
 */
export function unitFor(what: string): string {
  const w = what.toLowerCase();
  let best: { at: number; unit: string } | null = null;
  for (const [re, unit] of UNIT_WORDS) {
    const m = re.exec(w);
    if (m && (!best || m.index < best.at)) best = { at: m.index, unit };
  }
  return best?.unit ?? "Others";
}

/** Zero-width characters some documents are full of (U+200B …). */
const ZERO_WIDTH = /[​-‍⁠﻿]/g;

/** "96 content pieces", "53x content pieces in total", "Total deliverables" — an agreement total, not a row. */
const TOTAL_WHAT =
  /\bcontent\s+pieces?\b|\b(?:pieces?|posts|deliverables|assets|items)\s+(?:of\s+content\s+)?in\s+total\b|\btotal\s+(?:deliverables|pieces|content(?:\s+pieces)?|posts|assets)\b|^(?:grand\s+)?total\b/i;
/** Shoots / production days: a note, not content (what a shoot produces is content). */
const SHOOT_WHAT = /\b(?:shoots?|shooting|production\s+days?|shoot\s+days?|filming\s+days?)\b/i;
const SHOOT_OUTPUT = /\(from the shoot\)|\boutputs?\b|\bfrom\s+(?:the\s+)?shoots?\b/i;
const PER_MONTH = /\bper\s+month\b|\/\s*month\b|\bmonthly\b|\ba\s+month\b/i;

/** "96 content pieces in total (per month) — a total, not a row". */
function totalNote(quantity: number, what: string): string {
  const base = what.replace(PER_MONTH, " ").replace(/\s+in\s+total\b/i, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return `${quantity} ${base} in total${PER_MONTH.test(what) ? " (per month)" : ""} — a total, not a row`;
}

/** Where cleanRows puts what it takes out of the rows (totals → checks, shoots → notes). */
export interface CleanSink {
  notes: string[];
  totals: StatedTotal[];
}

/** The stated total of an extraction: the overall one (first found), with the per-phase ones. */
function statedTotalOf(totals: StatedTotal[], phases: Array<{ phase: string; quantity: number }>): StatedTotal | null {
  const overall = totals[0] ?? null;
  if (!phases.length) return overall;
  if (overall) return { ...overall, phases };
  const quantity = phases.reduce((n, p) => n + p.quantity, 0);
  return { quantity, per: null, text: `Totals per phase: ${phases.map((p) => `${p.phase} ${p.quantity}`).join("; ")}`, phases };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "26 Oct 2026", "26th October 2026", "2026-10-26", "26/10/2026" → "2026-10-26" (else null). */
export function parseLooseDate(raw: unknown, fallbackYear = new Date().getFullYear()): string | null {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw.toISOString().slice(0, 10);
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return iso(+m[3]!, +m[2]!, +m[1]!);
  m = s.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s*(\d{4})?/);
  if (m) {
    const month = MONTHS.indexOf(m[2]!.slice(0, 3)) + 1;
    if (month > 0) return iso(m[3] ? +m[3] : fallbackYear, month, +m[1]!);
  }
  m = s.match(/([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?/);
  if (m) {
    const month = MONTHS.indexOf(m[1]!.slice(0, 3)) + 1;
    if (month > 0) return iso(m[3] ? +m[3] : fallbackYear, month, +m[2]!);
  }
  return null;
}

function iso(y: number, mo: number, d: number): string | null {
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (Number.isNaN(date.getTime()) || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

const PLATFORM_RULES: Array<[RegExp, string]> = [
  [/\b(meta|facebook|fb)\b/i, "Meta (Facebook)"],
  [/\b(instagram|ig)\b/i, "Instagram"],
  [/\btik ?tok\b/i, "TikTok"],
  [/\b(twitter|x \(twitter\)|tweets?)\b/i, "X (Twitter)"],
  [/\blinked ?in\b/i, "LinkedIn"],
  [/\byou ?tube\b/i, "YouTube"],
  [/\bsnap ?chat\b/i, "Snapchat"],
];

function languagesIn(text: string): string[] {
  const found = SCOPE_LANGUAGES.filter((l) => l !== "Others" && new RegExp(`\\b${l}\\b`, "i").test(text));
  return found.length ? [...found] : ["English"];
}

/**
 * Every extracted row (AI and rules) goes through here: units, languages and limits checked, and a
 * post-pass: totals ("96 Content Pieces") become a stated total, shoots / production days a note
 * (unless the row is the shoot's output), and an "Others" row whose name is a real unit
 * ("Native Snap stories", "TikTok videos") gets that unit.
 */
export function cleanRows(rows: ExtractedScopeRow[], sink?: CleanSink): ExtractedScopeRow[] {
  const units = new Map(SCOPE_UNITS.map((u) => [u.toLowerCase(), u as string]));
  const langs = new Map(SCOPE_LANGUAGES.map((l) => [l.toLowerCase(), l as string]));
  const out: ExtractedScopeRow[] = [];
  for (const r of rows) {
    const quantity = Math.round(Number(r.quantity));
    if (!Number.isFinite(quantity) || quantity < 1) continue;
    const what = String(r.what ?? "").replace(ZERO_WIDTH, "").replace(/\s+/g, " ").trim().slice(0, 80);
    let unit = units.get(String(r.unit ?? "").toLowerCase()) ?? unitFor(what);
    if (TOTAL_WHAT.test(what)) {
      sink?.notes.push(totalNote(quantity, what));
      sink?.totals.push({ quantity, per: PER_MONTH.test(what) ? "month" : null, text: `${quantity} ${what}` });
      continue;
    }
    if (SHOOT_WHAT.test(what) && !SHOOT_OUTPUT.test(what)) {
      sink?.notes.push(`${quantity} × ${what} — a shoot / production day, kept as a note (not a content piece).`);
      continue;
    }
    // Brackets don't decide the unit ("Live event coverage (… 3 recap videos)" stays Others).
    if (unit === "Others") unit = unitFor(what.replace(/\(.*?\)/g, " "));
    const languageList = [...new Set((Array.isArray(r.languageList) ? r.languageList : []).map((l) => langs.get(String(l).toLowerCase())).filter((l): l is string => Boolean(l)))];
    const sizes = Math.min(SCOPE_LIMITS.maxMultiplier, Math.max(1, Math.round(Number(r.sizes) || 1)));
    // The same deliverable named twice (e.g. two pages of one brief) counts once.
    if (out.some((o) => o.unit === unit && o.what.toLowerCase() === what.toLowerCase() && o.quantity === quantity)) continue;
    out.push({
      unit,
      what,
      quantity: Math.min(SCOPE_LIMITS.maxQuantity, quantity),
      languageList: languageList.length ? languageList : ["English"],
      sizes,
      source: String(r.source ?? "").slice(0, 255),
    });
    if (out.length >= SCOPE_LIMITS.maxRows) break;
  }
  return mergeBreakdowns(out);
}

/**
 * "12 short-form videos — 5 storytelling, 7 shorter": rows right after a row, of the
 * same unit, whose quantities add up to it are its breakdown, not extra deliverables.
 * They are folded into that row's description.
 */
function mergeBreakdowns(rows: ExtractedScopeRow[]): ExtractedScopeRow[] {
  const out: ExtractedScopeRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const parent = rows[i]!;
    let sum = 0;
    let j = i + 1;
    while (j < rows.length && rows[j]!.unit === parent.unit && sum + rows[j]!.quantity <= parent.quantity) {
      sum += rows[j]!.quantity;
      j++;
      if (sum === parent.quantity) break;
    }
    if (j - i > 2 && sum === parent.quantity) {
      const parts = rows.slice(i + 1, j).map((r) => `${r.quantity} ${r.what.toLowerCase()}`);
      out.push({ ...parent, what: `${parent.what} (${parts.join(", ")})`.slice(0, 80) });
      i = j - 1;
    } else out.push(parent);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rules (no AI): "8x engagement posts", "10 reels", "Client presentation: 26 Oct 2026"
// ---------------------------------------------------------------------------

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
};

/** A quantity starting an item: "8 ", "8x ", "eight ". */
const QTY = String.raw`(?:\d{1,3}\s*[x×]?\s|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty)\s)`;
/** A bullet starting a line: "* ", "- ", "• ", "o ", "· ". */
const BULLET_START = /^\s*[-–*o·•]\s/;
/** Bullets inside a line: "… * next item * …", "• …". */
const INLINE_BULLET = /\s\*\s|•/;
/** Items after a dash: "IG and FB - 4 Static Posts". */
const DASH_SPLIT = /\s[-–]\s(?=\d)/;
/** Items listed in a sentence: ", 10 …", " and 12 …", ". 2 …". */
const SENTENCE_SPLIT = new RegExp(String.raw`[,;.]\s*(?:and\s+)?(?=${QTY})|\s+(?:and|&|plus)\s+(?=${QTY})|\s\+\s(?=\d)`, "i");

/**
 * A piece of text's items. A sentence is split only when at least two of its pieces are
 * real deliverables ("8 static posts, 10 reels and 12 stories"); a breakdown like
 * "12 videos — 5 storytelling, 7 shorter" stays one item.
 */
function itemsOf(text: string): string[] {
  return text.split(DASH_SPLIT).flatMap((line) => {
    const parts = line.split(SENTENCE_SPLIT);
    if (parts.length < 2) return [line];
    // Split when 2+ pieces are deliverables, or the line opens with something else ("Budget AED 40,000, 3 reels").
    const deliverables = parts.filter((p) => unitFor(p) !== "Others").length;
    return deliverables >= 2 || unitFor(parts[0]!) === "Others" ? parts : [line];
  });
}

/**
 * A line as its inline-bullet parts ("A * B * C" → A, B, C; a leading bullet is dropped).
 * `bullet` = the line started with a bullet; `inline` = it held more than one bullet item.
 */
function partsOf(line: string): { parts: string[]; bullet: boolean; inline: boolean } {
  const bullet = BULLET_START.test(line);
  const parts = line
    .replace(/^\s*[-–*o·•]\s+/, bullet ? "" : "$&")
    .split(INLINE_BULLET)
    .map((p) => p.trim())
    .filter(Boolean);
  return { parts, bullet, inline: parts.length > 1 };
}

// --- "Label: N" counts, per phase ----------------------------------------------

/** "Static:4", "Reels/Motion Graphics:13 to 15", "Posts - 8". */
const COUNT_SEG = /^([\p{L}][\p{L}\p{N}/&()'’ .+]{0,40}?(?:[-–][\p{L}][\p{L}\p{N}/&()'’ .+]{0,30}?)?)\s*(?::|\s[-–]\s|[-–])\s*(\d{1,4})(?:\s*(?:to|-|–)\s*(\d{1,4}))?\.?$/u;
const TOTAL_LABEL = /^(?:grand\s+)?total\b/i;

interface CountSeg {
  label: string;
  low: number;
  high: number;
  range: boolean;
}

/** A line made only of "Label: N" counts (else null). "Total: N" is read but ignored. */
function countsLine(line: string): CountSeg[] | null {
  const segs = line
    .replace(/ /g, " ")
    .trim()
    .split(/\s*[;|·]\s*|,\s*(?=\p{L})/u)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segs.length) return null;
  const out: CountSeg[] = [];
  for (const seg of segs) {
    const m = seg.match(COUNT_SEG);
    if (!m) return null;
    const label = m[1]!.replace(/\s+/g, " ").trim();
    const low = Number(m[2]);
    const high = m[3] ? Math.max(low, Number(m[3])) : low;
    out.push({ label, low: Math.min(low, Number(m[3] ?? low)), high, range: Boolean(m[3]) && Number(m[3]) !== low });
  }
  const real = out.filter((s) => !TOTAL_LABEL.test(s.label));
  // One "Label: N" alone counts only when the label is a known deliverable ("Videos: 3", not "Budget: 40").
  if (!real.length || (out.length === 1 && unitFor(real[0]!.label) === "Others")) return null;
  return out;
}

const PHASE_RE = /\b(?:phase|stage|wave|month|week|quarter|q[1-4]|pre|post|event|launch|teaser|sustain|always[- ]on|period|day|jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\b/i;

/** "Pre – Pre Event : Sep ’26" → "Pre-Pre Event, Sep '26". */
function tidyPhase(line: string): string {
  return line
    .replace(/ /g, " ")
    .replace(/[’‘`]/g, "'")
    .replace(/^\s*(pre|post|re)\s*[–—-]\s*/i, "$1-")
    .replace(/\s*:\s*/g, ", ")
    .replace(/\s+/g, " ")
    .replace(/[\s,:;.-]+$/, "")
    .trim();
}

/**
 * Lines of "Label: N" counts ("Total: 62; Static:4; Carousel:6; Reels/Motion Graphics:13 to 15")
 * and the phase heading above them ("Pre – Pre Event : Sep ’26"): one row per label and phase.
 * A range uses the higher number (noted); totals per unit across phases are noted.
 * Returns the indexes of the lines it read (they are not read again).
 */
function phaseCounts(lines: string[], languageList: string[], source: string) {
  const rows: ExtractedScopeRow[] = [];
  const notes: string[] = [];
  const consumed = new Set<number>();
  const ranges = new Map<string, string[]>();
  const phases: string[] = [];
  const totals = new Map<string, number>();
  // The "Total: N" of each phase (a check, not a row); one without a phase is an overall total.
  const phaseTotals: Array<{ phase: string; quantity: number }> = [];
  const overall: number[] = [];
  let phase: string | null = null;
  const nextLine = (i: number) => {
    for (let j = i + 1; j < lines.length; j++) if (lines[j]!.trim()) return j;
    return -1;
  };
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const counts = countsLine(line);
    if (!counts) {
      const next = nextLine(i);
      const heading = line.length <= 60 && !/[*•]/.test(line) && PHASE_RE.test(line) && next >= 0 && countsLine(lines[next]!) !== null;
      phase = heading ? tidyPhase(line) : null;
      if (heading) consumed.add(i);
      return;
    }
    consumed.add(i);
    if (phase && !phases.includes(phase)) phases.push(phase);
    for (const c of counts) {
      if (TOTAL_LABEL.test(c.label)) {
        if (phase) phaseTotals.push({ phase, quantity: c.high });
        else overall.push(c.high);
        continue;
      }
      const label = c.label.charAt(0).toUpperCase() + c.label.slice(1);
      const unit = unitFor(label);
      rows.push({ unit, what: phase ? `${label} — ${phase}` : label, quantity: c.high, languageList, sizes: 1, source });
      if (c.range) {
        const key = `${label}: ${c.low} to ${c.high} — ${c.high} used`;
        const list = ranges.get(key) ?? [];
        if (phase) list.push(phase);
        ranges.set(key, list);
      }
      totals.set(unit, (totals.get(unit) ?? 0) + c.high);
    }
  });
  for (const [key, list] of ranges) notes.push(list.length ? `${key} (${list.join("; ")})` : key);
  if (phases.length >= 2) {
    notes.push(`Across the ${phases.length} phases: ${[...totals].map(([unit, n]) => `${unit} ${n}`).join(", ")}`);
  }
  return { rows, notes, consumed, phased: phases.length > 0, phaseTotals, overall };
}

// --- "Other scope": the scope text that isn't a row or a note --------------------

/** The heading the scope part of a document starts at. */
const SCOPE_HEADING = /^(?:agreed\s+)?(?:deliverables|scope(?:\s+of\s+(?:work|services))?|statement\s+of\s+work)\s*:?$/i;
/** Table headers, empty cells, totals, and lines read into other fields (dates, budget). */
const DROP_LINE =
  /^(?:items?|details?|notes?|description|qty|quantity|remarks?|comments?|nil|n\/?a|none|tbc|-+|—|\*{3,}|={3,})$|^(?:grand\s+)?total\s*[:\-–]\s*\d+\.?$|^(?:client\s+pres(?:entation)?|milestone\s*\d|start(?:ing)?\s*date|end\s*date|deadline|go[- ]live|launch\s*date|budget|revenue|fee)\b[^:\n]{0,30}[:\-–]/i;

/** Footer lines: address, phone, email, website, page numbers. */
function isFooter(line: string): boolean {
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(line)) return true;
  if (/\bwww\.|https?:\/\//i.test(line) && line.length < 120) return true;
  if (/^page\s+\d+(?:\s+of\s+\d+)?$/i.test(line)) return true;
  if (/(?:^|\s)(?:m|t|ph|tel|phone|mob|mobile|fax)\.?\s*[:.]?\s*\+?\d[\d\s-]{6,}/i.test(line) || /\+\d{2,3}[\s-]?\d[\d\s-]{6,}/.test(line)) return true;
  if (/\b(?:building|tower|street|road|p\.?\s?o\.?\s?box|floor|suite|plaza|oasis)\b/i.test(line) && (line.match(/,/g) ?? []).length >= 2 && line.length < 200)
    return true;
  return false;
}

/** Words that don't need a home in the box (they become the row's languages / the platforms). */
const NON_CONTENT = new Set(
  "a an the and or of for to in on at with by per each x is are be will as all total pcs pieces piece items item english arabic french hindi urdu russian chinese german spanish ig fb li tt yt x meta instagram facebook linkedin tiktok youtube snapchat twitter".split(
    " "
  )
);

function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !NON_CONTENT.has(w) && !/^\d+$/.test(w))
    .map((w) => (w.length > 3 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

/** True when the row / note text covers every word of the item (bar languages, platforms and filler). */
function covered(item: string, by: string[]): boolean {
  // Counts ("8", "8x", "x8") are read into the row's quantity.
  const words = contentWords(item).filter((w) => !/^(?:\d+x?|x\d+)$/i.test(w));
  if (!words.length) return true;
  if (!by.length) return false;
  const have = new Set(contentWords(by.join(" ")));
  return words.every((w) => have.has(w));
}

/** A line wrapped mid-bracket ("… need to be" / "of DSLR quality)") is joined back. */
function joinWrapped(lines: string[]): string[] {
  const out: string[] = [];
  let open = false;
  for (const raw of lines) {
    const line = raw.replace(/ /g, " ");
    // The blank lines Word puts between paragraphs don't end the wrapped line.
    if (open && !line.trim()) continue;
    if (open) out[out.length - 1] = `${out[out.length - 1]!.trimEnd()} ${line.trim()}`;
    else out.push(line);
    const last = out[out.length - 1]!;
    open = (last.match(/\(/g) ?? []).length > (last.match(/\)/g) ?? []).length && last.length < 400;
  }
  return out;
}

const tidy = (s: string) => s.replace(ZERO_WIDTH, "").replace(/ /g, " ").replace(/[ \t]+/g, " ").trim();

/** Marks a bullet that was read in full (a row / note): kept only inside a headed section. */
const READ_MARK = "\u0001";

/** The box's text: headings on their own lines, " * " items as "• item", no orphan headings. */
function finishBox(raw: string[]): string {
  const out: string[] = [];
  const bulletLine = (l: string | undefined) => Boolean(l?.replace(READ_MARK, "").startsWith("•"));
  // A plain line right after a bullet continues it (a wrapped line), unless it is a heading ("…:").
  const input: string[] = [];
  for (const l of raw) {
    const prev = input[input.length - 1];
    if (prev !== undefined && bulletLine(prev) && !bulletLine(l) && !/:$/.test(l) && !/^(?:scope|platforms?)\s*:/i.test(l)) {
      input[input.length - 1] = `${prev} ${l}`;
      continue;
    }
    input.push(l);
  }
  // Plain-text documents: a short Title-like line ("Strategy & Planning", "KPIs & Evaluation") heads the
  // sentences under it; its sentences become "• item" lines. Two such lines in a row: the first is only a
  // group label ("Monthly Payment (Once per Month)") and is dropped.
  const titleLike = (l: string | undefined) =>
    l !== undefined &&
    !bulletLine(l) &&
    !/[.:;,!?]$/.test(l) &&
    !/^(?:scope|platforms?)\s*:/i.test(l) &&
    l.length <= 60 &&
    l.split(/\s+/).length <= 8 &&
    /^[\p{Lu}\d]/u.test(l);
  const sectioned: string[] = [];
  let inTitled = false;
  input.forEach((l, i) => {
    const next = input[i + 1];
    const shortHeading = (x: string) => /:$/.test(x) && x.length <= 60;
    if (titleLike(l) && next !== undefined && !shortHeading(next) && !bulletLine(next)) {
      if (titleLike(next)) return;
      sectioned.push(`${l}:`);
      inTitled = true;
      return;
    }
    if (shortHeading(l) && !bulletLine(l)) inTitled = false;
    sectioned.push(inTitled && !bulletLine(l) && !/^(?:scope|platforms?)\s*:/i.test(l) && !shortHeading(l) ? `• ${l}` : l);
  });
  input.splice(0, input.length, ...sectioned);
  // A plain line that bullets follow heads them ("360 Social Media Management - Facebook …" → "…:").
  const lines0 = input
    .filter((l, i) => {
      const next = input[i + 1];
      // "Social Media Management" right before "360 Social Media Management - …" says nothing more.
      return !(next && !bulletLine(l) && l.length <= 40 && !/:$/.test(l) && next.toLowerCase().includes(l.toLowerCase().replace(/[.:]+$/, "")));
    })
    .map((l, i, all) =>
      !bulletLine(l) && !/:$/.test(l) && !/^(?:scope|platforms?)\s*:/i.test(l) && l.length <= 120 && bulletLine(all[i + 1]) ? `${l.replace(/[.;,]+$/, "")}:` : l
    );
  const isHeading = (l: string) => /:$/.test(l) && l.length <= 121 && !l.startsWith("•");
  // Fully read bullets stay (as written) only under a heading; a plain list that all became rows adds nothing.
  const headed = lines0.some(isHeading);
  const lines = lines0
    .filter((l) => headed || !l.startsWith(READ_MARK))
    .map((l) => l.replace(READ_MARK, ""));
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (isHeading(l)) {
      // A heading whose content all became rows / notes isn't kept.
      const next = lines[i + 1];
      if (next === undefined || isHeading(next)) continue;
      if (out.length) out.push("");
    }
    out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
/**
 * Counts written out: "Four (4) campaigns" → "4 campaigns", "four-to-six (4-6) bursts" → "4-6 bursts",
 * "x6 on-ground coverage" → "6x on-ground coverage".
 */
function normaliseCounts(line: string): string {
  const words = Object.keys(WORD_NUMBERS).join("|");
  return line
    .replace(new RegExp(String.raw`\b(?:${words})(?:\s*(?:-\s*to\s*-|to|-)\s*(?:${words}))?\s*\((\d{1,3}(?:\s*[-–]\s*\d{1,3})?)\)`, "gi"), "$1")
    .replace(/(^|[\s:(])x(\d{1,3})\b/gi, "$1$2x");
}

/** Unit of an item inside a posts breakdown: "videos", "animations" / "animated" (= reels / motion), "statics". */
function breakdownUnit(word: string): string {
  const w = word.toLowerCase();
  if (/animat|motion|gif/.test(w)) return "Reel";
  return unitFor(w);
}

/**
 * "On IG & Fb: 20 posts/month (5 videos, 10 animations and 5 statics)" → 5 Video, 10 Reel, 5 Static
 * (the 20 is their total); "On LinkedIn & X: 4 static posts/month" → 4 Static. Else null.
 */
function postsPerMonth(line: string): { rows: Array<{ unit: string; what: string; quantity: number }>; note: string | null } | null {
  const per = String.raw`\s*(?:\/|per|a)\s*(month|week|year)`;
  const m = line.match(new RegExp(String.raw`^(?:on\s+(.{1,40}?)\s*:\s*)?(\d{1,3})\s+([\p{L} -]{0,30}?)posts?${per}\s*(?:\(([^)]*)\))?`, "iu"));
  if (!m) return null;
  const where = m[1]?.trim() ?? "";
  const kind = m[3]!.trim();
  const period = m[4]!.toLowerCase();
  const tail = `${where ? ` — ${where}` : ""} (per ${period})`;
  const inner = m[5]?.trim();
  if (inner) {
    const parts = [...inner.matchAll(/(\d{1,3})\s+([\p{L}-]+)/gu)].map((x) => ({ n: Number(x[1]), word: x[2]! }));
    if (parts.length) {
      const sum = parts.reduce((a, b) => a + b.n, 0);
      return {
        rows: parts.map((x) => ({ unit: breakdownUnit(x.word), what: `${x.word.charAt(0).toUpperCase()}${x.word.slice(1)}${tail}`, quantity: x.n })),
        note:
          sum === Number(m[2])
            ? `${m[2]} posts/${period}${where ? ` on ${where}` : ""} = ${parts.map((x) => `${x.n} ${x.word}`).join(" + ")} (animations read as Reel).`
            : `${m[2]} posts/${period}${where ? ` on ${where}` : ""}, but the breakdown adds up to ${sum} — check.`,
      };
    }
  }
  const label = `${kind ? `${kind.charAt(0).toUpperCase()}${kind.slice(1)} ` : ""}posts`;
  return { rows: [{ unit: kind ? breakdownUnit(kind) : "Static", what: `${label}${tail}`, quantity: Number(m[2]) }], note: null };
}

/** "x6 on-ground coverage per year … Deliverables: 20 edited photos + 3 recap videos per event" → one row. */
function eventCoverage(line: string): { quantity: number; what: string } | null {
  const m = line.match(/(\d{1,3})x?\s+(?:on[- ]ground\s+|live\s+|event\s+)*(?:event\s+)?coverage\b[^.]*?\bper\s+(year|month|quarter)/i);
  if (!m) return null;
  const per = line.match(/deliverables?\s*:\s*([^.]*?)\s+per\s+event/i);
  const what = `Live event coverage (per ${m[2]!.toLowerCase()}${per ? `; per event: ${per[1]!.trim()}` : ""})`;
  return { quantity: Number(m[1]), what: what.length > 80 ? `${what.slice(0, 77)}…)` : what };
}

/** The out-of-scope / rate-card part of a document: not scope, not read. */
const OUT_OF_SCOPE = /^(?:out[- ]of[- ]scope|rate\s*card)\b/i;

/** Words before the first quantity of a sentence: "Monthly scope: ", "We need ". */
const LEAD_IN = new RegExp(String.raw`^[^\d\n]{1,40}?(?:[:\-–]\s*|\s)(?=${QTY})`, "i");

/** "Output is 5 Reel size Videos", "producing 3 reels" — the content a shoot produces. */
const OUTPUT_RE = new RegExp(
  String.raw`\b(?:output(?:\s+is)?|outputs?|producing|delivering|resulting in)\s*[:\-–]?\s*(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+([\p{L} -]{0,30}\b(?:videos?|reels?|posts?|stor(?:y|ies)|statics?|carousels?|images?|visuals?|edits?))\b`,
  "iu"
);

const LEAD_LINE =
  /^(?:the\s+)?(account\s+lead|project\s+lead|client\s+lead|creative\s+lead|lead|account\s+manager|project\s+manager|point\s+of\s+contact|poc|contact\s+person|prepared\s+by)\s*(?:\(s\))?\s*[:\-–]\s*(.+)$/i;

/** "Sara Ali (sara@x.com), John & Mary" → ["Sara Ali", "John", "Mary"] (names only). */
export function leadNames(raw: string): string[] {
  return raw
    .replace(/\(.*?\)|<.*?>|\[.*?\]/g, " ")
    .split(/\s*(?:,|;|\/|&|\band\b|\||·|\s-\s)\s*/i)
    .map((part) =>
      part
        .replace(/^(?:mr|mrs|ms|dr|miss)\.?\s+/i, "")
        .replace(/[.:;,]+$/, "")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter((name) => /^[\p{L}][\p{L}.' -]{1,58}$/u.test(name) || /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(name))
    .slice(0, 5);
}

/** Lead / account lead / point-of-contact lines (rules). "Prepared by" is weak: only kept when it matches a user. */
export function leadsByRules(texts: Array<{ source: string; text: string }>): ExtractedLead[] {
  const out: ExtractedLead[] = [];
  for (const { source, text } of texts) {
    for (const rawLine of text.split(/\r?\n|•/)) {
      const m = rawLine.replace(/^[\s\-–*·]+/, "").trim().match(LEAD_LINE);
      if (!m) continue;
      const weak = /prepared/i.test(m[1]!);
      for (const name of leadNames(m[2]!)) {
        if (out.some((l) => l.name.toLowerCase() === name.toLowerCase())) continue;
        out.push({ name, source, ...(weak ? { weak: true } : {}) });
      }
    }
  }
  return out.slice(0, 10);
}

/** Acronyms kept in capitals when an ALL-CAPS cell is tidied. */
const ACRONYMS = new Set("FB IG KSA UAE KPI KPIS CTR AR VR UGC SM X TV OOH PR LPS SEO SEM CRM FAQ FAQS ROI".split(" "));
const CASED: Record<string, string> = { TIKTOK: "TikTok", YOUTUBE: "YouTube", LINKEDIN: "LinkedIn", SNAPCHAT: "Snapchat" };

/** "360 SOCIAL MARCOMS & ACCOUNT MANAGEMENT" → "360 Social Marcoms & Account Management" (ALL-CAPS only). */
function unshout(s: string, sentence = false): string {
  if (/\p{Ll}/u.test(s) || !/\p{Lu}{2}/u.test(s)) return s;
  let first = true;
  return s.replace(/\p{L}[\p{L}'’]*/gu, (w) => {
    const up = w.toUpperCase();
    const out = CASED[up] ?? (ACRONYMS.has(up) ? w : first || !sentence ? w.charAt(0) + w.slice(1).toLowerCase() : w.toLowerCase());
    first = false;
    return out;
  });
}

/** A sub-heading that is only a platform name ("Snapchat:", "Instagram:", "Tiktok"). */
const PLATFORM_HEADING = new Map<string, string>([
  ["snapchat", "Snapchat"], ["snap chat", "Snapchat"], ["snap", "Snapchat"],
  ["instagram", "Instagram"], ["ig", "Instagram"],
  ["tiktok", "TikTok"], ["tik tok", "TikTok"],
  ["facebook", "Facebook"], ["fb", "Facebook"], ["meta", "Meta"],
  ["linkedin", "LinkedIn"], ["linked in", "LinkedIn"],
  ["youtube", "YouTube"], ["you tube", "YouTube"],
  ["x", "X"], ["twitter", "X"], ["x (twitter)", "X"],
]);

/**
 * Table cells a heading was split into: "360 SOCIAL MARCOMS" / "&" / "ACCOUNT MANAGEMENT" → one line;
 * "PLATFORMS:" and the platform cells under it → "Platforms: Meta (FB & IG), TikTok, X (Twitter)".
 */
function joinFragments(lines: string[]): string[] {
  const out: string[] = [];
  const lastFilled = () => {
    for (let k = out.length - 1; k >= 0; k--) if (tidy(out[k]!)) return k;
    return -1;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = tidy(lines[i]!);
    const k = lastFilled();
    if (/^(?:&|and)$/i.test(line) && k >= 0) {
      let j = i + 1;
      while (j < lines.length && !tidy(lines[j]!)) j++;
      if (j < lines.length) {
        out.splice(k, out.length - k, unshout(`${tidy(out[k]!)} & ${tidy(lines[j]!)}`));
        i = j;
        continue;
      }
    }
    if (/^platforms?\s*:$/i.test(line)) {
      const names: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const n = tidy(lines[j]!);
        if (!n) continue;
        if (n.length > 30 || /^\d/.test(n) || /:$/.test(n) || DROP_LINE.test(n)) break;
        names.push(unshout(n));
      }
      if (names.length) {
        out.push(`Platforms: ${names.join(", ")}`);
        i = j - 1;
        continue;
      }
    }
    out.push(lines[i]!);
  }
  return out;
}

const KPI_START = /^(?:kpi[’']?s?|full\s+video\s+views|video\s+views|clicks|ctr|impressions|reach|engagement\s+rate)\b/i;
const KPI_METRIC = /^([\p{L}][\p{L} .’']{1,30}?)\s*[–:-]\s*([\d.,]+\s*[%kKmM]?\s*\+?)$/u;

/**
 * A KPI table at the end of the scope ("Full Video Views (Expected) · Clicks – 15K + · CTR – 5% +
 * (Estimated) · (KSA ONLY) · STREAMERS · 2 UNIQUE STATICS ADS …") → one section:
 * "KPIs & Streamers (KSA only):" with "• Clicks: 15K+" items. Null when there is none.
 */
function kpiSection(lines: string[], start: number, end: number): { at: number; consumed: Set<number>; lines: string[] } | null {
  let first = -1;
  for (let i = start; i < end; i++) {
    const l = tidy(lines[i]!);
    if (l.length <= 40 && KPI_START.test(l)) {
      first = i;
      break;
    }
  }
  if (first < 0) return null;
  const consumed = new Set<number>();
  const block: string[] = [];
  for (let i = first; i < end; i++) {
    const l = tidy(lines[i]!);
    if (isFooter(l)) break;
    consumed.add(i);
    if (l) block.push(l);
  }
  // Only a table of metrics ("Clicks – 15K +"), not a "KPIs & Evaluation" paragraph.
  if (!block.some((l) => KPI_METRIC.test(l)) || block.some((l) => l.length > 60)) return null;
  // Its "Deliverables" header cell just before.
  for (let i = first - 1; i >= start; i--) {
    const l = tidy(lines[i]!);
    if (!l) continue;
    if (/^deliverables?$/i.test(l)) consumed.add(i);
    break;
  }
  type Item = { label: string; value: string; note: string; parts: string[] };
  const items: Item[] = [];
  const lower = (s: string) => unshout(s, true).replace(/^\p{Lu}(?!\p{Lu})/u, (c) => c.toLowerCase());
  // "FULL VIDEO VIEWS" / "Full Video Views" → "Full video views" (acronyms kept).
  const sentence = (s: string) =>
    unshout(s.replace(/[’']s$/i, "s"), true).replace(/(?<=\s)(\p{Lu})(\p{Ll}+)/gu, (_w, a: string, b: string) => `${a.toLowerCase()}${b}`);
  let last: Item | null = null;
  let group: Item | null = null;
  let parenBefore = false;
  let qualifier = "";
  let number: string | null = null;
  for (const l of block) {
    if (/^kpi[’']?s?$/i.test(l) || /^deliverables?$/i.test(l)) {
      group = null;
      continue;
    }
    const paren = l.match(/^\((.+)\)$/);
    if (paren) {
      const q = lower(paren[1]!.trim()).replace(/\b(arabic|english|french|hindi|urdu)\b/gi, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
      if (last && !parenBefore && !last.note) last.note = q;
      else qualifier = q;
      parenBefore = true;
      continue;
    }
    parenBefore = false;
    const metric = l.match(KPI_METRIC);
    if (metric) {
      last = { label: sentence(metric[1]!.trim()), value: metric[2]!.replace(/\s+/g, ""), note: "", parts: [] };
      items.push(last);
      group = null;
      continue;
    }
    const num = l.match(/^([\d.,]+\s*(?:million|thousand|billion|bn|m|k)?)$/i);
    if (num) {
      number = num[1]!.trim().toLowerCase();
      continue;
    }
    if (number) {
      const label = sentence(l);
      const waiting = items.find((x) => x.label.toLowerCase() === label.toLowerCase() && !x.value);
      if (waiting) waiting.value = number;
      else items.push({ label, value: number, note: "", parts: [] });
      number = null;
      continue;
    }
    const count = l.match(/^(\d{1,3})\s*x?\s+(.+)$/i);
    if (count && group) {
      group.parts.push(`${count[1]} ${lower(count[2]!).replace(/\b(static|dynamic)s(?=\s+ads?\b)/gi, "$1")}`);
      last = group;
      continue;
    }
    last = { label: sentence(l), value: "", note: "", parts: [] };
    items.push(last);
    group = last;
  }
  const shown = items.filter((x) => x.value || x.parts.length);
  if (!shown.length) return null;
  const groups = shown.filter((x) => x.parts.length).map((x) => x.label);
  const title = `KPIs${groups.length ? ` & ${groups.join(" & ")}` : ""}${qualifier ? ` (${qualifier})` : ""}:`;
  return {
    at: Math.min(...consumed),
    consumed,
    lines: [title, ...shown.map((x) => `• ${x.label}: ${x.parts.length ? x.parts.join(" + ") : x.value}${x.note ? ` (${x.note})` : ""}`)],
  };
}

export function extractByRules(rawTexts: Array<{ source: string; text: string }>): Omit<ScopeExtraction, "texts" | "usedAI"> {
  const texts = rawTexts.map((t) => ({ ...t, text: t.text.replace(ZERO_WIDTH, "") }));
  const all = texts.map((t) => t.text).join("\n");
  const languageList = languagesIn(all);
  const rows: ExtractedScopeRow[] = [];
  const notes: string[] = [];
  // The agreement's totals ("96 Content Pieces per month", "Total: 62"): checks, not rows.
  const totals: StatedTotal[] = [];
  const phaseTotals: Array<{ phase: string; quantity: number }> = [];
  // A platform sub-heading ("Snapchat:", "Instagram:") names the rows under it; under "Shoots" they are notes.
  let platformCtx: string | null = null;
  let shootCtx = false;
  const boxes: Array<{ source: string; text: string }> = [];
  let phased = false;

  /**
   * One item → rows / notes. Returns the texts it was turned into (empty = nothing read),
   * used to tell whether the item's words all have a home.
   */
  // The whole line an item came from ("4 campaigns + 4-6 bursts per year": "per year" covers both).
  let lineText = "";
  const readItem = (rawItem: string, bullet: boolean, source: string): string[] => {
    const line = rawItem
      .replace(/^[\s\-–*o·]+/, "")
      // A label before the first item: "Monthly scope: 8 …", "We need 8 …".
      .replace(LEAD_IN, "")
      .trim();
    if (!line) return [];
    // "360 Social Media Management" — 360 names the service, it isn't a count.
    // It isn't a row either: it heads the services listed under it (the "other scope" sections).
    if (/^360\s*(?:°|degree)?\s+\p{L}/iu.test(line)) return [];
    // Revision rounds ("2 round", "2 rounds of revisions") are a note, not content.
    const rounds = line.match(/^(\d{1,2}|one|two|three)\s+rounds?\b/i);
    if (rounds) {
      notes.push(`${rounds[1]} round${rounds[1] === "1" || /^one$/i.test(rounds[1]!) ? "" : "s"} of revisions — kept as a note.`);
      return [line];
    }
    // A range ("4-6 smaller tactical bursts") uses the higher number (noted).
    const range = line.match(/^(\d{1,3})\s*(?:-|–|to)\s*(\d{1,3})\s+(.+)$/i);
    const counted = range ? `${Math.max(Number(range[1]), Number(range[2]))} ${range[3]}` : line;
    const m = counted.match(/^(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty)\s*[x×]?\s+(.+)$/i);
    // Hours, minutes, days, percentages and amounts aren't deliverables ("6 hrs × 7 days moderation", "within 24 hrs").
    if (m && /^(?:hrs?|hours?|mins?|minutes?|secs?|seconds?|days?|weeks?|months?|years?|%|percent|aed|usd|dirhams?)\b/i.test(m[2]!)) return [];
    if (!m) {
      // A shoot without a count ("Half a day shoot") is a note.
      if (/\bshoots?\b|\bshooting\b/i.test(line) && line.length <= 60) {
        notes.push(`${line.replace(/[.:;,]+$/, "")} — a production day, kept as a note (not a content piece).`);
        return [line];
      }
      // Services without a count (strategy, community management, reporting…) aren't rows: they stay,
      // grouped under their heading, in the "other scope" sections.
      return [];
    }
    const quantity = /^\d+$/.test(m[1]!) ? Number(m[1]) : WORD_NUMBERS[m[1]!.toLowerCase()]!;
    // The deliverable itself: no brackets, no "videos will be", nothing after " with / - / for / using".
    const what = m[2]!
      .replace(/\s*\(.*?\)\s*/g, " ")
      .replace(/^(videos?|posts?|pieces?|items?)\s+(will be|are|is)\s+/i, "")
      .split(/\s+(?:with|for|using|across|in|on|per|-|–)\s+/i)[0]!
      .replace(/[.:;,]+$/, "")
      .trim();
    if (TOTAL_WHAT.test(what) || /deliverables in total/i.test(what)) {
      const per = PER_MONTH.test(line) ? "month" : null;
      totals.push({ quantity, per, text: line.replace(/\s+/g, " ").trim() });
      notes.push(totalNote(quantity, `${what}${per && !PER_MONTH.test(what) ? " per month" : ""}`));
      return [line];
    }
    if (!what || /^days?\b|days a week/i.test(what)) return [];
    // A date ("Start date: 26 Oct 2026") isn't a count.
    if (/^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?(?:\s+'?\d{2,4})?$/i.test(what)) return [];
    // Talent isn't a deliverable.
    if (/^(models?|talents?)\b/i.test(what)) {
      notes.push(`${quantity} ${what.toLowerCase()} — talent, kept as a note.`);
      return [line];
    }
    // Items under a "Shoots" / "Production" heading are production, not content.
    if (shootCtx && !OUTPUT_RE.test(line)) {
      notes.push(`${quantity}x ${what} — production (shoots), kept as a note (not a content piece).`);
      return [line];
    }
    if (/\bshoots?\b|\bshooting\b/i.test(what)) {
      notes.push(`${quantity}x ${what} — a production day, kept as a note (not a content piece).`);
      // What the shoot produces is content: "… Shoot - Output is 5 Reel size Videos …".
      const output = line.slice(m[1]!.length).match(OUTPUT_RE);
      if (output) {
        const n = /^\d+$/.test(output[1]!) ? Number(output[1]) : WORD_NUMBERS[output[1]!.toLowerCase()]!;
        const made = output[2]!.trim();
        rows.push({ unit: unitFor(made), what: `${made.charAt(0).toUpperCase()}${made.slice(1)} (from the shoot)`, quantity: n, languageList, sizes: 1, source });
        return [what, output[0]];
      }
      return [what];
    }
    // How often: "… per year" / "annually" / "per quarter" stays with the row.
    const context = `${line} ${lineText}`;
    const often = /\bper\s+(?:year|annum)\b|\bannual(?:ly)?\b|\ba\s+year\b/i.test(context)
      ? " (per year)"
      : /\bper\s+quarter\b|\bquarterly\b/i.test(context)
        ? " (per quarter)"
        : /\bper\s+month\b|\/\s*month\b/i.test(line)
          ? " (per month)"
          : "";
    if (range) notes.push(`${range[1]}-${range[2]} ${what.toLowerCase()} — ${Math.max(Number(range[1]), Number(range[2]))} used.`);
    // The platform: the sub-heading the item sits under (tweets are always X).
    const platform = /\btweets?\b/i.test(what) ? "X" : platformCtx;
    const name = what.replace(/\s+\/\s*|\s*\/\s+/g, " / ");
    rows.push({ unit: unitFor(what), what: `${name.charAt(0).toUpperCase()}${name.slice(1)}${platform ? ` — ${platform}` : ""}${often}`, quantity, languageList, sizes: 1, source });
    return often === " (per month)" ? [what, often] : [what];
  };

  for (const { source, text } of texts) {
    const lines = joinFragments(joinWrapped(text.split(/\r?\n/)));
    // "Label: N" counts (per phase) first; those lines aren't read again.
    const counted = phaseCounts(lines, languageList, source);
    rows.push(...counted.rows);
    notes.push(...counted.notes);
    phaseTotals.push(...counted.phaseTotals);
    for (const quantity of counted.overall) totals.push({ quantity, per: null, text: `Total: ${quantity}` });
    platformCtx = null;
    shootCtx = false;
    let serviceSection = false;
    let listSection = false;
    phased ||= counted.phased;
    // The scope part of the document: from its "Agreed deliverables" / "Scope of work" heading (else all of it).
    const start = Math.max(0, lines.findIndex((l) => SCOPE_HEADING.test(tidy(l))) + 1);
    // An out-of-scope rate card after the scope isn't scope: nothing from it is read.
    const stop = lines.findIndex((l, i) => i >= start && OUT_OF_SCOPE.test(tidy(l)));
    if (stop >= 0) notes.push("The document's out-of-scope rate card isn't part of the scope (not read).");
    // A KPI table (views, clicks, CTR, streamers…) is one "other scope" section, never rows.
    const kpi = kpiSection(lines, start, stop >= 0 ? stop : lines.length);
    const box: string[] = [];
    lines.forEach((rawLine, idx) => {
      if (counted.consumed.has(idx) || (stop >= 0 && idx >= stop)) return;
      if (kpi?.consumed.has(idx)) {
        if (idx === kpi.at) box.push(...kpi.lines);
        return;
      }
      const line = normaliseCounts(tidy(rawLine));
      if (!line) return;
      // "Total: 62" alone: the agreement's total (a check, not a row).
      const total = line.match(/^(?:grand\s+)?total\s*[:\-–]\s*(\d{1,4})\.?$/i);
      if (total) {
        totals.push({ quantity: Number(total[1]), per: null, text: line });
        return;
      }
      // Platform sub-headings ("Snapchat:", "Instagram:", "Tiktok") and "Shoots" set what the items under them are.
      const heading = line.replace(/[\s:]+$/, "");
      const platform = PLATFORM_HEADING.get(heading.toLowerCase().replace(/\s+/g, " "));
      if (platform) {
        platformCtx = platform;
        shootCtx = false;
        return;
      }
      if (/^(?:shoots?|shooting|production(?:\s+days?)?)$/i.test(heading)) {
        shootCtx = true;
        platformCtx = null;
        return;
      }
      if (!new RegExp(String.raw`^(?:[-–*o·•]\s*)?(?:\d|${QTY})`, "i").test(line)) {
        platformCtx = null;
        shootCtx = false;
      }
      // "On IG & Fb: 20 posts/month (5 videos, 10 animations and 5 statics)" → its breakdown.
      const posts = postsPerMonth(line);
      if (posts) {
        for (const x of posts.rows) rows.push({ ...x, languageList, sizes: 1, source });
        if (posts.note) notes.push(posts.note);
        return;
      }
      // "x6 on-ground coverage per year … per event" → one row; the line stays in its section.
      const coverage = eventCoverage(line);
      if (coverage) {
        rows.push({ unit: "Others", what: coverage.what, quantity: coverage.quantity, languageList, sizes: 1, source });
        if (idx >= start) box.push(line);
        return;
      }
      // Items also start mid-line ("Mom Store: - 12 Short form video …"), sit in a sentence
      // ("Monthly scope: 8 static posts, 10 reels and 12 stories in English and Arabic") or
      // between inline bullets ("* Plan … * 1 weekly status meeting … * …").
      lineText = line;
      const { parts, bullet, inline } = partsOf(line);
      // Per part: kept for the box unless every item in it became a row / note.
      const keep = parts.map((part, pi) => {
        const items = itemsOf(part);
        let read = false;
        let all = true;
        items.forEach((item, ii) => {
          // A service row comes only from a bullet on its own line (not from a long inline-bullet paragraph).
          const asBullet = (pi === 0 && ii === 0 && bullet && !inline) || (ii === 0 && BULLET_START.test(item) && !inline);
          const got = readItem(item, asBullet, source);
          if (got.length) read = true;
          if (!covered(item.replace(LEAD_IN, ""), got)) all = false;
        });
        return !(read && all);
      });
      if (idx < start || DROP_LINE.test(line) || isFooter(line) || LEAD_LINE.test(line.replace(/^[\s\-–*·]+/, ""))) return;
      // Bulleted items stay in their section as written (a counted one is a row as well), marked when read in full.
      const readAll = !keep.some(Boolean);
      if (bullet || inline) keep.fill(true);
      if (!keep.some(Boolean)) return;
      const mark = readAll ? READ_MARK : "";
      if (!inline) {
        if (bullet) {
          box.push(`${mark}• ${parts[0] ?? ""}`);
          return;
        }
        // A heading cell followed by its "Platforms:" line: its service lines are its items.
        if (/:$/.test(line) || /^notes?$/i.test(line)) serviceSection = false;
        const next = lines.slice(idx + 1).find((l) => tidy(l));
        if (!/:$/.test(line) && next && /^platforms?\s*:/i.test(tidy(next))) {
          box.push(`${line.replace(/[.;,]+$/, "")}:`);
          serviceSection = true;
          return;
        }
        if (/^platforms?\s*:/i.test(line)) {
          box.push(line);
          return;
        }
        if (serviceSection) {
          box.push(`• ${line}`);
          return;
        }
        // "Special Activations (additional scope on request):" — the lines under it are its items
        // ("Seasonal Campaigns; Live Q&A on X, Influencer engagements" → one item each).
        if (/:$/.test(line)) {
          listSection = /\b(?:on request|additional scope|optional|special activations?)\b/i.test(line);
          box.push(line);
          return;
        }
        if (listSection) {
          const items = line.split(/\s*[;,]\s*/).filter(Boolean);
          const short = items.length > 1 && items.every((x) => x.length <= 40 && !/\d/.test(x));
          for (const x of short ? items : [line]) box.push(`• ${x}`);
          return;
        }
        box.push(line);
        return;
      }
      parts.forEach((part, pi) => {
        if (!keep[pi]) return;
        // Text before the first inline bullet ("Scope: Concept, Planning …") stays a plain line.
        box.push(pi === 0 && !bullet ? part : `${mark}• ${part}`);
      });
    });
    const textOut = finishBox(box);
    if (textOut) boxes.push({ source, text: textOut });
  }
  const otherScope = (boxes.length > 1 ? boxes.map((b) => `[${b.source}]\n${b.text}`).join("\n\n") : (boxes[0]?.text ?? "")).slice(0, OTHER_SCOPE_MAX);
  const find = (re: RegExp) => {
    for (const { text } of texts) {
      const m = text.match(re);
      if (m) return m[1] ?? null;
    }
    return null;
  };
  // Shoot days written in a sentence ("This will be a 1.5 shoot day …").
  for (const m of all.matchAll(/(\d+(?:\.\d+)?)\s*(?:full[- ]day\s+)?shoot\s*days?\b/gi)) {
    const note = `${m[1]} shoot day${m[1] === "1" ? "" : "s"} — kept as a note (not a content piece).`;
    if (!notes.some((n) => n.startsWith(`${m[1]} shoot`))) notes.push(note);
  }
  const platforms = PLATFORM_RULES.filter(([re]) => re.test(all)).map(([, name]) => name);
  // Work period: "Start date: …" / "End date: …" (deadline, go-live), or "Period: X to Y".
  const period = () => {
    const range = find(/(?:period|duration|term|campaign dates?)[^:\n]*[:\-–]\s*([^\n]+)/i);
    const [from, to] = range ? range.split(/\s+(?:to|until|till|-|–)\s+/i) : [];
    return {
      startDate:
        parseLooseDate(find(/\b(?:start(?:ing)?\s*date|starts?|commencement)\b[^:\n]*[:\-–]\s*([^\n]+)/i)) ?? parseLooseDate(from),
      endDate:
        parseLooseDate(find(/\b(?:end\s*date|ends?|deadline|go[- ]live|launch\s*date|completion)\b[^:\n]*[:\-–]\s*([^\n]+)/i)) ??
        parseLooseDate(to),
    };
  };
  const revenueRaw = find(/(?:revenue|budget|fee|value)[^\d]{0,20}([\d,]{4,})/i);
  // Counts per phase (months, events…) already say when; "monthly" there isn't a repeat.
  if (!phased && /\bmonthly\b/i.test(all)) notes.push("Monthly deliverables — the scope repeats every month.");
  if (rows.length && !/\bsizes?\b/i.test(all)) notes.push("Sizes aren't mentioned — 1 size per piece assumed.");
  return {
    projectName: null,
    platforms,
    revenue: revenueRaw ? Number(revenueRaw.replace(/,/g, "")) || null : null,
    dates: {
      clientPresentation: parseLooseDate(find(/client\s+pres(?:entation)?[^:\n]*[:\-–]\s*([^\n]+)/i)),
      milestone1: parseLooseDate(find(/milestone\s*1[^:\n]*[:\-–]\s*([^\n]+)/i)),
      milestone2: parseLooseDate(find(/milestone\s*2[^:\n]*[:\-–]\s*([^\n]+)/i)),
      ...period(),
    },
    scope: cleanRows(rows, { notes, totals }),
    notes,
    statedTotal: statedTotalOf(totals, phaseTotals),
    otherScope,
    leads: leadsByRules(texts),
  };
}

// ---------------------------------------------------------------------------
// AI (OpenAI vision): reads images and PDFs too
// ---------------------------------------------------------------------------

const EXTRACT_PROMPT = `You read briefs, statements of work (SOW) and pitch documents for a creative / marketing agency.
You get one or more files (images, PDFs, documents) and maybe typed text. For EACH input, transcribe its text
faithfully (keep bullet structure, max ${TEXT_MAX} characters). Then extract, across all inputs:
- "projectName": the campaign / idea / project title if one is stated (short), else null.
- "platforms": social platforms named (e.g. "Meta (Facebook)", "Instagram", "TikTok", "X (Twitter)", "LinkedIn").
- "revenue": a fee / budget / revenue amount in AED as a number if stated, else null.
- "dates": {"clientPresentation","milestone1","milestone2","startDate","endDate"} as YYYY-MM-DD if stated, else null.
  startDate / endDate are the period of the work (contract or campaign start; end date, deadline or go-live).
- "scope": the countable content deliverables, one row each: {"what": the deliverable as written (e.g. "Engagement posts"),
  "unit": one of ${SCOPE_UNITS.join(", ")} (Reel for reels, Story for stories — "Snap stories", "Native Snap stories",
  "Instagram stories" are Story —, Carousel, Video for videos / "TikTok videos" / "Native TikTok videos" / films,
  Static for posts / statics / images / visuals, Others ONLY for anything else such as tweets). Never use Others for an item
  whose name says story, video, reel, post, static or carousel. "quantity": integer,
  "languageList": languages from [${SCOPE_LANGUAGES.join(", ")}] the content is in (default ["English"]),
  "sizes": number of sizes/formats if stated else 1, "source": the input name it came from}.
  Services WITHOUT a count (strategy, community management, reporting, client meetings, content calendars, posting,
  copywriting, quality control, account management…) are NOT scope rows: they go in "otherScope", under their heading.
  "360" in "360 Social Media Management" is part of the service name, never a quantity.
  A shoot is not content, but what it produces is: "1 Half Day Shoot - Output is 5 Reel size Videos" → 5 × Reel (and the shoot as a note).
  Items joined with " * " on one line are separate items ("10 Brand Stories * Half a day shoot * 2 round" → 10 × Story;
  the shoot and "2 rounds of revisions" as notes).
  Do NOT list totals ("96 Content Pieces per month", "53x content pieces in total", "Total: 62"), shoots / shoot days /
  production days / "full day video shoots", revision rounds or models / talent as scope rows. A total goes in
  "statedTotal" (the rows are checked against it); shoots and production visits go in "notes".
  When a deliverable is broken down into sub-items whose counts add up to it ("12 videos: 5 storytelling, 7 shorter"),
  list it ONCE with the split in "what" ("Short-form videos (5 storytelling, 7 shorter)").
  If two inputs list the same deliverable, list it once.
  Counts written as "Label: N" ("Static:4; Carousel:6; Reels/Motion Graphics:13 to 15; Stories:35") are rows: unit from
  the label (Reels/Motion Graphics → Reel, Stories → Story, Static → Static, Carousel → Carousel). "Total: N" is not a row:
  per phase it goes in "statedTotal.phases" ({"phase","quantity"}).
  A range ("13 to 15", "13-15") uses the HIGHER number, with a note "Reels/Motion Graphics: 13 to 15 — 15 used".
  When such counts sit under phase / period headings ("Pre – Pre Event : Sep '26", "Event : Dec '26", "Phase 1",
  "Month 1", "Week 1", a month), list one row per label AND phase: "what" = "<Label> — <phase>"
  (e.g. "Static — Pre-Pre Event, Sep '26"), and add a note with the totals per unit across the phases
  (e.g. "Across the 4 phases: Static 29, Carousel 39, Reel 100, Story 173").
  A counted item inside a services list ("1 weekly status meeting at LPS Office") can still be a row.
  "On IG & Fb: 20 posts/month (5 videos, 10 animations and 5 statics)": the 20 is the TOTAL — list the breakdown
  (5 × Video, 10 × Reel for animations / animated / motion, 5 × Static), "what" with the platforms and "(per month)".
  "On LinkedIn & X: 4 static posts/month" → 4 × Static ("Static posts — LinkedIn & X (per month)").
  Hours, minutes, days, SLAs, percentages and amounts are NOT quantities ("6 hrs × 7 days moderation", "within 24 hrs",
  "up to 15 seconds") — those lines are service details for "otherScope".
  "Four (4) major integrated campaigns + four-to-six (4-6) smaller tactical bursts per year" → 4 × Others "Major integrated
  campaigns (per year)" and 6 × Others "Smaller tactical bursts (per year)" (range → higher number, noted).
  "x6 on-ground coverage per year … 20 edited photos + 3 recap videos per event" → ONE row: 6 × Others "Live event coverage
  (per year; per event: 20 edited photos + 3 recap videos)" — the per-event items are not separate rows.
  An "Out-of-Scope Rate Card" (or any rate card / price list) is NOT scope: no rows, no notes, nothing in "otherScope" from it
  — add one note "The document's out-of-scope rate card isn't part of the scope".
  Platform sub-headings ("Snapchat:", "Instagram:", "Tiktok") name the rows under them: "what" = "<item> — <platform>".
  Example (a monthly retainer agreement):
    "96 Content Pieces per month / Snapchat: 15-18 Native Snap stories per month / Instagram: 5x reels (Instagram),
    15x brand planned stories, 8x statics/ motion graphics / Tiktok: 8x native TikTok videos, 30x tweets /
    Shoots: 3x lean (mobile shot) storytelling visits + 2 x full day video shoots" →
    rows 18 × Story "Native Snap stories — Snapchat (per month)" (note "15-18 Native Snap stories — 18 used"),
    5 × Reel "Reels — Instagram", 15 × Story "Brand planned stories — Instagram", 8 × Static "Statics / motion graphics — Instagram",
    8 × Video "Native TikTok videos — TikTok", 30 × Others "Tweets — X"; "statedTotal" {"quantity":96,"per":"month",
    "text":"96 Content Pieces per month"}; the storytelling visits and the full day video shoots as notes (production).
    Its services under "360 SOCIAL MARCOMS & ACCOUNT MANAGEMENT / PLATFORMS: META (FB & IG), TIKTOK, X (TWITTER)" are the
    section "360 Social Marcoms & Account Management:" with "Platforms: Meta (FB & IG), TikTok, X (Twitter)" and one
    "• item" per service; "Special Activations (additional scope on request):" with one "• item" each (split "Seasonal
    Campaigns; Live Q&A on X, Influencer engagements"); a KPI table → "KPIs & Streamers (KSA only):" with
    "• Full video views: 1.2 million (expected)", "• Clicks: 15K+", "• CTR: 5%+ (estimated)",
    "• Streamers: 2 unique static ads + 2 unique dynamic ads (Arabic only)". KPI figures are never rows.
  Ignore zero-width characters.
  Documents whose sections are plain headings ("Strategy & Planning", "Community Management") followed by sentences:
  each heading is a section in "otherScope" and each sentence a "• item" line under it.
- "otherScope": ONE string with the rest of the scope / deliverables part of the documents that is NOT a scope row or a
  note, as SECTIONS. Each section is its heading on its own line ending with ":" (e.g. "Account Management & Content
  Planning:", "Content Creation & Management:", "360 Social Media Management – Facebook, Instagram, YouTube, LinkedIn and
  TikTok:"), then its lines: a lead-in line as written ("Scope: Platforms: Native: FB/IG/LI/X/Tiktok.") and each item as
  its own "• item" line (inline " * " items split). Separate sections with ONE blank line. Keep each item under the heading
  it belongs to, verbatim but tidied (runs of spaces collapsed), exclusions kept ("Subtitling is not included").
  Start at the "Agreed deliverables" / "Deliverables" / "Scope of work" heading if there is one. Leave out table headers
  (ITEM / DETAILS / NOTES), "NIL" / "N/A", the address / phone / email footer and the team / resources list.
  "" when nothing is left.
- "statedTotal": the overall number of content pieces the agreement states ("96 Content Pieces per month" →
  {"quantity":96,"per":"month","text":"96 Content Pieces per month"}; "per" is "month" or null), with "phases" when
  there are "Total: N" lines per phase; null when the agreement states no total. It is a check, never a row.
- "notes": short notes for the user to check (shoot days, things that repeat monthly, assumptions, conflicts between inputs).
- "leads": the AGENCY-side people named as lead: account lead, project lead, point of contact / contact person on the
  agency's side, or "Prepared by" (mark those {"weak":true}). Not the client's people, not signatories of the client.
  One entry per person: {"name": the person's name as written, "source": the input name}.
Reply with JSON only:
{"texts":[{"source":"<input name>","text":"..."}],"projectName":null,"platforms":[],"revenue":null,
 "dates":{"clientPresentation":null,"milestone1":null,"milestone2":null,"startDate":null,"endDate":null},"scope":[],"statedTotal":null,"notes":[],"otherScope":"","leads":[]}`;

/** The model's "otherScope" (any type) as tidy text: spaces collapsed per line, at most OTHER_SCOPE_MAX. */
function parseOtherScope(raw: unknown): string {
  // A string, a list of lines, or a list of sections ({ title / heading, items / lines / text }).
  const section = (x: unknown): string => {
    if (typeof x === "string") return x;
    if (!x || typeof x !== "object") return "";
    const o = x as Record<string, unknown>;
    const title = String(o.title ?? o.heading ?? "").trim().replace(/:$/, "");
    const items = o.items ?? o.lines ?? o.bullets;
    const body = Array.isArray(items)
      ? items.filter((i) => typeof i === "string").map((i) => (/^[•*\-–]/.test(i.trim()) ? i.trim() : `• ${i.trim()}`)).join("\n")
      : String(o.text ?? o.body ?? "");
    return [title ? `${title}:` : "", body].filter(Boolean).join("\n");
  };
  const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map(section).filter(Boolean).join("\n\n") : section(raw);
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(tidy)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, OTHER_SCOPE_MAX);
}

/** The model's "statedTotal" (any shape) checked; null when it isn't a positive count. */
export function parseStatedTotal(raw: unknown): StatedTotal | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const phases = (Array.isArray(o.phases) ? o.phases : [])
    .map((x) => x as Record<string, unknown>)
    .map((x) => ({ phase: String(x?.phase ?? "").replace(ZERO_WIDTH, "").trim().slice(0, 80), quantity: Math.round(Number(x?.quantity)) }))
    .filter((x) => x.phase && Number.isFinite(x.quantity) && x.quantity > 0)
    .slice(0, 24);
  let quantity = Math.round(Number(o.quantity));
  if (!(Number.isFinite(quantity) && quantity > 0) && phases.length) quantity = phases.reduce((n, x) => n + x.quantity, 0);
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > 100_000) return null;
  return {
    quantity,
    per: o.per === "month" ? "month" : null,
    text: String(o.text ?? "").replace(ZERO_WIDTH, "").replace(/\s+/g, " ").trim().slice(0, 200),
    ...(phases.length ? { phases } : {}),
  };
}

async function extractWithAI(files: ExtractInputFile[], typed: string): Promise<Omit<ScopeExtraction, "usedAI">> {
  const content: Array<Record<string, unknown>> = [{ type: "text", text: "Inputs follow. Each starts with its name." }];
  for (const f of files) {
    content.push({ type: "text", text: `Input name: ${f.originalname}` });
    if (isImage(f)) {
      content.push({ type: "image_url", image_url: { url: `data:${f.mimetype};base64,${f.buffer.toString("base64")}`, detail: "high" } });
    } else if (isPdf(f)) {
      content.push({ type: "file", file: { filename: f.originalname, file_data: `data:application/pdf;base64,${f.buffer.toString("base64")}` } });
    } else {
      const text = await localText(f);
      content.push({ type: "text", text: text ?? "(this file type can't be read)" });
    }
  }
  if (typed.trim()) content.push({ type: "text", text: `Input name: ${TYPED}\n${typed.slice(0, TEXT_MAX)}` });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY!.trim()}` },
      body: JSON.stringify({
        model: briefCheckModel(),
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: EXTRACT_PROMPT },
          { role: "user", content },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const p = JSON.parse(json.choices?.[0]?.message?.content ?? "{}") as Record<string, unknown>;
    const texts = Array.isArray(p.texts)
      ? (p.texts as Array<Record<string, unknown>>).map((t) => ({ source: String(t.source ?? ""), text: String(t.text ?? "").slice(0, TEXT_MAX), read: true }))
      : [];
    const dates = (p.dates ?? {}) as Record<string, unknown>;
    // Rows the model still made of totals / shoots are taken out here (totals become the stated total).
    const sink: CleanSink = { notes: [], totals: [] };
    const scope = cleanRows(Array.isArray(p.scope) ? (p.scope as ExtractedScopeRow[]) : [], sink);
    const notes = [...(Array.isArray(p.notes) ? (p.notes as unknown[]).map(String).map((s) => s.replace(ZERO_WIDTH, "").slice(0, 300)) : []), ...sink.notes].slice(0, 24);
    return {
      texts,
      projectName: typeof p.projectName === "string" && p.projectName.trim() ? p.projectName.trim().slice(0, 80) : null,
      platforms: Array.isArray(p.platforms) ? (p.platforms as unknown[]).map(String).map((s) => s.slice(0, 40)).slice(0, 12) : [],
      revenue: typeof p.revenue === "number" && p.revenue >= 0 ? p.revenue : null,
      dates: {
        clientPresentation: parseLooseDate(dates.clientPresentation),
        milestone1: parseLooseDate(dates.milestone1),
        milestone2: parseLooseDate(dates.milestone2),
        startDate: parseLooseDate(dates.startDate),
        endDate: parseLooseDate(dates.endDate),
      },
      scope,
      notes,
      statedTotal: parseStatedTotal(p.statedTotal) ?? statedTotalOf(sink.totals, []),
      otherScope: parseOtherScope(p.otherScope),
      // The model's leads, plus any the rules see in its transcription (it can miss a "Lead:" line).
      leads: mergeLeads(
        (Array.isArray(p.leads) ? (p.leads as Array<Record<string, unknown>>) : [])
          .filter((l) => typeof l?.name === "string" && l.name.trim())
          .flatMap((l) =>
            leadNames(String(l.name)).map((name) => ({ name, source: String(l.source ?? "").slice(0, 255), ...(l.weak === true ? { weak: true } : {}) }))
          ),
        leadsByRules(texts)
      ),
    };
  } finally {
    clearTimeout(timer);
  }
}

function mergeLeads(...lists: ExtractedLead[][]): ExtractedLead[] {
  const out: ExtractedLead[] = [];
  for (const l of lists.flat()) if (!out.some((o) => o.name.toLowerCase() === l.name.toLowerCase())) out.push(l);
  return out.slice(0, 10);
}

/** Reads the inputs and extracts the scope (AI when configured, else rules on readable text). */
export async function extractScope(files: ExtractInputFile[], typed: string): Promise<ScopeExtraction> {
  if (briefCheckConfigured()) {
    try {
      return { ...(await extractWithAI(files, typed)), usedAI: true };
    } catch (err) {
      console.error("[scope-extract] AI failed, falling back to rules", err);
    }
  }
  const texts: ScopeExtraction["texts"] = [];
  for (const f of files) {
    const text = await localText(f);
    texts.push({ source: f.originalname, text: text ?? "", read: text !== null });
  }
  if (typed.trim()) texts.push({ source: TYPED, text: typed.slice(0, TEXT_MAX), read: true });
  const readable = texts.filter((t) => t.read && t.text);
  const result = extractByRules(readable);
  const unread = texts.filter((t) => !t.read).map((t) => t.source);
  if (unread.length) {
    result.notes.unshift(
      `Couldn't read ${unread.join(", ")} without the AI reader (OPENAI_API_KEY isn't set). Type or paste the text from ${unread.length === 1 ? "it" : "them"} in the text box.`
    );
  }
  return { texts, ...result, usedAI: false };
}
