import { useEffect, useRef, useState } from "react";
import { LuLoaderCircle, LuSparkles } from "react-icons/lu";

import { Button } from "@/components/ui/button";
import { api, getErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { OutcomeReadiness } from "@/types";

/** Green 75+, amber 50–74, red below 50. */
export function outcomeTone(score: number) {
  return score >= 75
    ? { pill: "bg-primary/10 text-primary", bar: "bg-primary" }
    : score >= 50
      ? { pill: "bg-amber-500/15 text-amber-700 dark:text-amber-400", bar: "bg-amber-500" }
      : { pill: "bg-destructive/10 text-destructive", bar: "bg-destructive" };
}

const wordCount = (text: string) => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** Score, bar, reply and the covered / missing lists. */
function OutcomeResult({ result }: { result: OutcomeReadiness }) {
  const tone = outcomeTone(result.score);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums", tone.pill)}>
          {result.score}/100
        </span>
        <div
          className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
          role="meter"
          aria-label="Outcome readiness"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={result.score}
        >
          <div className={cn("h-full rounded-full transition-all", tone.bar)} style={{ width: `${result.score}%` }} />
        </div>
        <span className="shrink-0 text-[11px] text-muted-foreground">{result.source === "ai" ? "AI" : "Rules"}</span>
      </div>
      {result.reply && <p className="text-xs">{result.reply}</p>}
      {(result.covered.length > 0 || result.missing.length > 0) && (
        <ul className="space-y-0.5 text-xs">
          {result.covered.map((c) => (
            <li key={`c-${c}`} className="flex gap-1.5 text-muted-foreground">
              <span aria-hidden className="text-primary">✓</span>
              <span>{c}</span>
            </li>
          ))}
          {result.missing.map((m) => (
            <li key={`m-${m}`} className="flex gap-1.5">
              <span aria-hidden className="text-amber-600 dark:text-amber-400">•</span>
              <span>{m}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Close-task dialog: advice on how well the outcome note (and final link) answer
 * the brief and the project's scope. Runs ~1 s after typing stops once there is a
 * note of a few words, or on "Check". Never blocks closing the task.
 */
export function OutcomeReadinessBox({
  taskId,
  notes,
  finalUrl,
  hasFile,
}: {
  taskId: string;
  notes: string;
  finalUrl: string;
  hasFile: boolean;
}) {
  const [result, setResult] = useState<OutcomeReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const seq = useRef(0);
  const lastKey = useRef("");

  const key = `${notes.trim()}\u0000${finalUrl.trim()}\u0000${hasFile}`;

  async function run() {
    const id = ++seq.current;
    lastKey.current = key;
    setChecking(true);
    setError(null);
    try {
      const { data } = await api.post<{ enabled: boolean; result: OutcomeReadiness | null }>(
        `/tasks/${taskId}/outcome-readiness`,
        { notes, finalUrl: finalUrl.trim(), hasFile },
      );
      if (id !== seq.current) return;
      if (!data.enabled) setDisabled(true);
      setResult(data.result);
    } catch (err) {
      if (id === seq.current) setError(getErrorMessage(err));
    } finally {
      if (id === seq.current) setChecking(false);
    }
  }

  // Debounced auto-check once the note has a few words.
  const ready = wordCount(notes) >= 3;
  useEffect(() => {
    if (!ready || disabled || key === lastKey.current) return;
    const timer = setTimeout(() => void run(), 1000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready, disabled]);

  if (disabled) return null;

  return (
    <section aria-labelledby="outcome-readiness-heading" className="space-y-2 rounded-lg border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <h4 id="outcome-readiness-heading" className="flex items-center gap-1.5 text-sm font-medium">
          <LuSparkles aria-hidden className="size-4 text-muted-foreground" />
          Outcome readiness
        </h4>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => void run()}
          disabled={checking || !notes.trim()}
        >
          {checking ? <LuLoaderCircle aria-hidden className="animate-spin" /> : null}
          {checking ? "Checking…" : "Check"}
        </Button>
      </div>
      <div aria-live="polite">
        {error ? (
          <p className="text-xs text-destructive">{error}</p>
        ) : result ? (
          <div className={cn(checking && "opacity-60")}>
            <OutcomeResult result={result} />
          </div>
        ) : checking ? (
          <p className="text-xs text-muted-foreground">Checking…</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Write the outcome note — it&apos;s checked against the brief and the project scope as you type.
          </p>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">Advice only — you can still close the task.</p>
    </section>
  );
}

/** Stored score on the task page: "Outcome 82/100", click to see the reply and the lists. */
export function OutcomeReadinessBadge({ result }: { result: OutcomeReadiness }) {
  const tone = outcomeTone(result.score);
  return (
    <details className="group text-sm">
      <summary
        className={cn(
          "inline-flex cursor-pointer list-none items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums [&::-webkit-details-marker]:hidden",
          tone.pill,
        )}
        title={result.reply || undefined}
      >
        Outcome {result.score}/100
      </summary>
      <div className="mt-2 rounded-md border bg-background p-2.5 normal-case tracking-normal font-normal">
        <OutcomeResult result={result} />
      </div>
    </details>
  );
}
