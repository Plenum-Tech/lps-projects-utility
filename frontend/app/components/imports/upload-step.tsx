import { useId, useRef, useState, type DragEvent } from "react";
import {
  LuCircleAlert,
  LuDownload,
  LuFileSpreadsheet,
  LuLoaderCircle,
  LuUpload,
  LuX,
} from "react-icons/lu";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { useDownloadImportTemplate } from "@/hooks/use-imports";
import {
  IMPORT_ACCEPT,
  IMPORT_EXTENSIONS,
  IMPORT_NOUN,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  fileExtension,
} from "@/lib/imports";
import { formatBytes } from "@/lib/meetings";
import { cn } from "@/lib/utils";
import type { ImportPreviewResponse, ImportType } from "@/types";

/**
 * Step 1 — pick a file (drag & drop or browse), then the sheet and whether the
 * first row holds headers. The parent uploads as soon as a file is chosen.
 */
export function UploadStep({
  type,
  file,
  preview,
  pending,
  error,
  onFile,
  onClear,
  onSheet,
  onHeaderRow,
}: {
  type: ImportType;
  file: File | null;
  preview: ImportPreviewResponse | null;
  pending: boolean;
  error: string | null;
  onFile: (file: File) => void;
  onClear: () => void;
  onSheet: (sheet: string) => void;
  onHeaderRow: (headerRow: boolean) => void;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const template = useDownloadImportTemplate();

  function pick(next: File | null | undefined) {
    if (!next) return;
    const ext = fileExtension(next.name);
    if (!(IMPORT_EXTENSIONS as readonly string[]).includes(ext)) {
      setLocalError("Use an Excel workbook (.xlsx) or a .csv file. Older .xls files: save as .xlsx first.");
      return;
    }
    if (next.size > MAX_IMPORT_BYTES) {
      setLocalError(`That file is ${formatBytes(next.size)} — the limit is 5 MB.`);
      return;
    }
    setLocalError(null);
    onFile(next);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    pick(event.dataTransfer.files?.[0]);
  }

  const message = localError ?? error;

  return (
    <div className="space-y-4">
      {file ? (
        <div className="flex items-center gap-3 rounded-xl border bg-muted/30 p-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background ring-1 ring-border">
            {pending ? (
              <LuLoaderCircle aria-hidden className="size-4 animate-spin text-muted-foreground" />
            ) : (
              <LuFileSpreadsheet aria-hidden className="size-4 text-muted-foreground" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">{file.name}</p>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {formatBytes(file.size)}
              {pending
                ? " · Reading…"
                : preview
                  ? ` · ${preview.rowCount.toLocaleString()} row${preview.rowCount === 1 ? "" : "s"} · ${preview.columns.length} column${preview.columns.length === 1 ? "" : "s"}`
                  : ""}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClear}
            disabled={pending}
            aria-label={`Remove ${file.name}`}
          >
            <LuX aria-hidden />
          </Button>
        </div>
      ) : (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={cn(
            "flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-10 text-center transition-colors duration-150 ease-out",
            dragOver ? "border-ring bg-primary/5" : "bg-muted/30"
          )}
        >
          <span className="flex size-10 items-center justify-center rounded-lg bg-background text-muted-foreground ring-1 ring-border">
            <LuUpload aria-hidden className="size-4" />
          </span>
          <p className="text-sm text-foreground">
            Drag a spreadsheet here or{" "}
            <button
              type="button"
              className="font-medium text-primary underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
              onClick={() => inputRef.current?.click()}
            >
              browse
            </button>
          </p>
          <p className="text-xs text-muted-foreground">
            .xlsx or .csv · up to 5 MB and {MAX_IMPORT_ROWS.toLocaleString()} rows
          </p>
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={IMPORT_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose a spreadsheet"
        onChange={(event) => {
          pick(event.target.files?.[0]);
          event.target.value = "";
        }}
      />

      {message && (
        <Alert variant="destructive">
          <LuCircleAlert aria-hidden className="size-4" />
          <AlertTitle>Couldn&apos;t read this file</AlertTitle>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      {preview && (
        <div className="grid gap-4 rounded-xl border p-3 sm:grid-cols-2">
          {preview.sheets.length > 1 ? (
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor={`${id}-sheet`}>Sheet</Label>
              <NativeSelect
                id={`${id}-sheet`}
                className="w-full"
                value={preview.sheet ?? preview.sheets[0]}
                onChange={(event) => onSheet(event.target.value)}
                disabled={pending}
              >
                {preview.sheets.map((sheet) => (
                  <NativeSelectOption key={sheet} value={sheet}>
                    {sheet}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          ) : (
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-foreground">Sheet</p>
              <p className="text-sm text-muted-foreground">
                {preview.format === "csv" ? "CSV file — one sheet" : (preview.sheet ?? preview.sheets[0] ?? "—")}
              </p>
            </div>
          )}
          <div className="flex items-start gap-3">
            <Switch
              id={`${id}-header`}
              checked={preview.headerRow}
              onCheckedChange={(checked) => onHeaderRow(checked)}
              disabled={pending}
              className="mt-0.5"
            />
            <div className="space-y-0.5">
              <Label htmlFor={`${id}-header`} className="cursor-pointer">
                First row is a header row
              </Label>
              <p className="text-xs text-muted-foreground">
                Turn off when the file starts straight with data.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/30 px-3 py-2.5">
        <p className="text-xs text-muted-foreground">
          Not sure about the columns? Start from the template — it has an example {IMPORT_NOUN[type].one} and
          an Instructions sheet.
        </p>
        <Button variant="outline" size="sm" onClick={() => template.mutate(type)} disabled={template.isPending}>
          {template.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuDownload aria-hidden />}
          Download template
        </Button>
      </div>
    </div>
  );
}
