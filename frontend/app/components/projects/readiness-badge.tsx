import { cn } from "@/lib/utils";
import { formatDateOnly } from "@/lib/tasks";
import type { ProjectReadiness } from "@/types";

const TONE = {
  green: "bg-good/10 text-good",
  amber: "bg-warn/10 text-warn",
  red: "bg-critical/10 text-critical",
} as const;

/** What each part of the score measured, as lines of text. */
export function readinessLines(r: ProjectReadiness): string[] {
  const p = r.parts;
  return [
    `Scope planned: ${p.scope.points} of ${p.scope.max} — ${p.scope.total > 0 ? `${p.scope.planned} of ${p.scope.total} ${p.scope.note}` : p.scope.note}`,
    `Entered on time: ${p.onTime.points} of ${p.onTime.max} — ${p.onTime.onTime} of ${p.onTime.tasks} tasks by ${r.cutoff ? formatDateOnly(r.cutoff, true) : "the cut-off"}`,
    `Assignee: ${p.assignee.points} of ${p.assignee.max} — ${p.assignee.with} of ${p.assignee.tasks} tasks`,
    `Due date: ${p.dueDate.points} of ${p.dueDate.max} — ${p.dueDate.with} of ${p.dueDate.tasks} tasks`,
    `Estimate: ${p.estimate.points} of ${p.estimate.max} — ${p.estimate.with} of ${p.estimate.tasks} tasks`,
  ];
}

/** "Ready 72" pill; hover for the breakdown. Before the cut-off it says so (the score can still rise). */
export function ReadinessBadge({ readiness, className }: { readiness: ProjectReadiness; className?: string }) {
  const title = [
    `Readiness ${readiness.score} of 100 — planning ${readiness.pastCutoff ? "was" : "is"} due ${readiness.cutoff ? formatDateOnly(readiness.cutoff, true) : "at the start"}`,
    ...readinessLines(readiness),
  ].join("\n");
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap tabular-nums", TONE[readiness.band], className)} title={title}>
      Ready {readiness.score}
      {!readiness.pastCutoff && <span className="font-normal opacity-80">· due {readiness.cutoff ? formatDateOnly(readiness.cutoff) : "soon"}</span>}
    </span>
  );
}
