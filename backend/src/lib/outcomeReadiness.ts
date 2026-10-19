import mongoose from "mongoose";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";
import { briefCheckConfigured, briefCheckModel } from "./briefCheck.js";
import { getDeliverySettings } from "./delivery/settings.js";
import { richTextToPlain } from "./richText.js";

// ---------------------------------------------------------------------------
// Outcome readiness: how well a task's outcome note (and final link) answers
// its brief and the project's scope. Advice only — it never blocks completion.
// With OPENAI_API_KEY an OpenAI model judges it (same client / model as the
// brief check); without it, or on any error, simple deterministic rules do.
// ---------------------------------------------------------------------------

export type OutcomeVerdict = "good" | "partial" | "weak";

export interface OutcomeReadiness {
  score: number;
  verdict: OutcomeVerdict;
  covered: string[];
  missing: string[];
  reply: string;
  source: "ai" | "rules";
}

export interface OutcomeTaskInput {
  title?: string | null;
  description?: string | null;
  titleParts?: { unit?: string | null; quantity?: number | null } | null;
  submissionNotes?: string | null;
  finalFile?: { fileId?: unknown; url?: string | null } | null;
}

export interface OutcomeProjectInput {
  name?: string | null;
  summary?: string | null;
  scopeItems?: Array<{ unit: string; quantity: number; languages?: number; languageList?: string[]; sizes?: number }> | null;
}

type ScopeRow = NonNullable<OutcomeProjectInput["scopeItems"]>[number];

const AI_TIMEOUT_MS = 15_000;
const MIN_NOTE_WORDS = 15;

export const verdictFor = (score: number): OutcomeVerdict => (score >= 75 ? "good" : score >= 50 ? "partial" : "weak");

const STOPWORDS = new Set(
  (
    "a an the and or but of to in on for with at by from as is are was were be been it its this that these those " +
    "we our you your they their i me my he she his her them us will would should could can may might must shall " +
    "do does did done have has had not no yes so if then than into onto over under about also just only very more " +
    "most some any all each every per via etc please pls kindly need needs make made create created use using get " +
    "one two three new final task brief project client team work"
  ).split(" ")
);

function keywords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || STOPWORDS.has(raw) || /^\d+$/.test(raw)) continue;
    // Light stemming so "posts" matches "post", "designed" matches "design".
    out.add(raw.replace(/(ies|es|s|ed|ing)$/u, "") || raw);
  }
  return out;
}

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'()[\]{}]+/gi;
const words = (text: string) => text.replace(URL_RE, " ").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** The scope rows for the task's unit (case-insensitive), else every row. */
export function matchingScope(task: OutcomeTaskInput, project: OutcomeProjectInput | null): ScopeRow[] {
  const rows = project?.scopeItems ?? [];
  const unit = task.titleParts?.unit?.trim().toLowerCase();
  if (unit) {
    const same = rows.filter((r) => r.unit.trim().toLowerCase() === unit);
    if (same.length) return same;
  }
  return rows;
}

function unitWords(unit: string): string[] {
  const u = unit.toLowerCase();
  const map: Record<string, string[]> = {
    video: ["video", "film", "edit", "cut", "motion", "animation", "mp4"],
    static: ["static", "post", "image", "visual", "design", "banner", "creative", "artwork", "kv", "graphic"],
    story: ["story", "stories"],
    carousel: ["carousel", "slide", "frame", "card"],
    reel: ["reel", "video", "edit", "cut"],
  };
  return map[u] ?? [u];
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, single: 1, both: 2,
};

/** What the task asked for: quantity + unit (task name first, else its single scope row). */
export function expectedDeliverable(task: OutcomeTaskInput, project: OutcomeProjectInput | null): { quantity: number | null; unit: string | null } {
  const scope = matchingScope(task, project);
  const unit = task.titleParts?.unit?.trim() || (scope.length === 1 ? scope[0]!.unit : null);
  const quantity = task.titleParts?.quantity ?? (scope.length === 1 ? scope[0]!.quantity : null);
  return { quantity: quantity && quantity > 0 ? quantity : null, unit: unit || null };
}

/** Counts the note states next to a unit word: "2 videos", "two reels", "2x final video" → [2, 2, 2]. */
export function statedCounts(note: string, unit: string): number[] {
  const unitRe = unitWords(unit)
    .map((w) => `${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:e?s|ies)?`)
    .join("|");
  const numbers = `\\d{1,3}|${Object.keys(NUMBER_WORDS).join("|")}`;
  const re = new RegExp(`\\b(${numbers})\\s*(?:x|×)?\\s+(?:[\\p{L}-]+\\s+){0,2}?(?:${unitRe})\\b`, "giu");
  const out: number[] = [];
  for (const m of note.matchAll(re)) {
    const raw = m[1]!.toLowerCase();
    const n = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
    if (n) out.push(n);
  }
  return out;
}

/** Deliverables handed in: the final file / link plus other links in the note. */
export function deliveredItems(task: OutcomeTaskInput): number {
  const urls = new Set<string>();
  const finalUrl = (task.finalFile?.url ?? "").trim();
  if (finalUrl) urls.add(finalUrl.replace(/\/+$/, ""));
  for (const m of (task.submissionNotes ?? "").matchAll(URL_RE)) urls.add(m[0].replace(/[.,;)]+$/, "").replace(/\/+$/, ""));
  return urls.size + (task.finalFile?.fileId ? 1 : 0);
}

/** A shared folder link can hold every deliverable. */
const FOLDER_LINK = /drive\.google\.com\/drive\/folders|sharepoint\.com\/.*(?:AllItems|:f:)|dropbox\.com\/(?:sh|scl\/fo)|wetransfer|box\.com\/s\/|frame\.io/i;

/**
 * Deterministic score: does what was handed in match what the task asked for?
 * - The note states the delivered count + unit and it matches the task ("2 videos" for a 2 Video task): 35
 * - The files / links handed in cover that count (or a folder link): 20
 * - The note is detailed (15+ words, not just the task name repeated): 20
 * - It refers to the brief: 15 · it names the scope's languages: 10 (when the scope has them)
 * Caps: a note under 5 words ≤ 35; a count that contradicts the task ≤ 55; no count stated ≤ 70.
 */
export function evaluateOutcomeRules(task: OutcomeTaskInput, project: OutcomeProjectInput | null): OutcomeReadiness {
  const note = (task.submissionNotes ?? "").trim();
  const brief = richTextToPlain(task.description ?? "").trim();
  const scope = matchingScope(task, project);
  const expected = expectedDeliverable(task, project);
  const expectedText = expected.quantity && expected.unit ? `${expected.quantity} ${expected.unit}` : (expected.unit ?? null);
  const covered: string[] = [];
  const missing: string[] = [];
  let points = 0;
  let max = 0;
  let cap = 100;
  const n = words(note);

  // 1. Expected vs delivered count (35).
  if (expected.quantity && expected.unit) {
    max += 35;
    const counts = statedCounts(note, expected.unit);
    if (counts.includes(expected.quantity)) {
      points += 35;
      covered.push(`Delivered as expected: ${expectedText}`);
    } else if (counts.length) {
      points += 8;
      cap = Math.min(cap, 55);
      missing.push(`The note says ${counts[0]} ${expected.unit}, but the task is for ${expectedText}`);
    } else {
      cap = Math.min(cap, 70);
      const plural = expected.quantity > 1 ? "s" : "";
      missing.push(`Say what was delivered against the task: ${expectedText} (e.g. "${expected.quantity} ${expected.unit.toLowerCase()}${plural} delivered — …")`);
    }
  }

  // 2. Files / links handed in vs the count (20).
  max += 20;
  const items = deliveredItems(task);
  const folder = FOLDER_LINK.test(`${task.finalFile?.url ?? ""} ${note}`);
  const need = expected.quantity ?? 1;
  if (items === 0) {
    missing.push("No final file or link");
  } else if (items >= need || folder) {
    points += 20;
    covered.push(folder && items < need ? "Folder link with the deliverables" : `${items} file${items === 1 ? "" : "s"} / link${items === 1 ? "" : "s"} handed in`);
  } else {
    points += Math.round((20 * items) / need);
    // Deliverables short of the count can't read as "good".
    cap = Math.min(cap, 74);
    missing.push(`${expectedText} expected but ${items} file / link handed in — add the others, or one folder link`);
  }

  // 3. Detail (20): enough words, and not just the task name repeated.
  max += 20;
  const titleKeys = keywords(task.title ?? "");
  const noteKeys = keywords(note);
  const onlyTitle = noteKeys.size > 0 && [...noteKeys].every((k) => titleKeys.has(k));
  if (n < 5) cap = Math.min(cap, 35);
  if (n >= MIN_NOTE_WORDS && !onlyTitle) {
    points += 20;
    covered.push(`Detailed note (${n} words)`);
  } else {
    points += onlyTitle ? 0 : Math.round((20 * Math.min(n, MIN_NOTE_WORDS)) / MIN_NOTE_WORDS);
    missing.push(
      onlyTitle
        ? "The note only repeats the task name — describe what was delivered"
        : `Outcome note is short (${n} word${n === 1 ? "" : "s"}; aim for ${MIN_NOTE_WORDS}+)`
    );
  }

  // 4. Refers to the brief (15).
  max += 15;
  const briefKeys = keywords(`${brief} ${scope.map((r) => r.unit).join(" ")}`);
  if (briefKeys.size === 0) {
    points += 8;
  } else {
    const hits = [...briefKeys].filter((k) => noteKeys.has(k));
    const target = Math.max(1, Math.min(5, Math.ceil(briefKeys.size / 3)));
    const ratio = Math.min(1, hits.length / target);
    points += Math.round(15 * ratio);
    if (ratio >= 0.67 && n >= 5) covered.push(`Refers to the brief (${hits.slice(0, 4).join(", ")})`);
    else missing.push(hits.length ? `Only partly answers the brief (matched: ${hits.slice(0, 3).join(", ")})` : "Doesn't say how the brief was answered");
  }

  // 5. Languages, when the scope names more than English (10).
  const languages = [...new Set(scope.flatMap((r) => r.languageList ?? []).filter((l) => l && l !== "Others"))];
  if (languages.length > 1 || (languages.length === 1 && languages[0] !== "English")) {
    max += 10;
    const said = languages.filter(
      (l) =>
        new RegExp(`\\b${l}\\b`, "i").test(note) ||
        (l === "English" && /\ben\b|\beng\b/i.test(note)) ||
        (l === "Arabic" && /\bar\b|\barb\b/i.test(note))
    );
    points += Math.round((10 * said.length) / languages.length);
    if (said.length === languages.length) covered.push(`Languages delivered (${languages.join(", ")})`);
    else {
      const not = languages.filter((l) => !said.includes(l));
      missing.push(`Mention the language${not.length > 1 ? "s" : ""} delivered (${not.join(", ")})`);
    }
  }

  let score = Math.max(0, Math.min(cap, Math.round((100 * points) / max)));
  // Two or more gaps can't read as "good".
  if (missing.length >= 2) score = Math.min(score, 74);
  const verdict = verdictFor(score);
  const lead = expectedText ? `Expected ${expectedText}. ` : "";
  const first = missing[0];
  const reply =
    verdict === "good"
      ? `${lead}The handover matches what the task asked for.${first ? ` To finish it off: ${first.charAt(0).toLowerCase()}${first.slice(1)}.` : ""}`
      : verdict === "partial"
        ? `${lead}The handover only partly matches the task. ${first ? `${first}.` : ""}`.trim()
        : `${lead}The handover doesn't show the task was delivered yet. ${first ? `${first}.` : ""}`.trim();
  return { score, verdict, covered, missing, reply, source: "rules" };
}

const SYSTEM_PROMPT = `You review the outcome of a finished task inside a creative/marketing agency.
You get the task title, its brief, the project's scope rows for this kind of deliverable,
the outcome note the creator wrote when closing it, and the final link (you can't open it; judge only its presence and kind).
Judge whether what was handed in MATCHES WHAT THE TASK ASKED FOR (expected vs delivered), score 0-100:
- The note states what was delivered and it matches the expected deliverable, same quantity and kind
  (e.g. task "2 Video": the note says 2 videos were delivered): up to 40 points. A different count is a mismatch: score at most 55.
- The files / links handed in cover that quantity (one folder link may hold them all): up to 20 points.
- Covers the scope details (formats / sizes, languages) where the scope has them: up to 20 points.
- Clear, specific and useful to the reviewer (not "done", "test", the task name repeated, placeholders): up to 20 points.
Notes of a few words, or that don't say what was delivered, score below 40.
Reply with JSON only: {"score":0-100,"covered":["up to 4 short points the note covers"],"missing":["up to 4 short points to add"],"reply":"1-2 short sentences of advice to the creator"}.`;

async function evaluateOutcomeAI(task: OutcomeTaskInput, project: OutcomeProjectInput | null): Promise<OutcomeReadiness> {
  const scope = matchingScope(task, project);
  const scopeText = scope.length
    ? scope
        .map((r) => `- ${r.quantity} × ${r.unit}${r.languageList?.length ? `, languages: ${r.languageList.join(", ")}` : r.languages && r.languages > 1 ? `, ${r.languages} languages` : ""}${r.sizes && r.sizes > 1 ? `, ${r.sizes} sizes` : ""}`)
        .join("\n")
    : "(no scope rows)";
  const link = (task.finalFile?.url ?? "").trim() || (task.finalFile?.fileId ? "(a file was uploaded)" : "(none)");
  const content = [
    `Project: ${project?.name ?? "(none)"}`,
    `Task title: ${task.title ?? ""}`,
    (() => {
      const e = expectedDeliverable(task, project);
      return e.unit ? `Expected deliverable: ${e.quantity ? `${e.quantity} ` : ""}${e.unit}` : null;
    })(),
    `Files / links handed in: ${deliveredItems(task)}`,
    "Brief:",
    richTextToPlain(task.description ?? "").slice(0, 3000) || "(empty)",
    "Scope rows:",
    scopeText,
    `Final link: ${link.slice(0, 300)}`,
    "Outcome note:",
    (task.submissionNotes ?? "").slice(0, 2000) || "(empty)",
  ]
    .filter((l) => l !== null)
    .join("\n");

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
    const parsed = JSON.parse(json.choices?.[0]?.message?.content ?? "{}") as Record<string, unknown>;
    const raw = Number(parsed.score);
    if (!Number.isFinite(raw)) throw new Error("Unexpected model reply");
    const score = Math.max(0, Math.min(100, Math.round(raw)));
    const list = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().slice(0, 160)).slice(0, 4) : [];
    const reply = typeof parsed.reply === "string" ? parsed.reply.trim().slice(0, 300) : "";
    return { score, verdict: verdictFor(score), covered: list(parsed.covered), missing: list(parsed.missing), reply, source: "ai" };
  } finally {
    clearTimeout(timer);
  }
}

/** AI judgement when OPENAI_API_KEY is set (falls back to the rules on any error), else the rules. */
export async function evaluateOutcome(task: OutcomeTaskInput, project: OutcomeProjectInput | null): Promise<OutcomeReadiness> {
  if (briefCheckConfigured()) {
    try {
      return await evaluateOutcomeAI(task, project);
    } catch (err) {
      console.error("[outcome-readiness] AI check failed, using rules:", err instanceof Error ? err.message : "error");
    }
  }
  return evaluateOutcomeRules(task, project);
}

/** Settings → Delivery switch (default on). */
export async function outcomeReadinessEnabled(): Promise<boolean> {
  try {
    return (await getDeliverySettings()).outcomeReadiness !== false;
  } catch {
    return true;
  }
}

/**
 * Scores a task that was just submitted / completed and stores the result on it
 * (`task.outcomeReadiness`). The rules score is stored straight away (fast, no
 * network); with OPENAI_API_KEY the AI judgement replaces it in the background.
 * Never throws and never blocks completion.
 */
export async function recordOutcomeReadiness(taskId: mongoose.Types.ObjectId | string): Promise<void> {
  try {
    if (!(await outcomeReadinessEnabled())) return;
    const task = await Task.findById(taskId).select("title description titleParts submissionNotes finalFile project").lean();
    if (!task) return;
    const project = task.project
      ? await Project.findById(task.project).select("name summary scopeItems").lean<OutcomeProjectInput>()
      : null;
    const input = task as OutcomeTaskInput;
    const store = (result: OutcomeReadiness) =>
      Task.updateOne({ _id: task._id }, { $set: { outcomeReadiness: { ...result, at: new Date() } } });
    await store(evaluateOutcomeRules(input, project));
    if (briefCheckConfigured()) {
      void evaluateOutcomeAI(input, project)
        .then(store)
        .catch((err) => console.error("[outcome-readiness] AI check failed, kept rules:", err instanceof Error ? err.message : "error"));
    }
  } catch (err) {
    console.error("[outcome-readiness] couldn't score task", String(taskId), err instanceof Error ? err.message : err);
  }
}
