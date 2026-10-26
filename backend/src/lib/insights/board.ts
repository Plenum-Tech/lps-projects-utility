import crypto from "node:crypto";
import { z } from "zod/v4";
import type { ToolContext } from "./common.js";
import { datasetOf, TOOL_LISTS, type Dataset } from "./datasets.js";
import { INSIGHT_TOOLS, TOOL_BY_NAME, runTool } from "./tools.js";
import { INSIGHT_SCHEDULES, type InsightSchedule } from "../../models/InsightBoard.js";

// ---------------------------------------------------------------------------
// Board blocks: what a block shows is stored as tool + params + view (never the
// numbers), so a board re-fetches live data whenever it is opened. Blocks are
// validated with the tool's own zod params before they are run or saved.
// ---------------------------------------------------------------------------

export const BLOCK_VIEWS = ["table", "bar", "stacked", "line", "pie", "kpis"] as const;
const TOOL_NAMES = INSIGHT_TOOLS.map((t) => t.name) as [string, ...string[]];
export const MAX_BLOCKS = 12;

export const blockSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{4,32}$/),
  title: z.string().trim().min(1).max(100),
  tool: z.enum(TOOL_NAMES),
  params: z.record(z.string(), z.unknown()).default({}),
  view: z.enum(BLOCK_VIEWS).optional(),
  list: z.string().max(30).optional(),
  only: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
  /** Table sort (column key); the app picks the metric when unset. */
  sortBy: z.string().max(40).optional(),
  sortDir: z.enum(["desc", "asc"]).optional(),
});
export type BlockSpec = z.infer<typeof blockSchema>;

export const newBlockId = () => crypto.randomBytes(6).toString("hex");

/** A valid block (params checked by the tool's schema), or the reason it isn't. */
export function validateBlock(raw: unknown): { block: BlockSpec } | { error: string } {
  const parsed = blockSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const block = parsed.data;
  const tool = TOOL_BY_NAME.get(block.tool)!;
  const params = tool.params.safeParse(block.params);
  if (!params.success) return { error: `params: ${params.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  if (block.list && !TOOL_LISTS[block.tool]?.includes(block.list)) return { error: `list must be one of ${TOOL_LISTS[block.tool]?.join(", ")}` };
  return { block: { ...block, params: params.data as Record<string, unknown> } };
}

export interface BlockResult {
  dataset: Dataset | null;
  error?: string;
  trace: { name: string; params: Record<string, unknown>; ok: boolean; ms: number; rows: number };
}

/** Runs a block's tool and shapes the result (comparisons fetch every row, then keep the named ones). */
export async function runBlock(block: Pick<BlockSpec, "tool" | "params" | "list" | "only">, ctx: ToolContext): Promise<BlockResult> {
  const params = block.only?.length ? { ...block.params, limit: 200 } : block.params;
  const started = Date.now();
  const out = await runTool(block.tool, JSON.stringify(params), ctx);
  const ms = Date.now() - started;
  const trace = { name: block.tool, params: (out.args ?? {}) as Record<string, unknown>, ok: out.ok, ms, rows: 0 };
  if (!out.ok) return { dataset: null, error: String((out.result as { error?: unknown })?.error ?? "error"), trace };
  const dataset = datasetOf(block.tool, out.result, { list: block.list, only: block.only, params });
  trace.rows = dataset.rows.length;
  return { dataset, trace };
}

// -- Board operations from the conversation (the updateBoard tool) -----------

const opSchema = z.object({
  op: z.enum(["add", "update", "remove", "schedule"]).describe("schedule: set how often the board refreshes while open (refresh) and / or emails a report to the user (report)."),
  blockId: z.string().max(32).optional().describe("Required for update / remove: the id of an existing block."),
  title: z.string().max(100).optional(),
  tool: z.enum(TOOL_NAMES).optional().describe("add: required. update: optional (changes the data)."),
  params: z.record(z.string(), z.unknown()).optional().describe("The tool's params (same as when calling it). update: replaces the params."),
  view: z.enum(BLOCK_VIEWS).optional().describe("table, bar, stacked, line, pie or kpis (headline numbers only)."),
  list: z.string().max(30).optional().describe("Which list of the tool's result to show (see each tool's lists)."),
  only: z.array(z.string().max(80)).max(10).optional().describe("Keep only rows with these names (to compare e.g. two brands)."),
  sortBy: z.string().max(40).optional().describe("Column key to sort the block's table by (e.g. reworkPct)."),
  sortDir: z.enum(["desc", "asc"]).optional(),
  refresh: z.enum(INSIGHT_SCHEDULES).optional().describe("schedule op: auto-refresh while open."),
  report: z.enum(INSIGHT_SCHEDULES).optional().describe("schedule op: email + notification report to the user (leadership only)."),
});

export const updateBoardParams = z.object({ ops: z.array(opSchema).min(1).max(8) });

export const UPDATE_BOARD_DESCRIPTION =
  "Edits the user's Board (the analysis workspace): add a block, update one (title, tool params such as the period or filters, view, list, only, sortBy) or remove one. Only touch the blocks the user asked about. Filters take one name: to compare items use one block with only: [names]. Blocks store tool + params + view and always show live data. Lists per tool: " +
  Object.entries(TOOL_LISTS)
    .map(([t, l]) => `${t}: ${l.join(" / ")}`)
    .join("; ") +
  ".";

/** Applies the model's board operations to a copy of the blocks; returns the new blocks and a line per op. */
export interface BoardSettings {
  refresh?: InsightSchedule;
  report?: InsightSchedule;
}

export function applyBoardOps(blocks: BlockSpec[], rawOps: unknown): { blocks: BlockSpec[]; results: string[]; settings: BoardSettings } {
  const parsed = updateBoardParams.safeParse(rawOps);
  if (!parsed.success) return { blocks, settings: {}, results: [`Invalid operations: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`] };
  const next = [...blocks];
  const settings: BoardSettings = {};
  const results: string[] = [];
  for (const op of parsed.data.ops) {
    if (op.op === "schedule") {
      if (op.refresh) settings.refresh = op.refresh;
      if (op.report) settings.report = op.report;
      results.push(`schedule: ${[op.refresh && `refresh ${op.refresh}`, op.report && `report ${op.report}`].filter(Boolean).join(", ") || "nothing to change"}`);
      continue;
    }
    const index = op.blockId ? next.findIndex((b) => b.id === op.blockId) : -1;
    if (op.op === "remove") {
      if (index < 0) results.push(`remove: no block ${op.blockId}`);
      else results.push(`removed "${next.splice(index, 1)[0]!.title}"`);
      continue;
    }
    if (op.op === "add" && next.length >= MAX_BLOCKS) {
      results.push(`add: the board is full (${MAX_BLOCKS} blocks) — remove one first`);
      continue;
    }
    const base: Partial<BlockSpec> = op.op === "update" ? (next[index] ?? {}) : {};
    if (op.op === "update" && index < 0) {
      results.push(`update: no block ${op.blockId}`);
      continue;
    }
    const toolChanged = op.tool && op.tool !== base.tool;
    const candidate = {
      id: base.id ?? newBlockId(),
      title: op.title ?? base.title ?? op.tool ?? "Block",
      tool: op.tool ?? base.tool,
      params: op.params ?? (toolChanged ? {} : base.params) ?? {},
      view: op.view ?? base.view,
      list: op.list ?? (toolChanged ? undefined : base.list),
      only: op.only ?? (toolChanged ? undefined : base.only),
      sortBy: op.sortBy ?? (toolChanged ? undefined : base.sortBy),
      sortDir: op.sortDir ?? (toolChanged ? undefined : base.sortDir),
    };
    const checked = validateBlock(candidate);
    if ("error" in checked) {
      results.push(`${op.op} "${candidate.title}": ${checked.error}`);
      continue;
    }
    if (op.op === "add") next.push(checked.block);
    else next[index] = checked.block;
    results.push(`${op.op === "add" ? "added" : "updated"} "${checked.block.title}" (id ${checked.block.id})`);
  }
  return { blocks: next, results, settings };
}

/** The board as the model sees it (ids, titles, tool, params, view). */
export function boardSummary(blocks: BlockSpec[]): string {
  if (blocks.length === 0) return "The board is empty.";
  return blocks
    .map((b) => `- id ${b.id}: "${b.title}" — ${b.tool} ${JSON.stringify(b.params)}${b.view ? ` view ${b.view}` : ""}${b.list ? ` list ${b.list}` : ""}${b.only ? ` only ${b.only.join(", ")}` : ""}`)
    .join("\n");
}
