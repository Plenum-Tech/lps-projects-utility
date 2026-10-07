import { useState } from "react";
import {
  LuCircleAlert,
  LuDownload,
  LuLoaderCircle,
  LuRotateCcw,
  LuUndo2,
} from "react-icons/lu";

import { ConfirmDialog } from "@/components/globals/confirm-dialog";
import { ImportRowsGrid, TotalsLine } from "@/components/imports/import-rows";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useDownloadImportErrors, useUndoImport } from "@/hooks/use-imports";
import { formatDateTime } from "@/lib/format";
import { IMPORT_NOUN, plural, progressPercent } from "@/lib/imports";
import type { ImportJob } from "@/types";

/** Step 4 — background run with a polled progress bar. */
export function ProgressStep({ job }: { job: ImportJob }) {
  const percent = progressPercent(job);
  const { processed, total } = job.progress;
  return (
    <div className="space-y-4 py-4">
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <p id="import-progress-label" className="text-sm font-medium text-foreground">
            Importing {IMPORT_NOUN[job.type].many}…
          </p>
          <p className="text-sm text-muted-foreground tabular-nums" aria-hidden>
            {percent}%
          </p>
        </div>
        <Progress value={percent} aria-labelledby="import-progress-label" />
        <p className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
          {processed.toLocaleString()} of {total.toLocaleString()} rows processed
        </p>
      </div>
      <p className="rounded-xl bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
        This runs on the server. You can choose “Run in background & close” — the Import button shows the
        progress and you&apos;ll get a notification here when it finishes.
      </p>
    </div>
  );
}

/** Step 5 — summary, record links, error report and Undo (24 h). */
export function ResultStep({ job, onNavigate }: { job: ImportJob; onNavigate?: () => void }) {
  const errors = useDownloadImportErrors();
  const undo = useUndoImport();
  const [confirmUndo, setConfirmUndo] = useState(false);
  const { totals } = job;
  const rows = job.rows ?? [];

  return (
    <div className="space-y-4">
      {job.status === "failed" && (
        <Alert variant="destructive">
          <LuCircleAlert aria-hidden className="size-4" />
          <AlertTitle>The import stopped before it finished</AlertTitle>
          <AlertDescription>
            {job.error ?? "The server stopped processing this file."} Records created before it stopped are listed
            below{job.canUndo ? " and can still be undone" : ""}.
          </AlertDescription>
        </Alert>
      )}

      <div className="space-y-1">
        <p className="text-base font-semibold text-foreground">
          {job.status === "undone"
            ? "Import undone"
            : `${plural(totals.created, job.type)} created${
                totals.updated > 0 ? `, ${totals.updated.toLocaleString()} updated` : ""
              }${totals.skipped > 0 ? `, ${totals.skipped.toLocaleString()} skipped` : ""}`}
        </p>
        <TotalsLine
          parts={[
            { label: "created", count: totals.created, dot: "bg-primary" },
            ...(job.type === "projects" ? [{ label: "updated", count: totals.updated, dot: "bg-chart-2" }] : []),
            { label: "skipped", count: totals.skipped, dot: "bg-muted-foreground" },
            { label: totals.errors === 1 ? "error" : "errors", count: totals.errors, dot: "bg-destructive" },
          ]}
        />
      </div>

      {job.status === "undone" && <UndoSummary job={job} />}

      <div className="flex flex-wrap items-center gap-2">
        {job.hasErrorReport && (
          <Button variant="outline" size="sm" onClick={() => errors.mutate(job)} disabled={errors.isPending}>
            {errors.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuDownload aria-hidden />}
            Download error report
          </Button>
        )}
        {job.canUndo && job.status !== "undone" && (
          <Button variant="outline" size="sm" onClick={() => setConfirmUndo(true)} disabled={undo.isPending}>
            <LuUndo2 aria-hidden />
            Undo import
          </Button>
        )}
        {job.canUndo && job.undoUntil && job.status !== "undone" && (
          <span className="text-xs text-muted-foreground">Undo available until {formatDateTime(job.undoUntil)}</span>
        )}
      </div>

      {rows.length > 0 ? (
        <ImportRowsGrid
          rows={rows}
          type={job.type}
          mode="run"
          onNavigate={onNavigate}
          linkRecords={job.status !== "undone"}
        />
      ) : (
        <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
          {job.status === "running" ? "Loading row results…" : "No row results were kept for this import."}
        </p>
      )}

      <ConfirmDialog
        open={confirmUndo}
        onOpenChange={setConfirmUndo}
        pending={undo.isPending}
        destructive
        title="Undo this import?"
        description={`Deletes the ${plural(job.createdCount, job.type)} this import created, unless they've been edited since. Updated projects and new categories or labels are kept.`}
        confirmLabel="Undo import"
        icon={<LuRotateCcw aria-hidden />}
        onConfirm={() => undo.mutate(job.id, { onSettled: () => setConfirmUndo(false) })}
      />
    </div>
  );
}

function UndoSummary({ job }: { job: ImportJob }) {
  if (!job.undoResult) {
    return (
      <div className="space-y-2 rounded-xl border p-3" role="status">
        <p className="text-sm text-foreground">Removing imported records in the background…</p>
        <Progress value={null} aria-label="Undo in progress" />
      </div>
    );
  }
  const { deleted, skipped } = job.undoResult;
  return (
    <div className="space-y-2 rounded-xl border p-3">
      <p className="text-sm text-foreground">
        <span className="font-semibold tabular-nums">{deleted.toLocaleString()}</span> removed
        {skipped.length > 0 && (
          <>
            {" · "}
            <span className="font-semibold tabular-nums">{skipped.length.toLocaleString()}</span> kept because they
            changed since the import
          </>
        )}
        {job.undoneAt ? <span className="text-muted-foreground"> · {formatDateTime(job.undoneAt)}</span> : null}
      </p>
      {skipped.length > 0 && (
        <ul className="max-h-32 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
          {skipped.map((item) => (
            <li key={item.id}>
              <span className="font-medium text-foreground">{item.ref ?? item.id}</span> — {item.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
