import { useEffect, useMemo, useState, type FormEvent } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  LuLoaderCircle,
  LuLock,
  LuNotebookPen,
  LuPencil,
  LuPlus,
  LuSave,
  LuTrash2,
  LuUsers,
} from "react-icons/lu";

import { formatDateTime } from "@/lib/format";
import { MultiSelect, type MultiSelectOption } from "@/components/globals/multi-select";
import { EmptyState, QueryError } from "@/components/globals/query-states";
import { FieldError, OptionSelect } from "@/components/projects/project-fields";
import { UserAvatar } from "@/components/tasks/task-badges";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentUser } from "@/hooks/use-auth";
import { useDeleteProjectNote, useProjectNotes, useSaveProjectNote } from "@/hooks/use-projects";
import type { NoteVisibility, Project, ProjectNote } from "@/types";

const MAX_BODY = 10_000;

/** Notes tab: shared or private notes with add/edit/delete. */
export function ProjectNotes({ project, canAdd }: { project: Project; canAdd: boolean }) {
  const notes = useProjectNotes(project._id);
  const readOnly = Boolean(project.archivedAt);
  const [editing, setEditing] = useState<ProjectNote | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [deleting, setDeleting] = useState<ProjectNote | null>(null);
  const items = notes.data ?? [];

  function openCreate() {
    setEditing(null);
    setFormOpen(true);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-heading text-lg font-semibold">Notes</h2>
          <p className="text-sm text-muted-foreground">
            Decisions, meeting notes and context — shared with the team or kept private.
          </p>
        </div>
        {canAdd && items.length > 0 && (
          <Button onClick={openCreate}>
            <LuPlus aria-hidden />
            Add note
          </Button>
        )}
      </div>

      {notes.isPending ? (
        <div className="grid gap-3 md:grid-cols-2" aria-busy="true" aria-label="Loading notes">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-36 w-full rounded-xl" />
          ))}
        </div>
      ) : notes.isError ? (
        <QueryError
          title="Couldn't load notes"
          error={notes.error}
          onRetry={() => void notes.refetch()}
          retrying={notes.isRefetching}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={LuNotebookPen}
          title="No notes yet"
          description={canAdd ? "Write the first note for the team." : "Nothing has been written yet."}
        >
          {canAdd && (
            <Button onClick={openCreate}>
              <LuPlus aria-hidden />
              Add note
            </Button>
          )}
        </EmptyState>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {items.map((note) => (
            <li key={note._id} className="flex flex-col rounded-xl border bg-card p-4 text-card-foreground">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <h3 className="font-medium break-words">{note.title}</h3>
                  {note.visibility === "private" ? (
                    <Badge variant="outline" className="gap-1">
                      <LuLock aria-hidden className="size-3" />
                      Private
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="gap-1">
                      <LuUsers aria-hidden className="size-3" />
                      All members
                    </Badge>
                  )}
                </div>
                {note.canEdit && !readOnly && (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Edit ${note.title}`}
                      onClick={() => {
                        setEditing(note);
                        setFormOpen(true);
                      }}
                    >
                      <LuPencil aria-hidden />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${note.title}`}
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setDeleting(note)}
                    >
                      <LuTrash2 aria-hidden />
                    </Button>
                  </div>
                )}
              </div>
              {note.body && (
                <p className="mt-3 line-clamp-[12] text-sm break-words whitespace-pre-wrap text-foreground">
                  {note.body}
                </p>
              )}
              {note.visibility === "private" && note.sharedWith.length > 0 && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Shared with {note.sharedWith.map((user) => user.name).join(", ")}
                </p>
              )}
              <div aria-hidden className="flex-1" />
              <div className="mt-4 flex items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
                <UserAvatar user={note.author} />
                <span className="truncate">
                  <span className="font-medium text-foreground">{note.author.name}</span> ·{" "}
                  <time dateTime={note.updatedAt} title={formatDateTime(note.updatedAt)}>
                    {note.updatedAt !== note.createdAt ? "edited " : ""}
                    {formatDistanceToNow(new Date(note.updatedAt), { addSuffix: true })}
                  </time>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <NoteFormDialog project={project} note={editing} open={formOpen} onOpenChange={setFormOpen} />
      <DeleteNoteDialog projectId={project._id} note={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}

function NoteFormDialog({
  project,
  note,
  open,
  onOpenChange,
}: {
  project: Project;
  note: ProjectNote | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const save = useSaveProjectNote(project._id);
  const { data: me } = useCurrentUser();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<NoteVisibility>("members");
  const [sharedWith, setSharedWith] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(note?.title ?? "");
    setBody(note?.body ?? "");
    setVisibility(note?.visibility ?? "members");
    setSharedWith(note?.sharedWith.map((user) => user._id) ?? []);
    setSubmitted(false);
  }, [open, note]);

  const shareOptions = useMemo<MultiSelectOption[]>(() => {
    const options = new Map<string, MultiSelectOption>();
    for (const member of project.members) {
      if (member.user._id === me?._id) continue;
      options.set(member.user._id, {
        value: member.user._id,
        label: member.user.name,
        description: member.user.email,
      });
    }
    for (const user of note?.sharedWith ?? []) {
      if (!options.has(user._id)) {
        options.set(user._id, { value: user._id, label: user.name, description: user.email });
      }
    }
    return [...options.values()];
  }, [project.members, note, me?._id]);

  const titleError = title.trim() ? (title.length > 200 ? "Max 200 characters." : null) : "A title is required.";
  const bodyError = body.length > MAX_BODY ? `Keep it under ${MAX_BODY.toLocaleString()} characters.` : null;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (titleError || bodyError) return;
    save.mutate(
      {
        id: note?._id,
        input: {
          title: title.trim(),
          body,
          visibility,
          sharedWith: visibility === "private" ? sharedWith : [],
        },
      },
      { onSuccess: () => onOpenChange(false) }
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !save.isPending && onOpenChange(next)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{note ? "Edit note" : "New note"}</DialogTitle>
          <DialogDescription>Plain text. People you share a private note with are notified.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="note-title">Title</Label>
            <Input
              id="note-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
              aria-invalid={(submitted && Boolean(titleError)) || undefined}
              autoFocus
            />
            {submitted && titleError && <FieldError>{titleError}</FieldError>}
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="note-body">Note</Label>
              <span
                className={
                  body.length > MAX_BODY ? "text-xs text-destructive" : "text-xs text-muted-foreground"
                }
                aria-live="polite"
              >
                {body.length.toLocaleString()}/{MAX_BODY.toLocaleString()}
              </span>
            </div>
            <Textarea
              id="note-body"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={8}
              aria-invalid={Boolean(bodyError) || undefined}
            />
            {bodyError && <FieldError>{bodyError}</FieldError>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="note-visibility">Visibility</Label>
            <OptionSelect
              id="note-visibility"
              value={visibility}
              onChange={(value) => setVisibility(value as NoteVisibility)}
              options={[
                {
                  value: "members",
                  label: "All members",
                  description: "Everyone who can view the project",
                },
                {
                  value: "private",
                  label: "Private",
                  description: "Only you, people you share with, and admins",
                },
              ]}
            />
          </div>
          {visibility === "private" && (
            <div className="space-y-1.5">
              <Label htmlFor="note-shared">Share with</Label>
              <MultiSelect
                id="note-shared"
                options={shareOptions}
                value={sharedWith}
                onValueChange={setSharedWith}
                placeholder="Pick project members (optional)…"
                emptyText="No members found."
              />
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={save.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? (
                <LuLoaderCircle aria-hidden className="animate-spin" />
              ) : note ? (
                <LuSave aria-hidden />
              ) : (
                <LuPlus aria-hidden />
              )}
              {note ? "Save" : "Add note"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteNoteDialog({
  projectId,
  note,
  onClose,
}: {
  projectId: string;
  note: ProjectNote | null;
  onClose: () => void;
}) {
  const remove = useDeleteProjectNote(projectId);
  return (
    <AlertDialog open={note !== null} onOpenChange={(open) => !open && !remove.isPending && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this note?</AlertDialogTitle>
          <AlertDialogDescription>
            &ldquo;{note?.title}&rdquo; will be removed for everyone. This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => note && remove.mutate(note._id, { onSuccess: onClose })}
          >
            {remove.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuTrash2 aria-hidden />}
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
