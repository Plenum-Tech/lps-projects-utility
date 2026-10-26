import { createLibrary, defineComponent, type ComponentRenderer } from "@openuidev/react-lang";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Leadership Insights: the OpenUI component library the model answers with in
// the chat. Data is never written by the model: tables and charts are
// DataBlock(tool, params, view), filled with live, server-computed data.
// Renderers live in components/insights/library.tsx; this file has no UI
// imports so scripts/insights-prompt.ts can build the same library with stub
// renderers and write the generated system prompt to the backend
// (backend/src/lib/insights/uiPrompt.generated.ts). Change a schema here →
// run `bun run insights:prompt` in frontend/.
// ---------------------------------------------------------------------------

export const TOOL_NAMES = [
  "teamDay",
  "taskActivity",
  "tasksSummary",
  "lateTasks",
  "scopeUsage",
  "timeLogged",
  "manpowerLoad",
  "pitchPipeline",
  "reworkStats",
  "pearityStats",
  "approvalsWaiting",
] as const;
export const BLOCK_VIEWS = ["table", "bar", "stacked", "line", "pie", "kpis"] as const;

const props = {
  Text: z.object({ text: z.string().describe("1–3 plain sentences") }),
  Stat: z.object({
    label: z.string().describe("Short label"),
    value: z.union([z.string(), z.number()]).describe("A number copied exactly from a tool result"),
    hint: z.string().optional(),
    tone: z.enum(["default", "good", "warn", "bad"]).optional(),
  }),
  List: z.object({ items: z.array(z.string()), title: z.string().optional() }),
  Callout: z.object({
    text: z.string(),
    tone: z.enum(["info", "good", "warn", "bad"]).optional(),
    title: z.string().optional(),
  }),
  DataBlock: z.object({
    title: z.string(),
    tool: z.enum(TOOL_NAMES).describe("The data tool"),
    params: z.record(z.string(), z.unknown()).describe('The tool params as an object, e.g. {"month": "2026-10", "groupBy": "team"}'),
    view: z.enum(BLOCK_VIEWS).optional().describe("table (default), bar, stacked, line (weeks/months), pie (shares), kpis (headline numbers)"),
    list: z.string().optional().describe("Which list of the result (see updateBoard for each tool's lists)"),
    only: z.array(z.string()).optional().describe("Keep only rows with these names (compare)"),
    sortBy: z.string().optional().describe("Column key to sort the table by (e.g. reworkPct); default: the app picks the metric"),
    sortDir: z.enum(["desc", "asc"]).optional(),
  }),
  FollowUps: z.object({ questions: z.array(z.string()).describe("2–4 short follow-up questions the user can click") }),
};

export const COMPONENT_NAMES = ["Reply", "Text", "StatRow", "Stat", "List", "Callout", "DataBlock", "FollowUps"] as const;
export type InsightComponentName = (typeof COMPONENT_NAMES)[number];

const DESCRIPTIONS: Record<InsightComponentName, string> = {
  Reply: "The chat reply: its blocks in order",
  Text: "A short paragraph",
  StatRow: "A row of 2–4 Stat tiles",
  Stat: "One KPI tile (inside StatRow)",
  List: "Bulleted list of short findings",
  Callout: "Highlighted note: a key finding, caveat or warning",
  DataBlock: "Live table / chart of a data tool's result (the app fetches the numbers; the user can filter, drill in and pin it to the board)",
  FollowUps: "Follow-up question chips (always last)",
};

/** Builds the library with the given renderers (stubs in the prompt script). */
export function buildInsightsLibrary(r: Record<InsightComponentName, ComponentRenderer<any>>) {
  const def = (name: InsightComponentName, schema: z.ZodObject) =>
    defineComponent({ name, description: DESCRIPTIONS[name], props: schema, component: r[name] });

  const Text = def("Text", props.Text);
  const Stat = def("Stat", props.Stat);
  const StatRow = def("StatRow", z.object({ stats: z.array(Stat.ref) }));
  const List = def("List", props.List);
  const Callout = def("Callout", props.Callout);
  const DataBlock = def("DataBlock", props.DataBlock);
  const FollowUps = def("FollowUps", props.FollowUps);
  const Reply = def(
    "Reply",
    z.object({
      children: z.array(
        z.union([Text, StatRow, List, Callout, DataBlock, FollowUps].map((b) => b.ref) as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]),
      ),
    }),
  );

  return createLibrary({ components: [Reply, Text, StatRow, Stat, List, Callout, DataBlock, FollowUps], root: "Reply" });
}

/** Extra rules appended to the generated prompt. */
export const PROMPT_RULES = [
  "Start with root = Reply([...]). Keep replies short: the DataBlock shows the detail, the Text says what matters.",
  "Every number in Text, Stat or Callout must be copied from a tool result in this conversation — never estimate, add up or invent figures. If a tool returned an error or no data, say so in a Callout.",
  "Never write tables or chart data yourself: use DataBlock with the tool and params you called (the app fetches the same data live).",
  "Every statement is `name = Expression` on one line; FollowUps is referenced from the Reply children (last), never a bare line.",
  "Write plain text only inside strings (no markdown, no HTML).",
];

/** One complete reply (made-up names and numbers: the shape, never the data). */
export const PROMPT_EXAMPLES = [
  `root = Reply([summary, data, more])
summary = Text("Team B has the highest rework rate (24.0%); most rework has no internal / external source recorded.")
data = DataBlock("Rework by team, last 3 months", "reworkStats", {"from": "2026-01-01", "to": "2026-03-31", "groupBy": "team"}, "stacked")
more = FollowUps(["Which brands drive Team B's rework?", "Add this to the board"])`,
];
