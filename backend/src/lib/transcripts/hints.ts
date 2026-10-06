import * as chrono from "chrono-node";
import type mongoose from "mongoose";
import { MEETING_LIMITS } from "../../models/Meeting.js";
import type { TaskPriority } from "../../models/Task.js";
import type { CandidateUser } from "./match.js";
import { canonicalSpeakerName, matchName, normalizeName } from "./match.js";

// ---------------------------------------------------------------------------
// Smart hints — rule-based action-item detection. Nothing leaves the server.
// Each sentence is scored against trigger phrases; the best sentence of a
// segment above the threshold becomes an `origin: "hint"` suggestion with an
// owner (speaker or mentioned attendee), a due date (chrono-node, relative to
// the meeting date) and a cleaned-up title.
// ---------------------------------------------------------------------------

export const HINT_THRESHOLD = 2;
const TITLE_MAX = 120;
const A = "['’]"; // straight or curly apostrophe

interface Trigger {
  re: RegExp;
  weight: number;
  /** "self" → the speaker owns it; "other" → look for a mentioned attendee. */
  owner?: "self" | "other";
}

const TRIGGERS: Trigger[] = [
  { re: /\b(action items?|to-?dos?|follow[- ]?ups?|follow up)\b/i, weight: 3 },
  { re: new RegExp(String.raw`\b(I${A}ll|I will|I${A}m going to|I am going to|let me)\b`, "i"), weight: 2, owner: "self" },
  { re: new RegExp(String.raw`\b(we${A}ll|we will)\b`, "i"), weight: 1.5 },
  { re: /\b(can you|could you|would you mind)\b/i, weight: 2, owner: "other" },
  { re: /\bplease\b/i, weight: 1.5, owner: "other" },
  { re: /\b(needs? to|have to|has to)\b/i, weight: 1.5 },
  { re: /\bassign(?:ed)? (?:it |this |that )?to\b/i, weight: 3, owner: "other" },
  { re: /(^|\s)@\p{L}+/u, weight: 2, owner: "other" },
];

/** Meeting small talk that looks like an action but isn't. */
const NOISE = new RegExp(
  [
    String.raw`\b(can|could) you (all )?(hear|see) (me|my|it|that|this)`,
    String.raw`\b(share|sharing|stop sharing) (my|the) screen`,
    String.raw`\blet me (know|think|see|check if (you|everyone) can|share|just|try to remember)\b`,
    String.raw`\bI${A}ll (be honest|admit|say|tell you what|just say|pass)\b`,
    String.raw`\b(you${A}re|you are) (on )?mute`,
    String.raw`\bplease (go ahead|continue|stop)\b`,
    String.raw`\b(thank you|thanks),? (please|everyone)\b`,
  ].join("|"),
  "i"
);

const DATE_WORD =
  /\b(mon|tues?|wed(nes)?|thu(rs)?|fri|sat(ur)?|sun)(day)?\b|\b(today|tonight|tomorrow|week|month|days?|weekend)\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d|\d{1,2}[/-]\d{1,2}|\d{4}-\d{2}-\d{2}|\d(st|nd|rd|th)\b/i;

const RELATIVE_DAY = /\b(EOD|COB|end of (the )?(business )?day|by tonight)\b/i;
const END_OF_WEEK = /\b(EOW|end of (the |this )?week|this week)\b/i;
const NEXT_WEEK = /\b(end of )?next week\b/i;
const END_OF_MONTH = /\b(EOM|end of (the |this )?month)\b/i;

export interface HintSpeaker {
  name: string;
  user?: mongoose.Types.ObjectId | null;
}

export interface HintSegment {
  idx: number;
  speaker?: string | null;
  text: string;
}

export interface HintSuggestion {
  segmentIdxs: number[];
  quote: string;
  title: string;
  assignee: mongoose.Types.ObjectId | null;
  assigneeName: string | null;
  dueDate: Date | null;
  priority: TaskPriority;
  score: number;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

function dateOnly(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

function addDaysUtc(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/** Friday of the week containing `date` (date-only, UTC). */
function fridayOf(date: Date): Date {
  return addDaysUtc(date, (5 - date.getUTCDay() + 7) % 7);
}

/**
 * Due date from a sentence, relative to `meetingDate` (a date-only value — UTC
 * midnight of the meeting's calendar day in APP_TIMEZONE). Handles today,
 * tomorrow, weekday names, next week, EOD/EOW/EOM and explicit dates. Returns
 * null for past, far-future (> 1 year) or ambiguous (several dates) results.
 */
export function parseDueDate(text: string, meetingDate: Date): Date | null {
  const base = dateOnly(meetingDate.getUTCFullYear(), meetingDate.getUTCMonth() + 1, meetingDate.getUTCDate());

  // chrono reads components in the server's local zone: anchor the reference at local
  // noon of the meeting's calendar day so the calendar date is exactly the meeting date.
  const ref = new Date(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 12, 0, 0);
  const results = chrono.casual
    .parse(text, ref, { forwardDate: true })
    .filter((r) => DATE_WORD.test(r.text) && !/^next week$/i.test(r.text.trim()) && !/\bthis week\b/i.test(r.text));

  const candidates = new Map<string, Date>();
  for (const r of results) {
    const s = r.start;
    if (!(s.isCertain("day") || s.isCertain("weekday"))) continue;
    let date = dateOnly(s.get("year")!, s.get("month")!, s.get("day")!);
    // "by Monday" said on a Monday means next Monday.
    if (!s.isCertain("day") && s.isCertain("weekday") && date.getTime() === base.getTime()) date = addDaysUtc(date, 7);
    candidates.set(date.toISOString().slice(0, 10), date);
  }
  if (candidates.size === 0) {
    if (NEXT_WEEK.test(text)) {
      const nextMonday = addDaysUtc(base, ((8 - base.getUTCDay()) % 7) || 7);
      candidates.set("nw", addDaysUtc(nextMonday, 4));
    } else if (END_OF_WEEK.test(text)) {
      candidates.set("eow", fridayOf(base));
    } else if (END_OF_MONTH.test(text)) {
      candidates.set("eom", dateOnly(base.getUTCFullYear(), base.getUTCMonth() + 2, 0));
    } else if (RELATIVE_DAY.test(text)) {
      candidates.set("eod", base);
    }
  }
  if (candidates.size !== 1) return null; // none, or ambiguous
  const [date] = [...candidates.values()];
  if (date!.getTime() < base.getTime()) return null;
  if (date!.getTime() > addDaysUtc(base, 366).getTime()) return null;
  return date!;
}

// ---------------------------------------------------------------------------
// Owner
// ---------------------------------------------------------------------------

interface Attendee {
  /** Display form used as assigneeName. */
  name: string;
  user: mongoose.Types.ObjectId | null;
  /** Lower-cased forms that refer to this attendee (full name, unique first name). */
  aliases: string[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Speakers (full + unique first names) plus candidate users who didn't speak. */
export function buildAttendees(speakers: HintSpeaker[], candidates: CandidateUser[] = []): Attendee[] {
  const attendees: Attendee[] = speakers.map((s) => ({
    name: s.name,
    user: s.user ?? null,
    aliases: [normalizeName(canonicalSpeakerName(s.name))],
  }));
  const mapped = new Set(attendees.flatMap((a) => (a.user ? [a.user.toString()] : [])));
  for (const c of candidates) {
    if (mapped.has(c._id.toString())) continue;
    attendees.push({ name: c.name, user: c._id, aliases: [normalizeName(c.name)] });
  }
  // Unique first names (across everyone) become aliases too.
  const firstCounts = new Map<string, number>();
  for (const a of attendees) {
    const first = a.aliases[0]!.split(" ")[0]!;
    if (first) firstCounts.set(first, (firstCounts.get(first) ?? 0) + 1);
  }
  for (const a of attendees) {
    const first = a.aliases[0]!.split(" ")[0]!;
    if (first && first !== a.aliases[0] && firstCounts.get(first) === 1) a.aliases.push(first);
  }
  return attendees;
}

/** Alternation of every alias, longest first, for mention regexes. */
function aliasPattern(attendees: Attendee[]): string | null {
  const aliases = [...new Set(attendees.flatMap((a) => a.aliases))].filter((a) => a.length >= 2);
  if (aliases.length === 0) return null;
  aliases.sort((x, y) => y.length - x.length);
  return aliases.map((a) => escapeRe(a).replace(/ /g, "\\s+")).join("|");
}

function attendeeByAlias(attendees: Attendee[], alias: string): Attendee | null {
  const key = normalizeName(alias);
  return attendees.find((a) => a.aliases.includes(key)) ?? null;
}

/** Explicit mentions: "@Priya", "assigned to Priya", "Priya, can you / please", "Priya will", "action item: Priya to". */
function mentionedAttendee(sentence: string, attendees: Attendee[], speaker: string | null): Attendee | null {
  const names = aliasPattern(attendees);
  const speakerKey = speaker ? normalizeName(canonicalSpeakerName(speaker)) : null;
  const notSpeaker = (a: Attendee | null) => (a && (!speakerKey || !a.aliases.includes(speakerKey)) ? a : null);

  const at = /(?:^|\s)@([\p{L}][\p{L}'’.-]*(?:\s[\p{Lu}][\p{L}'’-]*)?)/u.exec(sentence);
  if (at) {
    const full = attendeeByAlias(attendees, at[1]!) ?? attendeeByAlias(attendees, at[1]!.split(/\s/)[0]!);
    if (full) return full;
  }
  if (!names) return null;
  const patterns = [
    new RegExp(String.raw`\bassign(?:ed)? (?:it |this |that )?to (${names})\b`, "i"),
    new RegExp(String.raw`\b(${names})\s*,\s*(?:can you|could you|would you|please|will you)\b`, "i"),
    new RegExp(String.raw`\b(?:can|could|would|will) you\b[^.?!]*?,\s*(${names})\s*[?.!]?$`, "i"),
    new RegExp(String.raw`\bplease\b[^.?!]*?,\s*(${names})\s*[?.!]?$`, "i"),
    new RegExp(String.raw`^(?:(?:so|ok|okay|and|then)\s*,?\s*)?(${names})\s+(?:will|is going to|needs to|has to|should)\b`, "i"),
    new RegExp(String.raw`\b(?:action items?|to-?dos?|follow[- ]?ups?)\s*(?:for)?\s*:?\s*(${names})\b`, "i"),
  ];
  for (const re of patterns) {
    const m = re.exec(sentence);
    if (m) {
      const hit = notSpeaker(attendeeByAlias(attendees, m[1]!));
      if (hit) return hit;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------

const FILLERS = new RegExp(
  String.raw`\b(um+|uh+|erm+|hmm+|uh-huh|you know|I mean|I think|I guess|I suppose|basically|actually|kind of|sort of|just)\b,?\s*`,
  "gi"
);
const LEADING = new RegExp(
  "^(?:" +
    [
      String.raw`(?:so|ok|okay|yeah|yes|well|right|alright|all right|and|but|also|then|anyway|great|cool|sure|perfect)\b[,.]?`,
      String.raw`(?:action items?|to-?dos?)\s*(?:for \S+)?\s*[:\-–]?|follow[- ]?ups?\s*[:\-–]`,
      String.raw`I${A}ll|I will|I${A}m going to|I am going to|let me|we${A}ll|we will|we need to|we should`,
      String.raw`(?:can|could|would|will) you(?: please)?|would you mind`,
      String.raw`please|you need to|you should|need to|needs to|have to|has to`,
      String.raw`(?:make sure|remember) (?:to|that)`,
    ].join("|") +
    String.raw`)\s*`,
  "i"
);

/** Cleans a sentence into a task title (fillers out, leading trigger out, capitalised, ≤ 120 chars). */
export function cleanTitle(sentence: string, attendees: Attendee[] = []): string {
  let t = sentence.replace(/\s+/g, " ").trim();
  t = t.replace(FILLERS, "").replace(/\s{2,}/g, " ").trim();
  const names = aliasPattern(attendees);
  for (let i = 0; i < 6; i++) {
    const before = t;
    if (names) {
      // "Priya, can you…" / "Priya to fix…" / "Priya will…" → drop the addressee.
      t = t.replace(
        new RegExp(String.raw`^(?:@(?:${names})\b[,:]?|(?:${names})\s*(?:[,:]|\s(?:to|will|is going to|needs to|should)\b))\s*`, "i"),
        ""
      );
    }
    t = t.replace(LEADING, "").replace(/^[,:;\-–—\s]+/, "");
    if (t === before) break;
  }
  if (names) t = t.replace(new RegExp(String.raw`,\s*@?(?:${names})\s*(?=[?.!]*$)`, "i"), "");
  t = t
    .replace(/,?\s*(please|for me|thanks|thank you)\s*[?.!]*$/i, "")
    .replace(/\s*[?.!,;:]+$/, "")
    .trim();
  if (!t) t = sentence.trim();
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (t.length > TITLE_MAX) t = `${t.slice(0, TITLE_MAX - 1).replace(/\s+\S*$/, "")}…`;
  return t.slice(0, TITLE_MAX);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=\S)/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

interface SentenceScore {
  sentence: string;
  score: number;
  owner: "self" | "other" | null;
}

export function scoreSentence(sentence: string, meetingDate?: Date): SentenceScore {
  let score = 0;
  let owner: "self" | "other" | null = null;
  for (const t of TRIGGERS) {
    if (!t.re.test(sentence)) continue;
    score += t.weight;
    if (t.owner === "other") owner = "other";
    else if (t.owner === "self" && owner === null) owner = "self";
  }
  if (score > 0 && (meetingDate ? parseDueDate(sentence, meetingDate) : DATE_WORD.test(sentence))) score += 1;
  if (NOISE.test(sentence)) score -= 3;
  if (sentence.split(/\s+/).length < 4) score -= 1;
  return { sentence, score, owner };
}

function bestSentence(text: string, meetingDate?: Date, attendees: Attendee[] = [], speaker: string | null = null): SentenceScore {
  let best: SentenceScore = { sentence: text, score: 0, owner: null };
  for (const s of splitSentences(text)) {
    const scored = scoreSentence(s, meetingDate);
    // "Rahul will …" / "@Priya …": an explicit attendee mention is a trigger on its own.
    if (attendees.length > 0 && !NOISE.test(s) && mentionedAttendee(s, attendees, speaker)) {
      scored.score += scored.owner === "other" ? 0.5 : 2;
      scored.owner = "other";
    }
    if (scored.score > best.score) best = scored;
  }
  return best;
}

/** Indexes of segments that score above the hint threshold (for highlighting). */
export function hintSegmentIdxs(segments: HintSegment[], meetingDate?: Date, speakers: HintSpeaker[] = []): number[] {
  const attendees = buildAttendees(speakers);
  return segments
    .filter((s) => bestSentence(s.text, meetingDate, attendees, s.speaker ?? null).score >= HINT_THRESHOLD)
    .map((s) => s.idx);
}

function priorityOf(text: string): TaskPriority {
  if (/\b(urgent|urgently|asap|as soon as possible|immediately|right away|blocker|blocking)\b/i.test(text)) return "urgent";
  if (/\b(high priority|top priority|important|critical)\b/i.test(text)) return "high";
  if (/\b(low priority|no rush|whenever you (can|get a chance)|nice to have)\b/i.test(text)) return "low";
  return "medium";
}

/**
 * Hint suggestions for a transcript. `speakers` carries the speaker → user
 * mapping; `candidates` (assignable users) lets "@Name" resolve to people who
 * didn't speak.
 */
export function generateHints(
  segments: HintSegment[],
  speakers: HintSpeaker[],
  meetingDate: Date,
  candidates: CandidateUser[] = []
): HintSuggestion[] {
  const attendees = buildAttendees(speakers, candidates);
  const speakerUser = new Map(speakers.map((s) => [s.name.toLowerCase(), s.user ?? null]));
  const out: HintSuggestion[] = [];

  for (const seg of segments) {
    const best = bestSentence(seg.text, meetingDate, attendees, seg.speaker ?? null);
    if (best.score < HINT_THRESHOLD) continue;

    let assigneeName: string | null = null;
    let assignee: mongoose.Types.ObjectId | null = null;
    const mention = mentionedAttendee(best.sentence, attendees, seg.speaker ?? null);
    if (mention) {
      assigneeName = mention.name;
      assignee = mention.user;
    } else if (best.owner === "self" && seg.speaker) {
      assigneeName = seg.speaker;
      assignee = speakerUser.get(seg.speaker.toLowerCase()) ?? null;
    } else if (best.owner === "other" && candidates.length > 0) {
      // "Can you …" with a name we only know from EMS (not a speaker).
      const word = /\b(\p{Lu}\p{Ll}+)\s*,/u.exec(best.sentence)?.[1];
      const user = word ? matchName(word, candidates) : null;
      if (user) {
        assigneeName = user.name;
        assignee = user._id;
      }
    }

    out.push({
      segmentIdxs: [seg.idx],
      quote: seg.text.slice(0, MEETING_LIMITS.quoteMax),
      title: cleanTitle(best.sentence, attendees),
      assignee,
      assigneeName,
      dueDate: parseDueDate(best.sentence, meetingDate),
      priority: priorityOf(seg.text),
      score: best.score,
    });
  }
  return out;
}
