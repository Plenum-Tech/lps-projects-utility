import { Renderer } from "@openuidev/react-lang";
import { useState, type KeyboardEvent } from "react";
import { LuChevronRight, LuCircleAlert, LuLoaderCircle, LuSend, LuSparkles, LuSquare, LuTriangleAlert } from "react-icons/lu";

import { insightsLibrary } from "@/components/insights/library";
import { PageHeader } from "@/components/globals/query-states";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import { followUpsOf, useInsights, type InsightToolTrace, type InsightTurn } from "@/hooks/use-insights";
import { cn } from "@/lib/utils";

export const EXAMPLE_QUESTIONS = [
  "Which brands are over scope this month?",
  "Rework rate by team, internal vs external, last 3 months",
  "Who's overloaded in November's plan?",
  "Pitch pipeline Q4 by lead",
  "Tasks closed late last week and why",
  "On vs off Pearity by brand this month",
];

const TOOL_LABELS: Record<string, string> = {
  tasksSummary: "Task summary",
  lateTasks: "Late tasks",
  scopeUsage: "Scope usage",
  timeLogged: "Hours logged",
  manpowerLoad: "Manpower plan",
  pitchPipeline: "Pitch pipeline",
  reworkStats: "Rework",
  pearityStats: "Pearity stats",
  approvalsWaiting: "Approvals waiting",
};
const toolLabel = (name: string) => TOOL_LABELS[name] ?? name;
const paramsText = (params: Record<string, unknown>) =>
  Object.entries(params)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" · ") || "defaults";

function Chips({ questions, onPick, disabled }: { questions: string[]; onPick: (q: string) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-2">
      {questions.map((q) => (
        <button
          key={q}
          type="button"
          disabled={disabled}
          onClick={() => onPick(q)}
          className="rounded-full border bg-background px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
        >
          {q}
        </button>
      ))}
    </div>
  );
}

/** "How this was calculated": the data tools the model called, with their parameters. */
function Calculation({ turn }: { turn: InsightTurn }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
        <LuChevronRight className="size-3.5 transition-transform group-data-[panel-open]:rotate-90" aria-hidden />
        How this was calculated
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 space-y-2 rounded-xl border bg-muted/30 p-3 text-xs">
          {turn.tools.length === 0 ? (
            <p className="text-muted-foreground">No data tools were used for this answer.</p>
          ) : (
            <ol className="space-y-1.5">
              {turn.tools.map((t: InsightToolTrace, i) => (
                <li key={i} className="break-words">
                  <span className="font-medium">{toolLabel(t.name)}</span>
                  <span className="text-muted-foreground"> ({paramsText(t.params)})</span>
                  <span className={cn("ml-1", t.ok ? "text-muted-foreground" : "text-critical")}>
                    → {t.ok ? `${t.rows} rows` : t.error}, {t.ms} ms
                  </span>
                </li>
              ))}
            </ol>
          )}
          <p className="text-muted-foreground">
            The numbers come only from these read-only queries of the Utility's data; the AI ({turn.model ?? "model"}) chooses the queries and lays out the
            answer.
            {turn.usage && ` ${turn.usage.total.toLocaleString("en-US")} tokens`}
            {turn.ms !== undefined && ` · ${(turn.ms / 1000).toFixed(1)} s`}
          </p>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Answer({ turn, onAsk, busy }: { turn: InsightTurn; onAsk: (q: string) => void; busy: boolean }) {
  const streaming = turn.status === "streaming";
  const followUps = turn.status === "done" ? followUpsOf(turn.text) : [];
  const unmatched = [...(turn.check?.unmatchedNumbers ?? []), ...(turn.check?.unmatchedTexts ?? []).map((t) => `“${t}”`)];
  return (
    <section className="space-y-3 rounded-2xl border bg-card p-4 sm:p-5">
      <p className="text-sm font-medium text-muted-foreground">{turn.question}</p>
      {streaming && !turn.text && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LuLoaderCircle className="size-4 animate-spin" aria-hidden />
          {turn.tools.length ? `Reading ${turn.tools.map((t) => toolLabel(t.name)).join(", ")}…` : "Choosing the data to look at…"}
        </p>
      )}
      {turn.text && <Renderer response={turn.text} library={insightsLibrary} isStreaming={streaming} />}
      {turn.status === "error" && (
        <p className="flex items-center gap-2 text-sm text-critical">
          <LuCircleAlert className="size-4" aria-hidden />
          {turn.error}
        </p>
      )}
      {unmatched.length > 0 && (
        <p className="flex gap-2 rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-xs">
          <LuTriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" aria-hidden />
          <span>
            Not found in the data, check before using: <span className="break-words">{unmatched.join(" · ")}</span>
          </span>
        </p>
      )}
      {followUps.length > 0 && <Chips questions={followUps} onPick={onAsk} disabled={busy} />}
      {turn.status === "done" && <Calculation turn={turn} />}
    </section>
  );
}

/** Leadership Insights (`/insights`, leadership only): ask in plain words, get a small report from live data. */
export function InsightsPage() {
  const { turns, ask, busy, stop } = useInsights();
  const [question, setQuestion] = useState("");

  function submit(q = question) {
    if (!q.trim() || busy) return;
    void ask(q);
    setQuestion("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Insights"
        description="Ask about delivery, scope, hours, the manpower plan, pitches, rework, Pearity and approvals. Answers are built from live data — open “How this was calculated” to see the queries."
      />

      <div className="space-y-3">
        <div className="relative">
          <Textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={onKeyDown}
            maxLength={500}
            rows={2}
            placeholder="Ask a question… (Enter to ask, Shift+Enter for a new line)"
            aria-label="Question"
            className="min-h-16 resize-none pr-14"
          />
          <Button
            type="button"
            size="icon"
            className="absolute right-2 bottom-2"
            onClick={() => (busy ? stop() : submit())}
            disabled={!busy && !question.trim()}
            aria-label={busy ? "Stop" : "Ask"}
            title={busy ? "Stop" : "Ask"}
          >
            {busy ? <LuSquare className="size-4" /> : <LuSend className="size-4" />}
          </Button>
        </div>
        <Chips questions={EXAMPLE_QUESTIONS} onPick={submit} disabled={busy} />
      </div>

      {turns.length === 0 ? (
        <div className="flex items-center gap-2 rounded-2xl border border-dashed p-6 text-sm text-muted-foreground">
          <LuSparkles className="size-4 shrink-0" aria-hidden />
          Pick an example or type your own question. Prototype: answers can be wrong — check the numbers that matter.
        </div>
      ) : (
        <div className="space-y-4">
          {[...turns].reverse().map((turn) => (
            <Answer key={turn.id} turn={turn} onAsk={submit} busy={busy} />
          ))}
        </div>
      )}
    </div>
  );
}