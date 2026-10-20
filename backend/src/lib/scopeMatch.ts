import { briefCheckConfigured, briefCheckModel } from "./briefCheck.js";

// ---------------------------------------------------------------------------
// Scope vs agreement: how close the scope rows a person ended up with (typed or
// edited after extraction) are to what the agreement says (the rows read from it
// plus its text). Advice only — it never blocks a save. With OPENAI_API_KEY an
// OpenAI model judges it semantically (same client / model as the brief check);
// without it, or on any error / timeout, deterministic rules do.
//
// Also: diffScope — a scope version against the previous one (added / removed /
// changed rows), for brand scope versions and scope change approvals.
// ---------------------------------------------------------------------------

/** A scope row as compared here (brand rows have `what`; project rows don't). */
export interface MatchRow {
  unit: string;
  what?: string;
  quantity: number;
  languages?: number;
  languageList?: string[];
  sizes?: number;
}

export interface ScopeAgreement {
  /** Rows read from the agreement (the extraction's scope). */
  rows: MatchRow[];
  /** The agreement's text (all inputs joined). */
  text: string;
}

export interface ScopeMatchChange {
  unit: string;
  what: string;
  agreement: number;
  entered: number;
}

export interface ScopeMatchResult {
  score: number;
  matched: string[];
  missingFromScope: string[];
  extraInScope: string[];
  changedQty: ScopeMatchChange[];
  source: "ai" | "rules";
}

const AI_TIMEOUT_MS = 15_000;
const TEXT_MAX = 8000;

const STOP = new Set("a an the and or of for to in on with x by per each all total pcs pieces piece items item".split(" "));

/** Lower-case word stems of a deliverable name ("Engagement posts" → engagement, post). */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w))
    .map((w) => (w.length > 3 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  const A = new Set(a);
  const B = new Set(b);
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}

const langs = (r: MatchRow) => (r.languageList?.length ? [...r.languageList].sort().join(", ") : String(r.languages ?? 1));
const unitKey = (r: MatchRow) => r.unit.trim().toLowerCase();

/** "8 × Static (Engagement posts)" */
export function rowLabel(r: MatchRow): string {
  const what = (r.what ?? "").trim();
  const extra = [
    r.languageList && r.languageList.length > 1 ? r.languageList.join(" + ") : (r.languages ?? 1) > 1 ? `${r.languages} languages` : "",
    (r.sizes ?? 1) > 1 ? `${r.sizes} sizes` : "",
  ].filter(Boolean);
  return `${r.quantity} × ${r.unit}${what && what.toLowerCase() !== r.unit.toLowerCase() ? ` (${what})` : ""}${extra.length ? ` — ${extra.join(", ")}` : ""}`;
}

/** How alike two rows are as the same deliverable (0–1), ignoring the counts. */
function sameness(a: MatchRow, b: MatchRow): number {
  const unit = unitKey(a) === unitKey(b) ? 1 : 0;
  const wa = words(a.what ?? "");
  const wb = words(b.what ?? "");
  const what = wa.length && wb.length ? jaccard(wa, wb) : unit;
  return unit * 0.55 + what * 0.45;
}

/** True when the agreement text names this row (its words, or its unit and quantity on one line). */
function textSupports(text: string, r: MatchRow): boolean {
  if (!text.trim()) return false;
  const lines = text.toLowerCase().split(/\r?\n|•|;/);
  const ws = words(r.what ?? "");
  const unitWords = words(r.unit);
  return lines.some((line) => {
    const lw = new Set(words(line));
    const hasQty = new RegExp(`(^|[^\\d])${r.quantity}([^\\d]|$)`).test(line);
    const namesIt = ws.length ? ws.filter((w) => lw.has(w)).length / ws.length >= 0.6 : unitWords.some((w) => lw.has(w));
    return namesIt && hasQty;
  });
}

/**
 * True when the "other scope" text (kept as text on the brand, not as rows) names this
 * agreement row: most of its words on one line / bullet. The count isn't needed there.
 */
function boxCovers(box: string, r: MatchRow): boolean {
  if (!box.trim()) return false;
  const ws = words(r.what ?? "");
  const want = ws.length ? ws : words(r.unit);
  if (!want.length) return false;
  return box
    .toLowerCase()
    .split(/\r?\n|•|;/)
    .some((line) => {
      const lw = new Set(words(line));
      return want.filter((w) => lw.has(w)).length / want.length >= 0.6;
    });
}

/**
 * Rules: pair rows by unit / name, then compare quantity, languages and sizes.
 * `otherScope` is the scope kept as text ("Other scope"): agreement rows it names count as covered.
 */
export function scopeMatchByRules(agreement: ScopeAgreement, entered: MatchRow[], otherScope = ""): ScopeMatchResult {
  const pairs: Array<{ a: number; e: number; s: number }> = [];
  agreement.rows.forEach((a, ai) =>
    entered.forEach((e, ei) => {
      const s = sameness(a, e) + (a.quantity === e.quantity ? 0.05 : 0);
      if (s >= 0.55) pairs.push({ a: ai, e: ei, s });
    })
  );
  pairs.sort((x, y) => y.s - x.s);
  const usedA = new Set<number>();
  const usedE = new Set<number>();
  const matched: string[] = [];
  const changedQty: ScopeMatchChange[] = [];
  let points = 0;
  let count = 0;
  for (const p of pairs) {
    if (usedA.has(p.a) || usedE.has(p.e)) continue;
    usedA.add(p.a);
    usedE.add(p.e);
    const a = agreement.rows[p.a]!;
    const e = entered[p.e]!;
    let pt = 1;
    if (a.quantity !== e.quantity) {
      pt -= 0.25 + 0.75 * Math.min(1, Math.abs(a.quantity - e.quantity) / Math.max(a.quantity, e.quantity));
      changedQty.push({ unit: e.unit, what: (e.what || a.what || "").trim(), agreement: a.quantity, entered: e.quantity });
    }
    if (langs(a) !== langs(e)) pt -= 0.15;
    if ((a.sizes ?? 1) !== (e.sizes ?? 1)) pt -= 0.1;
    // Same unit, different name: likely the same line renamed.
    if (unitKey(a) === unitKey(e) && p.s < 0.8) pt -= 0.1;
    points += Math.max(0, pt);
    count++;
    if (a.quantity === e.quantity) matched.push(rowLabel(e));
  }
  const missingFromScope: string[] = [];
  agreement.rows.forEach((a, i) => {
    if (usedA.has(i)) return;
    count++;
    // Kept in the "Other scope" text instead of a row: covered, not missing.
    if (boxCovers(otherScope, a)) {
      points += 1;
      matched.push(`${rowLabel(a)} (in Other scope)`);
    } else missingFromScope.push(rowLabel(a));
  });
  const extraInScope: string[] = [];
  entered.forEach((e, i) => {
    if (usedE.has(i)) return;
    count++;
    // Not among the rows read, but the agreement's text names it: supported.
    if (textSupports(agreement.text, e) || textSupports(otherScope, e)) {
      points += 0.9;
      matched.push(`${rowLabel(e)} (in the agreement text)`);
    } else extraInScope.push(rowLabel(e));
  });
  const score = count === 0 ? 100 : Math.round((100 * points) / count);
  return { score, matched, missingFromScope, extraInScope, changedQty, source: "rules" };
}

const SYSTEM_PROMPT = `You compare a creative agency's signed agreement / SOW with the scope rows a person entered for it.
You get the rows read from the agreement, the agreement's text, and the entered rows (unit, what, quantity, languages, sizes).
Judge semantically: "Engagement posts" and "Static posts" can be the same deliverable; a breakdown can be one line.
Score from 0 to 100 how faithfully the entered rows match what the agreement says (100 = the same deliverables and counts).
List:
- "matched": entered rows the agreement supports with the same count (short labels like "8 × Static (Engagement posts)").
- "missingFromScope": deliverables in the agreement that the entered rows lack.
- "extraInScope": entered rows the agreement doesn't support.
- "changedQty": [{"unit","what","agreement":number,"entered":number}] for the same deliverable with a different count.
You may also get "Other scope": scope text the person kept as text (not as rows). Whatever it covers is in scope:
never list it as missing, and don't lower the score for it.
Reply with JSON only: {"score":0-100,"matched":[],"missingFromScope":[],"extraInScope":[],"changedQty":[]}.`;

async function scopeMatchAI(agreement: ScopeAgreement, entered: MatchRow[], otherScope: string): Promise<ScopeMatchResult> {
  const show = (rows: MatchRow[]) =>
    rows.length
      ? rows.map((r) => `- unit: ${r.unit}; what: ${r.what || "-"}; quantity: ${r.quantity}; languages: ${langs(r)}; sizes: ${r.sizes ?? 1}`).join("\n")
      : "(none)";
  const content = [
    "Rows read from the agreement:",
    show(agreement.rows),
    "Agreement text:",
    agreement.text.slice(0, TEXT_MAX) || "(no text)",
    "Entered rows:",
    show(entered),
    ...(otherScope.trim() ? ["Other scope (kept as text, counts as covered):", otherScope.slice(0, TEXT_MAX)] : []),
  ].join("\n");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
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
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const p = JSON.parse(json.choices?.[0]?.message?.content ?? "{}") as Record<string, unknown>;
    const raw = Number(p.score);
    if (!Number.isFinite(raw)) throw new Error("Unexpected model reply");
    const list = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().slice(0, 160)).slice(0, 30) : [];
    const changedQty = (Array.isArray(p.changedQty) ? (p.changedQty as Array<Record<string, unknown>>) : [])
      .map((c) => ({ unit: String(c?.unit ?? "").slice(0, 40), what: String(c?.what ?? "").slice(0, 80), agreement: Number(c?.agreement), entered: Number(c?.entered) }))
      .filter((c) => Number.isFinite(c.agreement) && Number.isFinite(c.entered))
      .slice(0, 30);
    return {
      score: Math.max(0, Math.min(100, Math.round(raw))),
      matched: list(p.matched),
      missingFromScope: list(p.missingFromScope),
      extraInScope: list(p.extraInScope),
      changedQty,
      source: "ai",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** AI judgement when OPENAI_API_KEY is set (falls back to the rules on any error / timeout), else the rules. */
export async function computeScopeMatch(agreement: ScopeAgreement, entered: MatchRow[], otherScope = ""): Promise<ScopeMatchResult> {
  if (briefCheckConfigured()) {
    try {
      const ai = await scopeMatchAI(agreement, entered, otherScope);
      // The model can still name something the box covers as missing: drop those.
      if (otherScope.trim()) ai.missingFromScope = ai.missingFromScope.filter((m) => !boxCoversLabel(otherScope, m));
      return ai;
    } catch (err) {
      console.error("[scope-match] AI check failed, using rules:", err instanceof Error ? err.message : "error");
    }
  }
  return scopeMatchByRules(agreement, entered, otherScope);
}

/** A free-text label ("8 × Static (Engagement posts)") the "other scope" text names. */
function boxCoversLabel(box: string, label: string): boolean {
  const inner = label.match(/\(([^)]+)\)/)?.[1] ?? label;
  return boxCovers(box, { unit: "", what: inner, quantity: 1 });
}

/** What is stored on the brand (`scopeMatch`). */
export function storedScopeMatch(r: ScopeMatchResult) {
  return { score: r.score, missing: r.missingFromScope, extra: r.extraInScope, changed: r.changedQty, source: r.source, at: new Date() };
}

/** Reads `{ rows | scope, text | texts }` from a request body into an agreement (null when empty). */
export function parseAgreement(raw: unknown): ScopeAgreement | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const rowsRaw = Array.isArray(o.rows) ? o.rows : Array.isArray(o.scope) ? o.scope : [];
  const rows = parseMatchRows(rowsRaw);
  const text =
    typeof o.text === "string"
      ? o.text
      : Array.isArray(o.texts)
        ? (o.texts as Array<Record<string, unknown>>).map((t) => (typeof t?.text === "string" ? t.text : "")).join("\n")
        : "";
  if (!rows.length && !text.trim()) return null;
  return { rows, text: text.slice(0, 12_000) };
}

/** Loose scope rows (any of unit / what / quantity / languages / languageList / sizes), at most 60. */
export function parseMatchRows(raw: unknown): MatchRow[] {
  if (!Array.isArray(raw)) return [];
  const out: MatchRow[] = [];
  for (const r of raw.slice(0, 60) as Array<Record<string, unknown>>) {
    const unit = typeof r?.unit === "string" ? r.unit.trim().slice(0, 40) : "";
    const quantity = Math.round(Number(r?.quantity));
    if (!unit || !Number.isFinite(quantity) || quantity < 1) continue;
    const languageList = Array.isArray(r.languageList) ? (r.languageList as unknown[]).map(String).filter(Boolean).slice(0, 10) : undefined;
    out.push({
      unit,
      what: typeof r.what === "string" ? r.what.trim().slice(0, 80) : "",
      quantity,
      languages: languageList?.length ? languageList.length : Math.max(1, Math.round(Number(r.languages) || 1)),
      ...(languageList?.length ? { languageList } : {}),
      sizes: Math.max(1, Math.round(Number(r.sizes) || 1)),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Version diff
// ---------------------------------------------------------------------------

export interface DiffSide {
  quantity: number;
  languages: string;
  sizes: number;
}

export interface ScopeDiff {
  added: MatchRow[];
  removed: MatchRow[];
  changed: Array<{ unit: string; what: string; fromWhat?: string; from: DiffSide; to: DiffSide }>;
  same: number;
}

const side = (r: MatchRow): DiffSide => ({ quantity: r.quantity, languages: langs(r), sizes: r.sizes ?? 1 });
const nameKey = (r: MatchRow) => `${unitKey(r)}|${words(r.what ?? "").join(" ")}`;

/** New scope vs the previous one: rows added, removed, and the same deliverable with other counts. */
export function diffScope(previous: MatchRow[], next: MatchRow[]): ScopeDiff {
  const out: ScopeDiff = { added: [], removed: [], changed: [], same: 0 };
  const prevLeft = previous.map((r, i) => ({ r, i }));
  const nextLeft: MatchRow[] = [];
  // 1. Same unit and name (in order), or an identical row.
  for (const r of next) {
    let at = prevLeft.findIndex((p) => nameKey(p.r) === nameKey(r) && JSON.stringify(side(p.r)) === JSON.stringify(side(r)));
    if (at < 0) at = prevLeft.findIndex((p) => nameKey(p.r) === nameKey(r));
    if (at < 0) {
      nextLeft.push(r);
      continue;
    }
    const p = prevLeft.splice(at, 1)[0]!.r;
    const [from, to] = [side(p), side(r)];
    if (JSON.stringify(from) === JSON.stringify(to)) out.same++;
    else out.changed.push({ unit: r.unit, what: (r.what ?? "").trim(), from, to });
  }
  // 2. What's left: the same unit with a similar (or no) name is a changed row; the rest are added / removed.
  for (const r of nextLeft) {
    let best = -1;
    let bestScore = 0;
    prevLeft.forEach((p, i) => {
      if (unitKey(p.r) !== unitKey(r)) return;
      const wa = words(p.r.what ?? "");
      const wb = words(r.what ?? "");
      const s = !wa.length || !wb.length ? 0.6 : jaccard(wa, wb);
      if (s >= 0.5 && s > bestScore) {
        best = i;
        bestScore = s;
      }
    });
    if (best < 0) {
      out.added.push(r);
      continue;
    }
    const p = prevLeft.splice(best, 1)[0]!.r;
    const [from, to] = [side(p), side(r)];
    const renamed = (p.what ?? "").trim() !== (r.what ?? "").trim();
    if (!renamed && JSON.stringify(from) === JSON.stringify(to)) out.same++;
    else out.changed.push({ unit: r.unit, what: (r.what ?? "").trim(), ...(renamed ? { fromWhat: (p.what ?? "").trim() } : {}), from, to });
  }
  out.removed = prevLeft.map((p) => p.r);
  return out;
}

/** True when two scopes are the same rows (order ignored). */
export function sameScope(a: MatchRow[], b: MatchRow[]): boolean {
  const d = diffScope(a, b);
  return !d.added.length && !d.removed.length && !d.changed.length;
}
