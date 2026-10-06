import { useEffect, useId, useMemo, useRef, useState, type DragEvent } from "react";
import { useNavigate } from "react-router";
import {
  LuArrowLeft,
  LuArrowRight,
  LuCircleAlert,
  LuClipboardPaste,
  LuEye,
  LuFileText,
  LuLoaderCircle,
  LuPlus,
  LuTriangleAlert,
  LuUpload,
  LuX,
} from "react-icons/lu";

import { SpeakerMapping, type SpeakerRow } from "@/components/meetings/speaker-mapping";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useCreateMeeting, usePreviewMeeting } from "@/hooks/use-meetings";
import { useProjectOptions } from "@/hooks/use-projects";
import { getErrorMessage } from "@/lib/api";
import {
  MAX_TRANSCRIPT_BYTES,
  MAX_TRANSCRIPT_CHARS,
  TRANSCRIPT_ACCEPT,
  TRANSCRIPT_EXTENSIONS,
  fileExtension,
  formatBytes,
  formatTimestamp,
  titleFromFilename,
} from "@/lib/meetings";
import { todayKey } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { MeetingPreviewResponse, TranscriptInput } from "@/types";

const NO_PROJECT = "__none";
type SourceTab = "upload" | "paste";

/**
 * "New meeting" — step 1: transcript (upload or paste), title, date and
 * project, with a parse preview; step 2: map detected speakers to LPS users.
 */
export function MeetingUploadDialog({
  open,
  onOpenChange,
  defaultProjectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-selects a project (project detail → Meetings tab). */
  defaultProjectId?: string;
}) {
  const id = useId();
  const navigate = useNavigate();
  const projects = useProjectOptions(open);
  const preview = usePreviewMeeting();
  const create = useCreateMeeting();

  const [step, setStep] = useState<1 | 2>(1);
  const [tab, setTab] = useState<SourceTab>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [meetingDate, setMeetingDate] = useState(todayKey());
  const [project, setProject] = useState(defaultProjectId ?? NO_PROJECT);
  const [result, setResult] = useState<MeetingPreviewResponse | null>(null);
  const [speakers, setSpeakers] = useState<SpeakerRow[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const { reset: resetPreview } = preview;
  const { reset: resetCreate } = create;
  useEffect(() => {
    if (!open) return;
    setStep(1);
    setTab("upload");
    setFile(null);
    setFileError(null);
    setText("");
    setTitle("");
    setTitleTouched(false);
    setMeetingDate(todayKey());
    setProject(defaultProjectId ?? NO_PROJECT);
    setResult(null);
    setSpeakers([]);
    resetPreview();
    resetCreate();
  }, [open, defaultProjectId, resetPreview, resetCreate]);

  // Any change to the source or project invalidates the preview.
  function invalidate() {
    setResult(null);
    resetPreview();
  }

  const projectItems = useMemo(() => {
    const items: Record<string, string> = { [NO_PROJECT]: "No project — private to you and admins" };
    for (const option of projects.data ?? []) items[option._id] = `${option.code} · ${option.name}`;
    if (project !== NO_PROJECT && !items[project]) items[project] = "Loading…";
    return items;
  }, [projects.data, project]);

  function pickFile(next: File | undefined | null) {
    invalidate();
    if (!next) return;
    const ext = fileExtension(next.name);
    if (!(TRANSCRIPT_EXTENSIONS as readonly string[]).includes(ext)) {
      setFile(null);
      setFileError("Use a .vtt or .docx exported from Teams, or a .txt file.");
      return;
    }
    if (next.size > MAX_TRANSCRIPT_BYTES) {
      setFile(null);
      setFileError(`That file is ${formatBytes(next.size)} — the limit is 5 MB.`);
      return;
    }
    setFileError(null);
    setFile(next);
    if (!titleTouched) setTitle(titleFromFilename(next.name));
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    pickFile(event.dataTransfer.files?.[0]);
  }

  const transcript: TranscriptInput | null =
    tab === "upload" ? (file ? { file } : null) : text.trim() ? { text } : null;
  const textTooLong = tab === "paste" && text.length > MAX_TRANSCRIPT_CHARS;
  const titleTooLong = title.length > 200;
  const canPreview = Boolean(transcript) && !textTooLong && !preview.isPending;
  const projectValue = project === NO_PROJECT ? undefined : project;

  function runPreview() {
    if (!transcript || textTooLong) return;
    preview.mutate(
      { transcript, project: projectValue },
      {
        onSuccess: (data) => {
          setResult(data);
          setSpeakers(
            data.speakers.map((speaker) => ({
              name: speaker.name,
              user: speaker.matchedUser?._id ?? null,
              matched: speaker.matchedUser,
            }))
          );
        },
      }
    );
  }

  function submit() {
    if (!transcript || !result || titleTooLong) return;
    create.mutate(
      {
        transcript,
        title: title.trim() || undefined,
        meetingDate: meetingDate || undefined,
        project: projectValue,
        speakers: speakers.map((speaker) => ({ name: speaker.name, user: speaker.user })),
      },
      {
        onSuccess: (data) => {
          onOpenChange(false);
          void navigate(`/meetings/${data.meeting._id}`);
        },
      }
    );
  }

  const pending = preview.isPending || create.isPending;
  const matchedCount = speakers.filter((speaker) => speaker.user).length;

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New meeting</DialogTitle>
          <DialogDescription>
            {step === 1
              ? "Bring in a Teams transcript — LPS highlights likely action items so you can turn them into tasks."
              : "Match the people who spoke to LPS users so suggestions get the right owners."}
          </DialogDescription>
          <ol className="flex items-center gap-2 pt-1 text-xs" aria-label="Steps">
            {(["Transcript", "Speakers"] as const).map((label, index) => {
              const active = step === index + 1;
              const done = step > index + 1;
              return (
                <li key={label} className="flex items-center gap-2">
                  {index > 0 && <span aria-hidden className="h-px w-6 bg-border" />}
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
                    {label}
                  </span>
                </li>
              );
            })}
          </ol>
        </DialogHeader>

        {step === 1 ? (
          <div className="space-y-4">
            <Tabs value={tab} onValueChange={(value) => { setTab(value as SourceTab); invalidate(); }}>
              <TabsList className="w-full sm:w-fit">
                <TabsTrigger value="upload">
                  <LuUpload aria-hidden />
                  Upload
                </TabsTrigger>
                <TabsTrigger value="paste">
                  <LuClipboardPaste aria-hidden />
                  Paste
                </TabsTrigger>
              </TabsList>
              <TabsContent value="upload" className="pt-2">
                {file ? (
                  <div className="flex items-center gap-3 rounded-xl border bg-muted/30 p-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background ring-1 ring-border">
                      <LuFileText aria-hidden className="size-4 text-muted-foreground" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{file.name}</p>
                      <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => {
                        setFile(null);
                        invalidate();
                      }}
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
                      "flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-8 text-center transition-colors duration-150 ease-out",
                      dragOver ? "border-ring bg-primary/5" : "bg-muted/30"
                    )}
                  >
                    <span className="flex size-10 items-center justify-center rounded-lg bg-background text-muted-foreground ring-1 ring-border">
                      <LuUpload aria-hidden className="size-4" />
                    </span>
                    <p className="text-sm text-foreground">
                      Drag a transcript here or{" "}
                      <button
                        type="button"
                        className="font-medium text-primary underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
                        onClick={() => inputRef.current?.click()}
                      >
                        browse
                      </button>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      .vtt or .docx from Teams (Transcript → Download), or .txt · up to 5 MB
                    </p>
                  </div>
                )}
                <input
                  ref={inputRef}
                  type="file"
                  accept={TRANSCRIPT_ACCEPT}
                  className="sr-only"
                  tabIndex={-1}
                  aria-label="Choose a transcript file"
                  onChange={(event) => {
                    pickFile(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
                {fileError && (
                  <p role="alert" className="mt-2 text-xs text-destructive">
                    {fileError}
                  </p>
                )}
              </TabsContent>
              <TabsContent value="paste" className="space-y-1.5 pt-2">
                <Label htmlFor={`${id}-text`} className="sr-only">
                  Transcript text
                </Label>
                <Textarea
                  id={`${id}-text`}
                  value={text}
                  onChange={(event) => {
                    setText(event.target.value);
                    if (result) invalidate();
                  }}
                  rows={9}
                  placeholder={"[00:01:02] Priya Sharma: Let's start with the release plan.\nAnkit (00:01:15): I'll send the deck by Friday."}
                  className="max-h-72 font-mono text-xs"
                  aria-invalid={textTooLong || undefined}
                />
                <p className={cn("text-right text-xs tabular-nums", textTooLong ? "text-destructive" : "text-muted-foreground")}>
                  {text.length.toLocaleString()} / {MAX_TRANSCRIPT_CHARS.toLocaleString()}
                </p>
              </TabsContent>
            </Tabs>

            <div className="space-y-1.5">
              <Label htmlFor={`${id}-title`}>Title</Label>
              <Input
                id={`${id}-title`}
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setTitleTouched(true);
                }}
                maxLength={200}
                placeholder={file ? titleFromFilename(file.name) : `Meeting on ${meetingDate || todayKey()}`}
              />
              <p className="text-xs text-muted-foreground">Filled in from the file name — change it if you like.</p>
            </div>

            <div className="grid gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-date`}>Date</Label>
                <Input
                  id={`${id}-date`}
                  type="date"
                  value={meetingDate}
                  onChange={(event) => setMeetingDate(event.target.value)}
                />
              </div>
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor={`${id}-project`}>Project</Label>
                <Select
                  value={project}
                  onValueChange={(value) => {
                    setProject(String(value ?? NO_PROJECT));
                    invalidate();
                  }}
                  items={projectItems}
                >
                  <SelectTrigger id={`${id}-project`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(projectItems).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="-mt-2 text-xs text-muted-foreground">
              Project members can see the meeting, and tasks default to this project.
            </p>

            {preview.isError && (
              <Alert variant="destructive">
                <LuCircleAlert aria-hidden className="size-4" />
                <AlertTitle>Couldn&apos;t read this transcript</AlertTitle>
                <AlertDescription>{getErrorMessage(preview.error)}</AlertDescription>
              </Alert>
            )}

            {result && <PreviewSummary result={result} />}
          </div>
        ) : (
          <div className="space-y-3">
            {speakers.length === 0 ? (
              <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                No speaker names were found in this transcript — you can still create the meeting
                and assign action items by hand.
              </p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  <span className="font-medium text-foreground tabular-nums">{matchedCount}</span> of{" "}
                  <span className="tabular-nums">{speakers.length}</span> speakers mapped. Pick “Not in
                  LPS” for guests — their names are kept on suggestions.
                </p>
                <SpeakerMapping
                  rows={speakers}
                  onChange={(name, user) =>
                    setSpeakers((current) =>
                      current.map((row) => (row.name === name ? { ...row, user } : row))
                    )
                  }
                  people={result?.candidates ?? []}
                  disabled={create.isPending}
                />
              </>
            )}
            {create.isError && (
              <Alert variant="destructive">
                <LuCircleAlert aria-hidden className="size-4" />
                <AlertTitle>Couldn&apos;t create the meeting</AlertTitle>
                <AlertDescription>{getErrorMessage(create.error)}</AlertDescription>
              </Alert>
            )}
          </div>
        )}

        <DialogFooter>
          {step === 1 ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                Cancel
              </Button>
              {result ? (
                <Button onClick={() => setStep(2)} disabled={titleTooLong}>
                  Next: speakers
                  <LuArrowRight aria-hidden />
                </Button>
              ) : (
                <Button onClick={runPreview} disabled={!canPreview}>
                  {preview.isPending ? (
                    <LuLoaderCircle aria-hidden className="animate-spin" />
                  ) : (
                    <LuEye aria-hidden />
                  )}
                  {preview.isPending ? "Reading…" : "Preview"}
                </Button>
              )}
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep(1)} disabled={create.isPending}>
                <LuArrowLeft aria-hidden />
                Back
              </Button>
              <Button onClick={submit} disabled={create.isPending}>
                {create.isPending ? (
                  <LuLoaderCircle aria-hidden className="animate-spin" />
                ) : (
                  <LuPlus aria-hidden />
                )}
                {create.isPending ? "Creating…" : "Create meeting"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewSummary({ result }: { result: MeetingPreviewResponse }) {
  const lines = result.segments.slice(0, 5);
  return (
    <section
      aria-label="Transcript preview"
      className="space-y-3 rounded-xl border bg-muted/20 p-3 duration-150 animate-in fade-in-0"
    >
      <p className="text-sm text-foreground">
        <span className="font-semibold tabular-nums">{result.segmentCount.toLocaleString()}</span> line
        {result.segmentCount === 1 ? "" : "s"} ·{" "}
        <span className="font-semibold tabular-nums">{result.speakers.length}</span> speaker
        {result.speakers.length === 1 ? "" : "s"}
      </p>
      {result.warnings.length > 0 && (
        <ul className="space-y-1">
          {result.warnings.map((warning) => (
            <li key={warning} className="flex items-start gap-1.5 text-xs text-foreground">
              <LuTriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-chart-4" />
              {warning}
            </li>
          ))}
        </ul>
      )}
      <ol className="space-y-1.5">
        {lines.map((segment) => (
          <li key={segment.idx} className="flex gap-2 text-xs">
            {segment.start !== null && (
              <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
                {formatTimestamp(segment.start)}
              </span>
            )}
            <span className="min-w-0 break-words text-foreground">
              {segment.speaker && <span className="font-medium">{segment.speaker}: </span>}
              <span className="text-muted-foreground">{segment.text}</span>
            </span>
          </li>
        ))}
      </ol>
      {result.segmentCount > lines.length && (
        <p className="text-xs text-muted-foreground">
          …and {(result.segmentCount - lines.length).toLocaleString()} more
        </p>
      )}
    </section>
  );
}
