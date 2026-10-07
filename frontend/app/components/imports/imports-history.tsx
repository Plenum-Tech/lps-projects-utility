import { useEffect, useId, useState } from "react";
import {
  LuDownload,
  LuEye,
  LuFileSpreadsheet,
  LuFileUp,
  LuLoaderCircle,
  LuRotateCcw,
  LuUndo2,
} from "react-icons/lu";

import { ConfirmDialog } from "@/components/globals/confirm-dialog";
import { DataTablePager } from "@/components/globals/data-table/pagination";
import { EmptyState, QueryError } from "@/components/globals/query-states";
import { ImportDialog } from "@/components/imports/import-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useDownloadImportErrors, useImports, useUndoImport } from "@/hooks/use-imports";
import { formatDateTime } from "@/lib/format";
import { JOB_STATUS_META, plural } from "@/lib/imports";
import { formatBytes } from "@/lib/meetings";
import type { ImportJob, ImportType } from "@/types";

/** Settings → Imports (admin): every import, error reports and undo. */
export function ImportsHistorySection() {
  const id = useId();
  const [type, setType] = useState<ImportType | "">("");
  const [mine, setMine] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [viewing, setViewing] = useState<ImportJob | null>(null);
  const [undoing, setUndoing] = useState<ImportJob | null>(null);

  useEffect(() => setPage(1), [type, mine, pageSize]);

  const imports = useImports({ type, mine, limit: pageSize, offset: (page - 1) * pageSize });
  const errors = useDownloadImportErrors();
  const undo = useUndoImport();
  const items = imports.data?.imports ?? [];
  const total = imports.data?.total ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LuFileUp aria-hidden className="size-4 text-muted-foreground" />
          Import history
        </CardTitle>
        <CardDescription>
          Project and task imports from Excel or CSV. Download the rows that failed, or undo an import within 24
          hours — records edited since the import are kept.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-type`}>Type</Label>
            <NativeSelect
              id={`${id}-type`}
              value={type}
              onChange={(event) => setType(event.target.value as ImportType | "")}
              className="w-40"
            >
              <NativeSelectOption value="">All imports</NativeSelectOption>
              <NativeSelectOption value="projects">Projects</NativeSelectOption>
              <NativeSelectOption value="tasks">Tasks</NativeSelectOption>
            </NativeSelect>
          </div>
          <div className="flex h-8 items-center gap-2">
            <Switch id={`${id}-mine`} checked={mine} onCheckedChange={setMine} />
            <Label htmlFor={`${id}-mine`} className="cursor-pointer">
              Only mine
            </Label>
          </div>
        </div>

        {imports.isPending ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading imports">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        ) : imports.isError ? (
          <QueryError
            title="Couldn't load imports"
            error={imports.error}
            onRetry={() => void imports.refetch()}
            retrying={imports.isRefetching}
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={LuFileSpreadsheet}
            title={type || mine ? "No matching imports" : "No imports yet"}
            description="Use Import on the Projects or Tasks page to bring in a spreadsheet. Every run shows up here."
          />
        ) : (
          <div className={imports.isPlaceholderData ? "opacity-60 transition-opacity" : undefined}>
            <ul className="divide-y rounded-xl border">
              {items.map((job) => (
                <ImportHistoryRow
                  key={job.id}
                  job={job}
                  onView={() => setViewing(job)}
                  onErrors={() => errors.mutate(job)}
                  errorsPending={errors.isPending && errors.variables?.id === job.id}
                  onUndo={() => setUndoing(job)}
                />
              ))}
            </ul>
            <DataTablePager
              className="mt-3"
              page={page}
              pageSize={pageSize}
              total={total}
              shown={items.length}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              noun="imports"
            />
          </div>
        )}
      </CardContent>

      {viewing && (
        <ImportDialog
          type={viewing.type}
          open
          resumeJobId={viewing.id}
          onOpenChange={(open) => !open && setViewing(null)}
        />
      )}

      <ConfirmDialog
        open={undoing !== null}
        onOpenChange={(open) => !open && setUndoing(null)}
        pending={undo.isPending}
        destructive
        title="Undo this import?"
        description={
          undoing
            ? `Deletes the ${plural(undoing.createdCount, undoing.type)} created from “${undoing.fileName}”, unless they've been edited since. Updated projects and new categories or labels are kept.`
            : ""
        }
        confirmLabel="Undo import"
        icon={<LuRotateCcw aria-hidden />}
        onConfirm={() => undoing && undo.mutate(undoing.id, { onSettled: () => setUndoing(null) })}
      />
    </Card>
  );
}

function ImportHistoryRow({
  job,
  onView,
  onErrors,
  errorsPending,
  onUndo,
}: {
  job: ImportJob;
  onView: () => void;
  onErrors: () => void;
  errorsPending: boolean;
  onUndo: () => void;
}) {
  const status = JOB_STATUS_META[job.status];
  const undoRunning = job.status === "undone" && !job.undoResult;
  const ran = job.status !== "previewed";
  const { totals } = job;
  return (
    <li className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium text-foreground">{job.fileName}</p>
          <Badge variant="outline" className="capitalize">
            {job.type}
          </Badge>
          <Badge variant={status.badge}>
            {(job.status === "running" || undoRunning) && <LuLoaderCircle aria-hidden className="animate-spin" />}
            {undoRunning ? "Undoing" : status.label}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {job.createdBy.name ?? "Unknown user"} · {formatDateTime(job.finishedAt ?? job.createdAt)} ·{" "}
          {formatBytes(job.fileSize)} · {job.rowCount.toLocaleString()} rows
        </p>
        {ran && (
          <p className="text-xs text-muted-foreground tabular-nums">
            {job.status === "running"
              ? `${job.progress.processed.toLocaleString()} of ${job.progress.total.toLocaleString()} processed`
              : [
                  `${totals.created} created`,
                  totals.updated > 0 ? `${totals.updated} updated` : null,
                  totals.skipped > 0 ? `${totals.skipped} skipped` : null,
                  totals.errors > 0 ? `${totals.errors} errors` : null,
                  job.undoResult ? `${job.undoResult.deleted} removed by undo` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {ran && job.status !== "running" && (
          <Button variant="ghost" size="sm" onClick={onView}>
            <LuEye aria-hidden />
            Details
          </Button>
        )}
        {job.hasErrorReport && (
          <Button variant="outline" size="sm" onClick={onErrors} disabled={errorsPending}>
            {errorsPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuDownload aria-hidden />}
            Errors
          </Button>
        )}
        {job.canUndo && job.status !== "undone" && (
          <Button variant="outline" size="sm" onClick={onUndo}>
            <LuUndo2 aria-hidden />
            Undo
          </Button>
        )}
      </div>
    </li>
  );
}
