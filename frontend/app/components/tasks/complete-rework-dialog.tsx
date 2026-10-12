import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LuCircleCheck, LuLoaderCircle } from "react-icons/lu";

import { ACCEPT } from "@/components/tasks/task-files";
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
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useUpdateSubtask, useUploadSubtaskFiles } from "@/hooks/use-tasks";
import { api, getErrorMessage } from "@/lib/api";
import type { Subtask, Task } from "@/types";

/**
 * Ticking a rework item off needs a record of the work: a note, a file, or the
 * time spent (logged against the rework). Any one of them is enough.
 */
export function CompleteReworkDialog({
  task,
  subtask,
  existingFiles,
  open,
  onOpenChange,
}: {
  task: Task;
  subtask: Subtask;
  /** Files already attached to this rework item. */
  existingFiles: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const update = useUpdateSubtask(task._id);
  const upload = useUploadSubtaskFiles(task._id);
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [hours, setHours] = useState("");
  const [minutes, setMinutes] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setNote(subtask.completionNote ?? "");
      setFiles([]);
      setHours("");
      setMinutes("");
      setSubmitted(false);
    }
  }, [open, subtask.completionNote]);

  const h = hours.trim() === "" ? 0 : Number(hours);
  const m = minutes.trim() === "" ? 0 : Number(minutes);
  const timeInvalid = !Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0 || m > 59 || h > 23;
  const spent = timeInvalid ? 0 : h * 60 + m;
  const nothing = !note.trim() && files.length === 0 && spent === 0 && existingFiles === 0;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (nothing || timeInvalid || saving) return;
    setSaving(true);
    try {
      if (files.length > 0) await upload.mutateAsync({ subId: subtask._id, files });
      if (spent > 0) {
        const end = new Date();
        const start = new Date(end.getTime() - spent * 60_000);
        await api.post("/timelogs", {
          task: task._id,
          project: task.project?._id,
          subtask: subtask._id,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          memo: `Rework: ${subtask.title}`.slice(0, 500),
        });
        void queryClient.invalidateQueries({ queryKey: ["timelogs"] });
      }
      await update.mutateAsync({
        subId: subtask._id,
        input: { done: true, ...(note.trim() ? { completionNote: note.trim() } : {}) },
      });
      onOpenChange(false);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Complete rework</DialogTitle>
          <DialogDescription>
            &ldquo;{subtask.title}&rdquo; — add a note, a file or the time spent. Any one is enough.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="rework-done-note">Note</Label>
            <Textarea
              id="rework-done-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="What was changed?"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rework-done-files">Attach files</Label>
            <Input
              id="rework-done-files"
              type="file"
              multiple
              accept={ACCEPT}
              onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 10))}
            />
            {existingFiles > 0 && (
              <p className="text-xs text-muted-foreground">
                {existingFiles} file{existingFiles === 1 ? "" : "s"} already attached.
              </p>
            )}
          </div>
          <fieldset className="space-y-1.5">
            <legend className="mb-1.5 text-sm leading-none font-medium">Time spent</legend>
            <div className="flex items-center gap-2">
              <Input
                aria-label="Hours"
                inputMode="numeric"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                placeholder="0"
                className="w-20"
              />
              <span className="text-sm text-muted-foreground">h</span>
              <Input
                aria-label="Minutes"
                inputMode="numeric"
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                placeholder="0"
                className="w-20"
              />
              <span className="text-sm text-muted-foreground">m</span>
            </div>
            <p className="text-xs text-muted-foreground">Logged on the task&apos;s Time tab, ending now.</p>
            {submitted && timeInvalid && <p className="text-xs text-destructive">Enter whole hours (0–23) and minutes (0–59).</p>}
          </fieldset>
          {submitted && nothing && (
            <p role="alert" className="text-sm text-destructive">
              Add a note, attach a file or enter the time spent.
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuCircleCheck aria-hidden />}
              Mark done
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
