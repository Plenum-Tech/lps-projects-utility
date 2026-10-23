import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { LuCamera, LuCircleCheck, LuLoaderCircle, LuMic, LuPaperclip, LuRotateCcw, LuSend, LuSquare } from "react-icons/lu";

import { ACCEPT, MAX_FILE_SIZE } from "@/components/tasks/task-files";
import { useRecorder, type RecorderError } from "@/components/voice/use-recorder";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useCurrentUser } from "@/hooks/use-auth";
import { useCreateTask, useSubmitTask, useTask, useUpdateTask, useUpdateTaskStatus, useUploadTaskFiles } from "@/hooks/use-tasks";
import { useCreateTimeLog } from "@/hooks/use-timelogs";
import {
  useVoiceTranscribe,
  useVoiceUnderstand,
  type VoiceCard,
  type VoiceDraft,
  type VoiceExistingTask,
  type VoiceField,
} from "@/hooks/use-voice";
import { api, getErrorCode, getErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Voice task assistant: a floating mic button on every signed-in page (staff
// only) opening a chat that creates a task, closes a task or logs time. The
// server reads each voice note / typed message and asks for what's missing;
// a summary card is shown and NOTHING is saved until its button is tapped —
// then the existing task / time endpoints save it with all their rules.
// ---------------------------------------------------------------------------

const MAX_RECORD_SECONDS = 60;
const START_CHIPS = ["New task", "Close a task", "Log time"];
const FILE_CHIPS = ["📷 Take photo", "Pick a file", "Say a link"];
const FOLLOW_UP_CHIPS = ["Close it", "Log time", "Update it"];

type ChatItem =
  | { id: number; kind: "bot"; text: string; error?: boolean }
  | { id: number; kind: "user"; text: string; voice?: boolean; apiText?: string }
  | { id: number; kind: "card"; card: VoiceCard; draft: VoiceDraft; file: File | null; state: "open" | "closed" }
  | { id: number; kind: "done"; text: string; link?: string }
  | { id: number; kind: "existing"; tasks: VoiceExistingTask[]; state: "open" | "closed" };

/** A chat item before it gets its id. */
type NewItem = ChatItem extends infer T ? (T extends ChatItem ? Omit<T, "id"> : never) : never;
type ApiMessage = { role: "user" | "assistant"; text: string };

let nextId = 1;

const OPEN_EVENT = "voice-assistant:open";

/**
 * Opens the assistant from inside a modal (the task detail sheet makes the
 * floating button unreachable), with that task as the context.
 */
export function openVoiceAssistant(taskId?: string) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { taskId } }));
}

const formatClock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export function VoiceAssistant() {
  const { data: me } = useCurrentUser();
  const [searchParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  // The task it was opened from, or the one open in the page (?task=<id>): "close this, 2 hours, done".
  const contextTaskId = openedFor ?? searchParams.get("task");
  const contextTask = useTask(contextTaskId, open && Boolean(contextTaskId) && !me?.isGuest);

  const [items, setItems] = useState<ChatItem[]>([]);
  const [chips, setChips] = useState<string[]>(START_CHIPS);
  const [draft, setDraft] = useState<VoiceDraft | null>(null);
  const [ask, setAsk] = useState<VoiceField | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [voiceOff, setVoiceOff] = useState(false);
  // Tasks created / changed in this chat, newest first: "close it", "that task" … mean these.
  const [recentTaskIds, setRecentTaskIds] = useState<string[]>([]);
  const understand = useVoiceUnderstand();
  const transcribe = useVoiceTranscribe();
  const inputRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const recorder = useRecorder({ maxSeconds: MAX_RECORD_SECONDS, onDone: (audio) => void onRecorded(audio) });
  const busy = understand.isPending || transcribe.isPending;

  function push(item: NewItem) {
    setItems((current) => [...current, { ...item, id: nextId++ } as ChatItem]);
  }

  // Greeting (it names the page's task once that has loaded).
  const contextLabel = contextTask.data?.task ? (contextTask.data.task.shortCode ?? "this task") : null;
  const contextLoading = Boolean(contextTaskId) && contextTask.isLoading;
  useEffect(() => {
    if (!open || !me || items.length > 0 || contextLoading) return;
    const first = me.name.split(" ")[0];
    push({
      kind: "bot",
      text: contextLabel
        ? `Hi ${first}. Working on ${contextLabel}? Say "close this, 2 hours, done" or "log 45 minutes" — or create a new task.`
        : `Hi ${first}. Tell me what to do: create a task (brand, what to make, who's on it, when it's due), close a task, or log time.`,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, me, items.length, contextLoading]);

  // Keep the newest message in view.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [items, busy]);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const taskId = (event as CustomEvent<{ taskId?: string }>).detail?.taskId;
      setOpenedFor(taskId ?? null);
      setOpen(true);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  // Closing the sheet drops an unfinished recording.
  useEffect(() => {
    if (!open) {
      recorder.cancel();
      setOpenedFor(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!me || me.isGuest) return null;

  function apiMessages(extra: { text: string }): ApiMessage[] {
    const history = items.flatMap((item): ApiMessage[] =>
      item.kind === "bot" && !item.error
        ? [{ role: "assistant", text: item.text }]
        : item.kind === "user"
          ? [{ role: "user", text: item.apiText ?? item.text }]
          : [],
    );
    return [...history, { role: "user" as const, text: extra.text }].slice(-20);
  }

  async function send(display: string, options: { voice?: boolean; apiText?: string; draftOverride?: VoiceDraft | null; file?: File } = {}) {
    const message = (options.apiText ?? display).trim();
    if (!message || busy) return;
    push({ kind: "user", text: display, voice: options.voice, apiText: options.apiText });
    setChips([]);
    try {
      const res = await understand.mutateAsync({
        messages: apiMessages({ text: message }),
        draft: options.draftOverride !== undefined ? options.draftOverride : draft,
        context: { ...(contextTaskId ? { taskId: contextTaskId } : {}), recentTaskIds },
      });
      setDraft(res.draft);
      setAsk(res.ask);
      if (!res.draft.finalFile) setFile(null);
      // An older list can't be picked from any more.
      setItems((current) => current.map((item) => (item.kind === "existing" ? { ...item, state: "closed" } : item)));
      push({ kind: "bot", text: res.reply });
      if (res.existing?.length) push({ kind: "existing", tasks: res.existing, state: "open" });
      if (res.card) {
        // An older card can't be confirmed any more.
        setItems((current) => current.map((item) => (item.kind === "card" ? { ...item, state: "closed" } : item)));
        push({ kind: "card", card: res.card, draft: res.draft, file: res.draft.finalFile ? (options.file ?? file) : null, state: "open" });
      }
      setChips(res.ask === "final" ? FILE_CHIPS : res.chips);
    } catch (error) {
      push({ kind: "bot", text: getErrorMessage(error), error: true });
      setChips(draft ? [] : START_CHIPS);
    }
  }

  async function onRecorded(audio: Blob) {
    try {
      const heard = await transcribe.mutateAsync(audio);
      if (!heard.trim()) {
        push({ kind: "bot", text: "I didn't catch that. Try again, or type below.", error: true });
        return;
      }
      await send(heard, { voice: true });
    } catch (error) {
      if (getErrorCode(error) === "voice_unavailable") {
        setVoiceOff(true);
        inputRef.current?.focus();
      }
      push({ kind: "bot", text: getErrorMessage(error), error: true });
    }
  }

  async function toggleMic() {
    if (recorder.recording) {
      recorder.stop();
      return;
    }
    try {
      await recorder.start();
    } catch (error) {
      const reason = error as RecorderError;
      push({
        kind: "bot",
        error: true,
        text:
          reason === "denied"
            ? "Microphone access is blocked. Allow it in the browser's site settings, or type below."
            : reason === "unsupported"
              ? "This browser can't record audio. Type below instead."
              : "Couldn't start the microphone. Type below instead.",
      });
      // Blocked: they may allow it and tap again; no recording at all: type.
      if (reason === "unsupported") setVoiceOff(true);
      inputRef.current?.focus();
    }
  }

  function onChip(label: string) {
    if (busy) return;
    if (label === FILE_CHIPS[0]) return photoRef.current?.click();
    if (label === FILE_CHIPS[1]) return pickRef.current?.click();
    if (label === FILE_CHIPS[2]) {
      push({ kind: "bot", text: "Say or type the link (it must start with http:// or https://)." });
      inputRef.current?.focus();
      return;
    }
    void send(label);
  }

  function onFilePicked(picked: File | null | undefined) {
    if (!picked || !draft) return;
    if (picked.size > MAX_FILE_SIZE) {
      push({
        kind: "bot",
        error: true,
        text: `${picked.name} is ${(picked.size / (1024 * 1024)).toFixed(1)} MB — files can be up to ${MAX_FILE_SIZE / (1024 * 1024)} MB. Say a link (Drive, SharePoint…) instead.`,
      });
      return;
    }
    setFile(picked);
    const next: VoiceDraft = { ...draft, finalFile: { name: picked.name, size: picked.size }, finalUrl: null };
    // The file stays on the phone until the close is confirmed; only its name goes to the server.
    void send(`📎 ${picked.name}`, { apiText: "Attached the final file", draftOverride: next, file: picked });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText("");
    void send(value);
  }

  function reset() {
    recorder.cancel();
    setItems([]);
    setDraft(null);
    setAsk(null);
    setFile(null);
    setChips(START_CHIPS);
  }

  function finished(id: number, line: { text: string; link?: string; taskId?: string; followUp?: boolean }) {
    setItems((current) => current.map((item) => (item.id === id && item.kind === "card" ? { ...item, state: "closed" } : item)));
    push({ kind: "done", text: line.text, link: line.link });
    if (line.taskId) setRecentTaskIds((current) => [line.taskId!, ...current.filter((t) => t !== line.taskId)].slice(0, 10));
    setAsk(null);
    setFile(null);
    if (line.followUp && line.taskId) {
      // The new task is the one "close it" / "log time" / "update it" act on next.
      setDraft({ focusTaskId: line.taskId } as VoiceDraft);
      setChips(FOLLOW_UP_CHIPS);
    } else {
      setDraft(null);
      setChips(START_CHIPS);
    }
  }

  function change(id: number) {
    setItems((current) => current.map((item) => (item.id === id && item.kind === "card" ? { ...item, state: "closed" } : item)));
    push({ kind: "bot", text: 'Say what to change — for example "due Friday", "add Vishal" or "3 hours".' });
    setChips([]);
    inputRef.current?.focus();
  }

  const hint = recorder.recording
    ? `Listening… ${formatClock(recorder.seconds)} / ${formatClock(MAX_RECORD_SECONDS)} — tap to stop`
    : transcribe.isPending
      ? "Transcribing…"
      : understand.isPending
        ? "Reading the details…"
        : voiceOff
          ? "Voice is off here — type below"
          : ask === "final"
            ? "Add the final file or link"
            : "Tap the mic and speak";

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Voice tasks: create, close or log time by speaking"
          title="Voice tasks"
          className="fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 grid size-14 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg transition hover:bg-primary/90 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <LuMic aria-hidden className="size-6" />
        </button>
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="gap-0 p-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] data-[side=right]:w-full data-[side=right]:sm:max-w-[420px]"
        >
          <div className="flex items-center gap-3 border-b px-4 py-3 pr-12">
            <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
              <LuMic className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <SheetTitle>Voice tasks</SheetTitle>
              <SheetDescription className="truncate text-xs">
                {contextLabel ? `On ${contextLabel} · ` : ""}Create, close or log time — speak or type
              </SheetDescription>
            </div>
            <Button type="button" variant="ghost" size="icon-sm" onClick={reset} disabled={busy} aria-label="Start over" title="Start over">
              <LuRotateCcw />
            </Button>
          </div>

          <div ref={scrollRef} className="flex flex-1 flex-col gap-2 overflow-y-auto px-3 py-3" aria-live="polite">
            {items.map((item) => {
              if (item.kind === "user") {
                return (
                  <div key={item.id} className="max-w-[86%] self-end rounded-2xl rounded-br-md bg-primary px-3 py-2 text-sm text-primary-foreground">
                    {item.voice && <span className="mb-0.5 block text-[11px] opacity-80">🎙 voice note · transcribed</span>}
                    <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{item.text}</span>
                  </div>
                );
              }
              if (item.kind === "bot") {
                return (
                  <div
                    key={item.id}
                    className={cn(
                      "max-w-[86%] self-start rounded-2xl rounded-bl-md px-3 py-2 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]",
                      item.error ? "bg-destructive/10 text-destructive" : "bg-muted",
                    )}
                    role={item.error ? "alert" : undefined}
                  >
                    {item.text}
                  </div>
                );
              }
              if (item.kind === "existing") {
                return (
                  <ExistingTasks
                    key={item.id}
                    item={item}
                    disabled={busy || recorder.recording}
                    onPick={(message) => void send(message)}
                  />
                );
              }
              if (item.kind === "done") {
                return (
                  <div key={item.id} className="flex items-start gap-2 rounded-xl bg-emerald-500/10 px-3 py-2 text-sm text-emerald-900 dark:text-emerald-200">
                    <LuCircleCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
                    <span className="min-w-0">
                      {item.text}{" "}
                      {item.link && (
                        <Link to={item.link} onClick={() => setOpen(false)} className="font-medium underline underline-offset-2">
                          Open task
                        </Link>
                      )}
                    </span>
                  </div>
                );
              }
              return (
                <SummaryCard
                  key={item.id}
                  item={item}
                  onDone={(line) => finished(item.id, line)}
                  onChange={() => change(item.id)}
                  onError={(message) => push({ kind: "bot", text: message, error: true })}
                />
              );
            })}
            {busy && (
              <div className="self-start rounded-2xl rounded-bl-md bg-muted px-3 py-2 text-sm text-muted-foreground" role="status">
                <LuLoaderCircle aria-hidden className="inline size-4 animate-spin" />{" "}
                {transcribe.isPending ? "Transcribing…" : "Reading the details…"}
              </div>
            )}
          </div>

          {chips.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pb-2">
              {chips.map((label) => (
                <button
                  key={label}
                  type="button"
                  disabled={busy || recorder.recording}
                  onClick={() => onChip(label)}
                  className="inline-flex max-w-full items-center gap-1 truncate rounded-full border bg-background px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
                >
                  {label === FILE_CHIPS[0] ? <LuCamera aria-hidden className="size-3.5" /> : label === FILE_CHIPS[1] ? <LuPaperclip aria-hidden className="size-3.5" /> : null}
                  {label === FILE_CHIPS[0] ? "Take photo" : label}
                </button>
              ))}
            </div>
          )}

          <div className="grid gap-2 border-t px-3 pt-3 pb-3">
            <div className="grid justify-items-center gap-1.5">
              <button
                type="button"
                onClick={() => void toggleMic()}
                disabled={voiceOff || (busy && !recorder.recording)}
                aria-label={recorder.recording ? "Stop recording" : "Record a voice note"}
                aria-pressed={recorder.recording}
                className={cn(
                  "relative grid size-16 place-items-center rounded-full bg-primary text-primary-foreground shadow transition [touch-action:manipulation] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-40",
                  recorder.recording && "bg-destructive text-white",
                )}
              >
                {recorder.recording && (
                  <span aria-hidden className="absolute -inset-2 rounded-full border-[3px] border-destructive/50 motion-safe:animate-ping" />
                )}
                {recorder.recording ? <LuSquare aria-hidden className="size-6" /> : <LuMic aria-hidden className="size-7" />}
              </button>
              <div className="flex min-h-5 items-center gap-2 text-xs text-muted-foreground">
                {recorder.recording && (
                  <span aria-hidden className="flex h-4 items-center gap-[3px]">
                    {[0.6, 1, 0.8, 1, 0.6].map((scale, index) => (
                      <i
                        key={index}
                        className="w-[3px] rounded-sm bg-destructive transition-[height] duration-75"
                        style={{ height: `${Math.max(3, Math.round(16 * Math.min(1, recorder.level * scale + 0.1)))}px` }}
                      />
                    ))}
                  </span>
                )}
                <span>{hint}</span>
              </div>
            </div>
            <form onSubmit={onSubmit} className="flex items-center gap-2">
              <Input
                ref={inputRef}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={ask === "final" ? "Paste or type the link…" : "Or type here…"}
                aria-label="Message"
                maxLength={2000}
                className="text-base sm:text-sm"
                disabled={recorder.recording}
              />
              <Button type="submit" size="icon" disabled={busy || !text.trim()} aria-label="Send">
                <LuSend />
              </Button>
            </form>
          </div>

          {/* Close: the final photo (camera) or file; uploaded only after "Close task". */}
          <input
            ref={photoRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(event) => {
              onFilePicked(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <input
            ref={pickRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(event) => {
              onFilePicked(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * "Check and confirm": the fields that will be saved, Change, and the save
 * button. Saving uses the existing endpoints in the close dialog's order
 * (final file first, then the time, then complete / submit).
 */
function SummaryCard({
  item,
  onDone,
  onChange,
  onError,
}: {
  item: Extract<ChatItem, { kind: "card" }>;
  onDone: (line: { text: string; link?: string; taskId?: string; followUp?: boolean }) => void;
  onChange: () => void;
  onError: (message: string) => void;
}) {
  const { draft, card, file } = item;
  const taskId = draft.task?.id ?? "";
  const createTask = useCreateTask();
  const submitTask = useSubmitTask();
  const upload = useUploadTaskFiles(taskId);
  const createLog = useCreateTimeLog();
  const updateTask = useUpdateTask();
  const updateStatus = useUpdateTaskStatus();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const closed = item.state === "closed";

  /** The time to log: the actual start → end when given, else the time spent ending now. */
  function timeSpan(): { start: Date; end: Date } | null {
    if (draft.start && draft.end) return { start: new Date(draft.start), end: new Date(draft.end) };
    if (draft.minutes) {
      const end = new Date();
      return { start: new Date(end.getTime() - draft.minutes * 60_000), end };
    }
    return null;
  }

  async function save() {
    setSaving(true);
    try {
      if (draft.action === "create") {
        const rework = draft.iteration === "rework" && draft.reworkOf;
        const data = await createTask.mutateAsync(
          rework
            ? {
                // The server names a rework after the original task (R1, R2 …) and copies its brief, people and files when left empty.
                title: "Rework",
                iteration: "rework",
                reworkOf: draft.reworkOf!.id,
                ...(draft.reworkSource ? { reworkSource: draft.reworkSource } : {}),
                description: draft.briefHtml ?? draft.brief ?? undefined,
                assignees: draft.assignees.map((a) => a.id),
                dueDate: draft.dueDate,
                ...(draft.startDate ? { startDate: draft.startDate } : {}),
                ...(draft.project ? { project: draft.project.id } : {}),
              }
            : {
                // The same body as the task form.
                title: `${draft.unit} ${draft.quantity} – ${draft.shortName}`,
                titleParts: { unit: draft.unit!, quantity: draft.quantity!, shortName: draft.shortName! },
                iteration: "new",
                hasAttachments: false,
                description: draft.briefHtml ?? draft.brief ?? undefined,
                assignees: draft.assignees.map((a) => a.id),
                priority: "medium",
                startDate: draft.startDate,
                dueDate: draft.dueDate,
                project: draft.project!.id,
              },
        );
        onDone({
          text: `Created ${data.task.shortCode ?? "the task"} · ${data.task.title}.${data.task.assignees.length ? ` ${data.task.assignees.map((a) => a.name.split(" ")[0]).join(" and ")} ${data.task.assignees.length === 1 ? "was" : "were"} notified.` : ""}`,
          link: `/tasks?task=${data.task._id}`,
          taskId: data.task._id,
          followUp: true,
        });
        return;
      }
      const task = draft.task!;
      if (draft.action === "update") {
        // The edit form's PATCH body (only what changed), then the status move.
        if (draft.updatePatch && Object.keys(draft.updatePatch).length) {
          await updateTask.mutateAsync({ id: task.id, input: draft.updatePatch });
        }
        if (draft.updateStatus) await updateStatus.mutateAsync({ id: task.id, status: draft.updateStatus });
        onDone({ text: `Updated ${task.code}.`, link: `/tasks?task=${task.id}`, taskId: task.id });
        return;
      }
      const span = timeSpan();
      if (draft.action === "log_time") {
        if (!span) return;
        await createLog.mutateAsync({
          task: task.id,
          ...(task.projectId ? { project: task.projectId } : {}),
          startTime: span.start.toISOString(),
          endTime: span.end.toISOString(),
          memo: draft.note ?? "",
        });
        const minutes = Math.round((span.end.getTime() - span.start.getTime()) / 60_000);
        onDone({ text: `${formatMinutes(minutes)} logged on ${task.code}.`, link: `/tasks?task=${task.id}`, taskId: task.id });
        return;
      }
      // Close: the final file is uploaded first (a failed upload logs no time).
      let finalFileId: string | undefined;
      if (file) {
        const uploaded = await upload.mutateAsync({ files: [file] });
        finalFileId = uploaded[0]?._id;
        if (!finalFileId) throw new Error("The file didn't upload — try again.");
      }
      if (span) {
        await api.post("/timelogs", {
          completion: true,
          task: task.id,
          project: task.projectId ?? undefined,
          startTime: span.start.toISOString(),
          endTime: span.end.toISOString(),
          memo: "Logged when completing the task",
        });
        void queryClient.invalidateQueries({ queryKey: ["timelogs"] });
      }
      const data = await submitTask.mutateAsync({
        id: task.id,
        input: {
          submissionNotes: draft.note ?? undefined,
          ...(finalFileId ? { finalFileId } : {}),
          ...(!finalFileId && draft.finalUrl ? { finalUrl: draft.finalUrl } : {}),
        },
      });
      const minutes = span ? Math.round((span.end.getTime() - span.start.getTime()) / 60_000) : 0;
      onDone({
        text:
          data.task.status === "completed"
            ? `${task.code} is completed.${minutes ? ` ${formatMinutes(minutes)} logged.` : ""}`
            : `${task.code} was sent to ${task.reviewer ?? "the creator"} for review.${minutes ? ` ${formatMinutes(minutes)} logged.` : ""}`,
        link: `/tasks?task=${task.id}`,
        taskId: task.id,
      });
    } catch (error) {
      // The server's rule (scope, manual time off, permissions …) is shown in the chat.
      onError(getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={cn("rounded-2xl border bg-card p-3 text-sm", closed && "opacity-60")}>
      <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">{card.title} · check and confirm</p>
      <dl className="mb-3 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1">
        {card.rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium whitespace-pre-line [overflow-wrap:anywhere]">{value || "—"}</dd>
          </div>
        ))}
      </dl>
      {!closed && (
        <div className="flex gap-2">
          <Button type="button" variant="outline" className="h-10 flex-1" onClick={onChange} disabled={saving}>
            Change
          </Button>
          <Button type="button" className="h-10 flex-1" onClick={() => void save()} disabled={saving}>
            {saving && <LuLoaderCircle aria-hidden className="animate-spin" />}
            {card.confirm}
          </Button>
        </div>
      )}
    </div>
  );
}

function formatMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h && r ? `${h}h ${r}m` : h ? `${h}h` : `${r}m`;
}

/**
 * The project's existing tasks (best match first). Tapping one offers "New task
 * like this" (its name with the next number, people and brief) or "Work on this
 * task" (close it / log time).
 */
function ExistingTasks({
  item,
  disabled,
  onPick,
}: {
  item: Extract<ChatItem, { kind: "existing" }>;
  disabled: boolean;
  onPick: (message: string) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const closed = item.state === "closed";
  return (
    <ul className={cn("divide-y overflow-hidden rounded-2xl border bg-card text-sm", closed && "opacity-60")} aria-label="Existing tasks">
      {item.tasks.map((task) => (
        <li key={task.id}>
          <button
            type="button"
            disabled={closed || disabled}
            onClick={() => setPicked((current) => (current === task.id ? null : task.id))}
            aria-expanded={picked === task.id}
            className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent"
          >
            <span className="shrink-0 font-medium">{task.code}</span>
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{task.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{task.status}</span>
          </button>
          {picked === task.id && !closed && (
            <div className="flex gap-2 px-3 pb-2">
              <Button type="button" size="sm" variant="outline" className="flex-1" disabled={disabled} onClick={() => onPick(`New task like ${task.code}`)}>
                New task like this
              </Button>
              <Button type="button" size="sm" variant="outline" className="flex-1" disabled={disabled} onClick={() => onPick(`Work on ${task.code}`)}>
                Work on this task
              </Button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
