import { useId, useMemo, useState, type FormEvent } from "react";
import { LuLoaderCircle, LuSave } from "react-icons/lu";

import { QueryError } from "@/components/globals/query-states";
import { SpeakerMapping, type SpeakerRow } from "@/components/meetings/speaker-mapping";
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
import { Skeleton } from "@/components/ui/skeleton";
import { useMeeting, useMeetingAssignees, useUpdateMeeting } from "@/hooks/use-meetings";
import { useProjectOptions } from "@/hooks/use-projects";
import type { MeetingDetail, MeetingUpdateInput } from "@/types";

const NO_PROJECT = "__none";

/** Edit title, date, project and the speaker → user mapping. Loads the detail itself. */
export function MeetingEditDialog({
  meetingId,
  open,
  onOpenChange,
}: {
  meetingId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const detail = useMeeting(open ? meetingId : null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit meeting</DialogTitle>
          <DialogDescription>
            Changing a speaker&apos;s user also updates the owner of their open suggestions.
          </DialogDescription>
        </DialogHeader>
        {detail.isPending ? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading meeting">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-2/3" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : detail.isError ? (
          <QueryError
            title="Couldn't load the meeting"
            error={detail.error}
            onRetry={() => void detail.refetch()}
            retrying={detail.isRefetching}
          />
        ) : (
          <EditForm
            key={detail.data.meeting.updatedAt}
            meeting={detail.data.meeting}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditForm({ meeting, onDone }: { meeting: MeetingDetail; onDone: () => void }) {
  const id = useId();
  const update = useUpdateMeeting(meeting._id);
  const projects = useProjectOptions();
  const people = useMeetingAssignees(meeting._id);

  const [title, setTitle] = useState(meeting.title);
  const [meetingDate, setMeetingDate] = useState(meeting.meetingDate);
  const [project, setProject] = useState(meeting.project?._id ?? NO_PROJECT);
  const [speakers, setSpeakers] = useState<SpeakerRow[]>(() =>
    meeting.speakers.map((speaker) => ({
      name: speaker.name,
      user: speaker.user?._id ?? null,
      current: speaker.user,
    }))
  );

  const projectItems = useMemo(() => {
    const items: Record<string, string> = { [NO_PROJECT]: "No project — private to the creator and admins" };
    for (const option of projects.data ?? []) items[option._id] = `${option.code} · ${option.name}`;
    if (meeting.project && !items[meeting.project._id]) {
      items[meeting.project._id] = `${meeting.project.code} · ${meeting.project.name}`;
    }
    return items;
  }, [projects.data, meeting.project]);

  const titleInvalid = !title.trim() || title.length > 200;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (titleInvalid) return;
    const input: MeetingUpdateInput = {};
    if (title.trim() !== meeting.title) input.title = title.trim();
    if (meetingDate && meetingDate !== meeting.meetingDate) input.meetingDate = meetingDate;
    const nextProject = project === NO_PROJECT ? null : project;
    if (nextProject !== (meeting.project?._id ?? null)) input.project = nextProject;
    const changed = speakers.filter(
      (row) => row.user !== (meeting.speakers.find((speaker) => speaker.name === row.name)?.user?._id ?? null)
    );
    if (changed.length) input.speakers = changed.map((row) => ({ name: row.name, user: row.user }));
    if (Object.keys(input).length === 0) {
      onDone();
      return;
    }
    update.mutate(input, { onSuccess: onDone });
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-title`}>Title</Label>
        <Input
          id={`${id}-title`}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={200}
          aria-invalid={titleInvalid || undefined}
        />
        {titleInvalid && <p className="text-xs text-destructive">A title is required (max 200 characters).</p>}
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
          <Select value={project} onValueChange={(value) => setProject(String(value ?? NO_PROJECT))} items={projectItems}>
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

      {speakers.length > 0 && (
        <section aria-labelledby={`${id}-speakers`} className="space-y-2">
          <h3 id={`${id}-speakers`} className="text-sm font-medium text-foreground">
            Speakers
          </h3>
          <SpeakerMapping
            rows={speakers}
            onChange={(name, user) =>
              setSpeakers((current) => current.map((row) => (row.name === name ? { ...row, user } : row)))
            }
            people={people.data ?? []}
            loading={people.isPending}
            disabled={update.isPending}
          />
        </section>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={update.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={update.isPending || titleInvalid}>
          {update.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuSave aria-hidden />}
          {update.isPending ? "Saving…" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  );
}
