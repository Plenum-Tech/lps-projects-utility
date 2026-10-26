import { useEffect, useState, type FormEvent } from "react";
import { LuLoaderCircle } from "react-icons/lu";

import { ACCEPT, MAX_FILE_SIZE } from "@/components/tasks/task-files";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { usePitchOutcome } from "@/hooks/use-brand-dashboard";
import { getErrorMessage } from "@/lib/api";
import type { PitchRow, PitchStepKey } from "@/types";

// ---------------------------------------------------------------------------
// Pitch & Growth Tracker: what happened at a step (Milestone 1 / 2 meeting,
// Client presentation). Held closes the step task with the notes as its outcome
// note (no final file or time log needed); Not held closes it with the reason;
// Rescheduled moves its date and keeps it open.
// ---------------------------------------------------------------------------

export type PitchOutcomeMode = "held" | "not_held" | "rescheduled";

export interface PitchOutcomeTarget {
  row: PitchRow;
  step: PitchStepKey;
  title: string;
  mode: PitchOutcomeMode;
}

const DURATIONS: Array<[string, string]> = [
  ["", "Don't log time"],
  ["15", "15 min"],
  ["30", "30 min"],
  ["45", "45 min"],
  ["60", "1 h"],
  ["90", "1 h 30 min"],
  ["120", "2 h"],
  ["180", "3 h"],
  ["240", "4 h"],
];

const HEADINGS: Record<PitchOutcomeMode, string> = {
  held: "Held",
  not_held: "Not held",
  rescheduled: "Rescheduled",
};

const pitchDay = (key: string) =>
  new Date(`${key}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function PitchOutcomeDialog({ target, quarter, onClose }: { target: PitchOutcomeTarget | null; quarter: string; onClose: () => void }) {
  const save = usePitchOutcome(quarter);
  const [notes, setNotes] = useState("");
  const [link, setLink] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [minutes, setMinutes] = useState("");
  const [date, setDate] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const step = target ? target.row.steps.find((s) => s.key === target.step) : undefined;
  const mode = target?.mode ?? "held";

  useEffect(() => {
    if (!target) return;
    const current = target.row.steps.find((s) => s.key === target.step);
    // Re-recording the same outcome starts from its note.
    setNotes(current?.outcome === target.mode ? (current.outcomeNote ?? "") : "");
    setLink("");
    setFile(null);
    setMinutes("");
    setDate("");
    setSubmitted(false);
    setError(null);
  }, [target]);

  const linkValue = link.trim();
  const linkInvalid = linkValue !== "" && !/^https?:\/\/\S+$/i.test(linkValue);
  const fileTooBig = Boolean(file && file.size > MAX_FILE_SIZE);
  const notesMissing = mode !== "rescheduled" && !notes.trim();
  const dateMissing = mode === "rescheduled" && !date;
  const sameDate = mode === "rescheduled" && Boolean(date) && date === step?.due;
  const invalid = notesMissing || dateMissing || sameDate || (mode === "held" && (linkInvalid || fileTooBig));

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    setError(null);
    if (!target || invalid) return;
    const input =
      mode === "held"
        ? { outcome: "held" as const, notes: notes.trim(), ...(file ? { file } : linkValue ? { link: linkValue } : {}), ...(minutes ? { minutes: Number(minutes) } : {}) }
        : mode === "not_held"
          ? { outcome: "not_held" as const, notes: notes.trim() }
          : { outcome: "rescheduled" as const, date, ...(notes.trim() ? { notes: notes.trim() } : {}) };
    save.mutate({ row: target.row, step: target.step, input }, { onSuccess: onClose, onError: (e) => setError(getErrorMessage(e)) });
  }

  const pending = save.isPending;
  return (
    <Dialog open={target !== null} onOpenChange={(next) => !next && !pending && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {target?.title}: {HEADINGS[mode]}
          </DialogTitle>
          <DialogDescription>
            {target?.row.title}
            {step?.due ? ` · ${pitchDay(step.due)}` : ""}
            {mode === "held" && " — closes the step with your notes."}
            {mode === "not_held" && " — closes the step as not held."}
            {mode === "rescheduled" && " — moves the date; the step stays open."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {mode === "rescheduled" && (
            <div className="space-y-1.5">
              <Label htmlFor="pitch-new-date">
                New date<span aria-hidden className="ml-0.5 text-destructive">*</span>
              </Label>
              <Input
                id="pitch-new-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                aria-invalid={(submitted && (dateMissing || sameDate)) || undefined}
                className="w-44"
              />
              {submitted && dateMissing && <p className="text-xs text-destructive">Pick the new date.</p>}
              {submitted && sameDate && <p className="text-xs text-destructive">That&apos;s the current date. Pick a new one.</p>}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="pitch-outcome-notes">
              {mode === "held" ? "Notes" : mode === "not_held" ? "Reason" : "Note"}
              {mode !== "rescheduled" ? (
                <span aria-hidden className="ml-0.5 text-destructive">*</span>
              ) : (
                <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
              )}
            </Label>
            <Textarea
              id="pitch-outcome-notes"
              autoFocus={mode !== "rescheduled"}
              rows={4}
              maxLength={2000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={
                mode === "held"
                  ? "What was discussed, decisions, the client's feedback, next steps…"
                  : mode === "not_held"
                    ? "Why it didn't happen (client cancelled, not needed…)"
                    : "Why it moved"
              }
              aria-invalid={(submitted && notesMissing) || undefined}
            />
            {submitted && notesMissing && (
              <p className="text-xs text-destructive">{mode === "held" ? "Write what was discussed." : "Write why it wasn't held."}</p>
            )}
          </div>

          {mode === "held" && (
            <>
              <fieldset className="space-y-2 rounded-lg border p-3">
                <legend className="px-1 text-sm font-medium">
                  Minutes or deck <span className="font-normal text-muted-foreground">(optional)</span>
                </legend>
                <Input
                  type="url"
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  placeholder="https://… (Drive, SharePoint…)"
                  aria-label="Link to the minutes or deck"
                  aria-invalid={(submitted && linkInvalid) || undefined}
                  disabled={Boolean(file)}
                />
                <Input type="file" accept={ACCEPT} aria-label="Upload the minutes or deck" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                <p className="text-xs text-muted-foreground">A link or a file (up to {MAX_FILE_SIZE / (1024 * 1024)} MB). A file is attached to the step&apos;s task.</p>
                {submitted && linkInvalid && <p className="text-xs text-destructive">The link must start with http:// or https://.</p>}
                {fileTooBig && (
                  <p className="text-xs text-destructive">
                    This file is {(file!.size / (1024 * 1024)).toFixed(1)} MB — files can be up to {MAX_FILE_SIZE / (1024 * 1024)} MB. Paste a link instead.
                  </p>
                )}
              </fieldset>

              <div className="space-y-1.5">
                <Label htmlFor="pitch-meeting-length">
                  Meeting length <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <NativeSelect id="pitch-meeting-length" value={minutes} onChange={(e) => setMinutes(e.target.value)}>
                  {DURATIONS.map(([value, label]) => (
                    <NativeSelectOption key={value} value={value}>
                      {label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <p className="text-xs text-muted-foreground">Logged as your time on the step, ending at the meeting (6 pm on a past date, otherwise now).</p>
              </div>
            </>
          )}

          {error && (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <LuLoaderCircle aria-hidden className="animate-spin" />}
              {mode === "held" ? "Mark as held" : mode === "not_held" ? "Mark as not held" : "Reschedule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
