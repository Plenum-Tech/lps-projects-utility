import crypto from "node:crypto";
import mongoose from "mongoose";
import { Task } from "../models/Task.js";

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
Each brief is the instruction a creator receives. Classify it:
- "ok": clear and relevant enough to act on.
- "weak": relevant but too thin or vague to act on (e.g. one word, "as discussed", no deliverable described).
- "flagged": gibberish, keyboard mash, test/placeholder text, unrelated to the task title or project, or about a different brand than the project's.
Reply with JSON only: {"verdict":"ok"|"weak"|"flagged","reason":"at most 15 words"}.`;

function hashOf(parts: string[]): string {
  return crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
}

async function askModel(input: { brand: string; project: string; title: string; brief: string }) {
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
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Brand: ${input.brand || "(none)"}\nProject: ${input.project || "(none)"}\nTask title: ${input.title}\nBrief:\n${input.brief.slice(0, 4000)}`,
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const parsed = JSON.parse(json.choices?.[0]?.message?.content ?? "{}") as { verdict?: unknown; reason?: unknown };
    const verdict = (BRIEF_VERDICTS as readonly string[]).includes(String(parsed.verdict)) ? (parsed.verdict as BriefVerdict) : null;
    if (!verdict) throw new Error("Unexpected model reply");
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 200) : "";
    return { verdict, reason };
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
    const brief = (task.description ?? "").trim();
    if (!brief) {
      if (task.briefCheck) await Task.updateOne({ _id: task._id }, { $unset: { briefCheck: 1 } });
      return null;
    }
    const brand = task.project?.brand?.name ?? "";
    const project = task.project?.name ?? "";
    const hash = hashOf([brand, project, task.title, brief]);
    if (!force && task.briefCheck?.hash === hash) return null;
    const { verdict, reason } = await askModel({ brand, project, title: task.title, brief });
    await Task.updateOne(
      { _id: task._id },
      { $set: { briefCheck: { verdict, reason, model: briefCheckModel(), checkedAt: new Date(), hash } } },
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
