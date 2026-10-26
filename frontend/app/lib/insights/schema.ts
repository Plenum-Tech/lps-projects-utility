import { createLibrary, defineComponent, type ComponentRenderer } from "@openuidev/react-lang";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Leadership Insights: the OpenUI component library the model may answer with
// (names, positional props, descriptions). Renderers live in
// components/insights/library.tsx; this file has no UI imports so
// scripts/insights-prompt.ts can build the same library with stub renderers and
// write the generated system prompt to the backend
// (backend/src/lib/insights/uiPrompt.generated.ts). Change a schema here →
// run `bun run insights:prompt` in frontend/.
// ---------------------------------------------------------------------------

const cell = z.union([z.string(), z.number(), z.null()]);
const unit = z.string().optional().describe("Value suffix such as '%' or 'h'");

const props = {
  Stat: z.object({
    label: z.string().describe("Short label"),
    value: z.union([z.string(), z.number()]).describe("The number (copied exactly from a tool result)"),
    hint: z.string().optional().describe("Small line under the value, e.g. 'of 480 with a due date'"),
    tone: z.enum(["default", "good", "warn", "bad"]).optional(),
  }),
  Series: z.object({
    name: z.string().describe("Series name (legend)"),
    values: z.array(z.number()).describe("One number per label, same order as the chart labels"),
  }),
  Slice: z.object({ label: z.string(), value: z.number() }),
  Table: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.array(cell)).describe("Each row has one cell per column"),
    caption: z.string().optional(),
  }),
  BarChart: z.object({
    title: z.string(),
    labels: z.array(z.string()).describe("Category labels (x axis)"),
  }),
  StackedBar: z.object({
    title: z.string(),
    labels: z.array(z.string()),
  }),
  LineChart: z.object({
    title: z.string(),
    labels: z.array(z.string()).describe("Ordered labels, e.g. weeks"),
  }),
  PieChart: z.object({
    title: z.string(),
  }),
  List: z.object({
    items: z.array(z.string()),
    title: z.string().optional(),
  }),
  Callout: z.object({
    text: z.string(),
    tone: z.enum(["info", "good", "warn", "bad"]).optional(),
    title: z.string().optional(),
  }),
  Text: z.object({ text: z.string().describe("One short paragraph of plain text") }),
  FollowUps: z.object({ questions: z.array(z.string()).describe("2–4 short follow-up questions the user can click") }),
};

export type InsightComponentName = keyof typeof props | "StatRow" | "Card" | "Report";

const DESCRIPTIONS: Record<InsightComponentName, string> = {
  Stat: "One KPI tile (use inside StatRow)",
  StatRow: "A row of 2–4 Stat tiles",
  Series: "A named list of numbers for a chart",
  Slice: "One pie slice",
  Table: "A compact table; prefer ≤ 15 rows",
  BarChart: "Bar chart comparing categories (grouped bars when several series)",
  StackedBar: "Stacked bar chart (parts of a whole per category, e.g. internal vs external)",
  LineChart: "Line chart for a trend over time",
  PieChart: "Pie chart for shares of a whole (≤ 6 slices)",
  List: "Bulleted list of short findings",
  Callout: "Highlighted note: a key finding, caveat or warning",
  Text: "A short paragraph",
  FollowUps: "Follow-up question chips (always last)",
  Card: "A titled section grouping related blocks",
  Report: "The whole answer: a title, a one-line summary, then blocks",
};

/** Builds the library with the given renderers (stubs in the prompt script). */
export function buildInsightsLibrary(r: Record<InsightComponentName, ComponentRenderer<any>>) {
  const def = (name: InsightComponentName, schema: z.ZodObject) =>
    defineComponent({ name, description: DESCRIPTIONS[name], props: schema, component: r[name] });

  const Stat = def("Stat", props.Stat);
  const StatRow = def("StatRow", z.object({ stats: z.array(Stat.ref) }));
  const Series = def("Series", props.Series);
  const Slice = def("Slice", props.Slice);
  const Table = def("Table", props.Table);
  const BarChart = def("BarChart", props.BarChart.extend({ series: z.array(Series.ref).describe("Series(...) items"), unit }));
  const StackedBar = def("StackedBar", props.StackedBar.extend({ series: z.array(Series.ref).describe("Series(...) items, stacked"), unit }));
  const LineChart = def("LineChart", props.LineChart.extend({ series: z.array(Series.ref).describe("Series(...) items"), unit }));
  const PieChart = def("PieChart", props.PieChart.extend({ slices: z.array(Slice.ref).describe("Slice(...) items") }));
  const List = def("List", props.List);
  const Callout = def("Callout", props.Callout);
  const Text = def("Text", props.Text);
  const FollowUps = def("FollowUps", props.FollowUps);
  const blocks = [StatRow, Table, BarChart, StackedBar, LineChart, PieChart, List, Callout, Text] as const;
  const Card = def(
    "Card",
    z.object({
      title: z.string(),
      children: z.array(z.union(blocks.map((b) => b.ref) as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])),
      description: z.string().optional(),
    }),
  );
  const Report = def(
    "Report",
    z.object({
      title: z.string(),
      summary: z.string().describe("One-sentence answer to the question"),
      children: z.array(
        z.union([...blocks, Card, FollowUps].map((b) => b.ref) as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]),
      ),
    }),
  );

  return createLibrary({
    components: [Report, Card, StatRow, Stat, Table, BarChart, StackedBar, LineChart, PieChart, Series, Slice, List, Callout, Text, FollowUps],
    root: "Report",
  });
}

/** Extra rules appended to the generated prompt. */
export const PROMPT_RULES = [
  "Start with root = Report(...). Put a StatRow with the 2–4 headline numbers first when the data has them.",
  "Every number you show must be copied from a tool result in this conversation — never estimate, round differently, add up or invent figures you were not given. If a tool returned an error or no data, say so in a Callout.",
  "Prefer one chart plus one compact table over many blocks. Keep tables ≤ 15 rows; mention when rows were left out.",
  "Chart series values must line up with the labels (same length, same order).",
  "Every statement is `name = Expression` on one line; FollowUps must be referenced from the Report children (last), never written as a bare line.",
  "End with FollowUps(...) holding 2–4 short follow-up questions.",
  "Write plain text only inside strings (no markdown, no HTML).",
];

/** One complete answer (made-up names and numbers: the shape, never the data). */
export const PROMPT_EXAMPLES = [
  `root = Report("Rework by team, last 3 months", "Team B has the highest rework rate (24.0%).", [kpis, chart, tbl, note, more])
kpis = StatRow([s1, s2, s3])
s1 = Stat("Tasks created", 500)
s2 = Stat("Rework", 100, "20.0% of created", "warn")
s3 = Stat("External rework", 10, "asked by clients")
chart = StackedBar("Rework by team", ["Team A", "Team B"], [Series("Internal", [20, 30]), Series("External", [4, 6]), Series("Not set", [16, 24])])
tbl = Table(["Team", "Created", "Rework", "Rate %"], [["Team A", 250, 40, 16.0], ["Team B", 250, 60, 24.0]])
note = Callout("Half of the rework has no internal / external source recorded.", "info")
more = FollowUps(["Which brands drive Team B's rework?", "Rework by person in Team B"])`,
];
