import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { askInsights, insightsConfigured, insightsModel, type HistoryTurn, type ToolTrace } from "../lib/insights/ask.js";
import { checkAnswer, type AnswerCheck } from "../lib/insights/verify.js";
import { isLeadershipUser } from "../lib/leadership.js";
import { isProjectApprover } from "../lib/projectApproval.js";
import { InsightLog } from "../models/InsightLog.js";

// ---------------------------------------------------------------------------
// /api/insights — Leadership Insights (prototype). Leadership only.
//   POST /ask   { question, history? } → text/event-stream:
//     event tool   { name, params, ok, ms, rows }   (as each data tool runs)
//     event delta  { text }                          (OpenUI Lang, streamed)
//     event reset  {}                                (drop the text so far)
//     event done   { answer, tools, check, usage, ms, model }  ("How this was calculated"; check = unmatched figures)
//     event error  { error }
//   GET  /logs  → the latest questions (audit).
// ---------------------------------------------------------------------------

const QUESTION_MAX = 500;
const HISTORY_MAX = 6;

/** Leadership (the project approvers) only; everyone else gets 403. */
export async function requireLeadership(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = req.user!;
  if (isLeadershipUser(user) || (await isProjectApprover(user._id as mongoose.Types.ObjectId))) {
    next();
    return;
  }
  res.status(403).json({ error: "Insights are for leadership only" });
}

function parseHistory(raw: unknown): HistoryTurn[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > HISTORY_MAX) return null;
  const turns: HistoryTurn[] = [];
  for (const t of raw) {
    const q = (t as { question?: unknown })?.question;
    const a = (t as { answer?: unknown })?.answer;
    if (typeof q !== "string" || typeof a !== "string") return null;
    turns.push({ question: q.slice(0, QUESTION_MAX), answer: a.slice(0, 4000) });
  }
  return turns;
}

export async function askInsight(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { question?: unknown; history?: unknown };
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) {
    res.status(400).json({ error: "Ask a question first" });
    return;
  }
  if (question.length > QUESTION_MAX) {
    res.status(400).json({ error: `Keep the question under ${QUESTION_MAX} characters` });
    return;
  }
  const history = parseHistory(body.history);
  if (!history) {
    res.status(400).json({ error: "history must be a short list of { question, answer }" });
    return;
  }
  if (!insightsConfigured()) {
    res.status(503).json({ error: "Insights need the AI key" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const send = (event: string, data: unknown) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // The client went away: stop the model calls.
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  const started = Date.now();
  const tools: ToolTrace[] = [];
  let status: "ok" | "error" = "ok";
  let error = "";
  let usage = { prompt: 0, completion: 0, total: 0 };
  let answerChars = 0;
  let check: AnswerCheck = { unmatchedNumbers: [], unmatchedTexts: [] };
  try {
    const result = await askInsights({
      question,
      history,
      ctx: { user: req.user! },
      signal: abort.signal,
      emit: {
        tool: (t) => {
          tools.push(t);
          send("tool", t);
        },
        delta: (text) => send("delta", { text }),
        reset: () => send("reset", {}),
      },
    });
    usage = result.usage;
    answerChars = result.answer.length;
    check = checkAnswer(result.answer, result.results, question);
    send("done", { answer: result.answer, tools: result.tools, check, usage, ms: Date.now() - started, model: result.model });
  } catch (err) {
    status = "error";
    error = err instanceof Error ? err.message.slice(0, 300) : "failed";
    if (!abort.signal.aborted) console.error("[insights] ask failed", err);
    send("error", { error: "The insight couldn't be generated. Try again in a moment." });
  } finally {
    res.end();
    InsightLog.create({
      user: req.user!._id,
      question,
      tools: tools.map((t) => ({ name: t.name, params: t.params, ok: t.ok, ms: t.ms })),
      aiModel: insightsModel(),
      status,
      error,
      ms: Date.now() - started,
      tokens: usage,
      answerChars,
      unmatched: check,
    }).catch((e) => console.error("[insights] log failed", e));
  }
}

/** GET /api/insights/logs?limit=50 — the latest questions with who asked, tools and tokens. */
export async function listInsightLogs(req: Request, res: Response): Promise<void> {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const logs = await InsightLog.find().sort({ createdAt: -1 }).limit(limit).populate("user", "name").lean();
  res.json({ logs });
}
