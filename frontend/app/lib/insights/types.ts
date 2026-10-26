// Leadership Insights DTOs (mirror backend/src/lib/insights/{board,datasets}.ts and models/InsightBoard.ts).

import type { BLOCK_VIEWS, TOOL_NAMES } from "@/lib/insights/schema";

export type InsightTool = (typeof TOOL_NAMES)[number];
export type BlockView = (typeof BLOCK_VIEWS)[number];
export type Cell = string | number | boolean | null;
export type DrillKind = "brand" | "person" | "team" | "task" | "lead";
export type FilterKind = "period" | "month" | "quarter" | "brand" | "team" | "person";
export type InsightSchedule = "off" | "1h" | "2h" | "4h" | "daily9" | "weeklyMon9";

/** What a block shows: tool + params + view (never the numbers). */
export interface BlockSpec {
  id: string;
  title: string;
  tool: InsightTool;
  params: Record<string, unknown>;
  view?: BlockView;
  list?: string;
  only?: string[];
  sortBy?: string;
  sortDir?: "asc" | "desc";
}

export interface DatasetColumn {
  key: string;
  label: string;
  numeric?: boolean;
  unit?: string;
}

export interface Dataset {
  subtitle: string;
  kpis: Array<{ label: string; value: Cell; hint?: string }>;
  list: string;
  lists: string[];
  columns: DatasetColumn[];
  rows: Array<Record<string, Cell>>;
  total: number;
  labelKey: string;
  series: string[];
  stacked: boolean;
  ordered: boolean;
  drill: { kind: DrillKind; key: string } | null;
  filters: FilterKind[];
  applied: Record<string, string>;
  sortedBy?: { key: string; dir: "asc" | "desc" };
  /** A person's team: the definition used and the others. */
  teamScope?: { value: string; definition: string; options: Array<{ value: string; label: string }> };
  note?: string;
}

export interface ToolTrace {
  name: string;
  params: Record<string, unknown>;
  ok: boolean;
  ms: number;
  rows: number;
  error?: string;
}

export interface BlockResult {
  dataset: Dataset | null;
  error?: string;
  trace: ToolTrace;
}

export interface InsightBoardSummary {
  _id: string;
  title: string;
  blocks: number;
  refresh: InsightSchedule;
  report: InsightSchedule;
  lastSentAt: string | null;
  updatedAt: string;
}

export interface InsightBoard {
  _id: string;
  title: string;
  blocks: BlockSpec[];
  messages: Array<{ role: "user" | "assistant"; text: string; at: string }>;
  refresh: InsightSchedule;
  report: {
    schedule: InsightSchedule;
    recipients: string[];
    sendUnchanged: boolean;
    nextRunAt: string | null;
    lastSentAt: string | null;
  };
  updatedAt: string;
}

export interface InsightOptions {
  brands: Array<{ id: string; name: string }>;
  teams: Array<{ id: string; name: string }>;
  people: Array<{ id: string; name: string }>;
  leaders: Array<{ id: string; name: string }>;
}

/** Where a click on a row / bar / slice leads. */
export interface DrillTarget {
  kind: DrillKind;
  value: string;
}

export const SCHEDULE_LABELS: Record<InsightSchedule, string> = {
  off: "Off",
  "1h": "Every hour",
  "2h": "Every 2 hours",
  "4h": "Every 4 hours",
  daily9: "Daily at 9:00",
  weeklyMon9: "Mondays at 9:00",
};
