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

export const VOICE_ACTIONS = ["create", "close", "log_time", "update"] as const;
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
  /** Start and due date of a new task (both required). */
  "dates",
  /** The project's existing tasks were listed: reuse a name, work on one, or a new name. */
  "existing",
  /** A tidied brief was offered: use it, keep the words as said, or say it again. */
  "briefReview",
  /** Update: what should change on the task. */
  "changes",
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
  /** Update: new priority / status (To do ↔ In progress only; closing is its own action). */
  priority?: "low" | "medium" | "high" | "urgent";
  status?: "todo" | "in_progress";
  /** "add to the brief …": text added on to the brief. */
  briefAppend?: string;
  /** Typos read as day words: [said, read as]. */
  fixes?: Array<[string, string]>;
  /** A day said on its own in answer to "when?" (the assistant decides start or due). */
  anyDate?: string;
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

/**
 * The day in a short phrase: a calendar date wins ("Sat 24 Oct", "Today 23 Oct"),
 * else the first day word ("tomorrow", "Friday", "in 3 days").
 */
export function resolveLooseDay(phrase: string, today: string): string | null {
  const p = normalizeNumbers(phrase).toLowerCase();
  const dm = /\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/.exec(p);
  if (dm) return resolveDay(`${dm[1]} ${dm[2]}`, today);
  const md = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(p);
  if (md) return resolveDay(`${md[1]} ${md[2]}`, today);
  const iso = /\b\d{4}-\d{2}-\d{2}\b/.exec(p);
  if (iso) return iso[0];
  const word = new RegExp(`\\b${DATE_WORD}`, "i").exec(p);
  return word ? resolveDay(word[0], today) : null;
}

// ---------------------------------------------------------------------------
// Brief tidy (rules) — the FALLBACK for the AI rewrite: the first sentence is
// the objective, the rest become bullets, and counts, sizes / durations,
// languages and links are pulled out into labelled lines. Nothing is added.
// ---------------------------------------------------------------------------

export interface TidyBrief {
  objective: string;
  bullets: string[];
}

export function tidyBriefRules(text: string, units: string[]): TidyBrief {
  const clean = text.replace(/\s+/g, " ").trim();
  const links = [...clean.matchAll(/\bhttps?:\/\/[^\s,<>"]+/gi)].map((m) => m[0].replace(/[.)]+$/, ""));
  const noLinks = clean.replace(/\bhttps?:\/\/[^\s,<>"]+/gi, " ").replace(/\s+/g, " ").trim();
  const sentences = noLinks
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  // One long sentence: its first clause is the objective, the other clauses are bullets.
  let parts = sentences;
  if (sentences.length === 1) parts = sentences[0]!.split(/,\s+|\s+and then\s+/i).map((s) => s.trim()).filter(Boolean);
  const strip = (s: string) => capFirst(s.replace(/[.;!?,]+$/, "").trim());
  const objective = strip(parts[0] ?? clean);
  // A part that only pointed at a link ("Refs …") goes; the link is listed on its own line.
  const bullets = parts
    .slice(1)
    .map(strip)
    .filter((s) => s.length > 1 && !/^(?:refs?|references?|links?|see|here|attached)$/i.test(s));

  const n = normalizeNumbers(noLinks);
  const unitWords = [...new Set([...units, "post", "reel", "video", "story", "static", "carousel", "banner", "cutdown", "photo", "design"])];
  const alt = unitWords
    .map((u) => u.toLowerCase())
    .flatMap((u) => [u, u.endsWith("y") ? `${u.slice(0, -1)}ies` : `${u}s`])
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join("|");
  // "3 reels", "3 15-second vertical reels" (up to two words between).
  const counts = [...n.matchAll(new RegExp(`\\b(\\d{1,4})\\s+(?:[\\p{L}\\d-]+\\s+){0,2}?(${alt})\\b`, "giu"))].map((m) => `${m[1]} ${m[2]!.toLowerCase()}`);
  const sizes = [
    ...n.matchAll(/\b\d+(?:\.\d+)?\s*-?\s*(?:seconds?|secs?|minutes?|mins?|s)\b(?![a-z])|\b\d{1,2}:\d{1,2}\b|\b\d{3,4}\s*[x×]\s*\d{3,4}\b|\b(?:vertical|horizontal|square|portrait|landscape)\b/gi),
  ].map((m) => m[0].replace(/\s*-\s*/, " ").toLowerCase());
  const languages = [
    ...n.matchAll(/\b(?:english|arabic|french|hindi|urdu|russian|chinese|german|spanish)(?:\s+(?:and|&|\/)\s+(?:english|arabic|french|hindi|urdu|russian|chinese|german|spanish))?(?:\s+(?:captions?|subtitles?|copy|voice-?over|vo|text))?\b/gi),
  ].map((m) => m[0]);
  const labelled: string[] = [];
  if (counts.length) labelled.push(`Deliverables: ${[...new Set(counts)].join(", ")}`);
  if (sizes.length) labelled.push(`Size / duration: ${[...new Set(sizes)].join(", ")}`);
  if (languages.length) labelled.push(`Language: ${[...new Set(languages.map((l) => l.toLowerCase()))].map(capFirst).join(", ")}`);
  if (links.length) labelled.push(`References: ${links.join(", ")}`);
  // A clause that is only a pulled-out value ("Arabic captions") isn't repeated.
  const pulled = new Set([...counts, ...sizes, ...languages].map((v) => v.toLowerCase()));
  const rest = bullets.filter((b) => !pulled.has(normalizeNumbers(b).toLowerCase()));
  return { objective, bullets: [...labelled, ...rest].slice(0, 12) };
}

/** Simple HTML the task's rich-text brief renders: <p> + <ul><li>. */
export function briefHtml(brief: TidyBrief | string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  if (typeof brief === "string") {
    // Lines starting with "•" / "-" (a copied brief's list) stay a list.
    let html = "";
    let list: string[] = [];
    const flush = () => {
      if (list.length) html += `<ul>${list.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;
      list = [];
    };
    for (const raw of brief.split(/\n+/)) {
      const line = raw.trim();
      if (!line) continue;
      const item = /^[•\-*]\s+(.+)$/.exec(line);
      if (item) list.push(item[1]!);
      else {
        flush();
        html += `<p>${esc(line)}</p>`;
      }
    }
    flush();
    return html;
  }
  const items = brief.bullets.map((b) => `<li>${esc(b)}</li>`).join("");
  return `<p>${esc(brief.objective)}</p>${items ? `<ul>${items}</ul>` : ""}`;
}

/** The tidied brief as chat text: the objective, then "• " bullets. */
export function briefPreview(brief: TidyBrief): string {
  return [brief.objective, ...brief.bullets.map((b) => `• ${b}`)].join("\n");
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
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "oct", "nov", "dec", "mon", "tue", "wed", "thu", "fri", "sat", "sun",
  "start", "starts", "due", "none", "like", "keep", "use", "edit", "said", "tidied",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
]);

/** Ordinary English words that must never be fuzzy-matched to a person's name. */
export const COMMON_WORDS = new Set(
  (
    "also more most over image images high higher picture pictures photo photos product products quality make made take have " +
    "with from into this that they them then than there their what when where which while will would could should about after " +
    "again before below between both each just like only other same some such very well your more much many less good best " +
    "nice better colour color size text logo video videos reel reels post posts story final draft copy brief name note memo " +
    "update change adding added enhance improve fix fixed send sent shoot edit cut cuts make sure please thanks done also team " +
    "client review today tomorrow week month time hours mins minutes"
  ).split(" ")
);

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
    let found = byFirst.get(w);
    // A typed / misheard first name ("vishl"): the closest first names within 1 letter (2 for long names).
    // Ordinary words ("more", "image", "over") are never read as a misspelt name.
    if (!found && opts.anyCase && w.length >= 4 && !COMMON_WORDS.has(w)) {
      const max = w.length >= 7 ? 2 : 1;
      let best = max + 1;
      let near: VocabPerson[] = [];
      for (const [first, list] of byFirst) {
        if (Math.abs(first.length - w.length) > max) continue;
        const d = editDistance(w, first);
        if (d < best) {
          best = d;
          near = [...list];
        } else if (d === best) near.push(...list);
      }
      if (best <= max && near.length) found = near;
    }
    if (!found) continue;
    if (found.length === 1) {
      if (!ids.includes(found[0]!.id)) ids.push(found[0]!.id);
    } else ambiguous.push({ said: capFirst(w), ids: found.map((p) => p.id) });
  }
  return { ids, ambiguous };
}

/** Edit distance where swapping two neighbouring letters counts as one ("firday" → "friday" = 1). */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

const DAY_WORDS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "tomorrow", "january", "february", "september", "october", "november", "december"];
const SHORT_DAY_WORDS: Record<string, string> = { tmrw: "tomorrow", tmr: "tomorrow", tmw: "tomorrow", tmrrw: "tomorrow", tomoz: "tomorrow", tdy: "today", weds: "wednesday" };

/**
 * Typos in day words → the word ("froday" → "friday", "thrusday", "tomorow", "tmrw").
 * 1 letter off for 5–6 letter words, 2 for longer ones; returns the fixes made.
 */
export function fixDayWords(text: string): { text: string; fixes: Array<[string, string]> } {
  const fixes: Array<[string, string]> = [];
  const out = text.replace(/\p{L}+/gu, (word) => {
    const w = word.toLowerCase();
    if (SHORT_DAY_WORDS[w]) {
      fixes.push([word, SHORT_DAY_WORDS[w]!]);
      return SHORT_DAY_WORDS[w]!;
    }
    if (w.length < 5 || DAY_WORDS.includes(w)) return word;
    const max = w.length >= 7 ? 2 : 1;
    let best: string | null = null;
    let bestD = max + 1;
    for (const target of DAY_WORDS) {
      if (Math.abs(target.length - w.length) > max) continue;
      const d = editDistance(w, target);
      if (d < bestD) {
        bestD = d;
        best = target;
      }
    }
    if (!best || bestD > max) return word;
    fixes.push([word, best]);
    return best;
  });
  return { text: out, fixes };
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
  if (/\bwhat(?:'s| is| are)?\b.*\bdue\b|\bmove\b.*\b(?:time|hours?|minutes?|entr(?:y|ies))\b|\bdelete\b|\bwhat (?:are|is) my\b/i.test(t)) {
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

/**
 * "update the brief "…"", "brief: …", "add to the brief …", "change the name to …",
 * "note: …", "memo …" — a field and its new text (quoted text wins), or null.
 */
export function fieldEdit(text: string): { field: "brief" | "briefAppend" | "name" | "note"; value: string } | null {
  const forms: Array<[RegExp, "brief" | "briefAppend" | "name" | "note"]> = [
    [/^\s*(?:please\s+)?(?:add|append)\s+(?:this\s+|that\s+)?(?:to|in|into)\s+(?:the\s+)?brief\b\s*(?:that\s+)?[:\-–]?\s*([\s\S]+)$/i, "briefAppend"],
    [/^\s*(?:please\s+)?(?:(?:update|change|replace|set|edit|rewrite)\s+(?:the\s+)?brief|new\s+brief|brief)\b\s*(?:to|as|with|is)?\s*[:\-–]?\s*([\s\S]+)$/i, "brief"],
    [/^\s*(?:please\s+)?(?:(?:update|change|rename|set|edit)\s+(?:the\s+)?(?:short\s+name|task\s+name|name|title)|call\s+it|rename(?:\s+it)?|short\s+name)\b\s*(?:to|as|is)?\s*[:\-–]?\s*([\s\S]+)$/i, "name"],
    [/^\s*(?:please\s+)?(?:(?:update|change|replace|set|edit)\s+(?:the\s+)?(?:outcome\s+)?(?:note|memo)|(?:outcome\s+)?note|memo)\b\s*(?:to|as|is)?\s*[:\-–]?\s*([\s\S]+)$/i, "note"],
  ];
  for (const [re, field] of forms) {
    const m = re.exec(text);
    if (!m) continue;
    const quoted = /["“'‘]([^"”’]{2,})["”'’]/.exec(m[1]!);
    const value = (quoted ? quoted[1]! : m[1]!).replace(/^["“'‘]|["”'’]$/g, "").replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
    if (value.length >= 2) return { field, value };
  }
  return null;
}

/** Start / due dates: "due Friday", "due date to 30 Oct", "push it to Monday", "start tomorrow", "from A to B", "A → B". */
function readDates(t: string, opts: ParseOptions, out: Extracted): void {
  const due = new RegExp(
    `\\b(?:due(?:\\s+date)?|end(?:\\s+date)?|deadline|by|deliver(?:y|ed)?(?:\\s+(?:on|by))?|postpone(?:d)?(?:\\s+it)?|push(?:ed)?(?:\\s+it)?(?:\\s+back)?|extend(?:ed)?(?:\\s+it)?)\\s+(?:to\\s+|till\\s+|until\\s+|on\\s+|is\\s+|as\\s+)?(${DATE_WORD})`,
    "i"
  ).exec(t);
  const dueDay = due ? resolveLooseDay(due[1]!, opts.today) : null;
  if (dueDay) out.dueDate = dueDay;
  const start = new RegExp(
    `\\b(?:start(?:s|ing)?(?:\\s+date)?|begin(?:s|ning)?)\\s+(?:to\\s+|on\\s+|from\\s+|is\\s+|as\\s+)?(${DATE_WORD})`,
    "i"
  ).exec(t);
  const startDay = start ? resolveLooseDay(start[1]!, opts.today) : null;
  if (startDay) out.startDate = startDay;
  // "from tomorrow to 30 Oct", "Today 23 Oct → Sat 24 Oct" (the date chips).
  const span = /→/.test(t)
    ? t.split("→")
    : new RegExp(`\\bfrom\\s+(${DATE_WORD})\\s+(?:to|till|until|-|–)\\s+(${DATE_WORD})`, "i").exec(t)?.slice(1, 3);
  if (span && span.length >= 2) {
    const a = resolveLooseDay(span[0]!, opts.today);
    const b = resolveLooseDay(span[1]!, opts.today);
    if (a && b) {
      out.startDate = a;
      out.dueDate = b;
    }
  }
  if (opts.asking === "dates" && !out.startDate && !out.dueDate) {
    const day = resolveLooseDay(t, opts.today);
    if (day) out.anyDate = day;
  }
}

/** People: "for Rahaf and Izzat", "add Vishal", "remove Izzat" (names after add / and / plus …, typos allowed there). */
function readPeople(raw: string, opts: ParseOptions, spans: string[], out: Extracted): void {
  const remove = /\b(?:remove|without|drop|take off|unassign)\s+([\p{L}' -]+)/iu.exec(raw);
  // Quoted text is never read for names.
  const peopleText = (remove ? raw.slice(0, remove.index) : raw).replace(/["“][^"”]*["”]/g, " ");
  const matched = matchPeople(peopleText.replace(URL_RE, " "), opts.people, {
    me: opts.me,
    skip: spans,
    anyCase: opts.asking === "assignees",
  });
  // Names after "add / and / plus / with / for / assign to", or before "also / too", in any case
  // and with a typo ("add vishl also").
  // Word by word, so "and add Vishal" reads both triggers.
  const tokens = peopleText.split(/[^\p{L}'-]+/u).filter(Boolean);
  const triggers = new Set(["add", "and", "plus", "with", "for", "include", "also", "assign", "assigned", "reassign"]);
  const nameWords = tokens.filter((word, i) => {
    const w = word.toLowerCase();
    if (triggers.has(w) || w === "to") return false;
    const prev = tokens[i - 1]?.toLowerCase() ?? "";
    const prev2 = tokens[i - 2]?.toLowerCase() ?? "";
    const next = tokens[i + 1]?.toLowerCase() ?? "";
    return triggers.has(prev) || (prev === "to" && /^(?:re)?assign(?:ed)?$/.test(prev2)) || next === "also" || next === "too";
  });
  if (nameWords.length) {
    const extra = matchPeople(nameWords.join(" "), opts.people, { me: opts.me, skip: spans, anyCase: true });
    for (const id of extra.ids) if (!matched.ids.includes(id)) matched.ids.push(id);
    for (const a of extra.ambiguous) if (!matched.ambiguous.some((x) => x.said.toLowerCase() === a.said.toLowerCase())) matched.ambiguous.push(a);
  }
  if (matched.ids.length) out.addPeople = matched.ids;
  if (matched.ambiguous.length) out.ambiguousPeople = matched.ambiguous;
  if (remove) {
    const gone = matchPeople(remove[1]!, opts.people, { me: opts.me, anyCase: true });
    if (gone.ids.length) out.removePeople = gone.ids;
  }
}

const UPDATE_VERB = /^\s*(?:please\s+)?(?:update|change|edit|modify|move|reschedule|postpone|push|extend|rename|reassign|set|mark)\b/i;
const PEOPLE_TO_TASK = /^\s*(?:please\s+)?(?:add|assign|remove|take|unassign)\b[\s\S]*\b(?:to|from|on|off)\s+(?:task\s+)?[A-Za-z][A-Za-z0-9]{0,11}\s?[-–]\s?\d{1,5}\b/i;
const UPDATE_THIS = /^\s*(?:please\s+)?(?:update|edit|change)\s+(?:it|this(?:\s+(?:one|task))?|the\s+task)\b/i;

/**
 * UPDATE a task: "update EO26-14 due Friday", "add Vishal to EO26-14", "change the brief of
 * EO26-14 to …", "priority high", "move to in progress", "rename to …". `codes` are the task
 * codes in the message (taken out before the fields are read).
 */
function readUpdate(raw: string, t: string, opts: ParseOptions, codes: string[], out: Extracted): Extracted {
  let text = raw;
  for (const code of codes) {
    const [p, n] = code.split("-");
    text = text.replace(new RegExp(`(?:\\b(?:of|for|on|in|to|from)\\s+)?(?:\\btask\\s+)?\\b${escapeRe(p!)}\\s?[-–]?\\s?${n}\\b`, "gi"), " ");
  }
  text = text.replace(/^\s*(?:please\s+)?(?:update|edit|change)\s+(?:it|this(?:\s+(?:one|task))?|the\s+task)\b[\s,:]*/i, "").replace(/\s+/g, " ").trim();
  const edit = fieldEdit(text);
  if (edit && edit.field !== "note") {
    if (edit.field === "name") out.shortName = capFirst(clip(edit.value, 80));
    else if (edit.field === "briefAppend") out.briefAppend = clip(edit.value, 2000);
    else out.brief = capFirst(clip(edit.value, 2000));
    return out;
  }
  const lower = normalizeNumbers(fixDayWords(text).text);
  readDates(lower, opts, out);
  const priority = /\b(?:priority\s+(?:to\s+|is\s+|as\s+)?(low|medium|normal|high|urgent)|(low|medium|normal|high|urgent)\s+priority)\b/i.exec(lower);
  if (priority) {
    const p = (priority[1] ?? priority[2])!.toLowerCase();
    out.priority = (p === "normal" ? "medium" : p) as Extracted["priority"];
  }
  if (/\b(?:in[\s-]progress|start(?:ed)?\s+work(?:ing)?)\b/i.test(lower)) out.status = "in_progress";
  else if (/\b(?:(?:back\s+)?to\s+(?:to[\s-]?do|todo)|status\s+(?:to\s+)?(?:to[\s-]?do|todo)|as\s+(?:to[\s-]?do|todo)|not\s+started)\b/i.test(lower)) out.status = "todo";
  readPeople(text, opts, [], out);
  return out;
}

/** Reads one message into a draft change. `text` is the latest user message. */
export function parseVoiceText(text: string, opts: ParseOptions): Extracted {
  const raw = text.trim();
  const out: Extracted = {};
  if (!raw) return out;
  // Typos in day words are fixed first ("due froday" → "due friday") and reported back.
  const fixed = fixDayWords(raw);
  const t = normalizeNumbers(fixed.text);
  if (fixed.fixes.length) out.fixes = fixed.fixes;
  const freeAnswer = FREE_TEXT.has(opts.asking) && !COMMAND_START.test(raw);
  // A scope chip ("Video · 6 of 6 left") is the unit only.
  const scopeChip = /^\s*(.+?)\s*·\s*\d+\s+of\s+\d+\s+left\s*$/i.exec(raw);
  if (scopeChip) {
    const unit = matchUnit(scopeChip[1]!, opts.units);
    return unit ? { unit: unit.unit } : out;
  }

  // Update a task: a change verb with a task code ("move EO26-14 due date to Friday", "add Vishal to
  // EO26-14"), "update this / it", or any change once updating. Out-of-scope asks ("move my hours …") excluded.
  if (!freeAnswer) {
    const codesEarly = findTaskCodes(t, opts.codes);
    const oos = detectIntent(t) === "out_of_scope" || detectIntent(t) === "cancel";
    const command =
      !oos &&
      ((codesEarly.length > 0 && (UPDATE_VERB.test(raw) || PEOPLE_TO_TASK.test(raw))) ||
        (opts.action !== "create" && UPDATE_THIS.test(raw)) ||
        /^\s*update (?:it|this|task)\s*$/i.test(raw));
    if (command || (opts.action === "update" && !oos && !/^\s*(?:close|log)\b/i.test(raw) && !/^\s*(?:new task|create a task)\b/i.test(raw))) {
      if (command) out.intent = "update";
      if (codesEarly[0] && (command || opts.asking === "task")) out.taskCode = codesEarly[0];
      return readUpdate(raw, t, opts, codesEarly, out);
    }
  }

  // Field edits come first, before any date / people / intent reading: their text is the value, verbatim.
  if (!freeAnswer) {
    const edit = fieldEdit(raw);
    if (edit) {
      if (edit.field === "name") return { ...out, shortName: capFirst(clip(edit.value, 80)) };
      const forCreate = opts.action === "create" || opts.action === null;
      if (edit.field === "briefAppend" && forCreate) return { ...out, briefAppend: clip(edit.value, 2000) };
      if (forCreate && edit.field !== "note") return { ...out, brief: capFirst(clip(edit.value, 2000)) };
      if (!forCreate) return { ...out, note: capFirst(clip(edit.value, 2000)) };
      return { ...out, brief: capFirst(clip(edit.value, 2000)) };
    }
  }

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

    readDates(t, opts, out);

    const brief = /\bbrief(?:\s+is|\s*[:\-–])\s*(.+)$/i.exec(raw);
    if (brief) out.brief = capFirst(clip(tidy(brief[1]!), 2000));

    readPeople(raw, opts, spans, out);
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
