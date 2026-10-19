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

/** Deterministic score: keyword overlap, note length, link, quantity / units, languages. */
export function evaluateOutcomeRules(task: OutcomeTaskInput, project: OutcomeProjectInput | null): OutcomeReadiness {
  const note = (task.submissionNotes ?? "").trim();
  const noteLower = note.toLowerCase();
  const link = (task.finalFile?.url ?? "").trim() || (task.finalFile?.fileId ? "file" : "");
  const brief = richTextToPlain(task.description ?? "").trim();
  const scope = matchingScope(task, project);
  const covered: string[] = [];
  const missing: string[] = [];
  let points = 0;
  let max = 0;

  // 1. Keyword overlap with the brief / title / scope (35 points).
  max += 35;
  const briefKeys = keywords(`${task.title ?? ""} ${brief} ${scope.map((r) => r.unit).join(" ")}`);
  const noteKeys = keywords(note);
  if (briefKeys.size === 0) {
    points += noteKeys.size >= 5 ? 20 : 8;
    missing.push("The brief is empty, so the note can't be matched to it");
  } else {
    const hits = [...briefKeys].filter((k) => noteKeys.has(k));
    // Matching a third of the brief's keywords (or 6) counts as full coverage.
    const target = Math.max(1, Math.min(6, Math.ceil(briefKeys.size / 3)));
    const ratio = Math.min(1, hits.length / target);
    points += Math.round(35 * ratio);
    if (ratio >= 0.67) covered.push(`Refers to the brief (${hits.slice(0, 4).join(", ")})`);
    else if (hits.length) missing.push(`Only partly refers to the brief — mention what was asked (matched: ${hits.slice(0, 3).join(", ")})`);
    else missing.push("Doesn't refer to what the brief asked for");
  }

  // 2. Note length (20 points).
  max += 20;
  const n = words(note);
  if (n >= MIN_NOTE_WORDS) {
    points += 20;
    covered.push(`Outcome note has ${n} words`);
  } else {
    points += Math.round((20 * n) / MIN_NOTE_WORDS);
    missing.push(`Outcome note is short (${n} word${n === 1 ? "" : "s"}; aim for ${MIN_NOTE_WORDS}+)`);
  }

  // 3. A link / file (15 points).
  max += 15;
  if (link) {
    points += 15;
    covered.push(link === "file" ? "Final file attached" : "Final link added");
  } else {
    missing.push("No final link or file");
  }

  // 4. Quantity / units, when the scope row has a quantity (15 points).
  const qty = task.titleParts?.quantity ?? scope.find((r) => r.quantity > 0)?.quantity ?? null;
  if (qty && scope.length) {
    max += 15;
    const unitHit = scope.some((r) => unitWords(r.unit).some((w) => noteLower.includes(w)));
    const numberHit = new RegExp(`\\b${qty}\\b`).test(note) || /\b\d+\s*(x\b|×|pcs|pieces|posts?|videos?|reels?|stor(y|ies)|statics?|carousels?|frames?|slides?|sizes?|versions?)/i.test(note);
    if (numberHit && unitHit) {
      points += 15;
      covered.push("Says how many were delivered");
    } else if (numberHit || unitHit) {
      points += 7;
      missing.push(`Say how many were delivered (${qty} ${scope[0]!.unit})`);
    } else {
      missing.push(`Say how many were delivered (${qty} ${scope[0]!.unit})`);
    }
  }

  // 5. Languages, when the scope row names them (15 points).
  const languages = [...new Set(scope.flatMap((r) => r.languageList ?? []).filter((l) => l && l !== "Others"))];
  if (languages.length) {
    max += 15;
    const said = languages.filter((l) => new RegExp(`\\b${l}\\b`, "i").test(note) || (l === "English" && /\ben\b|\beng\b/i.test(note)) || (l === "Arabic" && /\bar\b|\barb\b/i.test(note)));
    if (said.length === languages.length) {
      points += 15;
      covered.push(`Mentions the language${languages.length > 1 ? "s" : ""} (${languages.join(", ")})`);
    } else {
      points += Math.round((15 * said.length) / languages.length);
      const not = languages.filter((l) => !said.includes(l));
      missing.push(`Mention the language${not.length > 1 ? "s" : ""} delivered (${not.join(", ")})`);
    }
  }

  let score = Math.max(0, Math.min(100, Math.round((100 * points) / max)));
  // Two or more gaps can't read as "good".
  if (missing.length >= 2) score = Math.min(score, 74);
  const verdict = verdictFor(score);
  const reply =
    verdict === "good"
      ? `The outcome note answers the brief and scope well.${missing[0] ? ` To finish it off: ${missing[0].charAt(0).toLowerCase()}${missing[0].slice(1)}.` : ""}`
      : verdict === "partial"
        ? `The note covers part of the brief. ${missing[0] ? `${missing[0]}.` : ""}`.trim()
        : `The note doesn't show the brief was met yet. ${missing[0] ? `${missing[0]}.` : ""}`.trim();
  return { score, verdict, covered, missing, reply, source: "rules" };
}

const SYSTEM_PROMPT = `You review the outcome of a finished task inside a creative/marketing agency.
You get the task title, its brief, the project's scope rows for this kind of deliverable,
the outcome note the creator wrote when closing it, and the final link (you can't open it; judge only its presence and kind).
Score from 0 to 100 how well the outcome note shows the brief and scope were delivered:
- Says what was delivered and it matches what the brief asked: up to 45 points.
- Covers the scope details (quantity, formats / sizes, languages) where the scope has them: up to 25 points.
- Clear, specific and useful to the reviewer (not "done", "as discussed", placeholders): up to 20 points.
- A final link or file is given: up to 10 points.
Notes of a few words or unrelated to the brief score below 40.
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
    task.titleParts?.unit ? `Task unit: ${task.titleParts.quantity ?? ""} ${task.titleParts.unit}` : null,
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
