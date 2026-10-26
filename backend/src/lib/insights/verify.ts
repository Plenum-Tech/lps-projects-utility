// ---------------------------------------------------------------------------
// Grounding check of an Insights answer: every number shown, and every text
// cell of a Table, should come from the tool results of that question. What
// can't be matched is reported with the answer ("couldn't be matched to the
// data") instead of being trusted silently. Heuristic, not a proof: a number
// that happens to appear elsewhere in the results passes.
// ---------------------------------------------------------------------------

const NUMBER = /(?<![\w.\-/:])-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\w\-/:])/g;
const MAX_REPORTED = 12;

const keys = (n: number) => [String(n), String(Math.round(n * 10) / 10), String(Math.round(n))];

function collect(value: unknown, numbers: Set<string>, texts: string[]): void {
  if (typeof value === "number") keys(value).forEach((k) => numbers.add(k));
  else if (typeof value === "string") {
    texts.push(value.toLowerCase());
    for (const m of value.matchAll(NUMBER)) keys(Number(m[0].replace(/,/g, ""))).forEach((k) => numbers.add(k));
  } else if (Array.isArray(value)) value.forEach((v) => collect(v, numbers, texts));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => collect(v, numbers, texts));
}

/** The "[ … ]" starting at `open` (strings respected); "" when there is none. */
function bracketed(text: string, open: number): string {
  if (open < 0) return "";
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

/**
 * Name filters (brand / team / person / lead / project) the tools used that the question
 * doesn't mention — usually carried over from an earlier question. Shown to the user.
 */
export function inheritedFilters(question: string, calls: Array<{ params: Record<string, unknown> }>): string[] {
  const q = question.toLowerCase();
  const out = new Set<string>();
  for (const call of calls) {
    for (const key of ["brand", "team", "person", "lead", "project"]) {
      const value = call.params[key];
      if (typeof value !== "string" || !value.trim()) continue;
      const words = value.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      if (!words.some((w) => q.includes(w))) out.add(`${key}: ${value}`);
    }
  }
  return [...out];
}

export interface AnswerCheck {
  unmatchedNumbers: string[];
  unmatchedTexts: string[];
}

export function checkAnswer(answer: string, results: unknown[], question: string): AnswerCheck {
  const numbers = new Set<string>();
  const texts: string[] = [];
  collect(results, numbers, texts);
  collect(question, numbers, texts);
  const corpus = texts.join("\n");

  const unmatchedNumbers = new Set<string>();
  for (const m of answer.matchAll(NUMBER)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (!Number.isFinite(n) || (Number.isInteger(n) && n >= 0 && n <= 10) || (n >= 1990 && n <= 2100)) continue;
    if (!keys(n).some((k) => numbers.has(k))) unmatchedNumbers.add(m[0]);
  }

  const unmatchedTexts = new Set<string>();
  // Every Table(columns, rows, caption?) wherever it is: the cells of its rows list (the caption is prose).
  for (const cols of answer.matchAll(/\bTable\(\s*\[[^\]]*\]/g)) {
    const rows = bracketed(answer, answer.indexOf("[", cols.index + cols[0].length));
    for (const m of rows.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      const text = m[1]!.replace(/\\"/g, '"').trim();
      if (text.length < 4 || /^[\d.,%\s-]+$/.test(text)) continue;
      // A joined list ("GITEX, Ajmal, …") passes when each part is in the data.
      const parts = text.split(/,\s+/);
      const found = (t: string) => corpus.includes(t.toLowerCase());
      if (!found(text) && !(parts.length > 1 && parts.every(found))) unmatchedTexts.add(text.length > 60 ? `${text.slice(0, 59)}…` : text);
    }
  }
  return { unmatchedNumbers: [...unmatchedNumbers].slice(0, MAX_REPORTED), unmatchedTexts: [...unmatchedTexts].slice(0, MAX_REPORTED) };
}
