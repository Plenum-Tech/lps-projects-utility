// ---------------------------------------------------------------------------
// Voice task assistant — shared word matching + the RULES-BASED FALLBACK
// parser. The fallback runs when OPENAI_API_KEY isn't set (local testing) or
// the AI call fails; it only knows simple phrasing: task codes ("MO-6"),
// numbers + units ("3 reels"), durations ("2 hours", "45 minutes", "1h 30m"),
// time ranges ("from 10 to 12"), weekdays / today / tomorrow, a project by its
// code or brand / name, people by first name, "rework of X", "client" →
// external review. Pure (the caller passes the vocabulary), so it is checked
// without a database: `bun src/scripts/voiceParseCheck.ts`.
// ---------------------------------------------------------------------------

export const VOICE_ACTIONS = ["create", "close", "log_time"] as const;
export type VoiceAction = (typeof VOICE_ACTIONS)[number];

/** What a message asks for: an action, a rework (= create + iteration rework), or none. */
export type VoiceIntent = VoiceAction | "rework" | "out_of_scope" | "cancel";

/** The field the assistant last asked for (answers are read for it first). */
export const VOICE_FIELDS = [
  "action",
  "project",
  "iteration",
  "reworkOf",
  "reworkSource",
  "unit",
  "quantity",
  "shortName",
  "brief",
  "assignees",
  "task",
  "final",
  "note",
  "time",
] as const;
export type VoiceField = (typeof VOICE_FIELDS)[number];

export interface VocabProject {
  id: string;
  code: string;
  name: string;
  brand: string;
  /** The project's scope units ("Reel", "Video" …). */
  units: string[];
}

export interface VocabPerson {
  id: string;
  name: string;
}

/** What one message says (a change to the draft); ids are already matched. */
export interface Extracted {
  intent?: VoiceIntent;
  /** One id = matched; several = ask which. */
  projectIds?: string[];
  iteration?: "new" | "rework";
  unit?: string;
  quantity?: number;
  shortName?: string;
  brief?: string;
  addPeople?: string[];
  removePeople?: string[];
  /** A name that fits several people: ask which. */
  ambiguousPeople?: Array<{ said: string; ids: string[] }>;
  /** "YYYY-MM-DD". */
  dueDate?: string;
  startDate?: string;
  /** Task code of the original task ("MO-6"). */
  reworkOf?: string;
  reworkSource?: "internal" | "external";
  /** The task to close / log on: a code, a global number, or words of its title. */
  taskCode?: string;
  taskNumber?: number;
  taskText?: string;
  minutes?: number;
  /** App-timezone wall clock "YYYY-MM-DDTHH:mm". */
  start?: string;
  end?: string;
  /** Close: the outcome note; log time: the memo. */
  note?: string;
  finalUrl?: string;
}

export interface ParseOptions {
  /** The field the assistant asked for last (null at the start). */
  asking: VoiceField | null;
  /** The draft's action so far (decides how loose words are read). */
  action: VoiceAction | null;
  /** Today in the app timezone, "YYYY-MM-DD". */
  today: string;
  projects: VocabProject[];
  people: VocabPerson[];
  /** The speaker's user id ("me"). */
  me: string;
  /** Every scope unit name the user may pick (project units + the standard ones). */
  units: string[];
  /** Project codes the user can see (task codes said with a space: "MO 6"). */
  codes: string[];
  /** The draft already has a short name: only "called …" / "named …" changes it. */
  keepShortName?: boolean;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[_|]+/g, " ")
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max).trim() : s);
const capFirst = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
/** Trims spaces and dangling punctuation / joining words at both ends. */
function tidy(s: string): string {
  let out = s.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 4; i++) {
    out = out
      .replace(/^(?:[,.;:!?\-–—]+|and|then|also|so|please|pls)\s*/i, "")
      .replace(/\s*(?:[,;:.!?\-–—]+|and|then|please|pls|today)$/i, "")
      .trim();
  }
  return out.replace(/[.!?]+$/, "").trim();
}

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** Spoken numbers → digits ("forty five minutes" → "45 minutes", "an hour and a half" → "1.5 hours"). */
export function normalizeNumbers(text: string): string {
  let t = ` ${text} `;
  t = t.replace(/\bhalf an? hour\b/gi, "30 minutes");
  t = t.replace(/\b(?:an|one|a) hour and a half\b/gi, "1.5 hours");
  t = t.replace(/\b(?:an|a) hour\b/gi, "1 hour");
  t = t.replace(/\ba couple of hours\b/gi, "2 hours");
  const tens = Object.keys(TENS).join("|");
  const small = Object.keys(SMALL).join("|");
  t = t.replace(new RegExp(`\\b(${tens})(?:[\\s-](one|two|three|four|five|six|seven|eight|nine))?\\b`, "gi"), (_m, a: string, b?: string) =>
    String(TENS[a.toLowerCase()]! + (b ? SMALL[b.toLowerCase()]! : 0))
  );
  t = t.replace(new RegExp(`\\b(${small})\\b`, "gi"), (m) => String(SMALL[m.toLowerCase()]));
  t = t.replace(/\b(\d+) and a half (hours?|hrs?)\b/gi, (_m, n: string, u: string) => `${n}.5 ${u}`);
  t = t.replace(/\b(\d+) (hours?|hrs?) and a half\b/gi, (_m, n: string, u: string) => `${n}.5 ${u}`);
  return t.trim();
}

// ---------------------------------------------------------------------------
// Dates and times
// ---------------------------------------------------------------------------

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function addDaysKey(key: string, days: number): string {
  const d = new Date(`${key}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const DATE_WORD =
  "(?:the\\s+)?(?:day after tomorrow|today|tonight|tomorrow|(?:next|this|coming)\\s+\\w+|(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?|in\\s+\\d+\\s+days?|\\d{1,2}(?:st|nd|rd|th)?(?:\\s+of)?\\s+[a-z]{3,9}|[a-z]{3,9}\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{4}-\\d{2}-\\d{2})";

/** A spoken day ("Thursday", "tomorrow", "in 3 days", "29 Oct") → "YYYY-MM-DD", or null. */
export function resolveDay(phrase: string, today: string): string | null {
  const p = phrase.toLowerCase().replace(/^the\s+/, "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return p;
  if (p === "today" || p === "tonight") return today;
  if (p === "tomorrow") return addDaysKey(today, 1);
  if (p === "day after tomorrow") return addDaysKey(today, 2);
  const inDays = /^in\s+(\d+)\s+days?$/.exec(p);
  if (inDays) return addDaysKey(today, Math.min(365, Number(inDays[1])));
  const wd = /^(?:(?:next|this|coming)\s+)?(mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?$/.exec(p);
  if (wd) {
    const idx = WEEKDAYS.findIndex((d) => d.startsWith(wd[1]!.slice(0, 3)));
    const now = new Date(`${today}T00:00:00.000Z`).getUTCDay();
    // The next one after today ("due Thursday" on a Thursday = next week).
    let ahead = (idx - now + 7) % 7;
    if (ahead === 0) ahead = 7;
    return addDaysKey(today, ahead);
  }
  const dm = /^(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+([a-z]{3,9})$/.exec(p) ?? null;
  const md = /^([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?$/.exec(p) ?? null;
  const day = dm ? Number(dm[1]) : md ? Number(md[2]) : NaN;
  const monthWord = dm ? dm[2]! : md ? md[1]! : "";
  const month = MONTHS.indexOf(monthWord.slice(0, 3));
  if (month >= 0 && day >= 1 && day <= 31) {
    const year = Number(today.slice(0, 4));
    let key = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    // A date already past this year means next year's.
    if (key < today) key = `${year + 1}${key.slice(4)}`;
    return Number.isNaN(new Date(`${key}T00:00:00Z`).getTime()) ? null : key;
  }
  return null;
}

/** "2 hours", "45 minutes", "1h 30m", "1.5 hours" → minutes (after normalizeNumbers). */
export function parseDuration(text: string): number | null {
  const compact = /\b(\d{1,2})\s*h\s*(\d{1,2})\s*m?\b/i.exec(text);
  if (compact) return Number(compact[1]) * 60 + Number(compact[2]);
  const hours = /\b(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b(?:\s*(?:and\s+)?(\d{1,2})\s*(?:m|min|mins|minute|minutes)\b)?/i.exec(text);
  if (hours) return Math.round(Number(hours[1]) * 60) + (hours[2] ? Number(hours[2]) : 0);
  const mins = /\b(\d{1,4})\s*(?:m|min|mins|minute|minutes)\b/i.exec(text);
  if (mins) return Number(mins[1]);
  return null;
}

const CLOCK = "(\\d{1,2})(?:[:.](\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)?";

/** "from 10 to 12:30" / "10am - 1pm" (today, or yesterday when said) → app-local "YYYY-MM-DDTHH:mm" pair. */
export function parseRange(text: string, today: string): { start: string; end: string } | null {
  const re = new RegExp(`\\b(?:from\\s+|between\\s+)?${CLOCK}\\s*(?:to|till|until|and|-|–)\\s*${CLOCK}`, "gi");
  const toMinutes = (h: string, mi: string | undefined, ap: string | undefined) => {
    let hour = Number(h);
    const minute = mi ? Number(mi) : 0;
    const mer = (ap ?? "").toLowerCase().replace(/\./g, "");
    if (mer === "pm" && hour < 12) hour += 12;
    else if (mer === "am" && hour === 12) hour = 0;
    // No am / pm: 1–7 o'clock is the afternoon in a working day.
    else if (!mer && hour >= 1 && hour <= 7) hour += 12;
    return hour > 23 || minute > 59 ? null : hour * 60 + minute;
  };
  for (const m of text.matchAll(re)) {
    // Needs "from" / "between" or an am/pm, so "MO-6 - 2 hours" isn't read as a time.
    if (!/^(?:from|between)\s/i.test(m[0]) && !m[3] && !m[6]) continue;
    const start = toMinutes(m[1]!, m[2], m[3]);
    let end = toMinutes(m[4]!, m[5], m[6] ?? (m[3] && Number(m[4]) > Number(m[1]) ? m[3] : undefined));
    if (start === null || end === null) continue;
    if (end <= start && !m[6] && end + 720 <= 1439) end += 720;
    if (end <= start) continue;
    const day = /\byesterday\b/i.test(text) ? addDaysKey(today, -1) : today;
    const hhmm = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
    return { start: `${day}T${hhmm(start)}`, end: `${day}T${hhmm(end)}` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Vocabulary matching (shared with the AI path)
// ---------------------------------------------------------------------------

/** Projects named in `text`: by code (strongest), brand or name. Several = ambiguous. */
export function matchProjects(text: string, projects: VocabProject[], loose = false): string[] {
  const t = ` ${norm(text)} `;
  // Codes are checked on the text with its punctuation ("EO26, 3 statics" isn't the task EO26-3).
  const lower = ` ${text.toLowerCase()} `;
  // A loose answer is a few words at most (a sentence isn't read word by word).
  const looseOk = loose && t.trim().split(" ").length <= 4;
  let best = 0;
  let ids: string[] = [];
  for (const p of projects) {
    let score = 0;
    const code = p.code.toLowerCase();
    // The code on its own (not a task code like "MO-6").
    if (code && new RegExp(`(?:^|[^a-z0-9])${escapeRe(code)}(?![a-z0-9]|\\s?[-–]\\s?\\d|\\s\\d)`).test(lower)) score = 100;
    const name = norm(p.name);
    if (!score && name && t.includes(` ${name} `)) score = 90;
    const brand = norm(p.brand);
    if (!score && brand.length >= 2 && t.includes(` ${brand} `)) score = 50 + brand.length;
    if (!score && looseOk) {
      // An answer to "which project?": any longer word of its name / brand.
      const words = `${name} ${brand}`.split(" ").filter((w) => w.length >= 4);
      const hits = words.filter((w) => t.includes(` ${w} `)).length;
      if (hits) score = 10 + hits;
    }
    if (score > best) {
      best = score;
      ids = [p.id];
    } else if (score && score === best) ids.push(p.id);
  }
  return ids;
}

const NOT_NAMES = new Set([
  "new", "task", "tasks", "close", "log", "time", "hours", "hour", "minutes", "the", "for", "and", "with", "due", "today",
  "tomorrow", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "rework", "work", "brief",
  "internal", "external", "client", "review", "done", "project", "please", "add", "remove", "assign", "assigned", "me",
  "reel", "reels", "video", "videos", "static", "statics", "story", "stories", "carousel", "carousels", "post", "posts",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
]);

/** People named in `text` (full name, or first name when it is unique). */
export function matchPeople(
  text: string,
  people: VocabPerson[],
  opts: { me: string; skip?: string[]; anyCase?: boolean } = { me: "" }
): { ids: string[]; ambiguous: Array<{ said: string; ids: string[] }> } {
  const ids: string[] = [];
  const ambiguous: Array<{ said: string; ids: string[] }> = [];
  const t = ` ${norm(text)} `;
  const skip = new Set((opts.skip ?? []).flatMap((s) => norm(s).split(" ")));
  if (opts.me && /\s(?:me|myself)\s/.test(t)) ids.push(opts.me);
  // Full names first.
  const covered = new Set<string>();
  for (const p of people) {
    const full = norm(p.name);
    if (full.includes(" ") && t.includes(` ${full} `)) {
      if (!ids.includes(p.id)) ids.push(p.id);
      for (const w of full.split(" ")) covered.add(w);
    }
  }
  // Then first names: capitalised words (transcripts capitalise names), or any word in an answer.
  const words = (opts.anyCase ? text : text.replace(/\b[a-z][\p{L}'-]*/gu, " "))
    .split(/[^\p{L}'-]+/u)
    .map((w) => w.replace(/'s$/i, "").toLowerCase())
    .filter((w) => w.length >= 3 && !NOT_NAMES.has(w) && !covered.has(w) && !skip.has(w));
  const byFirst = new Map<string, VocabPerson[]>();
  for (const p of people) {
    const first = norm(p.name).split(" ")[0] ?? "";
    if (first.length < 3) continue;
    byFirst.set(first, [...(byFirst.get(first) ?? []), p]);
  }
  for (const w of new Set(words)) {
    const found = byFirst.get(w);
    if (!found) continue;
    if (found.length === 1) {
      if (!ids.includes(found[0]!.id)) ids.push(found[0]!.id);
    } else ambiguous.push({ said: capFirst(w), ids: found.map((p) => p.id) });
  }
  return { ids, ambiguous };
}

/** "3 reels" / "reel 3" → canonical unit + quantity (the unit list decides the spelling). */
export function matchUnit(text: string, units: string[]): { unit: string; quantity?: number; index: number; length: number } | null {
  const forms = new Map<string, string>();
  for (const u of units) {
    const l = u.toLowerCase().trim();
    if (!l || forms.has(l)) continue;
    forms.set(l, u);
    forms.set(l.endsWith("y") ? `${l.slice(0, -1)}ies` : `${l}s`, u);
    forms.set(`${l}es`, u);
  }
  if (forms.size === 0) return null;
  const alt = [...forms.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
  const numFirst = new RegExp(`\\b(\\d{1,4})\\s+(?:x\\s+)?(${alt})\\b`, "i").exec(text);
  if (numFirst) return { unit: forms.get(numFirst[2]!.toLowerCase())!, quantity: Number(numFirst[1]), index: numFirst.index, length: numFirst[0].length };
  const unitFirst = new RegExp(`\\b(${alt})\\s+(\\d{1,4})\\b(?!\\s*(?:h|hr|hrs|hours?|m|mins?|minutes?)\\b)`, "i").exec(text);
  if (unitFirst) return { unit: forms.get(unitFirst[1]!.toLowerCase())!, quantity: Number(unitFirst[2]), index: unitFirst.index, length: unitFirst[0].length };
  const bare = new RegExp(`\\b(${alt})\\b`, "i").exec(text);
  if (bare) return { unit: forms.get(bare[1]!.toLowerCase())!, index: bare.index, length: bare[0].length };
  return null;
}

/** Task codes said in `text` ("MO-6", "EO26-7", "ENOC 13" when ENOC is a known code). */
export function findTaskCodes(text: string, codes: string[]): string[] {
  const out: string[] = [];
  const known = new Set(codes.map((c) => c.toUpperCase()));
  for (const m of text.matchAll(/\b([A-Za-z][A-Za-z0-9]{0,11})\s?[-–]\s?(\d{1,5})\b/g)) {
    out.push(`${m[1]!.toUpperCase()}-${Number(m[2])}`);
  }
  // Said without the dash: "ENOC 13" / "ENOC13" — only for codes the user can see.
  for (const m of text.matchAll(/\b([A-Za-z][A-Za-z0-9]{0,11})\s(\d{1,5})\b/g)) {
    const code = m[1]!.toUpperCase();
    if (known.has(code)) out.push(`${code}-${Number(m[2])}`);
  }
  for (const m of text.matchAll(/\b([A-Za-z][A-Za-z0-9]{0,10}[A-Za-z])(\d{1,5})\b/g)) {
    const code = m[1]!.toUpperCase();
    if (known.has(code)) out.push(`${code}-${Number(m[2])}`);
  }
  return [...new Set(out)];
}

const URL_RE = /\bhttps?:\/\/[^\s,<>"]+/i;

// ---------------------------------------------------------------------------
// The fallback parser
// ---------------------------------------------------------------------------

const FREE_TEXT: ReadonlySet<VoiceField | null> = new Set<VoiceField | null>(["brief", "shortName", "note"]);
/** A new command said while a free-text answer was expected (it is not taken as the answer). */
const COMMAND_START =
  /^\s*(?:new task\b|create (?:a )?(?:new )?task\b|close\s+(?:task\b|this\b|[a-z][a-z0-9]*[-\s]?\d)|log\s+(?:time\b|\d)|rework of\b|cancel\b|start over\b|never ?mind\b)/i;

function detectIntent(t: string): VoiceIntent | undefined {
  if (/^\s*(?:cancel|stop|start over|reset|never ?mind|forget it)\b/i.test(t)) return "cancel";
  if (/\bwhat(?:'s| is| are)?\b.*\bdue\b|\bmove\b.*\b(?:time|hours?|minutes?|entr(?:y|ies))\b|\bdelete\b|\breassign\b|\bwhat (?:are|is) my\b/i.test(t)) {
    return "out_of_scope";
  }
  // The command the message starts with wins ("new task … close-up shots").
  if (/^\s*(?:please\s+)?(?:new|create|add|make|open)\b(?:\s+\w+)?\s+task\b|^\s*new work\b/i.test(t)) return "create";
  if (/^\s*(?:please\s+)?(?:rework|redo|revision|revise)\b/i.test(t)) return "rework";
  if (/^\s*(?:please\s+)?(?:close|complete|finish|submit|mark)\b/i.test(t)) return "close";
  if (/^\s*(?:please\s+)?(?:log|track|add)\b.*\b(?:time|hours?|minutes?|h|m)\b/i.test(t)) return "log_time";
  if (/\b(?:close|closing|complete|completed|finish|finished|submit|wrap(?:ped)? up)\b|\bmark\b.*\b(?:done|complete)\b/i.test(t)) return "close";
  if (/\blog(?:ged)?\b|\b(?:spent|tracked)\b.*\b(?:hours?|minutes?)\b/i.test(t)) return "log_time";
  if (/\b(?:rework|redo|revision)\b/i.test(t)) return "rework";
  if (/\b(?:new|create|add|make)\b(?:\s+\w+)?\s+task\b|\bnew work\b/i.test(t)) return "create";
  return undefined;
}

/** Leftover words after the command, code, time and link are taken out (a close note / log memo). */
function remainder(text: string, parts: string[]): string {
  let out = ` ${text} `;
  out = out.replace(URL_RE, " ");
  for (const p of parts) if (p) out = out.replace(new RegExp(`(?:\\b(?:on|for|of)\\s+)?${escapeRe(p)}`, "i"), " ");
  out = out
    .replace(/\b(?:from|between)\s+\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?\s*(?:to|till|until|and|-)\s*\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?/gi, " ")
    .replace(/\b\d+(?:\.\d+)?\s*(?:h|hr|hrs|hours?)\b(?:\s*(?:and\s+)?\d{1,2}\s*(?:m|mins?|minutes?)\b)?/gi, " ")
    .replace(/\b\d+\s*(?:m|mins?|minutes?)\b/gi, " ")
    .replace(/^\s*(?:please\s+)?(?:close|complete|finish|log|submit)(?:\s+(?:task|time|hours))?\b/i, " ")
    .replace(/^\s*(?:this(?:\s+(?:one|task))?|it)\b/i, " ")
    .replace(/\b(?:spent|today|yesterday|this morning|so far)\b/gi, " ")
    .replace(/(?:\s*[,;]\s*)+/g, ", ")
    .replace(/^\s*(?:(?:,|\.|and|of|on|for)\s+)*(?:the\s+)?/i, " ");
  out = tidy(out);
  return out.length >= 2 ? capFirst(clip(out, 2000)) : "";
}

/** Reads one message into a draft change. `text` is the latest user message. */
export function parseVoiceText(text: string, opts: ParseOptions): Extracted {
  const raw = text.trim();
  const out: Extracted = {};
  if (!raw) return out;
  const t = normalizeNumbers(raw);
  const freeAnswer = FREE_TEXT.has(opts.asking) && !COMMAND_START.test(raw);

  const intent = detectIntent(t);
  // In a free-text answer ("… it's done") only "cancel" is a command.
  if (intent && (!freeAnswer || intent === "cancel")) out.intent = intent;
  if (out.intent === "cancel" || out.intent === "out_of_scope") return out;
  // Quick replies.
  if (/^\s*(?:new task|create a task)\s*$/i.test(raw)) return { intent: "create" };
  if (/^\s*close a task\s*$/i.test(raw)) return { intent: "close" };
  if (/^\s*log time\s*$/i.test(raw)) return { intent: "log_time" };

  const action: VoiceAction | null =
    out.intent === "rework" ? "create" : out.intent === "create" || out.intent === "close" || out.intent === "log_time" ? out.intent : opts.action;

  // Answers to a free-text question are taken whole.
  if (freeAnswer) {
    const value = clip(tidy(raw), 2000);
    if (opts.asking === "brief" && value) out.brief = capFirst(value);
    if (opts.asking === "shortName" && value) out.shortName = capFirst(clip(value, 80));
    if (opts.asking === "note") {
      const url = URL_RE.exec(raw)?.[0];
      if (url) out.finalUrl = url.replace(/[.)]+$/, "");
      const minutes = parseDuration(t);
      if (minutes) out.minutes = minutes;
      const note = url || minutes ? remainder(t, []) : capFirst(value);
      if (note) out.note = note;
    }
    return out;
  }

  // Iteration / review answers.
  if (/^\s*new(?: work)?\s*\.?$/i.test(raw) || (opts.asking === "iteration" && /\bnew\b/i.test(raw))) out.iteration = "new";
  if (out.intent === "rework" || (opts.asking === "iteration" && /\b(?:rework|redo|revision)\b/i.test(raw))) out.iteration = "rework";
  if (/\b(?:client|external|customer)\b/i.test(t)) out.reworkSource = "external";
  else if (/\b(?:internal|in-house|our (?:own )?review|team review)\b/i.test(t)) out.reworkSource = "internal";

  // Links.
  const url = URL_RE.exec(raw)?.[0];
  if (url) out.finalUrl = url.replace(/[.)]+$/, "");
  else if (opts.asking === "final") {
    const bare = /\b((?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?)/i.exec(raw)?.[1];
    if (bare && /\.[a-z]{2,}/i.test(bare)) out.finalUrl = `https://${bare.replace(/[.)]+$/, "")}`;
  }

  // Task codes / numbers.
  const codes = findTaskCodes(t, opts.codes);
  const number = /\b(?:task\s+(?:number\s+|no\.?\s*)?#?|#)(\d{2,7})\b/i.exec(t);
  const isRework = out.iteration === "rework" || out.intent === "rework";
  if (codes.length) {
    if (isRework || (opts.asking === "reworkOf" && action === "create")) out.reworkOf = codes[0];
    else if (action === "close" || action === "log_time" || opts.asking === "task") out.taskCode = codes[0];
  } else if (number && (action === "close" || action === "log_time")) {
    out.taskNumber = Number(number[1]);
  } else if (opts.asking === "task") {
    const words = tidy(raw);
    if (words) out.taskText = clip(words, 120);
  }

  // Time: a range wins over a duration.
  const range = parseRange(t, opts.today);
  if (range) {
    out.start = range.start;
    out.end = range.end;
  } else {
    const minutes = parseDuration(t);
    if (minutes && (action === "close" || action === "log_time" || opts.asking === "time")) out.minutes = minutes;
  }

  // Create: project, unit + quantity + short name, people, dates, brief.
  const spans: string[] = [];
  if (action === "create" || action === null || opts.asking === "project") {
    const projectIds = matchProjects(raw, opts.projects, opts.asking === "project");
    if (projectIds.length) {
      out.projectIds = projectIds;
      for (const p of opts.projects.filter((x) => projectIds.includes(x.id))) spans.push(p.code, p.brand, p.name);
    }
  }
  if (action === "create" || action === null) {
    const unitMatch = matchUnit(t, opts.units);
    if (unitMatch) {
      out.unit = unitMatch.unit;
      if (unitMatch.quantity) out.quantity = unitMatch.quantity;
      spans.push(unitMatch.unit);
      // The short name follows the unit: "3 reels, BTS cutdowns, for …".
      const after = t
        .slice(unitMatch.index + unitMatch.length)
        .replace(/^\s*(?:[-–—:,]\s*)?(?:of\s+|about\s+|called\s+|named\s+|for the\s+)?/i, "");
      const cut = after.split(/[,.;]|(?:^|\s)(?:for|due|by|assign(?:ed)?|start(?:ing|s)?|brief|with)\b/i)[0] ?? "";
      const shortName = tidy(cut);
      if (shortName.length >= 2 && !opts.keepShortName) {
        out.shortName = capFirst(clip(shortName, 80));
        spans.push(shortName);
      }
    } else if (opts.asking === "quantity") {
      const n = /\b(\d{1,4})\b/.exec(t);
      if (n) out.quantity = Number(n[1]);
    }
    const named = /\b(?:called|named|short name(?: is)?)\s+["“]?([^",.;”]+)/i.exec(raw);
    if (named) out.shortName = capFirst(clip(tidy(named[1]!), 80));

    const due = new RegExp(`\\b(?:due|by|deadline|deliver(?:y|ed)?(?:\\s+(?:on|by))?)\\s+(?:on\\s+|is\\s+)?(${DATE_WORD})`, "i").exec(t);
    const dueDay = due ? resolveDay(due[1]!, opts.today) : null;
    if (dueDay) out.dueDate = dueDay;
    const start = new RegExp(`\\b(?:start(?:s|ing)?|begin(?:s|ning)?)\\s+(?:on\\s+|from\\s+)?(${DATE_WORD})`, "i").exec(t);
    const startDay = start ? resolveDay(start[1]!, opts.today) : null;
    if (startDay) out.startDate = startDay;

    const brief = /\bbrief(?:\s+is|\s*[:\-–])\s*(.+)$/i.exec(raw);
    if (brief) out.brief = capFirst(clip(tidy(brief[1]!), 2000));

    // People: "for Rahaf and Izzat", "add Vishal", "remove Izzat".
    const remove = /\b(?:remove|without|drop)\s+([\p{L}' -]+)/iu.exec(raw);
    const peopleText = remove ? raw.slice(0, remove.index) : raw;
    const matched = matchPeople(peopleText.replace(URL_RE, " "), opts.people, {
      me: opts.me,
      skip: spans,
      anyCase: opts.asking === "assignees",
    });
    if (matched.ids.length) out.addPeople = matched.ids;
    if (matched.ambiguous.length) out.ambiguousPeople = matched.ambiguous;
    if (remove) {
      const gone = matchPeople(remove[1]!, opts.people, { me: opts.me, anyCase: true });
      if (gone.ids.length) out.removePeople = gone.ids;
    }
  }

  // Close note / log memo: what's left after the command, code and time.
  if ((action === "close" || action === "log_time") && !freeAnswer) {
    const explicit = /\b(?:note|outcome|memo)(?:\s+is|\s*[:\-–])\s*(.+)$/i.exec(raw);
    const note = explicit ? capFirst(tidy(explicit[1]!)) : remainder(t, [...codes, ...(number ? [number[0]] : [])]);
    // A bare answer to "which task" / "how long" isn't a note.
    if (note && opts.asking !== "task" && opts.asking !== "time" && opts.asking !== "final" && !/^(?:task|this(?: one)?|it)$/i.test(note)) {
      out.note = note;
    }
  }
  return out;
}
