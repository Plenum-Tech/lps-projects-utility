import { useIsStreaming, useTriggerAction, type ComponentRenderProps } from "@openuidev/react-lang";
import { LuCircleAlert, LuCircleCheck, LuInfo, LuTriangleAlert } from "react-icons/lu";

import { DataBlock } from "@/components/insights/data-block";
import type { PinTarget } from "@/components/insights/actions";
import { buildInsightsLibrary } from "@/lib/insights/schema";
import type { BlockSpec, BlockView, DrillTarget, InsightTool } from "@/lib/insights/types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Renderers of the Leadership Insights OpenUI library (schemas in
// lib/insights/schema.ts). Data blocks fetch live, server-computed data; their
// Pin / drill-down and the follow-up chips go back to the page through
// react-lang actions (useTriggerAction → Renderer onAction), see
// insights-chat.tsx. Props arrive while streaming, so renderers tolerate
// missing values.
// ---------------------------------------------------------------------------

type P<T> = ComponentRenderProps<T>;

/** Custom action types the chat Renderer's onAction handles. */
export const INSIGHT_ACTIONS = { ask: "insights:ask", pin: "insights:pin", drill: "insights:drill" } as const;

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const fmt = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 1 }) : v == null ? "—" : String(v));
const TONE_TEXT: Record<string, string> = { good: "text-good", warn: "text-warn", bad: "text-critical", default: "text-foreground" };

function Reply({ props, renderNode }: P<{ children?: unknown[] }>) {
  return <div className="space-y-3">{renderNode(props.children)}</div>;
}

function Text({ props }: P<{ text?: string }>) {
  return <p className="text-sm leading-relaxed">{props.text}</p>;
}

function StatRow({ props, renderNode }: P<{ stats?: unknown[] }>) {
  return <div className="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fit,minmax(8rem,1fr))]">{renderNode(props.stats)}</div>;
}

function Stat({ props }: P<{ label?: string; value?: string | number; hint?: string; tone?: string }>) {
  return (
    <div className="rounded-lg border bg-background px-2.5 py-2">
      <div className="truncate text-[11px] text-muted-foreground">{props.label}</div>
      <div className={cn("font-heading text-lg font-semibold tabular-nums", TONE_TEXT[props.tone ?? "default"])}>{fmt(props.value)}</div>
      {props.hint && <div className="truncate text-[11px] text-muted-foreground">{props.hint}</div>}
    </div>
  );
}

function List({ props }: P<{ items?: string[]; title?: string }>) {
  return (
    <div className="space-y-1">
      {props.title && <h4 className="text-sm font-medium">{props.title}</h4>}
      <ul className="list-disc space-y-0.5 pl-5 text-sm">
        {arr<string>(props.items).map((item, i) => (
          <li key={i}>{String(item)}</li>
        ))}
      </ul>
    </div>
  );
}

const CALLOUT = {
  info: { icon: LuInfo, cls: "border-border bg-muted/40" },
  good: { icon: LuCircleCheck, cls: "border-good/30 bg-good/10 [&_svg]:text-good" },
  warn: { icon: LuTriangleAlert, cls: "border-warn/30 bg-warn/10 [&_svg]:text-warn" },
  bad: { icon: LuCircleAlert, cls: "border-critical/30 bg-critical/10 [&_svg]:text-critical" },
} as const;

function Callout({ props }: P<{ text?: string; tone?: keyof typeof CALLOUT; title?: string }>) {
  const { icon: Icon, cls } = CALLOUT[props.tone ?? "info"] ?? CALLOUT.info;
  return (
    <div className={cn("flex gap-2.5 rounded-xl border px-3 py-2.5 text-sm", cls)}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div>
        {props.title && <div className="font-medium">{props.title}</div>}
        <p>{props.text}</p>
      </div>
    </div>
  );
}

type DataBlockProps = { title?: string; tool?: InsightTool; params?: Record<string, unknown>; view?: BlockView; list?: string; only?: string[]; sortBy?: string; sortDir?: "asc" | "desc" };

/** A live data block in the chat; mounts once the call is complete (no half-streamed params). */
function ChatDataBlock({ props }: P<DataBlockProps>) {
  const streaming = useIsStreaming();
  const trigger = useTriggerAction();
  if (!props.tool || !props.title || (streaming && !props.params)) return <div className="h-24 animate-pulse rounded-xl border bg-muted/30" />;
  const spec: Omit<BlockSpec, "id"> = {
    title: props.title,
    tool: props.tool,
    params: props.params ?? {},
    view: props.view,
    list: props.list,
    only: props.only,
    sortBy: props.sortBy,
    sortDir: props.sortDir,
  };
  return (
    <DataBlock
      key={JSON.stringify(spec)}
      spec={spec}
      mode="chat"
      actions={{
        pin: (block: Omit<BlockSpec, "id">, target: PinTarget) => void trigger(`Pin “${block.title}” to the board`, undefined, { type: INSIGHT_ACTIONS.pin, params: { block, target } }),
        drill: (target: DrillTarget) => void trigger(`Details: ${target.value}`, undefined, { type: INSIGHT_ACTIONS.drill, params: { target } }),
      }}
    />
  );
}

function FollowUps({ props }: P<{ questions?: string[] }>) {
  const trigger = useTriggerAction();
  const streaming = useIsStreaming();
  const questions = arr<string>(props.questions).filter((q) => typeof q === "string");
  if (questions.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {questions.map((q) => (
        <button
          key={q}
          type="button"
          disabled={streaming}
          onClick={() => void trigger(q, undefined, { type: INSIGHT_ACTIONS.ask, params: { question: q } })}
          className="rounded-full border bg-background px-2.5 py-1 text-left text-xs transition-colors hover:bg-muted disabled:opacity-50"
        >
          {q}
        </button>
      ))}
    </div>
  );
}

export const insightsLibrary = buildInsightsLibrary({
  Reply,
  Text,
  StatRow,
  Stat,
  List,
  Callout,
  DataBlock: ChatDataBlock,
  FollowUps,
});
