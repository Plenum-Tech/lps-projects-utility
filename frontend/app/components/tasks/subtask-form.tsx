import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import {
  LuCircleAlert,
  LuLoaderCircle,
  LuPaperclip,
  LuPlus,
  LuRefreshCw,
  LuSave,
  LuX,
} from "react-icons/lu";

import { FieldError } from "@/components/projects/project-fields";
import { UserAvatar } from "@/components/tasks/task-badges";
import {
  ACCEPT,
  MAX_FILES_PER_TASK,
  MAX_PER_REQUEST,
  validateUploads,
} from "@/components/tasks/task-files";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  sendDeferredSubtaskNotifications,
  useAddSubtask,
  useSubtaskAssignees,
  useTaskFiles,
  useUpdateSubtask,
  useUploadSubtaskFiles,
} from "@/hooks/use-tasks";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api";
import { formatDateOnly, formatFileSize, toDateInput } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { Subtask, SubtaskUpdateInput, Task, UserRef } from "@/types";

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 2000;
const UNASSIGNED = "__unassigned";

interface AssigneeOption {
  value: string;
  label: string;
  email: string;
}

interface FailedUpload {
  file: File;
  error: string;
}

/**
 * A subtask filled in before its task exists (New task dialog). It's created —
 * with its files and emails — right after the task is saved.
 */
export interface SubtaskDraft {
  title: string;
  description: string;
  startDate: string;
  dueDate: string;
  assignee: UserRef | null;
  files: File[];
}

/** What the form needs to know about the parent task (a draft has no id yet). */
type SubtaskFormTask = Pick<Task, "_id" | "title" | "shortCode" | "dueDate">;

/**
 * Worksuite-style subtask form (add + edit): title, start/due dates, a
 * searchable assignee picker, description and attachments. Files upload after
 * the subtask is saved; failures keep the dialog open with a retry.
 *
 * Draft mode (`draft` prop): nothing is sent — Submit hands the filled-in
 * subtask to `draft.onSave`, and the people list comes from `draft.people`.
 */
export function SubtaskFormDialog({
  task,
  subtask,
  me,
  open,
  onOpenChange,
  onSaved,
  draft,
}: {
  task: SubtaskFormTask;
  /** Null = add a new subtask. */
  subtask: Subtask | null;
  me: { _id: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (subtaskId: string) => void;
  draft?: {
    /** Edit an existing draft; null = new. */
    initial: SubtaskDraft | null;
    people: UserRef[];
    onSave: (draft: SubtaskDraft) => void;
  };
}) {
  const live = !draft;
  const add = useAddSubtask(task._id);
  const update = useUpdateSubtask(task._id);
  const upload = useUploadSubtaskFiles(task._id);
  const assignees = useSubtaskAssignees(live ? task._id : null, open);
  const files = useTaskFiles(open && live ? task._id : null);
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState("");
  const [startDate, setStartDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [assignee, setAssignee] = useState<string>(UNASSIGNED);
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState<"saving" | "uploading" | null>(null);
  /** Set once the subtask is saved but some uploads failed. */
  const [savedId, setSavedId] = useState<string | null>(null);
  const [failed, setFailed] = useState<FailedUpload[]>([]);

  const initialDraft = draft?.initial ?? null;
  useEffect(() => {
    if (!open) return;
    if (draft) {
      setTitle(initialDraft?.title ?? "");
      setStartDate(initialDraft?.startDate ?? "");
      setDueDate(initialDraft?.dueDate ?? "");
      setAssignee(initialDraft?.assignee?._id ?? UNASSIGNED);
      setDescription(initialDraft?.description ?? "");
      setPending(initialDraft?.files ?? []);
    } else {
      setTitle(subtask?.title ?? "");
      setStartDate(toDateInput(subtask?.startDate));
      setDueDate(toDateInput(subtask?.dueDate));
      setAssignee(subtask?.assignee?._id ?? UNASSIGNED);
      setDescription(subtask?.description ?? "");
      setPending([]);
    }
    // `draft` is a fresh object each render; re-seed only when opened or the target changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, subtask, initialDraft]);

  useEffect(() => {
    if (!open) return;
    setSubmitted(false);
    setBusy(null);
    setSavedId(null);
    setFailed([]);
  }, [open, subtask]);

  const options = useMemo<AssigneeOption[]>(() => {
    const list: AssigneeOption[] = [{ value: UNASSIGNED, label: "Unassigned", email: "" }];
    const seen = new Set<string>();
    const push = (user: UserRef) => {
      if (seen.has(user._id)) return;
      seen.add(user._id);
      list.push({ value: user._id, label: user.name, email: user.email });
    };
    // The current assignee stays selectable even if the rule no longer lists them.
    if (subtask?.assignee) push(subtask.assignee);
    if (draft?.initial?.assignee) push(draft.initial.assignee);
    for (const user of (draft ? draft.people : assignees.data) ?? []) push(user);
    return list;
  }, [assignees.data, subtask, draft?.initial, draft?.people]);
  // "Unassigned" is an option, but shows as an empty search box (placeholder) when picked.
  const selected =
    assignee === UNASSIGNED ? null : (options.find((option) => option.value === assignee) ?? null);

  const existingFiles = files.data?.total ?? files.data?.files.length ?? 0;
  const titleError = !title.trim()
    ? "A title is required."
    : title.trim().length > MAX_TITLE
      ? `Keep it under ${MAX_TITLE} characters.`
      : null;
  const datesError =
    startDate && dueDate && startDate > dueDate ? "The due date can't be before the start date." : null;
  const descriptionError =
    description.length > MAX_DESCRIPTION ? `Keep it under ${MAX_DESCRIPTION.toLocaleString()} characters.` : null;
  const taskDue = toDateInput(task.dueDate);
  const dueAfterTask = Boolean(dueDate && taskDue && dueDate > taskDue);
  const locked = busy !== null || savedId !== null;

  function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const { accepted, rejected } = validateUploads(Array.from(list));
    if (rejected.length) toast.warning(rejected.join(" · "));
    const room = Math.min(MAX_PER_REQUEST, MAX_FILES_PER_TASK - existingFiles) - pending.length;
    if (accepted.length > room) {
      toast.warning(
        `This task can take ${Math.max(room + pending.length, 0)} more file(s) right now (max ${MAX_FILES_PER_TASK} per task, ${MAX_PER_REQUEST} per upload).`
      );
    }
    setPending((current) => [...current, ...accepted.slice(0, Math.max(room, 0))]);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    if (!locked) addFiles(event.dataTransfer.files);
  }

  /** Uploads one file at a time so each failure can be reported (and retried). */
  async function uploadAll(subId: string, list: File[]): Promise<FailedUpload[]> {
    const failures: FailedUpload[] = [];
    for (const file of list) {
      try {
        await upload.mutateAsync({ subId, files: [file] });
      } catch (error) {
        failures.push({ file, error: getErrorMessage(error) });
      }
    }
    return failures;
  }

  function finish(subId: string, message: string) {
    toast.success(message);
    onSaved?.(subId);
    onOpenChange(false);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (titleError || datesError || descriptionError || locked) return;

    if (draft) {
      draft.onSave({
        title: title.trim(),
        description: description.trim(),
        startDate,
        dueDate,
        assignee: selected ? { _id: selected.value, name: selected.label, email: selected.email } : null,
        files: pending,
      });
      onOpenChange(false);
      return;
    }

    const nextAssignee = assignee === UNASSIGNED ? null : assignee;
    const hasFiles = pending.length > 0;
    setBusy("saving");
    let subId: string;
    let deferred = false;
    try {
      if (subtask) {
        const input: SubtaskUpdateInput = {};
        if (title.trim() !== subtask.title) input.title = title.trim();
        if (description.trim() !== (subtask.description ?? "")) input.description = description.trim();
        if (startDate !== toDateInput(subtask.startDate)) input.startDate = startDate || null;
        if (dueDate !== toDateInput(subtask.dueDate)) input.dueDate = dueDate || null;
        if (nextAssignee !== (subtask.assignee?._id ?? null)) input.assignee = nextAssignee;
        subId = subtask._id;
        if (Object.keys(input).length > 0) {
          deferred = hasFiles && input.assignee !== undefined && nextAssignee !== null;
          const data = await update.mutateAsync({
            subId,
            input: { ...input, ...(deferred ? { deferNotifications: true } : {}) },
          });
          data.warnings?.forEach((warning) => toast.warning(warning));
        } else if (!hasFiles) {
          setBusy(null);
          onOpenChange(false);
          return;
        }
      } else {
        deferred = hasFiles;
        const data = await add.mutateAsync({
          title: title.trim(),
          description: description.trim() || undefined,
          startDate: startDate || null,
          dueDate: dueDate || null,
          assignee: nextAssignee,
          ...(deferred ? { deferNotifications: true } : {}),
        });
        subId = data.subtaskId ?? data.task.subtasks[data.task.subtasks.length - 1]?._id ?? "";
        data.warnings?.forEach((warning) => toast.warning(warning));
      }
    } catch {
      // The mutation hook already showed the error toast.
      setBusy(null);
      return;
    }

    if (!hasFiles) {
      setBusy(null);
      finish(subId, subtask ? "Subtask updated" : "Subtask added");
      return;
    }

    setBusy("uploading");
    const failures = await uploadAll(subId, pending);
    // Emails go out after the uploads so they carry the attachment count.
    if (deferred) void sendDeferredSubtaskNotifications(task._id, subId);
    setBusy(null);
    setPending([]);
    if (failures.length === 0) {
      finish(subId, subtask ? "Subtask updated" : "Subtask added");
      return;
    }
    setSavedId(subId);
    setFailed(failures);
  }

  async function retryFailed() {
    if (!savedId) return;
    setBusy("uploading");
    const failures = await uploadAll(
      savedId,
      failed.map((item) => item.file)
    );
    setBusy(null);
    setFailed(failures);
    if (failures.length === 0) finish(savedId, "Files uploaded");
  }

  const pendingAction = busy === "saving" ? "Saving…" : busy === "uploading" ? "Uploading files…" : null;

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{subtask || draft?.initial ? "Edit subtask" : "Add subtask"}</DialogTitle>
          <DialogDescription>
            {draft
              ? `For the new task${task.title ? ` "${task.title}"` : ""} — created when you save the task.`
              : `${task.shortCode ? `${task.shortCode} · ` : ""}${task.title}`}
          </DialogDescription>
        </DialogHeader>

        {savedId ? (
          <div className="space-y-3" role="alert">
            <div className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
              <LuCircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div className="min-w-0 space-y-1">
                <p className="font-medium text-foreground">
                  The subtask was saved, but {failed.length} file{failed.length === 1 ? "" : "s"} didn&apos;t upload.
                </p>
                <ul className="space-y-0.5 text-xs text-muted-foreground">
                  {failed.map((item) => (
                    <li key={`${item.file.name}-${item.file.size}`} className="break-words">
                      <span className="font-medium text-foreground">{item.file.name}</span> — {item.error}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => finish(savedId, "Subtask saved")}
                disabled={busy !== null}
              >
                Skip these files
              </Button>
              <Button type="button" onClick={() => void retryFailed()} disabled={busy !== null}>
                {busy ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuRefreshCw aria-hidden />}
                Retry upload
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              // In draft mode this dialog sits inside the New task form's React
              // tree; without this the submit would bubble up and create the task.
              event.stopPropagation();
              void handleSubmit(event);
            }}
            noValidate
            className="space-y-4"
          >
            <div className="space-y-1.5">
              <Label htmlFor="subtask-title">
                Title <span className="text-destructive">*</span>
              </Label>
              <Input
                id="subtask-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={MAX_TITLE}
                placeholder="What needs to be done?"
                aria-invalid={(submitted && Boolean(titleError)) || undefined}
                aria-describedby={submitted && titleError ? "subtask-title-error" : undefined}
                disabled={locked}
                autoFocus
              />
              {submitted && titleError && <FieldError id="subtask-title-error">{titleError}</FieldError>}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="subtask-start">Start date</Label>
                <Input
                  id="subtask-start"
                  type="date"
                  value={startDate}
                  onChange={(event) => setStartDate(event.target.value)}
                  disabled={locked}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="subtask-due">Due date</Label>
                <Input
                  id="subtask-due"
                  type="date"
                  value={dueDate}
                  min={startDate || undefined}
                  onChange={(event) => setDueDate(event.target.value)}
                  aria-invalid={Boolean(datesError) || undefined}
                  aria-describedby={datesError ? "subtask-dates-error" : undefined}
                  disabled={locked}
                />
              </div>
              {datesError && (
                <div className="sm:col-span-2">
                  <FieldError id="subtask-dates-error">{datesError}</FieldError>
                </div>
              )}
              {dueAfterTask && !datesError && (
                <p className="text-xs text-muted-foreground sm:col-span-2" role="status">
                  Heads up: this is after the task&apos;s due date ({formatDateOnly(task.dueDate, true)}).
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="subtask-assignee">Assigned to</Label>
              <Combobox
                items={options}
                value={selected}
                onValueChange={(item: AssigneeOption | null) => setAssignee(item?.value ?? UNASSIGNED)}
                isItemEqualToValue={(item: AssigneeOption, current: AssigneeOption) =>
                  item.value === current.value
                }
                autoHighlight
                disabled={locked}
              >
                <ComboboxInput
                  id="subtask-assignee"
                  placeholder={live && assignees.isPending ? "Loading people…" : "Unassigned — search people…"}
                  className="w-full"
                  showClear={selected !== null}
                />
                <ComboboxContent sideOffset={4}>
                  <ComboboxEmpty>
                    {live && assignees.isError ? "Couldn't load people." : "No one matches."}
                  </ComboboxEmpty>
                  <ComboboxList>
                    {(option: AssigneeOption) => (
                      <ComboboxItem key={option.value} value={option}>
                        {option.value === UNASSIGNED ? (
                          <span className="text-muted-foreground">Unassigned</span>
                        ) : (
                          <>
                            <UserAvatar user={{ name: option.label }} />
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="flex items-center gap-1.5 truncate">
                                {option.label}
                                {option.value === me._id && (
                                  <Badge variant="secondary" className="h-4 px-1.5 text-[0.65rem]">
                                    It&apos;s you
                                  </Badge>
                                )}
                              </span>
                              <span className="truncate text-xs text-muted-foreground">{option.email}</span>
                            </span>
                          </>
                        )}
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="subtask-description">Description</Label>
                <span
                  className={cn(
                    "text-xs tabular-nums",
                    descriptionError ? "text-destructive" : "text-muted-foreground"
                  )}
                  aria-live="polite"
                >
                  {description.length.toLocaleString()}/{MAX_DESCRIPTION.toLocaleString()}
                </span>
              </div>
              <Textarea
                id="subtask-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={4}
                placeholder="Add details, acceptance criteria or links…"
                aria-invalid={Boolean(descriptionError) || undefined}
                disabled={locked}
              />
              {descriptionError && <FieldError>{descriptionError}</FieldError>}
            </div>

            <div
              onDragOver={(event) => {
                event.preventDefault();
                if (!locked) setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              className={cn(
                "space-y-2 rounded-lg border border-dashed p-3 transition-colors duration-150 ease-out",
                dragOver ? "border-ring bg-primary/5" : "bg-muted/20"
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:underline disabled:pointer-events-none disabled:opacity-50"
                  onClick={() => inputRef.current?.click()}
                  disabled={locked}
                >
                  <LuPaperclip aria-hidden className="size-4" />
                  Upload file
                </button>
                <span className="text-xs text-muted-foreground">or drop files here · up to 10 MB each</span>
              </div>
              {pending.length > 0 && (
                <ul className="space-y-1" aria-label="Files to upload">
                  {pending.map((file, index) => (
                    <li
                      key={`${file.name}-${file.size}-${index}`}
                      className="flex items-center gap-2 rounded-md bg-background px-2 py-1.5 text-sm ring-1 ring-border"
                    >
                      <LuPaperclip aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate" title={file.name}>
                        {file.name}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">{formatFileSize(file.size)}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => setPending((current) => current.filter((_, i) => i !== index))}
                        disabled={locked}
                        aria-label={`Remove ${file.name}`}
                      >
                        <LuX aria-hidden />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <input
                ref={inputRef}
                type="file"
                multiple
                accept={ACCEPT}
                className="sr-only"
                tabIndex={-1}
                aria-label="Choose files to attach"
                onChange={(event) => {
                  addFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy !== null}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy !== null}>
                {busy ? (
                  <LuLoaderCircle aria-hidden className="animate-spin" />
                ) : subtask ? (
                  <LuSave aria-hidden />
                ) : (
                  <LuPlus aria-hidden />
                )}
                {pendingAction ?? (subtask ? "Save" : "Submit")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
