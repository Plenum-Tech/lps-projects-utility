import { LuLoaderCircle, LuSparkles } from "react-icons/lu";

import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { diffIsEmpty } from "@/lib/scope-diff";
import { cn } from "@/lib/utils";
import type { DiffRow, ScopeDiff, ScopeDiffSide, ScopeMatchResult } from "@/types";

// ---------------------------------------------------------------------------
// Scope comparisons shared by the brand flow, the brand page and Approvals:
// "Matches the agreement: 86/100" (advice only, never blocks) and "Changed
// since the last version" (added green, removed red, changed amber "8 → 6").
// ---------------------------------------------------------------------------

export function matchTone(score: number) {
  return score >= 75
    ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200"
    : score >= 50
      ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200"
      : "border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200";
}

/** Small "86" pill for lists (Brands → Overview). */
export function MatchBadge({ score, title }: { score: number; title?: string }) {
  return (
    <span title={title ?? `Scope matches the agreement: ${score}/100`} className={cn("inline-flex items-center rounded-full border px-1.5 py-0 text-[11px] font-semibold tabular-nums", matchTone(score))}>
      {score}
    </span>
  );
}

type MatchView = Pick<ScopeMatchResult, "score" | "missingFromScope" | "extraInScope" | "changedQty"> & { source?: "ai" | "rules" };

/** "Matches the agreement: 86/100" with what's missing, extra or changed. Advice only. */
export function ScopeMatchBox({
  match,
  loading,
  note,
  className,
  at,
}: {
  match: MatchView | null | undefined;
  loading?: boolean;
  /** Shown instead when there's nothing to compare with. */
  note?: string | null;
  className?: string;
  at?: string | null;
}) {
  if (!match) {
    if (loading) {
      return (
        <p className={cn("flex items-center gap-2 text-xs text-muted-foreground", className)}>
          <LuLoaderCircle aria-hidden className="size-3.5 animate-spin" /> Comparing with the agreement…
        </p>
      );
    }
    return note ? <p className={cn("text-xs text-muted-foreground", className)}>{note}</p> : null;
  }
  const lists: Array<[string, string[]]> = [
    ["In the agreement, not in the scope", match.missingFromScope],
    ["In the scope, not in the agreement", match.extraInScope],
    ["Different count", match.changedQty.map((c) => `${c.what || c.unit}: agreement ${c.agreement} → entered ${c.entered}`)],
  ];
  return (
    <div role="status" aria-live="polite" className={cn("rounded-lg border p-3 text-sm", matchTone(match.score), className)}>
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">
          Matches the agreement: <span className="tabular-nums">{match.score}/100</span>
        </span>
        {loading && <LuLoaderCircle aria-hidden className="size-3.5 animate-spin" />}
        <span className="text-xs opacity-80">
          {match.source === "ai" ? (
            <span className="inline-flex items-center gap-1"><LuSparkles aria-hidden className="size-3" /> judged by AI</span>
          ) : match.source === "rules" ? (
            "compared by rules"
          ) : null}
          {at ? ` · ${new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : ""} · advice only, never blocks
        </span>
      </p>
      {lists.some(([, items]) => items.length) ? (
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {lists
            .filter(([, items]) => items.length)
            .map(([label, items]) => (
              <div key={label}>
                <p className="text-xs font-medium">{label}</p>
                <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-xs">
                  {items.slice(0, 12).map((t) => <li key={t}>{t}</li>)}
                  {items.length > 12 && <li>{items.length - 12} more</li>}
                </ul>
              </div>
            ))}
        </div>
      ) : (
        <p className="mt-1 text-xs">Every row matches the agreement.</p>
      )}
    </div>
  );
}

const rowText = (r: DiffRow) => {
  const what = (r.what ?? "").trim();
  const langs =
    r.languageList && r.languageList.length > 1 ? r.languageList.join(" + ") : !r.languageList?.length && (r.languages ?? 1) > 1 ? `${r.languages} languages` : "";
  return `${r.quantity} × ${r.unit}${what && what.toLowerCase() !== r.unit.toLowerCase() ? ` (${what})` : ""}${langs ? ` — ${langs}` : ""}${(r.sizes ?? 1) > 1 ? `, ${r.sizes} sizes` : ""}`;
};

function changeText(from: ScopeDiffSide, to: ScopeDiffSide): string {
  const parts: string[] = [];
  if (from.quantity !== to.quantity) parts.push(`${from.quantity} → ${to.quantity}`);
  if (from.languages !== to.languages) parts.push(`languages ${from.languages} → ${to.languages}`);
  if (from.sizes !== to.sizes) parts.push(`sizes ${from.sizes} → ${to.sizes}`);
  return parts.join(", ") || "renamed";
}

/** Added (green), removed (red) and changed (amber "8 → 6") rows. */
export function ScopeDiffView({ diff, title, emptyText, className }: { diff: ScopeDiff; title?: string; emptyText?: string; className?: string }) {
  if (diffIsEmpty(diff)) return emptyText ? <p className={cn("text-xs text-muted-foreground", className)}>{emptyText}</p> : null;
  return (
    <div className={cn("space-y-1.5", className)}>
      {title && <p className="text-sm font-medium">{title}</p>}
      <ul className="space-y-1 text-sm">
        {diff.added.map((r, i) => (
          <li key={`a${i}`} className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200">
            <span className="mr-1.5 font-semibold">+ Added</span>
            {rowText(r)}
          </li>
        ))}
        {diff.removed.map((r, i) => (
          <li key={`r${i}`} className="rounded-md border border-red-300 bg-red-50 px-2 py-1 text-red-900 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200">
            <span className="mr-1.5 font-semibold">− Removed</span>
            <span className="line-through decoration-1">{rowText(r)}</span>
          </li>
        ))}
        {diff.changed.map((c, i) => (
          <li key={`c${i}`} className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
            <span className="mr-1.5 font-semibold">~ Changed</span>
            {c.unit}
            {c.what && c.what.toLowerCase() !== c.unit.toLowerCase() ? ` (${c.fromWhat ? `${c.fromWhat} → ` : ""}${c.what})` : ""}: <span className="font-semibold tabular-nums">{changeText(c.from, c.to)}</span>
          </li>
        ))}
      </ul>
      {diff.same > 0 && <p className="text-xs text-muted-foreground">{diff.same} row{diff.same === 1 ? "" : "s"} unchanged.</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// "Other scope": the agreement's scope text that isn't itemised as rows
// (paragraphs, exclusions, " * " items). Edited with the rows, saved on the brand.
// ---------------------------------------------------------------------------

export const OTHER_SCOPE_MAX = 10_000;

/** The editable "Other scope (not itemised)" box under the scope rows. */
export function OtherScopeField({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>Other scope (not itemised)</Label>
        <span className="text-xs text-muted-foreground tabular-nums">{value.length.toLocaleString()} / {OTHER_SCOPE_MAX.toLocaleString()}</span>
      </div>
      <Textarea
        id={id}
        rows={6}
        className="max-h-80 font-normal"
        value={value}
        maxLength={OTHER_SCOPE_MAX}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Scope from the agreement that isn't a row: services, exclusions, conditions…"
      />
      <p className="text-xs text-muted-foreground">Kept with the scope as written. What it covers isn’t counted as missing from the rows.</p>
    </div>
  );
}

/** The saved "Other scope" text, read-only. */
export function OtherScopeText({ text, className }: { text: string; className?: string }) {
  if (!text.trim()) return null;
  return (
    <div className={cn("space-y-1", className)}>
      <p className="text-sm font-medium">Other scope (not itemised)</p>
      <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg border bg-muted/30 px-3 py-2 text-sm">{text}</div>
    </div>
  );
}

/** "Other scope changed": before / after. */
export function OtherScopeChange({ from, to, className }: { from: string; to: string; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <p className="text-sm font-medium">Other scope changed</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="min-w-0">
          <p className="mb-1 text-xs font-medium text-muted-foreground">Before</p>
          <div className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded-md border border-red-300 bg-red-50 px-2 py-1 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200">
            {from.trim() || "—"}
          </div>
        </div>
        <div className="min-w-0">
          <p className="mb-1 text-xs font-medium text-muted-foreground">After</p>
          <div className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200">
            {to.trim() || "—"}
          </div>
        </div>
      </div>
    </div>
  );
}
