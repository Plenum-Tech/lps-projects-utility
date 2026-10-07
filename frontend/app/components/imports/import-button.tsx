import { useEffect, useRef, useState } from "react";
import { LuFileUp, LuLoaderCircle } from "react-icons/lu";

import { ImportDialog } from "@/components/imports/import-dialog";
import { Button } from "@/components/ui/button";
import { toast as toastManager } from "@/components/ui/toast";
import { useImportJob } from "@/hooks/use-imports";
import { plural, progressPercent, readBackgroundJob, writeBackgroundJob } from "@/lib/imports";
import type { ImportType } from "@/types";

/**
 * Toolbar "Import" button + dialog. While a run continues in the background it
 * shows the progress, and toasts (with "View results") when the run finishes.
 */
export function ImportButton({
  type,
  defaultProjectId,
  disabled,
}: {
  type: ImportType;
  defaultProjectId?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [resumeJobId, setResumeJobId] = useState<string | null>(null);
  const [backgroundJobId, setBackgroundJobId] = useState<string | null>(null);

  // Pick up a run that was sent to the background before a page change.
  useEffect(() => {
    setBackgroundJobId(readBackgroundJob(type));
  }, [type]);

  const watched = useImportJob(backgroundJobId, Boolean(backgroundJobId));
  const job = watched.data;
  const notified = useRef<string | null>(null);

  useEffect(() => {
    if (!backgroundJobId) return;
    const status = (watched.error as { response?: { status?: number } } | null)?.response?.status;
    if (watched.isError && (status === 401 || status === 403 || status === 404)) {
      // Gone (or another user's) — stop watching. Other errors are transient; keep polling.
      writeBackgroundJob(type, null);
      setBackgroundJobId(null);
      return;
    }
    if (!job || job.status === "running" || notified.current === job.id) return;
    notified.current = job.id;
    writeBackgroundJob(type, null);
    setBackgroundJobId(null);
    if (open) return; // The dialog already shows the result.
    const failed = job.status === "failed";
    toastManager.add({
      type: failed ? "error" : job.totals.errors > 0 ? "warning" : "success",
      title: failed ? "Import stopped before it finished" : `Import finished — ${plural(job.totals.created, type)} created`,
      description: [
        job.totals.updated > 0 ? `${job.totals.updated} updated` : null,
        job.totals.skipped > 0 ? `${job.totals.skipped} skipped` : null,
        job.totals.errors > 0 ? `${job.totals.errors} with errors` : null,
      ]
        .filter(Boolean)
        .join(" · ") || job.fileName,
      timeout: 15_000,
      actionProps: {
        children: "View results",
        onClick: () => {
          setResumeJobId(job.id);
          setOpen(true);
        },
      },
    });
  }, [backgroundJobId, job, watched.isError, watched.error, open, type]);

  const runningInBackground = Boolean(backgroundJobId) && (!job || job.status === "running");
  const percent = job ? progressPercent(job) : 0;

  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          setResumeJobId(runningInBackground ? backgroundJobId : null);
          setOpen(true);
        }}
        disabled={disabled}
      >
        {runningInBackground ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuFileUp aria-hidden />}
        {runningInBackground ? (
          <>
            Importing <span className="tabular-nums">{percent}%</span>
          </>
        ) : (
          "Import"
        )}
      </Button>
      <ImportDialog
        type={type}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setResumeJobId(null);
        }}
        defaultProjectId={defaultProjectId}
        resumeJobId={resumeJobId}
        onBackground={(jobId) => {
          writeBackgroundJob(type, jobId);
          notified.current = null;
          setBackgroundJobId(jobId);
        }}
      />
    </>
  );
}
