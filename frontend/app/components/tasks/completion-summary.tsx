import { useState } from "react";
import { LuCircleCheck, LuExternalLink, LuLoaderCircle, LuTimer } from "react-icons/lu";

import { OutcomeReadinessBadge } from "@/components/tasks/outcome-readiness";
import { useTaskFiles, viewTaskFile } from "@/hooks/use-tasks";
import { formatDateTime } from "@/lib/format";
import { formatEffort } from "@/lib/tasks";
import type { Task } from "@/types";

/**
 * "Completion" box on the task page: what was entered when the task was
 * marked complete — the final file or link, the outcome note, the time spent
 * and when / by whom it was completed.
 */
export function CompletionSummary({ task }: { task: Task }) {
  const finalFileId = task.finalFile?.fileId ?? null;
  const finalUrl = task.finalFile?.url ?? null;
  const files = useTaskFiles(finalFileId ? task._id : null);
  const finalFile = finalFileId ? files.data?.files.find((f) => f._id === finalFileId) : undefined;
  const [downloading, setDownloading] = useState(false);

  const completed = task.status === "completed";
  if (!completed && !finalFileId && !finalUrl && !task.submissionNotes) return null;

  return (
    <section
      aria-labelledby="task-completion-heading"
      className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3 sm:p-4"
    >
      <h3
        id="task-completion-heading"
        className="flex flex-wrap items-center gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase"
      >
        <LuCircleCheck aria-hidden className="size-4 text-primary" />
        {completed ? "Completion" : "Submitted"}
        {(task.completedAt ?? task.submittedAt) && (
          <span className="font-normal tracking-normal normal-case">
            · {formatDateTime(task.completedAt ?? task.submittedAt ?? null)}
            {completed && task.reviewedBy?.name ? ` by ${task.reviewedBy.name}` : ""}
          </span>
        )}
      </h3>

      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div className="space-y-0.5">
          <dt className="text-xs text-muted-foreground">Final file / link</dt>
          <dd className="min-w-0">
            {finalUrl ? (
              <a
                href={finalUrl}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="inline-flex max-w-full items-center gap-1 break-all text-primary underline underline-offset-2"
              >
                {finalUrl}
                <LuExternalLink aria-hidden className="size-3.5 shrink-0" />
              </a>
            ) : finalFileId ? (
              finalFile ? (
                <button
                  type="button"
                  disabled={downloading}
                  onClick={async () => {
                    setDownloading(true);
                    try {
                      await viewTaskFile(task._id, finalFile);
                    } finally {
                      setDownloading(false);
                    }
                  }}
                  className="inline-flex max-w-full items-center gap-1 break-all text-primary underline underline-offset-2"
                >
                  {downloading ? (
                    <LuLoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin" />
                  ) : (
                    <LuExternalLink aria-hidden className="size-3.5 shrink-0" />
                  )}
                  {finalFile.filename}
                </button>
              ) : (
                <span className="text-muted-foreground">{files.isPending ? "Loading…" : "File attached"}</span>
              )
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </dd>
        </div>
        <div className="space-y-0.5">
          <dt className="text-xs text-muted-foreground">Time spent</dt>
          <dd className="inline-flex items-center gap-1 tabular-nums">
            <LuTimer aria-hidden className="size-3.5 text-muted-foreground" />
            {formatEffort(task.loggedMinutes ?? 0)}
          </dd>
        </div>
        <div className="space-y-0.5 sm:col-span-2">
          <dt className="text-xs text-muted-foreground">Outcome note</dt>
          <dd className="break-words whitespace-pre-wrap">
            {task.submissionNotes?.trim() ? task.submissionNotes : <span className="text-muted-foreground">—</span>}
          </dd>
        </div>
        {task.outcomeReadiness && (
          <div className="space-y-0.5 sm:col-span-2">
            <dt className="text-xs text-muted-foreground">Outcome readiness</dt>
            <dd>
              <OutcomeReadinessBadge result={task.outcomeReadiness} />
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}
