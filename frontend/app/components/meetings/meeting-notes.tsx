import { useEffect, useId, useState } from "react";
import { LuLoaderCircle, LuNotebookPen, LuSave } from "react-icons/lu";

import { EmptyState } from "@/components/globals/query-states";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useUpdateMeeting } from "@/hooks/use-meetings";
import { MAX_NOTES_CHARS } from "@/lib/meetings";
import { cn } from "@/lib/utils";
import type { MeetingDetail } from "@/types";

/** Free-form meeting notes / summary. Read-only for people who can't edit the meeting. */
export function MeetingNotes({ meeting, canEdit }: { meeting: MeetingDetail; canEdit: boolean }) {
  const id = useId();
  const toast = useToast();
  const update = useUpdateMeeting(meeting._id);
  const [value, setValue] = useState(meeting.notes ?? "");
  const [dirty, setDirty] = useState(false);

  // Pick up server changes unless the user is mid-edit.
  useEffect(() => {
    if (!dirty) setValue(meeting.notes ?? "");
  }, [meeting.notes, dirty]);

  const tooLong = value.length > MAX_NOTES_CHARS;

  if (!canEdit) {
    return meeting.notes ? (
      <div className="rounded-xl border bg-card p-4">
        <p className="text-sm break-words whitespace-pre-wrap text-foreground">{meeting.notes}</p>
      </div>
    ) : (
      <EmptyState
        icon={LuNotebookPen}
        title="No notes yet"
        description="The meeting's owner can add a summary or decisions here."
        className="py-10"
      />
    );
  }

  function save() {
    if (tooLong) return;
    update.mutate(
      { notes: value.trim() ? value : null },
      {
        onSuccess: () => {
          setDirty(false);
          toast.success("Notes saved");
        },
      }
    );
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={`${id}-notes`} className="sr-only">
        Meeting notes
      </Label>
      <Textarea
        id={`${id}-notes`}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setDirty(true);
        }}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "s") {
            event.preventDefault();
            save();
          }
        }}
        rows={14}
        placeholder="Summary, decisions, open questions…"
        aria-invalid={tooLong || undefined}
        className="min-h-64"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={cn("text-xs tabular-nums", tooLong ? "text-destructive" : "text-muted-foreground")}>
          {value.length.toLocaleString()} / {MAX_NOTES_CHARS.toLocaleString()}
          {dirty && !tooLong && <span className="ml-2">· Unsaved changes</span>}
        </p>
        <div className="flex gap-2">
          {dirty && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setValue(meeting.notes ?? "");
                setDirty(false);
              }}
              disabled={update.isPending}
            >
              Discard
            </Button>
          )}
          <Button size="sm" onClick={save} disabled={!dirty || tooLong || update.isPending}>
            {update.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuSave aria-hidden />}
            Save notes
          </Button>
        </div>
      </div>
    </div>
  );
}
