import { richTextToPlain } from "./richText.js";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { Task } from "../models/Task.js";
import { TaskFile } from "../models/TaskFile.js";

// ---------------------------------------------------------------------------
// AI brief check (Delivery Pulse): an OpenAI model reads a task's brief and
// flags weak ones — gibberish, placeholder text, off-context or off-brand.
// Runs in the background after a task's title/description changes; the verdict
// is stored on the task (`briefCheck`) so dashboards never wait on the model.
// Needs OPENAI_API_KEY (OPENAI_MODEL optional); without it nothing runs.
// ---------------------------------------------------------------------------

export const BRIEF_VERDICTS = ["ok", "weak", "flagged"] as const;
export type BriefVerdict = (typeof BRIEF_VERDICTS)[number];

const DEFAULT_MODEL = "gpt-4o-mini";
const TIMEOUT_MS = 20_000;
const MAX_CONCURRENT = 2;

export function briefCheckConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

export function briefCheckModel(): string {
  return process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
}

const SYSTEM_PROMPT = `You review task briefs written inside a creative/marketing agency.
Each brief is the instruction a creator receives. Score its quality from 0 to 100:
- Written in clear, proper English and easy to understand: up to 30 points.
- Linked to the brand and the project (mentions the brand, product, campaign or audience): up to 25 points.
- Actionable: says what to deliver (format, size, copy, deadline or acceptance criteria): up to 25 points.
- Includes a reference link (deck, drive, Figma, example) or attached files: up to 20 points; neither scores 0 here.
Briefs without proper information (one word, "as discussed", "pls do", placeholders) score below 20.
Gibberish, test text or a brief about a different brand than the project's scores below 10.
Then classify: "ok" (score 70+), "weak" (40-69) or "flagged" (below 40).
Reply with JSON only: {"score":0-100,"verdict":"ok"|"weak"|"flagged","reason":"at most 15 words"}.`;

function hashOf(parts: string[]): string {
  return crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
}

const SUMMARY_PROMPT = `You review the summary (scope) of a new project inside a creative/marketing agency.
It tells leadership and the team what the project is. Score its quality from 0 to 100:
- Written in clear, proper English and easy to understand: up to 25 points.
- Fits the brand and the project type (a Campaign has a goal, audience and timing; a Program / Retainer has the
  ongoing deliverables and cadence; a Project has the outcome and deliverables): up to 30 points.
- Says what will be delivered (formats, quantities, platforms, languages, key dates): up to 25 points.
- Includes a reference link (deck, drive, brief document) or attached files: up to 20 points; neither scores 0 here.
One-line or vague summaries ("social media", "as discussed", placeholders) score below 25.
Gibberish, test text or a summary about a different brand scores below 10.
Reply with JSON only: {"score":0-100,"verdict":"ok"|"weak"|"flagged","reason":"at most 20 words, say what to add"}.`;

/** Scores a new project's summary against its brand and type (not stored). */
export async function checkProjectSummary(input: {
  brand: string;
  type: string;
  name: string;
  summary: string;
  files: number;
}): Promise<{ score: number | null; verdict: BriefVerdict; reason: string }> {
  return askModel(
    { brand: input.brand, project: input.name, title: input.type, brief: input.summary, files: input.files },
    SUMMARY_PROMPT,
    [
      `Brand: ${input.brand || "(none)"}`,
      `Project type: ${input.type || "(none)"}`,
      `Project name: ${input.name || "(none)"}`,
      `Attached files: ${input.files}`,
      "Summary:",
      input.summary.slice(0, 4000),
    ].join("\n")
  );
}

async function askModel(
  input: { brand: string; project: string; title: string; brief: string; files: number },
  systemPrompt = SYSTEM_PROMPT,
  userContent?: string
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY!.trim()}`,
      },
      body: JSON.stringify({
        model: briefCheckModel(),
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: userContent ?? `Brand: ${input.brand || "(none)"}\nProject: ${input.project || "(none)"}\nTask title: ${input.title}\nAttached files: ${input.files}\nBrief:\n${input.brief.slice(0, 4000)}`,
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const parsed = JSON.parse(json.choices?.[0]?.message?.content ?? "{}") as { score?: unknown; verdict?: unknown; reason?: unknown };
    const rawScore = Number(parsed.score);
    const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : null;
    // The verdict follows the score when there is one.
    const verdict: BriefVerdict | null =
      score !== null
        ? score >= 70
          ? "ok"
          : score >= 40
            ? "weak"
            : "flagged"
        : (BRIEF_VERDICTS as readonly string[]).includes(String(parsed.verdict))
          ? (parsed.verdict as BriefVerdict)
          : null;
    if (!verdict) throw new Error("Unexpected model reply");
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 200) : "";
    return { verdict, score, reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks one task's brief and stores the verdict. Skips tasks without a
 * description (coverage handles those) and briefs already checked unchanged.
 * Never throws.
 */
export async function checkTaskBrief(taskId: mongoose.Types.ObjectId | string, force = false): Promise<BriefVerdict | null> {
  if (!briefCheckConfigured()) return null;
  try {
    const task = await Task.findById(taskId)
      .select("title description project briefCheck")
      .populate({ path: "project", select: "name brand", populate: { path: "brand", select: "name" } })
      .lean<{
        _id: mongoose.Types.ObjectId;
        title: string;
        description?: string;
        project?: { name?: string; brand?: { name?: string } | null } | null;
        briefCheck?: { hash?: string } | null;
      }>();
    if (!task) return null;
    const brief = richTextToPlain(task.description).trim();
    if (!brief) {
      if (task.briefCheck) await Task.updateOne({ _id: task._id }, { $unset: { briefCheck: 1 } });
      return null;
    }
    const brand = task.project?.brand?.name ?? "";
    const project = task.project?.name ?? "";
    // "v2": the scoring prompt — older verdicts are re-checked when the brief is next checked.
    // Attachments count toward the score, so adding files re-checks too.
    const files = await TaskFile.countDocuments({ task: task._id, subtask: null });
    const hash = hashOf(["v2", brand, project, task.title, brief, String(Math.min(files, 1))]);
    if (!force && task.briefCheck?.hash === hash) return null;
    const { verdict, score, reason } = await askModel({ brand, project, title: task.title, brief, files });
    await Task.updateOne(
      { _id: task._id },
      {
        $set: {
          briefCheck: { verdict, ...(score !== null ? { score } : {}), reason, model: briefCheckModel(), checkedAt: new Date(), hash },
        },
      },
      { timestamps: false }
    );
    return verdict;
  } catch (err) {
    console.error("[brief-check]", String(taskId), err instanceof Error ? err.message : err);
    return null;
  }
}

// Small in-process queue so a burst of edits doesn't fan out into many API calls.
const queue: string[] = [];
const queued = new Set<string>();
let running = 0;

function pump(): void {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const id = queue.shift()!;
    queued.delete(id);
    running++;
    void checkTaskBrief(id).finally(() => {
      running--;
      pump();
    });
  }
}

/** Fire-and-forget: check this task's brief soon (no-op without OPENAI_API_KEY). */
export function scheduleBriefCheck(taskId: mongoose.Types.ObjectId | string): void {
  if (!briefCheckConfigured()) return;
  const id = String(taskId);
  if (queued.has(id)) return;
  queued.add(id);
  queue.push(id);
  pump();
}
