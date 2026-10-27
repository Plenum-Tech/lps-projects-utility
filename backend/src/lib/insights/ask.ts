import { appDateKey, appTimeZone } from "../appTime.js";
import { dayFromKey, keyFromDay, mondayOfDay } from "../delivery/days.js";
import { applyBoardOps, boardSummary, UPDATE_BOARD_DESCRIPTION, updateBoardParams, type BlockSpec, type BoardSettings } from "./board.js";
import type { ToolContext } from "./common.js";
import { z } from "zod/v4";
import { describedCollections, queryCollections } from "./query.js";
import { openAiToolDefs, runTool } from "./tools.js";
import { INSIGHTS_UI_PROMPT } from "./uiPrompt.generated.js";

// ---------------------------------------------------------------------------
// Leadership Insights engine: OpenAI chat with tool calling over our read-only
// data tools (at most MAX_TOOL_ROUNDS rounds), then the final answer in OpenUI
// Lang (our component library only), streamed as it arrives. Same OpenAI
// conventions as lib/briefCheck.ts (plain fetch, OPENAI_API_KEY).
// ---------------------------------------------------------------------------

/** Fixed tools need one round; a dynamic query: catalog → fields → query → (fix) → answer. */
const MAX_TOOL_ROUNDS = 6;
const CALL_TIMEOUT_MS = 90_000;
/** Tool results sent to the model are cut at this many characters. */
const RESULT_MAX_CHARS = 24_000;
const HISTORY_TURNS = 3;
const HISTORY_ANSWER_CHARS = 1_500;

export const insightsConfigured = () => Boolean(process.env.OPENAI_API_KEY?.trim());
export const insightsModel = () => process.env.INSIGHTS_MODEL?.trim() || "gpt-4.1-mini";

export interface HistoryTurn {
  question: string;
  answer: string;
}

export interface ToolTrace {
  name: string;
  params: Record<string, unknown>;
  ok: boolean;
  ms: number;
  /** Rows the tool returned (sum of its top-level lists) or its error. */
  rows: number;
  error?: string;
}

export interface AskEmitter {
  tool(trace: ToolTrace): void;
  delta(text: string): void;
  /** Text streamed so far turned out to precede tool calls: the client drops it. */
  reset(): void;
  /** The conversation changed the board (validated blocks) and what each operation did. */
  board(blocks: BlockSpec[], results: string[], settings: BoardSettings): void;
}

export interface AskResult {
  answer: string;
  tools: ToolTrace[];
  /** Raw tool results (for the grounding check; not sent to the client). */
  results: unknown[];
  usage: { prompt: number; completion: number; total: number };
  /** The board after the conversation's operations (unchanged when there were none). */
  blocks: BlockSpec[];
  model: string;
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

function systemPrompt(blocks: BlockSpec[]): string {
  const today = appDateKey();
  const day = dayFromKey(today);
  const monday = mondayOfDay(day);
  const weekday = new Date(`${today}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  return [
    "You are Leadership Insights for LPS, a creative agency, inside its Projects Utility. Leadership asks about delivery (tasks, on-time, late work), scope usage, hours logged, the manpower plan, pitches, rework, Pearity (AI generation tool) usage and approvals.",
    `Today is ${weekday} ${today} (${appTimeZone()}). This month is ${today.slice(0, 7)}. This week started ${keyFromDay(monday)}; last week was ${keyFromDay(monday - 7)} to ${keyFromDay(monday - 1)}. "Last 3 months" means the 3 months up to today unless the user says otherwise. Quarters are calendar quarters (Q4 = Oct–Dec).`,
    "How to work: first call the data tools you need (several in parallel when useful; filters take names, not ids). When you have the data, reply with the final answer in openui-lang as described below — no tool calls in that reply. One round of tool calls is usually enough: tool results are complete for the arguments given (lists say how many rows exist), so never repeat a call or re-ask the same tool for more rows unless a count shows rows were left out.",
    "Dynamic queries: the fixed tools above come first. When none of them answers the question (other fields, other groupings, comments, task history, approvals detail, counts across collections), work like an analyst: 1) call describeData (no args) to see the collections, 2) describeData with the collections you need for their fields, 3) plan, 4) call runQuery with your plan in purpose and an aggregation that returns a small, grouped result with readable names. If runQuery returns an error, fix the pipeline and call it again. Always run runQuery yourself and put its key numbers in the Text (the answer's DataBlock uses runQuery with the same params); say in the Text that this was a custom query. Use a dynamic query too when a fixed tool can't express the exact question (e.g. status changes such as review → in progress, which live in taskhistories) or returns nothing for a question it doesn't really cover — never answer 'no data' before checking with a query.",
    "Workspace: the screen has this chat and the user's Board, a saved workspace of live data blocks (each block = tool + params + view; the numbers are always fetched fresh). Current board:",
    boardSummary(blocks),
    "- To answer a question: call the data tools, then reply with a short Text (1–3 sentences with the key numbers) and usually ONE DataBlock(...) with the same tool and params you used (it shows the live data; the user can pin it to the board), then FollowUps.",
    "- When the user asks to add / put something on the board, change a board block (period, filters, view, list), remove one, compare items on the board, or build an overview: call updateBoard (blocks are referred to by id; keep params in the tool's own format). Then reply with one short Text saying what changed — no DataBlock needed. You don't need to call the data tool before adding a block unless you also report its numbers.",
    "Names: a filter that matches nothing returns an error with the closest names (suggestions) — never answer just 'not found': say what was not found and offer the suggestions as FollowUps (e.g. 'Hamza Sheikh's team'). '<Name> team' or '<Name>'s team': pass team: '<Name>' — the tools resolve a department, else that person's team, and return team.definition (which definition was used, default tasks they own or assigned); state it in the Text. The user can switch the definition with teamScope (own, assigned, department, projects).",
    "Day-to-day updates: for a team or person's daily task update / status dashboard use teamDay (today's workload per person and the tasks) and taskActivity (updates in the last 24 hours). When the user asks for a dashboard, to keep it, or to refresh / email it every N hours: first call teamDay to read team.definition (say it in the Text), then call updateBoard to add the blocks — teamDay (people), teamDay with list tasks (all task details) and taskActivity (updates, last 24 hours) — AND a schedule op (refresh and / or report, e.g. '2h'). Otherwise offer FollowUps such as 'Pin this to a board and refresh every 2 hours' and 'Email me this every 2 hours'.",
    "Filters: apply only the filters this question asks for. Each question is fresh: never carry a brand, team, person or period filter over from an earlier question unless this question explicitly points back to it ('there', 'that brand', 'same for …', 'it'). If you do keep one, say so in the Text and the DataBlock title (e.g. 'still filtered to GITEX'). To compare several brands, teams or people, use ONE block without that filter plus only: [names] — filters take a single name. Rankings: for who / which is most, top, worst, frequently or a rate, pass the tool's sortBy for that metric (rates: the *Pct field; low-volume groups are flagged and ranked last).",
    "Hard rules: copy table cells (titles, names, outcome notes) verbatim from the results — never paraphrase or fill them in; use ONLY numbers that appear in tool results of this conversation; never estimate or invent figures, names or dates. If a tool returns an error, no plan or no rows, say so plainly. Never show emails, passwords, hourly rates, costs, salaries, leave or HR details — if asked, explain that Insights doesn't cover them. If the question can't be answered from the tools, reply with a short Report whose Callout lists what you can answer. If the asked period has no data (e.g. no plan for that month), say that first in the summary; you may then show the nearest period that has data, clearly labelled as such. Don't compute new percentages, sums or breakdowns yourself — show only figures present in the results (onPct is of the tasks with a recorded choice; use the *OfClosed shares for shares of all tasks).",
    "",
    INSIGHTS_UI_PROMPT,
  ].join("\n");
}

function countRows(result: unknown): number {
  if (!result || typeof result !== "object") return 0;
  let n = 0;
  for (const v of Object.values(result as Record<string, unknown>)) if (Array.isArray(v)) n += v.length;
  return n;
}

interface StreamedTurn {
  content: string;
  toolCalls: ToolCall[];
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}

/** One streamed chat completion: content deltas go to `onContent` while no tool call has appeared. */
async function streamTurn(
  messages: ChatMessage[],
  allowTools: boolean,
  signal: AbortSignal,
  onContent: (text: string) => void
): Promise<StreamedTurn> {
  const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.any([signal, timeout]),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY!.trim()}` },
    body: JSON.stringify({
      model: insightsModel(),
      temperature: 0.1,
      stream: true,
      stream_options: { include_usage: true },
      messages,
      tools: [...openAiToolDefs(), UPDATE_BOARD_TOOL],
      tool_choice: allowTools ? "auto" : "none",
    }),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenAI ${res.status} ${detail.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let usage: StreamedTurn["usage"] = null;
  const calls: ToolCall[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      const chunk = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> } }>;
        usage?: StreamedTurn["usage"];
      };
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      for (const tc of delta.tool_calls ?? []) {
        const call = (calls[tc.index] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.function.name += tc.function.name;
        if (tc.function?.arguments) call.function.arguments += tc.function.arguments;
      }
      if (delta.content) {
        content += delta.content;
        if (calls.length === 0) onContent(delta.content);
      }
    }
  }
  return { content, toolCalls: calls.filter(Boolean), usage };
}

const UPDATE_BOARD_TOOL = {
  type: "function" as const,
  function: (() => {
    const { $schema: _s, ...parameters } = z.toJSONSchema(updateBoardParams, { io: "input" }) as Record<string, unknown>;
    return { name: "updateBoard", description: UPDATE_BOARD_DESCRIPTION, parameters };
  })(),
};

/** Same tool + same arguments (the row limit ignored: results already say how many rows exist). */
function callKey(call: ToolCall): string {
  try {
    const { limit: _limit, ...args } = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
    return `${call.function.name}:${JSON.stringify(Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b))))}`;
  } catch {
    return `${call.function.name}:${call.function.arguments}`;
  }
}

/** Strips a ```openui fence the model sometimes adds around its answer. */
export function cleanAnswer(text: string): string {
  return text.replace(/^\s*```[a-z-]*\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
}

export async function askInsights(params: {
  question: string;
  history: HistoryTurn[];
  blocks: BlockSpec[];
  ctx: ToolContext;
  signal: AbortSignal;
  emit: AskEmitter;
}): Promise<AskResult> {
  const { question, history, ctx, signal, emit } = params;
  let blocks = params.blocks;
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt(blocks) }];
  for (const turn of history.slice(-HISTORY_TURNS)) {
    messages.push({ role: "user", content: turn.question });
    messages.push({ role: "assistant", content: turn.answer.slice(0, HISTORY_ANSWER_CHARS) });
  }
  messages.push({ role: "user", content: question });

  const usage = { prompt: 0, completion: 0, total: 0 };
  const tools: ToolTrace[] = [];
  const results: unknown[] = [];
  // Identical calls (same tool, same arguments) are answered once; a round of only repeats ends the tool phase.
  const seen = new Set<string>();
  // runQuery only on collections whose fields the model has read (describeData) — no guessed fields.
  const described = new Set<string>();
  let onlyRepeats = false;
  for (let round = 0; ; round++) {
    const allowTools = round < MAX_TOOL_ROUNDS && !onlyRepeats;
    let streamed = false;
    const turn = await streamTurn(messages, allowTools, signal, (text) => {
      streamed = true;
      emit.delta(text);
    });
    usage.prompt += turn.usage?.prompt_tokens ?? 0;
    usage.completion += turn.usage?.completion_tokens ?? 0;
    usage.total += turn.usage?.total_tokens ?? 0;
    if (turn.toolCalls.length === 0 || !allowTools) {
      return { answer: cleanAnswer(turn.content), tools, results, blocks, usage, model: insightsModel() };
    }
    if (streamed) emit.reset();

    messages.push({ role: "assistant", content: turn.content || null, tool_calls: turn.toolCalls });
    onlyRepeats = turn.toolCalls.every((call) => seen.has(callKey(call)));
    const replies = await Promise.all(
      turn.toolCalls.map(async (call) => {
        const key = callKey(call);
        if (seen.has(key)) {
          return { role: "tool" as const, tool_call_id: call.id, content: JSON.stringify({ note: "Same call as before — its result is above. Do not call it again; write the answer now." }) };
        }
        seen.add(key);
        if (call.function.name === "updateBoard") {
          let raw: unknown = null;
          try {
            raw = JSON.parse(call.function.arguments || "{}");
          } catch {
            // reported below as invalid operations
          }
          const applied = applyBoardOps(blocks, raw);
          blocks = applied.blocks;
          emit.board(blocks, applied.results, applied.settings);
          return { role: "tool" as const, tool_call_id: call.id, content: JSON.stringify({ results: applied.results, board: boardSummary(blocks) }) };
        }
        if (call.function.name === "runQuery") {
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(call.function.arguments || "{}");
          } catch {
            // runTool reports invalid JSON
          }
          const unread = queryCollections(parsed).filter((c) => !described.has(c));
          if (unread.length) {
            seen.delete(key);
            return { role: "tool" as const, tool_call_id: call.id, content: JSON.stringify({ error: `First call describeData with collections ${JSON.stringify(unread)} to see their real fields and example documents, then write the query with those fields.` }) };
          }
        }
        const started = Date.now();
        const out = await runTool(call.function.name, call.function.arguments, ctx);
        if (call.function.name === "describeData" && out.ok) describedCollections(out.args).forEach((c) => described.add(c));
        results.push(out.result);
        const error = out.ok ? undefined : String((out.result as { error?: unknown })?.error ?? "error");
        const trace: ToolTrace = {
          name: call.function.name,
          params: (out.args && typeof out.args === "object" ? out.args : { raw: String(out.args) }) as Record<string, unknown>,
          ok: out.ok,
          ms: Date.now() - started,
          rows: countRows(out.result),
          ...(error ? { error } : {}),
        };
        tools.push(trace);
        emit.tool(trace);
        let json = JSON.stringify(out.result);
        if (json.length > RESULT_MAX_CHARS) json = `${json.slice(0, RESULT_MAX_CHARS)}… [truncated: ask for fewer rows]`;
        return { role: "tool" as const, tool_call_id: call.id, content: json };
      })
    );
    messages.push(...replies);
  }
}
