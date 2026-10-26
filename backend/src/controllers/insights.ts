import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { askInsights, insightsConfigured, insightsModel, type HistoryTurn, type ToolTrace } from "../lib/insights/ask.js";
import { MAX_BLOCKS, runBlock, validateBlock, type BlockSpec } from "../lib/insights/board.js";
import { loadRefData } from "../lib/delivery/facts.js";
import { runTool } from "../lib/insights/tools.js";
import { nextRunAt, runBoardReport, runDueInsightReports } from "../lib/insights/reports.js";
import { checkAnswer, inheritedFilters, type AnswerCheck } from "../lib/insights/verify.js";
import { firstNameOf } from "../lib/notifications.js";
import { isLeadershipUser } from "../lib/leadership.js";
import { isProjectApprover, projectApproverIds } from "../lib/projectApproval.js";
import { appTimeZone, zonedParts } from "../lib/appTime.js";
import { BOARD_LIMITS, INSIGHT_SCHEDULES, InsightBoard, type IInsightBoard, type InsightSchedule } from "../models/InsightBoard.js";
import { InsightLog } from "../models/InsightLog.js";
import { InsightReportRun } from "../models/InsightReportRun.js";
import { User } from "../models/User.js";

// ---------------------------------------------------------------------------
// /api/insights — Leadership Insights. EVERY endpoint is leadership only (no
// sharing with other staff yet: a read-only viewer route for a shared board
// would be the place to add it, see models/InsightBoard.ts → report.recipients).
//   POST /ask            { question, history?, blocks?, boardId? } → text/event-stream:
//     tool  { name, params, ok, ms, rows }   board { blocks, results }
//     delta { text }  reset {}  done { answer, tools, check, blocks, usage, ms, model }  error { error }
//   POST /tool           { tool, params, list?, only? } → one block's live data (no AI call)
//   GET  /options        names for the filter chips and report recipients
//   GET  /headline       start-screen headline from live data
//   GET|POST /boards, GET|PUT|DELETE /boards/:id, POST /boards/:id/report (send now)
//   POST /reports/tick   run due scheduled reports (manual tick; JOBS_MODE=off locally)
//   GET  /logs           the latest questions (audit)
// ---------------------------------------------------------------------------

const QUESTION_MAX = 500;
const HISTORY_MAX = 6;
const isId = (v: unknown): v is string => typeof v === "string" && mongoose.isValidObjectId(v);

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

/** Valid blocks of a client-sent list (invalid ones are dropped), at most MAX_BLOCKS. */
function parseBlocks(raw: unknown): BlockSpec[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_BLOCKS) return null;
  return raw.map((b) => validateBlock(b)).flatMap((r) => ("block" in r ? [r.block] : []));
}

export async function askInsight(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { question?: unknown; history?: unknown; blocks?: unknown; boardId?: unknown };
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
  const blocks = parseBlocks(body.blocks);
  if (!history || !blocks) {
    res.status(400).json({ error: "history / blocks are not valid" });
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
  let boardOps = 0;
  let check: AnswerCheck = { unmatchedNumbers: [], unmatchedTexts: [] };
  try {
    const result = await askInsights({
      question,
      history,
      blocks,
      ctx: { user: req.user! },
      signal: abort.signal,
      emit: {
        tool: (t) => {
          tools.push(t);
          send("tool", t);
        },
        delta: (text) => send("delta", { text }),
        reset: () => send("reset", {}),
        board: (next, results, settings) => {
          boardOps += results.length;
          send("board", { blocks: next, results, settings });
        },
      },
    });
    usage = result.usage;
    answerChars = result.answer.length;
    check = checkAnswer(result.answer, result.results, question);
    const inherited = inheritedFilters(question, result.tools);
    send("done", { answer: result.answer, tools: result.tools, check, inherited, blocks: result.blocks, usage, ms: Date.now() - started, model: result.model });
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
      board: isId(body.boardId) ? body.boardId : null,
      boardOps,
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

/** POST /tool — one block's live data: the tool re-run with the given params (validated by its zod schema). */
export async function runInsightTool(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const checked = validateBlock({ id: "live", title: "live", tool: body.tool, params: body.params ?? {}, list: body.list, only: body.only });
  if ("error" in checked) {
    res.status(400).json({ error: checked.error });
    return;
  }
  const result = await runBlock(checked.block, { user: req.user! });
  res.json(result);
}

/** GET /options — names for the filter chips (brands, teams, people) and the leadership report recipients. */
export async function insightOptions(_req: Request, res: Response): Promise<void> {
  const [ref, leaders] = await Promise.all([loadRefData(), projectApproverIds()]);
  const sorted = <T extends { name: string }>(rows: T[]) => rows.sort((a, b) => a.name.localeCompare(b.name));
  res.json({
    brands: sorted([...ref.brands].filter(([, b]) => b.active).map(([id, b]) => ({ id, name: b.name }))),
    teams: sorted([...ref.departments].map(([id, name]) => ({ id, name }))),
    people: sorted([...ref.users].map(([id, u]) => ({ id, name: u.name }))),
    leaders: sorted(leaders.map(String).filter((id) => ref.users.has(id)).map((id) => ({ id, name: ref.users.get(id)!.name }))),
  });
}

/** GET /headline — "Good morning Bala — …" from live data (no AI call). */
export async function insightHeadline(req: Request, res: Response): Promise<void> {
  const ctx = { user: req.user! };
  const [scope, late, approvals] = await Promise.all([
    runTool("scopeUsage", JSON.stringify({ overOnly: true }), ctx),
    runTool("lateTasks", JSON.stringify({ from: lastWeek().from, to: lastWeek().to, kind: "closed_late", limit: 1 }), ctx),
    runTool("approvalsWaiting", JSON.stringify({ limit: 1 }), ctx),
  ]);
  const overBrands = ((scope.result as { brands?: Array<{ overUnits?: number }> }).brands ?? []).filter((b) => Number(b.overUnits) > 0).length;
  const closedLate = Number((late.result as { closedLate?: number }).closedLate ?? 0);
  const waiting = Number((approvals.result as { total?: number }).total ?? 0);
  const hour = zonedParts(new Date()).hour;
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const parts = [
    `${overBrands} brand${overBrands === 1 ? "" : "s"} over scope this month`,
    `${closedLate} task${closedLate === 1 ? "" : "s"} closed late last week`,
    `${waiting} approval${waiting === 1 ? "" : "s"} waiting`,
  ];
  res.json({ greeting: `${greeting} ${firstNameOf(req.user!.name)}`, parts, timezone: appTimeZone() });
}

function lastWeek(): { from: string; to: string } {
  const p = zonedParts(new Date());
  const today = Date.UTC(p.year, p.month - 1, p.day);
  const monday = today - ((p.weekday + 6) % 7) * 86_400_000;
  const key = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: key(monday - 7 * 86_400_000), to: key(monday - 86_400_000) };
}

// -- Boards (each leader sees only their own) -----------------------------------


async function ownBoard(req: Request, res: Response): Promise<IInsightBoard | null> {
  const id = req.params.id;
  const board = isId(id) ? await InsightBoard.findOne({ _id: id, user: req.user!._id }) : null;
  if (!board) res.status(404).json({ error: "Board not found" });
  return board;
}

/** GET /boards — the user's boards, latest first. */
export async function listBoards(req: Request, res: Response): Promise<void> {
  const boards = await InsightBoard.find({ user: req.user!._id })
    .sort({ updatedAt: -1 })
    .limit(BOARD_LIMITS.maxBoardsPerUser)
    .select("title blocks.id refresh report.schedule report.lastSentAt updatedAt createdAt")
    .lean();
  res.json({
    boards: boards.map((b) => ({ _id: String(b._id), title: b.title, blocks: b.blocks.length, refresh: b.refresh, report: b.report?.schedule ?? "off", lastSentAt: b.report?.lastSentAt ?? null, updatedAt: b.updatedAt })),
  });
}

function parseMessages(raw: unknown): IInsightBoard["messages"] | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return null;
  return raw
    .slice(-BOARD_LIMITS.maxMessages)
    .filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m?.text === "string" && m.text.trim())
    .map((m) => ({ role: m.role, text: String(m.text).slice(0, BOARD_LIMITS.messageMax), at: new Date() }));
}

/** POST /boards — { title, blocks?, messages? }. */
export async function createBoard(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, BOARD_LIMITS.titleMax) : "Untitled board";
  const blocks = parseBlocks(body.blocks);
  if (!blocks) {
    res.status(400).json({ error: `blocks must be a list of at most ${MAX_BLOCKS}` });
    return;
  }
  if ((await InsightBoard.countDocuments({ user: req.user!._id })) >= BOARD_LIMITS.maxBoardsPerUser) {
    res.status(400).json({ error: "Too many boards — delete some first" });
    return;
  }
  const board = await InsightBoard.create({ user: req.user!._id, title, blocks, messages: parseMessages(body.messages) ?? [] });
  res.status(201).json({ board: board.toObject() });
}

/** GET /boards/:id */
export async function getBoard(req: Request, res: Response): Promise<void> {
  const board = await ownBoard(req, res);
  if (board) res.json({ board: board.toObject() });
}

/** PUT /boards/:id — { title?, blocks?, messages?, refresh?, report?: { schedule, recipients, sendUnchanged } }. */
export async function updateBoard(req: Request, res: Response): Promise<void> {
  const board = await ownBoard(req, res);
  if (!board) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.title === "string" && body.title.trim()) board.title = body.title.trim().slice(0, BOARD_LIMITS.titleMax);
  if (body.blocks !== undefined) {
    const blocks = parseBlocks(body.blocks);
    if (!blocks) {
      res.status(400).json({ error: `blocks must be a list of at most ${MAX_BLOCKS}` });
      return;
    }
    board.blocks = blocks as IInsightBoard["blocks"];
  }
  const messages = parseMessages(body.messages);
  if (messages) board.messages = messages;
  const isSchedule = (v: unknown): v is InsightSchedule => typeof v === "string" && (INSIGHT_SCHEDULES as readonly string[]).includes(v);
  if (body.refresh !== undefined) {
    if (!isSchedule(body.refresh)) {
      res.status(400).json({ error: `refresh must be one of ${INSIGHT_SCHEDULES.join(", ")}` });
      return;
    }
    board.refresh = body.refresh;
  }
  if (body.report !== undefined) {
    const report = (body.report ?? {}) as { schedule?: unknown; recipients?: unknown; sendUnchanged?: unknown };
    if (report.schedule !== undefined) {
      if (!isSchedule(report.schedule)) {
        res.status(400).json({ error: `report.schedule must be one of ${INSIGHT_SCHEDULES.join(", ")}` });
        return;
      }
      if (report.schedule !== board.report.schedule) board.report.nextRunAt = nextRunAt(report.schedule);
      board.report.schedule = report.schedule;
    }
    if (report.recipients !== undefined) {
      if (!Array.isArray(report.recipients) || report.recipients.length > 20 || !report.recipients.every(isId)) {
        res.status(400).json({ error: "recipients must be a list of user ids" });
        return;
      }
      // Leadership only for now: reports may go to leadership users only.
      const leaders = new Set((await projectApproverIds()).map(String));
      const outsiders = report.recipients.filter((id) => !leaders.has(String(id)));
      if (outsiders.length) {
        const names = await User.find({ _id: { $in: outsiders } }).select("name").lean();
        res.status(400).json({ error: `Reports go to leadership only — not ${names.map((u) => u.name).join(", ") || "these users"}` });
        return;
      }
      board.report.recipients = [...new Set(report.recipients.map(String))].map((id) => new mongoose.Types.ObjectId(id));
    }
    if (report.sendUnchanged !== undefined) board.report.sendUnchanged = Boolean(report.sendUnchanged);
  }
  await board.save();
  res.json({ board: board.toObject() });
}

/** DELETE /boards/:id (with its report runs). */
export async function deleteBoard(req: Request, res: Response): Promise<void> {
  const board = await ownBoard(req, res);
  if (!board) return;
  await Promise.all([board.deleteOne(), InsightReportRun.deleteMany({ board: board._id })]);
  res.json({ ok: true });
}

/** POST /boards/:id/report — { force? }: send the board's report now. */
export async function sendBoardReport(req: Request, res: Response): Promise<void> {
  const board = await ownBoard(req, res);
  if (!board) return;
  const schedule = board.report.schedule;
  const nextBefore = board.report.nextRunAt;
  const outcome = await runBoardReport(board, "manual", Boolean((req.body ?? {}).force));
  // A manual send doesn't move the schedule.
  if (schedule !== "off") {
    board.report.nextRunAt = nextBefore ?? nextRunAt(schedule);
    await board.save();
  }
  res.json({ outcome, board: board.toObject() });
}

/** POST /reports/tick — runs the due scheduled reports now (the scheduler does this every 15 min). */
export async function tickInsightReports(_req: Request, res: Response): Promise<void> {
  res.json(await runDueInsightReports(new Date()));
}

/** GET /logs?limit=50 — the latest questions with who asked, tools and tokens. */
export async function listInsightLogs(req: Request, res: Response): Promise<void> {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const logs = await InsightLog.find().sort({ createdAt: -1 }).limit(limit).populate("user", "name").lean();
  res.json({ logs });
}
