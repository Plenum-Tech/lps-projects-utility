import { toDateTimeInput } from "@/lib/time";
import { useEffect, useState, type FormEvent } from "react";
import {
  LuCircleCheck,
  LuCircleX,
  LuLoaderCircle,
  LuPlus,
  LuSend,
  LuTrash2,
  LuX,
} from "react-icons/lu";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  useDeleteTask,
  useTaskLoggedTime,
  useReviewTask,
  useSubmitTask,
  useUploadTaskFiles,
} from "@/hooks/use-tasks";
import { ACCEPT, MAX_FILE_SIZE } from "@/components/tasks/task-files";
import { ReworkTaskPicker } from "@/components/tasks/rework-panel";
import { OutcomeReadinessBox } from "@/components/tasks/outcome-readiness";
import { formatEffort } from "@/lib/tasks";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/use-auth";
import { api, getErrorMessage } from "@/lib/api";
import { Input } from "@/components/ui/input";
import type { Task } from "@/types";

const LINK_RE = /^https?:\/\/\S+$/i;
const MAX_FINAL_LINKS = 10;

/** The task's recorded final links (several, or the single url). */
function finalLinksOf(task: Task): string[] {
  if (task.finalFile?.links?.length) return task.finalFile.links;
  return task.finalFile?.url ? [task.finalFile.url] : [];
}

/**
 * Complete the task (or send it for review). Both are mandatory: an outcome —
 * a note, the final file or link (or a file already on the task) — and the time
 * spent (entered here unless already logged).
 */
export function SubmitTaskDialog({
  task,
  open,
  onOpenChange,
}: {
  task: Task;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const submit = useSubmitTask();
  const upload = useUploadTaskFiles(task._id);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [notes, setNotes] = useState("");
  const [hours, setHours] = useState("");
  // Or the actual start / end of the work (logged as that range).
  const [actualStart, setActualStart] = useState("");
  const [actualEnd, setActualEnd] = useState("");
  const [minutes, setMinutes] = useState("");
  const [logging, setLogging] = useState(false);
  const [mode, setMode] = useState<"file" | "link">("file");
  const [file, setFile] = useState<File | null>(null);
  const [links, setLinks] = useState<string[]>([""]);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (open) {
      setNotes(task.submissionNotes ?? "");
      const recorded = finalLinksOf(task);
      setLinks(recorded.length ? recorded : [""]);
      setMode(task.finalFile?.url ? "link" : "file");
      setFile(null);
      setHours("");
      setMinutes("");
      // Pick up the task's actual start / end when both are already set.
      const both = Boolean(task.actualStartAt && task.actualEndAt);
      setActualStart(both ? toDateTimeInput(task.actualStartAt!) : "");
      setActualEnd(both ? toDateTimeInput(task.actualEndAt!) : "");
      setSubmitted(false);
    }
  }, [open, task.submissionNotes, task.finalFile?.url, task.finalFile?.links, task.actualStartAt, task.actualEndAt]);

  const direct = task.project?.requireTaskApproval === false;
  // Logged time is optional for completion.
  const noTime = false;
  const linkValues = [...new Set(links.map((l) => l.trim()).filter(Boolean))];
  const badLink = (value: string) => value.trim() !== "" && !LINK_RE.test(value.trim());
  const linkInvalid = mode === "link" && links.some(badLink);
  const h = hours.trim() === "" ? 0 : Number(hours);
  const m = minutes.trim() === "" ? 0 : Number(minutes);
  const timeInvalid = !Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0 || m > 59 || h > 23;
  const spent = timeInvalid ? 0 : h * 60 + m;
  // Actual start / end: both or neither; end after start and not in the future.
  const rangeSet = Boolean(actualStart && actualEnd);
  const rangeError =
    (actualStart && !actualEnd) || (!actualStart && actualEnd)
      ? "Enter both the actual start and the actual end."
      : rangeSet && new Date(actualEnd).getTime() <= new Date(actualStart).getTime()
        ? "The actual end must be after the actual start."
        : rangeSet && new Date(actualEnd).getTime() > Date.now() + 60_000
          ? "The actual end can't be in the future."
          : null;
  // Time spent is mandatory: required here unless time is already logged on the task.
  const alreadyLogged = (task.loggedMinutes ?? 0) > 0;
  // A range pre-filled from the task and left as is isn't logged again when the
  // task already has time (it came from those logs).
  const rangeUnchanged =
    rangeSet &&
    Boolean(task.actualStartAt && task.actualEndAt) &&
    actualStart === toDateTimeInput(task.actualStartAt!) &&
    actualEnd === toDateTimeInput(task.actualEndAt!);
  const logRange = rangeSet && !(alreadyLogged && rangeUnchanged);
  const timeMissing = !alreadyLogged && spent === 0 && !rangeSet;
  // Closing needs the final deliverable (a link, or a file / image) AND an outcome note.
  const deliverableMissing =
    !(mode === "file" && file) &&
    !(mode === "link" && linkValues.length > 0 && !linkInvalid) &&
    !task.finalFile?.fileId &&
    !task.finalFile?.url;
  const notesMissing = !notes.trim();
  const fileTooBig = mode === "file" && Boolean(file && file.size > MAX_FILE_SIZE);
  const outcomeMissing = deliverableMissing || notesMissing;
  const pending = submit.isPending || upload.isPending || logging;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (noTime || linkInvalid || timeInvalid || timeMissing || outcomeMissing || rangeError || fileTooBig) return;
    // The final file is uploaded first (a failed upload logs no time), then the time —
    // the actual start → end when given, else the time spent ending now — then the task is completed.
    let finalFileId: string | undefined;
    if (mode === "file" && file) {
      const uploaded = await upload
        .mutateAsync({ files: [file] })
        .catch(() => null);
      if (!uploaded?.[0]) return;
      finalFileId = uploaded[0]._id;
    }
    if (logRange || spent > 0) {
      setLogging(true);
      try {
        const end = logRange ? new Date(actualEnd) : new Date();
        const start = logRange ? new Date(actualStart) : new Date(end.getTime() - spent * 60_000);
        await api.post("/timelogs", {
          completion: true,
          task: task._id,
          project: task.project?._id,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          memo: "Logged when completing the task",
        });
        void queryClient.invalidateQueries({ queryKey: ["timelogs"] });
        setHours("");
        setMinutes("");
        setActualStart("");
        setActualEnd("");
      } catch (error) {
        toast.error(getErrorMessage(error));
        return;
      } finally {
        setLogging(false);
      }
    }
    submit.mutate(
      {
        id: task._id,
        input: {
          submissionNotes: notes.trim() || undefined,
          ...(finalFileId ? { finalFileId } : {}),
          ...(mode === "link" && linkValues.length ? { finalUrls: linkValues } : {}),
        },
      },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {direct ? "Mark as complete" : "Submit for review"}
          </DialogTitle>
          <DialogDescription>
            {direct ? (
              <>
                &ldquo;{task.title}&rdquo; is completed straight away — this
                project doesn&apos;t require a review.
              </>
            ) : (
              <>
                &ldquo;{task.title}&rdquo; goes to{" "}
                {task.assignedBy?.name ?? "the creator"} for review.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {noTime && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              No time is logged on this task yet. Log your time (Time tab or the
              timer) before completing it.
            </p>
          )}

          <fieldset className="space-y-2 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">
              Final link or file / image
              <span aria-hidden className="ml-0.5 text-destructive">*</span>
            </legend>
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                variant={mode === "file" ? "secondary" : "ghost"}
                onClick={() => setMode("file")}
              >
                Upload a file / image
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mode === "link" ? "secondary" : "ghost"}
                onClick={() => setMode("link")}
              >
                Paste a link
              </Button>
            </div>
            {mode === "file" ? (
              <Input
                type="file"
                accept={ACCEPT}
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                aria-label="Final file"
              />
            ) : (
              <div className="space-y-2">
                {links.map((value, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <Input
                      type="url"
                      value={value}
                      onChange={(event) =>
                        setLinks(links.map((l, i) => (i === index ? event.target.value : l)))
                      }
                      placeholder="https://… (Drive, SharePoint, Figma, YouTube…)"
                      aria-label={`Final link ${index + 1}`}
                      aria-invalid={(submitted && badLink(value)) || undefined}
                    />
                    {links.length > 1 && (
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="shrink-0"
                        onClick={() => setLinks(links.filter((_, i) => i !== index))}
                        aria-label={`Remove link ${index + 1}`}
                      >
                        <LuX aria-hidden />
                      </Button>
                    )}
                  </div>
                ))}
                {links.length < MAX_FINAL_LINKS && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setLinks([...links, ""])}
                  >
                    <LuPlus aria-hidden />
                    Add another link
                  </Button>
                )}
              </div>
            )}
            {(task.finalFile?.fileId || task.finalFile?.url) &&
              !file &&
              linkValues.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  A final deliverable is already recorded for this task.
                </p>
              )}
            {submitted && linkInvalid && (
              <p className="text-xs text-destructive">
                Each link must start with http:// or https://.
              </p>
            )}
            {fileTooBig && (
              <p className="text-xs text-destructive">
                This file is {(file!.size / (1024 * 1024)).toFixed(1)} MB — files can be up to {MAX_FILE_SIZE / (1024 * 1024)} MB. Paste a link (Drive, SharePoint…) instead.
              </p>
            )}
            {submitted && deliverableMissing && !linkInvalid && (
              <p className="text-xs text-destructive">
                Add the final link, or upload the final file or image.
              </p>
            )}
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor="submission-notes">
              Outcome note<span aria-hidden className="ml-0.5 text-destructive">*</span>
            </Label>
            <Textarea
              id="submission-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={3}
              placeholder="What was delivered? Anything the reviewer should check?"
              aria-invalid={(submitted && notesMissing) || undefined}
            />
            {submitted && notesMissing && (
              <p className="text-xs text-destructive">Write what was delivered.</p>
            )}
          </div>

          <OutcomeReadinessBox
            taskId={task._id}
            notes={notes}
            finalUrls={
              mode === "link" ? linkValues.filter((l) => LINK_RE.test(l)) : !file ? finalLinksOf(task) : []
            }
            hasFile={(mode === "file" && Boolean(file)) || Boolean(task.finalFile?.fileId)}
          />

          <fieldset className="space-y-1.5">
            <legend className="mb-1.5 text-sm leading-none font-medium">
              Time spent
              {!alreadyLogged && (
                <span aria-hidden className="ml-0.5 text-destructive">
                  *
                </span>
              )}
            </legend>
            <div className="flex items-center gap-2">
              <Input
                aria-label="Hours"
                inputMode="numeric"
                value={hours}
                onChange={(event) => setHours(event.target.value)}
                placeholder="0"
                className="w-20"
              />
              <span className="text-sm text-muted-foreground">h</span>
              <Input
                aria-label="Minutes"
                inputMode="numeric"
                value={minutes}
                onChange={(event) => setMinutes(event.target.value)}
                placeholder="0"
                className="w-20"
              />
              <span className="text-sm text-muted-foreground">m</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {task.loggedMinutes
                ? `${Math.floor(task.loggedMinutes / 60)}h ${task.loggedMinutes % 60}m already logged. Add any time not logged yet.`
                : "No time logged yet. Enter the time spent; it's logged on the Time tab, ending now."}
            </p>
            {submitted && timeMissing && !timeInvalid && (
              <p className="text-xs text-destructive">Enter the time spent on this task.</p>
            )}
            {submitted && timeInvalid && (
              <p className="text-xs text-destructive">Enter whole hours (0–23) and minutes (0–59).</p>
            )}
            <p className="pt-2 text-xs text-muted-foreground">
              Or enter when the work actually started and ended (if you fill in both, the actual start and end are used):
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="complete-actual-start" className="text-xs text-muted-foreground">
                  Actual start
                </Label>
                <Input
                  id="complete-actual-start"
                  type="datetime-local"
                  value={actualStart}
                  onChange={(event) => setActualStart(event.target.value)}
                  aria-invalid={(submitted && Boolean(rangeError)) || undefined}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="complete-actual-end" className="text-xs text-muted-foreground">
                  Actual end
                </Label>
                <Input
                  id="complete-actual-end"
                  type="datetime-local"
                  value={actualEnd}
                  min={actualStart || undefined}
                  onChange={(event) => setActualEnd(event.target.value)}
                  aria-invalid={(submitted && Boolean(rangeError)) || undefined}
                />
              </div>
            </div>
            {rangeSet && !rangeError && !logRange && (
              <p className="text-xs text-muted-foreground">
                Taken from the task&apos;s actual dates — this time is already logged, so nothing extra is added.
              </p>
            )}
            {logRange && !rangeError && (
              <p className="text-xs text-muted-foreground">
                Logged from the actual start to the actual end (several dates: 8 h per working day, Saturday and Sunday
                skipped). The task&apos;s actual dates follow.
                {spent > 0 && " The time spent above is not added — the actual start and end are used instead."}
              </p>
            )}
            {submitted && rangeError && <p className="text-xs text-destructive">{rangeError}</p>}
          </fieldset>

          <DialogFooter className="sticky -bottom-4 z-10 bg-background">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || noTime}>
              {pending ? (
                <LuLoaderCircle aria-hidden className="animate-spin" />
              ) : (
                <LuSend aria-hidden />
              )}
              {upload.isPending
                ? "Uploading…"
                : submit.isPending
                  ? "Submitting…"
                  : direct
                    ? "Complete"
                    : "Submit"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Creator/admin: approve or reject a submission. */
export function ReviewTaskDialog({
  task,
  open,
  onOpenChange,
}: {
  task: Task;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const review = useReviewTask();
  const [notes, setNotes] = useState("");
  const [decision, setDecision] = useState<"approved" | "rejected" | null>(
    null,
  );

  useEffect(() => {
    if (open) {
      setNotes("");
      setDecision(null);
    }
  }, [open]);

  function decide(next: "approved" | "rejected") {
    setDecision(next);
    review.mutate(
      {
        id: task._id,
        input: { decision: next, reviewNotes: notes.trim() || undefined },
      },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !review.isPending && onOpenChange(next)}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Review submission</DialogTitle>
          <DialogDescription>
            Approve to complete &ldquo;{task.title}&rdquo;, or send it back with
            feedback.
          </DialogDescription>
        </DialogHeader>
        {task.submissionNotes && (
          <div className="rounded-lg bg-muted/60 p-3 text-sm">
            <p className="text-xs font-medium text-muted-foreground">
              Submission notes
            </p>
            <p className="mt-1 whitespace-pre-wrap text-foreground">
              {task.submissionNotes}
            </p>
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="review-notes">Feedback (optional)</Label>
          <Textarea
            id="review-notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={3}
            placeholder="Shared with the assignees"
          />
        </div>
        <DialogFooter>
          <Button
            variant="destructive"
            onClick={() => decide("rejected")}
            disabled={review.isPending}
          >
            {review.isPending && decision === "rejected" ? (
              <LuLoaderCircle aria-hidden className="animate-spin" />
            ) : (
              <LuCircleX aria-hidden />
            )}
            Reject
          </Button>
          <Button
            onClick={() => decide("approved")}
            disabled={review.isPending}
          >
            {review.isPending && decision === "approved" ? (
              <LuLoaderCircle aria-hidden className="animate-spin" />
            ) : (
              <LuCircleCheck aria-hidden />
            )}
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Creator/admin: permanently delete a task. */
export function DeleteTaskDialog({
  task,
  open,
  onOpenChange,
  onDeleted,
}: {
  task: Task;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const remove = useDeleteTask();
  const { data: me } = useCurrentUser();
  // Logged time moves to another task (e.g. the duplicate being kept) instead of disappearing.
  const logged = useTaskLoggedTime(open ? task._id : null);
  const hasTime = (logged.data?.entries ?? 0) > 0;
  const [moveTo, setMoveTo] = useState("");
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (open) {
      setMoveTo("");
      setTried(false);
    }
  }, [open]);
  const moveError = hasTime && (!moveTo || moveTo === task._id) ? "Choose the task to move the time to." : null;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => !remove.isPending && onOpenChange(next)}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this task?</AlertDialogTitle>
          <AlertDialogDescription>
            &ldquo;{task.title}&rdquo; and its comments, files and history will
            be removed for everyone. This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {logged.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LuLoaderCircle aria-hidden className="size-4 animate-spin" />
            Checking logged time…
          </p>
        ) : hasTime && logged.data ? (
          <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
            <p className="font-medium text-foreground">
              {formatEffort(logged.data.minutes)} of time is logged on this task
              {logged.data.running > 0 ? " (a timer is running)" : ""}
            </p>
            <ul className="space-y-0.5 text-muted-foreground">
              {logged.data.people.map((person) => (
                <li key={person.name} className="flex justify-between gap-3">
                  <span>
                    {person.name}
                    {person.running ? " · timer running" : ""}
                  </span>
                  <span className="tabular-nums">{formatEffort(person.minutes)}</span>
                </li>
              ))}
            </ul>
            <div className="space-y-1.5">
              <Label htmlFor="delete-move-time">Move the time to</Label>
              <ReworkTaskPicker
                id="delete-move-time"
                projectId={task.project?._id ?? null}
                // Time on a task without a project stays off projects (admins may pick any task).
                standaloneOnly={me?.role !== "admin"}
                value={moveTo}
                onChange={(value) => setMoveTo(value)}
                invalid={tried && Boolean(moveError)}
              />
              {tried && moveError && <p className="text-xs text-destructive">{moveError}</p>}
              <p className="text-xs text-muted-foreground">
                Pick the task the work belongs to, for example the copy you&apos;re keeping. Nobody&apos;s time is lost.
              </p>
            </div>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>
            Cancel
          </AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={remove.isPending || logged.isPending}
            onClick={() => {
              setTried(true);
              if (moveError) return;
              remove.mutate(
                { id: task._id, moveTimeTo: hasTime ? moveTo : null },
                {
                  onSuccess: () => {
                    onOpenChange(false);
                    onDeleted();
                  },
                },
              );
            }}
          >
            {remove.isPending ? (
              <LuLoaderCircle aria-hidden className="animate-spin" />
            ) : (
              <LuTrash2 aria-hidden />
            )}
            Delete task
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
