import mammoth from "mammoth";
import { briefCheckConfigured, briefCheckModel } from "./briefCheck.js";
import { SCOPE_LANGUAGES, SCOPE_LIMITS, SCOPE_UNITS } from "./scopeUnits.js";

// ---------------------------------------------------------------------------
// Brand flow, step 2: read the brief / SOW the user gives (images, PDFs, Word
// files, typed text) and pull out the scope, the project name, platforms and the
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
  /** true when the AI model read the files. */
  usedAI: boolean;
}

const TIMEOUT_MS = 90_000;
const TEXT_MAX = 6000;
const TYPED = "Typed text";

const isImage = (f: ExtractInputFile) => f.mimetype.startsWith("image/");
const isPdf = (f: ExtractInputFile) => f.mimetype === "application/pdf" || /\.pdf$/i.test(f.originalname);
const isDocx = (f: ExtractInputFile) => /\.docx$/i.test(f.originalname) || f.mimetype.includes("wordprocessingml");
const isPlain = (f: ExtractInputFile) => f.mimetype.startsWith("text/") || /\.(txt|csv|md)$/i.test(f.originalname);

/** Text the server can read without the model (Word, plain text), else null. */
async function localText(f: ExtractInputFile): Promise<string | null> {
  try {
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

/** The scope unit a deliverable name belongs to. */
export function unitFor(what: string): string {
  const w = what.toLowerCase();
  if (/\breels?\b/.test(w)) return "Reel";
  if (/\bstor(y|ies)\b/.test(w)) return "Story";
  if (/\bcarousels?\b/.test(w)) return "Carousel";
  if (/\b(videos?|films?|tiktoks?|shorts|youtube|motion|animations?|gifs?)\b/.test(w)) return "Video";
  if (/\b(posts?|statics?|images?|visuals?|designs?|banners?|creatives?|artworks?|key ?visuals?|kv|graphics?|infographics?)\b/.test(w)) return "Static";
  return "Others";
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

function cleanRows(rows: ExtractedScopeRow[]): ExtractedScopeRow[] {
  const units = new Map(SCOPE_UNITS.map((u) => [u.toLowerCase(), u as string]));
  const langs = new Map(SCOPE_LANGUAGES.map((l) => [l.toLowerCase(), l as string]));
  const out: ExtractedScopeRow[] = [];
  for (const r of rows) {
    const quantity = Math.round(Number(r.quantity));
    if (!Number.isFinite(quantity) || quantity < 1) continue;
    const what = String(r.what ?? "").trim().slice(0, 80);
    const unit = units.get(String(r.unit ?? "").toLowerCase()) ?? unitFor(what);
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
  return out;
}

// ---------------------------------------------------------------------------
// Rules (no AI): "8x engagement posts", "10 reels", "Client presentation: 26 Oct 2026"
// ---------------------------------------------------------------------------

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
};

export function extractByRules(texts: Array<{ source: string; text: string }>): Omit<ScopeExtraction, "texts" | "usedAI"> {
  const all = texts.map((t) => t.text).join("\n");
  const languageList = languagesIn(all);
  const rows: ExtractedScopeRow[] = [];
  const notes: string[] = [];
  for (const { source, text } of texts) {
    for (const rawLine of text.split(/\r?\n|•/)) {
      const line = rawLine.replace(/^[\s\-–*o·]+/, "").trim();
      if (!line) continue;
      const m = line.match(/^(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty)\s*[x×]?\s+(.+)$/i);
      if (!m) continue;
      const quantity = /^\d+$/.test(m[1]!) ? Number(m[1]) : WORD_NUMBERS[m[1]!.toLowerCase()]!;
      const what = m[2]!.replace(/\s*\(.*?\)\s*/g, " ").replace(/[.:;,]+$/, "").trim();
      if (/content pieces|deliverables in total|^days?\b|days a week/i.test(what)) continue;
      if (/\bshoots?\b|\bshooting\b/i.test(what)) {
        notes.push(`${quantity}x ${what} — a production day, kept as a note (not a content piece).`);
        continue;
      }
      rows.push({ unit: unitFor(what), what: what.charAt(0).toUpperCase() + what.slice(1), quantity, languageList, sizes: 1, source });
    }
  }
  const find = (re: RegExp) => {
    for (const { text } of texts) {
      const m = text.match(re);
      if (m) return m[1] ?? null;
    }
    return null;
  };
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
  if (/\bmonthly\b/i.test(all)) notes.push("Monthly deliverables — the scope repeats every month.");
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
    scope: cleanRows(rows),
    notes,
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
  "unit": one of ${SCOPE_UNITS.join(", ")} (Reel for reels, Story for stories, Carousel, Video for videos/TikToks/films,
  Static for posts/images/visuals, Others for anything else such as tweets), "quantity": integer,
  "languageList": languages from [${SCOPE_LANGUAGES.join(", ")}] the content is in (default ["English"]),
  "sizes": number of sizes/formats if stated else 1, "source": the input name it came from}.
  Do NOT list totals ("53x content pieces"), shoot / production days, or services without a count as scope rows.
  If two inputs list the same deliverable, list it once.
- "notes": short notes for the user to check (shoot days, things that repeat monthly, assumptions, conflicts between inputs).
Reply with JSON only:
{"texts":[{"source":"<input name>","text":"..."}],"projectName":null,"platforms":[],"revenue":null,
 "dates":{"clientPresentation":null,"milestone1":null,"milestone2":null,"startDate":null,"endDate":null},"scope":[],"notes":[]}`;

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
      scope: cleanRows(Array.isArray(p.scope) ? (p.scope as ExtractedScopeRow[]) : []),
      notes: Array.isArray(p.notes) ? (p.notes as unknown[]).map(String).map((s) => s.slice(0, 300)).slice(0, 20) : [],
    };
  } finally {
    clearTimeout(timer);
  }
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
