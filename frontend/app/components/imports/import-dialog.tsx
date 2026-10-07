import { useEffect, useRef, useState } from "react";
import {
  LuArrowLeft,
  LuArrowRight,
  LuCircleAlert,
  LuEye,
  LuLoaderCircle,
  LuMinimize2,
  LuUpload,
} from "react-icons/lu";

import { MappingStep } from "@/components/imports/mapping-step";
import { importableCount, PreviewStep } from "@/components/imports/preview-step";
import { ProgressStep, ResultStep } from "@/components/imports/result-step";
import { UploadStep } from "@/components/imports/upload-step";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCurrentUser } from "@/hooks/use-auth";
import {
  useImportJob,
  usePreviewImport,
  useRunImport,
  useValidateImport,
} from "@/hooks/use-imports";
import { getErrorMessage } from "@/lib/api";
import {
  IMPORT_NOUN,
  duplicateTargets,
  initialMapping,
  missingRequired,
  rememberMapping,
} from "@/lib/imports";
import { cn } from "@/lib/utils";
import type { ImportJob, ImportMapping, ImportOptions, ImportPreviewResponse, ImportType, Role } from "@/types";

type Step = "upload" | "map" | "preview" | "import" | "result";

const STEPS: { id: Step; label: string }[] = [
  { id: "upload", label: "Upload" },
  { id: "map", label: "Map" },
  { id: "preview", label: "Preview" },
  { id: "import", label: "Import" },
  { id: "result", label: "Result" },
];

const DESCRIPTIONS: Record<Step, string> = {
  upload: "Bring in an Excel workbook or a CSV file — nothing is saved until you confirm the import.",
  map: "Tell LPS which column holds what. Matching headers are picked for you.",
  preview: "Every row has been checked. Rows with errors are skipped; warnings import with defaults.",
  import: "Your file is being imported.",
  result: "Here's what happened to each row.",
};

function defaultOptions(type: ImportType, defaultProjectId?: string): ImportOptions {
  return type === "projects"
    ? { onExisting: "skip", skipUnknownPeople: false }
    : { defaultProject: defaultProjectId ?? null, sendEmails: false, skipUnknownPeople: false };
}

/**
 * Import stepper: Upload → Map → Preview → Import → Result. Runs over 200 rows
 * continue on the server; "Run in background & close" hands the job to the
 * toolbar button (`onBackground`), which keeps polling.
 */
export function ImportDialog({
  type,
  open,
  onOpenChange,
  defaultProjectId,
  resumeJobId,
  onBackground,
}: {
  type: ImportType;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Tasks opened from a project's Tasks tab. */
  defaultProjectId?: string;
  /** Re-open an existing job at its progress / result. */
  resumeJobId?: string | null;
  onBackground?: (jobId: string) => void;
}) {
  const { data: user } = useCurrentUser();
  const me = { _id: user?._id ?? "", role: (user?.role ?? "employee") as Role };

  const previewMutation = usePreviewImport();
  const validateMutation = useValidateImport();
  const runMutation = useRunImport();

  const [step, setStep] = useState<Step>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [mapping, setMapping] = useState<ImportMapping>({});
  const [remembered, setRemembered] = useState(0);
  const [options, setOptions] = useState<ImportOptions>(() => defaultOptions(type, defaultProjectId));
  const [validated, setValidated] = useState<ImportJob | null>(null);
  const [runJobId, setRunJobId] = useState<string | null>(null);
  const validateSeq = useRef(0);

  const jobQuery = useImportJob(runJobId, open && Boolean(runJobId));
  const runJob = jobQuery.data ?? null;

  const { reset: resetPreview } = previewMutation;
  const { reset: resetValidate } = validateMutation;
  const { reset: resetRun } = runMutation;
  useEffect(() => {
    if (!open) return;
    setFile(null);
    setPreview(null);
    setMapping({});
    setRemembered(0);
    setOptions(defaultOptions(type, defaultProjectId));
    setValidated(null);
    setRunJobId(resumeJobId ?? null);
    setStep(resumeJobId ? "import" : "upload");
    resetPreview();
    resetValidate();
    resetRun();
  }, [open, type, defaultProjectId, resumeJobId, resetPreview, resetValidate, resetRun]);

  // Background run finished → show the result.
  useEffect(() => {
    if (step === "import" && runJob && runJob.status !== "running") setStep("result");
  }, [step, runJob]);

  const running = step === "import" && (!runJob || runJob.status === "running");
  const busy = runMutation.isPending || running;

  function applyPreview(data: ImportPreviewResponse) {
    setPreview(data);
    const start = initialMapping(me._id, type, data.columns, data.fields, data.suggestedMapping);
    setMapping(start.mapping);
    setRemembered(start.remembered);
    setValidated(null);
    resetValidate();
  }

  function upload(next: File) {
    setFile(next);
    setPreview(null);
    previewMutation.mutate({ type, file: next }, { onSuccess: applyPreview });
  }

  function reread(change: { sheet?: string; headerRow?: boolean }) {
    if (!preview) return;
    previewMutation.mutate(
      {
        type,
        jobId: preview.jobId,
        sheet: change.sheet ?? preview.sheet,
        headerRow: change.headerRow ?? preview.headerRow,
      },
      { onSuccess: applyPreview }
    );
  }

  function validate(nextOptions: ImportOptions, thenStep?: Step) {
    if (!preview) return;
    const seq = ++validateSeq.current;
    validateMutation.mutate(
      { jobId: preview.jobId, mapping, options: nextOptions },
      {
        onSuccess: (job) => {
          if (seq !== validateSeq.current) return;
          setValidated(job);
          rememberMapping(me._id, type, preview.columns, mapping);
          if (thenStep) setStep(thenStep);
        },
      }
    );
  }

  function changeOptions(next: ImportOptions) {
    setOptions(next);
    validate(next);
  }

  function run() {
    if (!preview) return;
    runMutation.mutate(
      { jobId: preview.jobId, mapping, options },
      {
        onSuccess: ({ job, background }) => {
          setRunJobId(job.id);
          setStep(background ? "import" : "result");
        },
      }
    );
  }

  function sendToBackground() {
    if (runJobId) onBackground?.(runJobId);
    onOpenChange(false);
  }

  const missing = preview ? missingRequired(preview.fields, mapping) : [];
  const hasDupes = duplicateTargets(mapping).size > 0;
  const importable = validated ? importableCount(validated) : 0;
  const stepIndex = STEPS.findIndex((item) => item.id === step);
  const noun = IMPORT_NOUN[type];

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && !previewMutation.isPending && onOpenChange(next)}>
      <DialogContent
        showCloseButton={!busy}
        className="flex h-dvh max-h-dvh w-full max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:max-w-3xl sm:rounded-xl"
      >
        <DialogHeader className="border-b px-4 pt-4 pb-3 sm:px-6">
          <DialogTitle className="pr-8">Import {noun.many}</DialogTitle>
          <DialogDescription>{DESCRIPTIONS[step]}</DialogDescription>
          <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-xs" aria-label="Steps">
            {STEPS.map((item, index) => {
              const active = index === stepIndex;
              const done = index < stepIndex;
              return (
                <li key={item.id} className="flex items-center gap-2">
                  {index > 0 && <span aria-hidden className="h-px w-3 bg-border sm:w-5" />}
                  <span
                    aria-current={active ? "step" : undefined}
                    className={cn(
                      "inline-flex items-center gap-1.5 font-medium",
                      active ? "text-foreground" : "text-muted-foreground"
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-5 items-center justify-center rounded-full text-[0.65rem] tabular-nums",
                        active || done ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                      )}
                    >
                      {index + 1}
                    </span>
                    <span className={cn(!active && "hidden sm:inline")}>{item.label}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          {step === "upload" && (
            <UploadStep
              type={type}
              file={file}
              preview={preview}
              pending={previewMutation.isPending}
              error={previewMutation.isError ? getErrorMessage(previewMutation.error) : null}
              onFile={upload}
              onClear={() => {
                setFile(null);
                setPreview(null);
                resetPreview();
              }}
              onSheet={(sheet) => reread({ sheet })}
              onHeaderRow={(headerRow) => reread({ headerRow })}
            />
          )}

          {step === "map" && preview && (
            <div className="space-y-4">
              <MappingStep
                preview={preview}
                mapping={mapping}
                onChange={(next) => {
                  setMapping(next);
                  setValidated(null);
                }}
                rememberedCount={remembered}
              />
              <MutationError title="Couldn't check the rows" error={validateMutation.isError ? validateMutation.error : null} />
            </div>
          )}

          {step === "preview" && validated && (
            <div className="space-y-4">
              <PreviewStep
                job={validated}
                type={type}
                options={options}
                onOptions={changeOptions}
                validating={validateMutation.isPending}
                me={me}
                defaultProjectLocked={Boolean(defaultProjectId)}
              />
              <MutationError title="Couldn't check the rows" error={validateMutation.isError ? validateMutation.error : null} />
              <MutationError title="The import didn't start" error={runMutation.isError ? runMutation.error : null} />
            </div>
          )}

          {step === "import" &&
            (runJob ? (
              <ProgressStep job={runJob} />
            ) : jobQuery.isError ? (
              <MutationError title="Couldn't load this import" error={jobQuery.error} />
            ) : (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground" role="status">
                <LuLoaderCircle aria-hidden className="size-4 animate-spin" />
                Loading import…
              </div>
            ))}

          {step === "result" && runJob && <ResultStep job={runJob} onNavigate={() => onOpenChange(false)} />}
        </div>

        <DialogFooter className="m-0 rounded-none border-t bg-muted/30 px-4 py-3 sm:px-6">
          {step === "upload" && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={previewMutation.isPending}>
                Cancel
              </Button>
              <Button onClick={() => setStep("map")} disabled={!preview || previewMutation.isPending}>
                Next: map columns
                <LuArrowRight aria-hidden />
              </Button>
            </>
          )}
          {step === "map" && (
            <>
              <Button variant="outline" onClick={() => setStep("upload")} disabled={validateMutation.isPending}>
                <LuArrowLeft aria-hidden />
                Back
              </Button>
              <Button
                onClick={() => validate(options, "preview")}
                disabled={missing.length > 0 || hasDupes || validateMutation.isPending}
              >
                {validateMutation.isPending ? (
                  <LuLoaderCircle aria-hidden className="animate-spin" />
                ) : (
                  <LuEye aria-hidden />
                )}
                {validateMutation.isPending ? "Checking rows…" : "Next: preview"}
              </Button>
            </>
          )}
          {step === "preview" && (
            <>
              <Button variant="outline" onClick={() => setStep("map")} disabled={runMutation.isPending}>
                <LuArrowLeft aria-hidden />
                Back
              </Button>
              <Button
                onClick={run}
                disabled={importable === 0 || validateMutation.isPending || runMutation.isPending}
              >
                {runMutation.isPending ? (
                  <LuLoaderCircle aria-hidden className="animate-spin" />
                ) : (
                  <LuUpload aria-hidden />
                )}
                {runMutation.isPending
                  ? "Importing…"
                  : `Import ${importable.toLocaleString()} ${importable === 1 ? noun.one : noun.many}`}
              </Button>
            </>
          )}
          {step === "import" && (
            <Button variant="outline" onClick={sendToBackground} disabled={!runJobId}>
              <LuMinimize2 aria-hidden />
              Run in background &amp; close
            </Button>
          )}
          {step === "result" && <Button onClick={() => onOpenChange(false)}>Done</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MutationError({ title, error }: { title: string; error: unknown }) {
  if (!error) return null;
  return (
    <Alert variant="destructive">
      <LuCircleAlert aria-hidden className="size-4" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{getErrorMessage(error)}</AlertDescription>
    </Alert>
  );
}
