import { useEffect, useState } from "react";

import { Progress } from "@/components/ui/progress";

/**
 * Shown while a deck uploads and converts: elapsed time and an estimated bar
 * (a 25-slide deck takes about a minute), so a long conversion doesn't look stuck.
 */
export function ConvertProgress({ fileSize }: { fileSize: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => window.clearInterval(id);
  }, []);
  // Rough estimate: ~20 s base + ~8 s per MB, never shown as finished before it is.
  const estimate = Math.max(30, 20 + Math.round((fileSize / 1_048_576) * 8));
  const pct = Math.min(95, Math.round((elapsed / estimate) * 100));
  const mmss = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
  const phase = elapsed < 5 ? "Uploading the deck…" : "Converting slides to images…";
  return (
    <div className="space-y-1.5 rounded-lg border bg-muted/40 p-3" role="status" aria-live="polite">
      <div className="flex items-center justify-between text-sm">
        <span className="text-foreground">{phase}</span>
        <span className="tabular-nums text-muted-foreground">{mmss}</span>
      </div>
      <Progress value={pct} aria-label="Conversion progress (estimated)" />
      <p className="text-xs text-muted-foreground">
        Usually about a minute for 25 slides. Keep this window open until it finishes.
      </p>
    </div>
  );
}
