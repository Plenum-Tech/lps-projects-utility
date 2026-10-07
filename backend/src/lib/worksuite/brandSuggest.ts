// ---------------------------------------------------------------------------
// Brand suggestions from project names (bun run brands:suggest).
//
// Worksuite project names encode the client in one "|"-separated segment, e.g.
//   "June 2025 | Program | Wasl | 360 Social", "Crocs MENA | June 25 | 360 Social".
// Pure functions only (no DB) so the heuristics are easy to reason about:
//   1. split into segments; strip zero-width chars / extra spaces
//   2. drop date tokens (months, years, quarters) and generic words from the
//      segment ends (stoplist), and market/region words (KSA, MENA, US…) at the end
//   3. learn extra generic segments: recurring phrases that are rarely the
//      first candidate and sit next to several different recurring brands
//      (e.g. "VDOR" in "Carluccio's | 360 and VDOR", "Zafran | 360 and VDOR")
//   4. merge variants: same key ignoring case/punctuation/spaces ("Homes R Us"
//      == "HomesRUs"), small alias map, and word-prefix of a recurring
//      candidate ("Ajmal Perfumes" → "Ajmal", "Noya Clinics" → "Noya")
//   5. pick the candidate that recurs most across projects (tie → first)
// ---------------------------------------------------------------------------

export type Confidence = "high" | "medium" | "low" | "none";

export interface ProjectInput {
  id: string;
  legacyId: string;
  name: string;
}

export interface BrandSuggestion {
  id: string;
  legacyId: string;
  name: string;
  brand: string;
  /** Original segment the brand came from (before normalisation). */
  segment: string;
  confidence: Confidence;
  reason: string;
}

export interface BrandSummary {
  brand: string;
  projects: number;
  variants: string[];
}

export interface SuggestResult {
  rows: BrandSuggestion[];
  brands: BrandSummary[];
  learnedGeneric: string[];
}

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DATE_TOKEN = new RegExp(
  `^(?:${MONTH}(?:['’@]?\\d{2,4})?|${MONTH}-${MONTH}|['’@]?\\d{2}|['’@]?20\\d{2}|@0\\d{2}|q[1-4](?:-q[1-4])?|h[12]|fy\\d{2,4})$`,
  "i"
);

/** Generic words (lower-case). A segment made only of these (+ dates/connectives) carries no brand. */
const GENERIC_WORDS = new Set(
  `program programme programs pitch pitches projects project 360 social socia media content contents tiktok campaign campaigns
  influencer influencers launch plan plans onboarding training test testing name calendar retainer report reports reporting
  monthly weekly qbr qbrs production video videos creative creatives branding identity marketing cm sfv sfvs vdor strategy
  management proposal research design website microsite shoot photoshoot edits edit new misc miscellaneous adhoc ad ads lps
  generic review deck animation awareness brand film films case study phase rfp community existing one time year years end
  highlight highlights recap wrap up visual invite technical hr task download script scripts captions caption calendar
  ideas idea concept amends carousels carousel trend story stories collection always on quarter quater digital
  communication communications presentation ppt changes event annual meeting guideline playbook menu gathering hosting
  pre post corporate kv shots e-comm ecomm moodboard reels reel posts post plan award awards bts strategy sm`
    .split(/\s+/)
    .filter(Boolean)
);

/** Connectives/fillers that may sit between generic words. */
const FILLER = new Set(["and", "&", "+", "x", "of", "for", "the", "to", "a", "an", "in", "-", "–", "with", "new", "all"]);

/** Market / region words dropped from candidate ends ("Crocs MENA" → "Crocs"). */
const REGION_WORDS = new Set(
  "gcc us usa uk ksa uae mena me qatar kuwait global international turkey europe india middle east saudi dubai emea apac".split(" ")
);

/** Words that mark an internal (non-client) project when present in the name. */
const INTERNAL_PATTERNS = [/\btechnical onboarding\b/i, /\btraining\b/i, /^\s*test\b/i, /\blps[\s_-]*(brands|generic)\b/i, /\|\s*lps\s*$/i];

/** Known shorthand → canonical key (keys are normalised: lower-case alphanumerics). */
const ALIASES: Record<string, string> = {
  hru: "homesrus",
  hershy: "hersheys",
  hershey: "hersheys",
  mands: "marksspencer",
  mahed: "mahe",
};

const ZERO_WIDTH = /[​-‍﻿ ]/g;

export function normaliseKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "");
}

function cleanText(text: string): string {
  return text.replace(ZERO_WIDTH, " ").replace(/\s+/g, " ").trim();
}

/** Splits a project name into raw segments on "|" and clear separators (" - ", "–", " _ ", "/ "). */
export function splitSegments(name: string): string[] {
  return cleanText(name)
    .split(/\s*\|\s*|\s+[-–—]\s+|\s*[–—]\s*|\s+_\s+|_|\s*\/\s+|\s+\/\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isDateToken(token: string): boolean {
  return DATE_TOKEN.test(token.replace(/[.,]$/, ""));
}

function isGenericToken(token: string): boolean {
  const t = token.toLowerCase().replace(/[.,:;()]+/g, "").replace(/['’]s$/, "");
  if (!t) return true;
  if (FILLER.has(t) || GENERIC_WORDS.has(t)) return true;
  // "VDOR-11-16" / "360" style codes.
  const base = t.replace(/(-\d+)+$/, "");
  return GENERIC_WORDS.has(base) || /^\d+$/.test(t);
}

/**
 * Candidate text of a segment: date tokens removed, generic/filler words stripped
 * from both ends, region words stripped from the end. "" = nothing brand-like left.
 */
export function cleanSegment(segment: string, extraGeneric: Set<string> = new Set()): string {
  let tokens = segment
    .replace(/\([^)]*\)/g, " ")
    .split(/\s+/)
    .flatMap((t) => (/^[a-z]+-[a-z]+$/i.test(t) && t.split("-").every((p) => isDateToken(p)) ? [] : [t]))
    .filter((t) => t && !isDateToken(t));
  const generic = (t: string) => isGenericToken(t) || extraGeneric.has(normaliseKey(t));
  // "US"/"ME" only when upper-case, so "Homes R Us" keeps its "Us".
  const region = (t: string) => {
    const w = t.toLowerCase().replace(/[.,]/g, "");
    if (!REGION_WORDS.has(w)) return false;
    return w.length > 2 || t === t.toUpperCase();
  };
  let changed = true;
  while (changed && tokens.length) {
    changed = false;
    if (tokens.length && generic(tokens[0] ?? "")) {
      tokens = tokens.slice(1);
      changed = true;
    }
    if (tokens.length && generic(tokens[tokens.length - 1] ?? "")) {
      tokens = tokens.slice(0, -1);
      changed = true;
    }
    if (tokens.length > 1 && region(tokens[tokens.length - 1] ?? "")) {
      tokens = tokens.slice(0, -1);
      changed = true;
    }
  }
  // Only region words left ("KSA") → not a brand.
  if (tokens.every(region)) return "";
  const text = tokens.join(" ").replace(/[\s,.:;-]+$/, "").trim();
  if (!text || extraGeneric.has(normaliseKey(text))) return "";
  // Brand names start with a capital or digit ("C4"); lower-case leftovers are prose.
  if (!/^[A-Z0-9À-Ý]/.test(text)) return "";
  return text;
}

interface Candidate {
  segment: string;
  text: string;
  key: string;
}

function candidatesOf(name: string, extraGeneric: Set<string>): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const segment of splitSegments(name)) {
    const text = cleanSegment(segment, extraGeneric);
    if (!text) continue;
    let key = normaliseKey(text);
    key = ALIASES[key] ?? key;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ segment, text, key });
  }
  return out;
}

function isInternal(name: string): boolean {
  return INTERNAL_PATTERNS.some((re) => re.test(cleanText(name)));
}

const SMALL_WORDS = new Set(["of", "and", "the", "for", "x", "al", "el", "de"]);

/**
 * Display name for a key: most frequent spelling, preferring (in order) spellings
 * that aren't all-caps (for names > 4 letters), that capitalise every word, and
 * whose letters match the canonical key (so an alias like "Hershy" loses to "Hersheys").
 */
function displayName(variants: Map<string, number>, canon: string): string {
  let best = "";
  let bestScore = -Infinity;
  for (const [text, count] of variants) {
    const shouting = text.length > 4 && text === text.toUpperCase() && /[A-Z]{5}/.test(text);
    const lowerWord = text.split(/\s+/).some((w) => /^[a-z]/.test(w) && !SMALL_WORDS.has(w));
    const score =
      count - (shouting ? 1000 : 0) - (lowerWord ? 500 : 0) + (normaliseKey(text) === canon ? 0.5 : 0) - text.length / 1000;
    if (score > bestScore) {
      best = text;
      bestScore = score;
    }
  }
  // No capitalised spelling seen ("Dahn al oud") → capitalise the words ourselves.
  return best
    .split(" ")
    .map((w, i) => (/^[a-z]/.test(w) && (i === 0 || !SMALL_WORDS.has(w)) ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Suggests a brand for every project. */
export function suggestBrands(projects: ProjectInput[]): SuggestResult {
  // Pass 1: candidates with the static stoplist; learn generic segments.
  const first = projects.map((p) => (isInternal(p.name) ? [] : candidatesOf(p.name, new Set())));
  const freq = new Map<string, number>();
  const firstPos = new Map<string, number>();
  for (const cands of first) {
    cands.forEach((c, i) => {
      freq.set(c.key, (freq.get(c.key) ?? 0) + 1);
      if (i === 0) firstPos.set(c.key, (firstPos.get(c.key) ?? 0) + 1);
    });
  }
  const neighbours = new Map<string, Set<string>>();
  for (const cands of first) {
    for (const c of cands) {
      const set = neighbours.get(c.key) ?? new Set<string>();
      for (const o of cands) if (o.key !== c.key && (freq.get(o.key) ?? 0) >= 2) set.add(o.key);
      neighbours.set(c.key, set);
    }
  }
  const learned = new Set<string>();
  const learnedDisplay: string[] = [];
  for (const [key, n] of freq) {
    const firstShare = (firstPos.get(key) ?? 0) / n;
    if (n >= 3 && firstShare < 0.25 && (neighbours.get(key)?.size ?? 0) >= 2) {
      learned.add(key);
      const sample = first.flat().find((c) => c.key === key);
      learnedDisplay.push(sample?.text ?? key);
    }
  }

  // Pass 2: candidates without learned generic segments.
  const second = projects.map((p) => (isInternal(p.name) ? [] : candidatesOf(p.name, learned)));
  const freq2 = new Map<string, number>();
  for (const cands of second) for (const c of cands) freq2.set(c.key, (freq2.get(c.key) ?? 0) + 1);

  // Prefix merge: "Ajmal Perfumes" → "Ajmal" when "Ajmal" itself recurs (≥ 2 projects).
  const wordsOf = (text: string) => text.split(/\s+/).map(normaliseKey).filter(Boolean);
  const textByKey = new Map<string, string>();
  for (const cands of second) for (const c of cands) if (!textByKey.has(c.key)) textByKey.set(c.key, c.text);
  const recurring = [...freq2.entries()].filter(([, n]) => n >= 2).map(([k]) => k);
  const canonicalOf = new Map<string, string>();
  for (const [key, text] of textByKey) {
    const words = wordsOf(text);
    let best: string | null = null;
    for (const r of recurring) {
      if (r === key) continue;
      const rWords = wordsOf(textByKey.get(r) ?? r);
      const isPrefix =
        rWords.length < words.length && rWords.every((w, i) => words[i] === w) && rWords.join("").length >= 2;
      // Also "Al-Farooj"/"Al Farooj x Modesh": key starts with the recurring key on a word boundary.
      if (isPrefix && (!best || (freq2.get(r) ?? 0) > (freq2.get(best) ?? 0))) best = r;
    }
    canonicalOf.set(key, best ?? key);
  }
  // One-off short form of a single recurring longer name: "Afnan" → "Afnan Perfumes".
  for (const [key, text] of textByKey) {
    if ((freq2.get(key) ?? 0) !== 1 || canonicalOf.get(key) !== key) continue;
    const words = wordsOf(text);
    const longer = recurring.filter((r) => {
      const rWords = wordsOf(textByKey.get(r) ?? r);
      return r !== key && canonicalOf.get(r) === r && rWords.length > words.length && words.every((w, i) => rWords[i] === w);
    });
    if (longer.length === 1 && longer[0]) canonicalOf.set(key, longer[0]);
  }

  const canonFreq = new Map<string, number>();
  const variants = new Map<string, Map<string, number>>();
  for (const cands of second) {
    const seen = new Set<string>();
    for (const c of cands) {
      const canon = canonicalOf.get(c.key) ?? c.key;
      if (!seen.has(canon)) canonFreq.set(canon, (canonFreq.get(canon) ?? 0) + 1);
      seen.add(canon);
      if (canon === c.key) {
        const v = variants.get(canon) ?? new Map<string, number>();
        v.set(c.text, (v.get(c.text) ?? 0) + 1);
        variants.set(canon, v);
      }
    }
  }
  const display = (canon: string) => displayName(variants.get(canon) ?? new Map([[textByKey.get(canon) ?? canon, 1]]), canon);

  const rows: BrandSuggestion[] = projects.map((p, idx) => {
    const base = { id: p.id, legacyId: p.legacyId, name: p.name };
    if (isInternal(p.name)) return { ...base, brand: "", segment: "", confidence: "none", reason: "internal project (onboarding/training/test/LPS)" };
    const cands = second[idx] ?? [];
    if (!cands.length) return { ...base, brand: "", segment: "", confidence: "none", reason: "only dates/generic words in name" };
    const scored = cands.map((c, i) => {
      const canon = canonicalOf.get(c.key) ?? c.key;
      return { c, canon, n: canonFreq.get(canon) ?? 1, i };
    });
    // Distinct canonical brands, best first (frequency, then position).
    const byCanon = new Map<string, (typeof scored)[number]>();
    for (const s of scored) if (!byCanon.has(s.canon)) byCanon.set(s.canon, s);
    const ranked = [...byCanon.values()].sort((a, b) => b.n - a.n || a.i - b.i);
    const top = ranked[0]!;
    const runnerUp = ranked[1];
    const brand = display(top.canon);
    const merged = top.canon !== top.c.key;
    const contested = runnerUp && runnerUp.n * 2 > top.n;
    let confidence: Confidence;
    const notes: string[] = [];
    if (top.n >= 3 && !merged && !contested) confidence = "high";
    else if (top.n >= 2) confidence = "medium";
    else confidence = "low";
    notes.push(`segment "${top.c.segment}" recurs in ${top.n} project${top.n === 1 ? "" : "s"}`);
    if (merged) notes.push(`"${top.c.text}" merged into "${brand}"`);
    else if (normaliseKey(top.c.text) !== normaliseKey(brand)) notes.push(`normalised from "${top.c.text}"`);
    if (runnerUp) notes.push(`other candidate${ranked.length > 2 ? "s" : ""}: ${ranked.slice(1, 4).map((r) => `"${r.c.text}" (${r.n})`).join(", ")}`);
    if (top.n === 1 && cands.length === 1 && splitSegments(p.name).length === 1) notes.push("single-segment name");
    return { ...base, brand, segment: top.c.segment, confidence, reason: notes.join("; ") };
  });

  const summary = new Map<string, { brand: string; projects: number; variants: Set<string> }>();
  for (const r of rows) {
    if (!r.brand) continue;
    const key = normaliseKey(r.brand);
    const s = summary.get(key) ?? { brand: r.brand, projects: 0, variants: new Set<string>() };
    s.projects += 1;
    if (r.segment) s.variants.add(r.segment);
    summary.set(key, s);
  }
  const brands = [...summary.values()]
    .map((s) => ({ brand: s.brand, projects: s.projects, variants: [...s.variants].sort() }))
    .sort((a, b) => b.projects - a.projects || a.brand.localeCompare(b.brand));

  return { rows, brands, learnedGeneric: learnedDisplay.sort() };
}
