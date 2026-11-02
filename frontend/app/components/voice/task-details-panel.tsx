import { useState } from "react";
import { Link } from "react-router";
import { LuChevronDown, LuCircleAlert, LuExternalLink, LuFile, LuLink } from "react-icons/lu";

import { RichText } from "@/components/globals/rich-text";
import { ShortCode } from "@/components/projects/project-badges";
import { Skeleton } from "@/components/ui/skeleton";
import { useTask, useTaskFiles, useTaskLoggedTime, viewTaskFile } from "@/hooks/use-tasks";
import { formatDate } from "@/lib/format";
import { formatEffort, PRIORITY_META, STATUS_META } from "@/lib/tasks";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Task details in the voice chat, above a close / update / log time / comment
// card: what the task is before the person confirms. Loaded on the client from
// the existing task, files and logged-time endpoints (the chat reply stays small).
// ---------------------------------------------------------------------------

const MAX_FILES = 5;

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const todayKey = () => new Date().toISOString().slice(0, 10);

export function TaskDetailsPanel({
  taskId,
  defaultOpen,
  onOpenTask,
}: {
  taskId: string;
  /** Expanded for closing; collapsed for the other cards. */
  defaultOpen: boolean;
  /** Called when "Open full task" is followed (the sheet closes). */
  onOpenTask?: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [fullBrief, setFullBrief] = useState(false);
  const detail = useTask(taskId, true);
  const files = useTaskFiles(open ? taskId : null);
  const logged = useTaskLoggedTime(open ? taskId : null);
  const task = detail.data?.task;

  if (detail.isLoading) {
    return (
      <div className="rounded-2xl border bg-card p-3" aria-busy="true">
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  if (!task) return null;

  const due = task.dueDate?.slice(0, 10) ?? null;
  const overdue = Boolean(due && due < todayKey() && task.status !== "completed");
  const taskFiles = (files.data?.files ?? []).filter((f) => !f.subtask);
  const finalFile = task.finalFile?.fileId ? taskFiles.find((f) => f._id === task.finalFile!.fileId) : undefined;
  const subtasksDone = task.subtasks.filter((s) => s.done).length;
  const blocked = task.overScope?.status === "pending" || task.overScope?.status === "rejected";
  const direct = task.project?.requireTaskApproval === false;

  const row = (label: string, value: React.ReactNode) => (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );

  return (
    <section className="rounded-2xl border bg-card text-sm" aria-label={`Task details: ${task.title}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-2 px-3 py-2.5 text-left"
      >
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex items-start gap-1.5">
            {task.shortCode && <ShortCode code={task.shortCode} className="mt-px" />}
            <span className="font-medium [overflow-wrap:anywhere]">{task.title}</span>
          </span>
          <span className="text-xs text-muted-foreground">{open ? "Task details" : "Show task details"}</span>
        </span>
        <LuChevronDown aria-hidden className={cn("mt-1 size-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="grid gap-3 border-t px-3 py-3">
          {/* The same check the server makes before closing (blocked over the approved scope). */}
          {blocked && (
            <p role="alert" className="flex items-start gap-2 rounded-lg bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
              <LuCircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              {task.overScope!.status === "pending"
                ? `Beyond the approved scope (${task.overScope!.unit} ${task.titleParts?.quantity ?? "?"} of ${task.overScope!.allowed} approved) — it's blocked until an admin approves it, so it can't be closed yet.`
                : "An admin didn't approve this task beyond the scope, so it can't be worked on or closed."}
            </p>
          )}

          <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1">
            {task.project && row("Project", task.project.name)}
            {row(
              "Status",
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className={cn("size-2 rounded-full", STATUS_META[task.status].dot)} />
                {STATUS_META[task.status].label}
              </span>,
            )}
            {row("Priority", <span className={PRIORITY_META[task.priority].text}>{PRIORITY_META[task.priority].label}</span>)}
            {row(
              "Dates",
              <span>
                {task.startDate ? formatDate(task.startDate) : "—"} →{" "}
                <span className={cn(overdue && "font-medium text-destructive")}>
                  {due ? formatDate(due) : "—"}
                  {overdue && " (overdue)"}
                </span>
              </span>,
            )}
            {row("Assignees", task.assignees.map((a) => a.name).join(", ") || "—")}
            {row("Creator", task.assignedBy?.name ?? "—")}
            {task.titleParts && row("Scope", `${task.titleParts.unit} · ${task.titleParts.quantity}`)}
            {task.subtasks.length > 0 && row("Subtasks", `${subtasksDone} / ${task.subtasks.length} done`)}
            {row(
              "Time",
              logged.isLoading ? (
                "…"
              ) : (
                <span>
                  {formatEffort(logged.data?.minutes ?? task.loggedMinutes ?? 0) || "0m"} logged
                  {task.estimateMinutes ? ` · estimate ${formatEffort(task.estimateMinutes)}` : ""}
                  {logged.data && logged.data.people.length > 0 && logged.data.people.length <= 4 && (
                    <span className="block text-xs text-muted-foreground">
                      {logged.data.people.map((p) => `${p.name.split(" ")[0]} ${formatEffort(p.minutes)}`).join(" · ")}
                    </span>
                  )}
                </span>
              ),
            )}
            {row("Closing", direct ? "Completes straight away" : `Goes to ${task.assignedBy?.name ?? "the creator"} for review`)}
          </dl>

          {task.description && (
            <div className="grid gap-1">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Brief</p>
              <div className={cn("relative overflow-hidden", !fullBrief && "max-h-36")}>
                <RichText value={task.description} className="text-sm" />
                {!fullBrief && <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-card" />}
              </div>
              <button type="button" onClick={() => setFullBrief((v) => !v)} className="justify-self-start text-xs font-medium text-primary hover:underline">
                {fullBrief ? "Show less" : "Show more"}
              </button>
            </div>
          )}

          {(taskFiles.length > 0 || task.finalFile?.url) && (
            <div className="grid gap-1">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Files{taskFiles.length > MAX_FILES ? ` (${taskFiles.length})` : ""}
              </p>
              {task.finalFile?.url && (
                <a href={task.finalFile.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-primary hover:underline">
                  <LuLink aria-hidden className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate">Final link: {task.finalFile.url}</span>
                </a>
              )}
              {taskFiles.slice(0, MAX_FILES).map((file) => (
                <button
                  key={file._id}
                  type="button"
                  onClick={() => void viewTaskFile(taskId, file)}
                  className="flex min-w-0 items-center gap-1.5 text-left hover:underline"
                >
                  <LuFile aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{file.filename}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {finalFile?._id === file._id ? "final · " : ""}
                    {sizeLabel(file.size)}
                  </span>
                </button>
              ))}
              {taskFiles.length > MAX_FILES && (
                <span className="text-xs text-muted-foreground">+{taskFiles.length - MAX_FILES} more in the task</span>
              )}
            </div>
          )}

          <Link to={`/tasks?task=${taskId}`} onClick={onOpenTask} className="inline-flex items-center gap-1 justify-self-start text-xs font-medium text-primary hover:underline">
            Open full task
            <LuExternalLink aria-hidden className="size-3" />
          </Link>
        </div>
      )}
    </section>
  );
}
