import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  LuLoaderCircle,
  LuLock,
  LuNotebookPen,
  LuPencil,
  LuPin,
  LuPinOff,
  LuPlus,
  LuSave,
  LuTrash2,
} from "react-icons/lu";

import { formatDateTime } from "@/lib/format";
import { EmptyState, QueryError } from "@/components/globals/query-states";
import {
  CommentBody,
  EMPTY_DRAFT,
  MentionTextarea,
  bodyToDraft,
  draftToBody,
  type MentionDraft,
} from "@/components/tasks/mention-textarea";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  useAddTaskNote,
  useDeleteTaskNote,
  useMentionableUsers,
  useTaskNotes,
  useUpdateTaskNote,
} from "@/hooks/use-tasks";
import { cn } from "@/lib/utils";
import type { MentionableUser, Role, TaskNote, TaskNoteVisibility } from "@/types";

const MAX_TITLE = 150;
const MAX_BODY = 10_000;
/** Bodies longer than this start collapsed. */
const COLLAPSE_AT = 400;

/** Notes tab: longer-lived reference text (specs, decisions, links), pinned first. */
export function TaskNotes({
  taskId,
  me,
  readOnly,
}: {
  taskId: string;
  me: { _id: string; role: Role };
  readOnly?: boolean;
}) {
  const notes = useTaskNotes(taskId);
  const mentionable = useMentionableUsers(taskId);
  const [composing, setComposing] = useState(false);
  const [deleting, setDeleting] = useState<TaskNote | null>(null);
  const users = (mentionable.data ?? []).filter((user) => user._id !== me._id);
  const items = notes.data ?? [];

  return (
    <div className="space-y-4">
      {!readOnly && (
        composing ? (
          <NoteEditor taskId={taskId} users={users} onDone={() => setComposing(false)} />
        ) : (
          items.length > 0 && (
            <div className="flex justify-end">
              <Button size="sm" variant="outline" onClick={() => setComposing(true)}>
                <LuPlus aria-hidden />
                Add note
              </Button>
            </div>
          )
        )
      )}

      {notes.isPending ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading notes">
          {Array.from({ length: 2 }).map((_, index) => (
            <Skeleton key={index} className="h-28 w-full rounded-lg" />
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
        !composing && (
          <EmptyState
            icon={LuNotebookPen}
            title="No notes yet"
            description="Keep specs, decisions and handy links here."
            className="py-8"
          >
            {!readOnly && (
              <Button size="sm" onClick={() => setComposing(true)}>
                <LuPlus aria-hidden />
                Add note
              </Button>
            )}
          </EmptyState>
        )
      ) : (
        <ul className="space-y-3" aria-label="Notes">
          {items.map((note) => (
            <NoteCard
              key={note._id}
              taskId={taskId}
              note={note}
              users={users}
              readOnly={readOnly}
              onDelete={() => setDeleting(note)}
            />
          ))}
        </ul>
      )}

      <DeleteNoteDialog taskId={taskId} note={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}

function NoteEditor({
  taskId,
  users,
  note,
  onDone,
}: {
  taskId: string;
  users: MentionableUser[];
  /** Null/undefined = new note. */
  note?: TaskNote;
  onDone: () => void;
}) {
  const add = useAddTaskNote(taskId);
  const update = useUpdateTaskNote(taskId);
  const [title, setTitle] = useState(note?.title ?? "");
  const [draft, setDraft] = useState<MentionDraft>(note ? bodyToDraft(note.body) : EMPTY_DRAFT);
  const [visibility, setVisibility] = useState<TaskNoteVisibility>(note?.visibility ?? "task");
  const [submitted, setSubmitted] = useState(false);
  const pending = add.isPending || update.isPending;
  const body = draftToBody(draft);
  const idBase = note ? `note-${note._id}` : "note-new";

  const bodyError = !body ? "Write something first." : body.length > MAX_BODY ? `Keep it under ${MAX_BODY.toLocaleString()} characters.` : null;
  const titleError = title.trim().length > MAX_TITLE ? `Keep the title under ${MAX_TITLE} characters.` : null;

  function save() {
    setSubmitted(true);
    if (bodyError || titleError || pending) return;
    const input = { title: title.trim(), body, visibility };
    if (note) {
      update.mutate({ noteId: note._id, input }, { onSuccess: onDone });
    } else {
      add.mutate(input, { onSuccess: onDone });
    }
  }

  return (
    <div className="space-y-3 rounded-lg border bg-card p-3">
      <div className="space-y-1.5">
        <Label htmlFor={`${idBase}-title`}>
          Title <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id={`${idBase}-title`}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={MAX_TITLE}
          placeholder="e.g. API contract"
          aria-invalid={Boolean(titleError) || undefined}
          disabled={pending}
          autoFocus
        />
        {titleError && <p className="text-xs text-destructive">{titleError}</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idBase}-body`}>Note</Label>
        <MentionTextarea
          id={`${idBase}-body`}
          value={draft}
          onChange={setDraft}
          users={visibility === "private" ? [] : users}
          onSubmit={save}
          rows={5}
          placeholder="Specs, decisions, where things live…"
          aria-label="Note text"
          disabled={pending}
        />
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-destructive">{submitted && bodyError ? bodyError : ""}</span>
          <span className={cn("tabular-nums", body.length > MAX_BODY ? "text-destructive" : "text-muted-foreground")}>
            {body.length.toLocaleString()}/{MAX_BODY.toLocaleString()}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Switch
            id={`${idBase}-private`}
            checked={visibility === "private"}
            onCheckedChange={(checked) => setVisibility(checked ? "private" : "task")}
            disabled={pending}
            aria-describedby={`${idBase}-private-hint`}
          />
          <Label htmlFor={`${idBase}-private`} className="text-sm font-normal">
            Private (only me)
          </Label>
          <span id={`${idBase}-private-hint`} className="sr-only">
            Private notes are visible to you and admins only; mentions are ignored.
          </span>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onDone} disabled={pending}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={pending}>
            {pending ? (
              <LuLoaderCircle aria-hidden className="animate-spin" />
            ) : note ? (
              <LuSave aria-hidden />
            ) : (
              <LuPlus aria-hidden />
            )}
            {note ? "Save" : "Add note"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function NoteCard({
  taskId,
  note,
  users,
  readOnly,
  onDelete,
}: {
  taskId: string;
  note: TaskNote;
  users: MentionableUser[];
  readOnly?: boolean;
  onDelete: () => void;
}) {
  const update = useUpdateTaskNote(taskId);
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const long = note.body.length > COLLAPSE_AT || note.body.split("\n").length > 8;
  const bodyId = `note-body-${note._id}`;

  if (editing) {
    return (
      <li>
        <NoteEditor taskId={taskId} users={users} note={note} onDone={() => setEditing(false)} />
      </li>
    );
  }

  return (
    <li
      className={cn(
        "group/note rounded-lg border bg-card p-3 text-card-foreground",
        note.pinned && "border-primary/40 bg-primary/5"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          {note.title && <h4 className="text-sm font-semibold break-words text-foreground">{note.title}</h4>}
          {(note.pinned || note.visibility === "private") && (
            <div className="flex flex-wrap gap-1.5">
              {note.pinned && (
                <Badge variant="secondary" className="gap-1">
                  <LuPin aria-hidden className="size-3" />
                  Pinned
                </Badge>
              )}
              {note.visibility === "private" && (
                <Badge variant="outline" className="gap-1">
                  <LuLock aria-hidden className="size-3" />
                  Private
                </Badge>
              )}
            </div>
          )}
        </div>
        {!readOnly && (note.canPin || note.canEdit || note.canDelete) && (
          <div className="flex shrink-0 items-center gap-0.5">
            {note.canPin && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => update.mutate({ noteId: note._id, input: { pinned: !note.pinned } })}
                disabled={update.isPending}
                aria-label={note.pinned ? "Unpin note" : "Pin note"}
                aria-pressed={note.pinned}
              >
                {update.isPending ? (
                  <LuLoaderCircle aria-hidden className="animate-spin" />
                ) : note.pinned ? (
                  <LuPinOff aria-hidden />
                ) : (
                  <LuPin aria-hidden />
                )}
              </Button>
            )}
            {note.canEdit && (
              <Button variant="ghost" size="icon-sm" onClick={() => setEditing(true)} aria-label="Edit note">
                <LuPencil aria-hidden />
              </Button>
            )}
            {note.canDelete && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onDelete}
                aria-label="Delete note"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <LuTrash2 aria-hidden />
              </Button>
            )}
          </div>
        )}
      </div>

      <div id={bodyId} className={cn("mt-2", long && !expanded && "line-clamp-6")}>
        <CommentBody body={note.body} />
      </div>
      {long && (
        <button
          type="button"
          className="mt-1 rounded-sm text-xs font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:underline"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-controls={bodyId}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}

      <div className="mt-3 flex items-center gap-2 border-t pt-2 text-xs text-muted-foreground">
        <UserAvatar user={note.author ?? { name: "?" }} />
        <span className="min-w-0 truncate">
          <span className="font-medium text-foreground">{note.author?.name ?? "Deleted user"}</span> ·{" "}
          <time dateTime={note.createdAt} title={formatDateTime(note.createdAt)}>
            {formatDistanceToNow(new Date(note.createdAt), { addSuffix: true })}
          </time>
          {note.editedAt && (
            <span title={`Edited ${formatDateTime(note.editedAt)}`}> · edited</span>
          )}
        </span>
      </div>
    </li>
  );
}

function DeleteNoteDialog({
  taskId,
  note,
  onClose,
}: {
  taskId: string;
  note: TaskNote | null;
  onClose: () => void;
}) {
  const remove = useDeleteTaskNote(taskId);
  return (
    <AlertDialog open={note !== null} onOpenChange={(open) => !open && !remove.isPending && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this note?</AlertDialogTitle>
          <AlertDialogDescription>
            {note?.title ? <>&ldquo;{note.title}&rdquo;</> : "This note"} will be removed for everyone. This
            can&apos;t be undone.
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
