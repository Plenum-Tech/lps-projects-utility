import { useEffect, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  LuCircleAlert,
  LuLoaderCircle,
  LuMessageSquare,
  LuPencil,
  LuRefreshCw,
  LuSend,
  LuTrash2,
} from "react-icons/lu";

import {
  CommentBody,
  EMPTY_DRAFT,
  MentionTextarea,
  bodyToDraft,
  draftToBody,
  type MentionDraft,
} from "@/components/tasks/mention-textarea";
import { formatDateTime } from "@/lib/format";
import { UserAvatar } from "@/components/tasks/task-badges";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useAddComment,
  useDeleteComment,
  useMentionableUsers,
  useTaskComments,
  useUpdateComment,
} from "@/hooks/use-tasks";
import { getErrorMessage } from "@/lib/api";
import type { MentionableUser, Role, TaskComment } from "@/types";

const MAX_BODY = 5000;

/** Comment thread (oldest first) with an @mention composer (none when `readOnly`). */
export function TaskComments({
  taskId,
  me,
  readOnly = false,
}: {
  taskId: string;
  me: { _id: string; role: Role };
  /** View-only task: just the thread (the server refuses mentions and writes). */
  readOnly?: boolean;
}) {
  const comments = useTaskComments(taskId);
  const mentionable = useMentionableUsers(readOnly ? null : taskId);
  const addComment = useAddComment(taskId);
  const [draft, setDraft] = useState<MentionDraft>(EMPTY_DRAFT);
  const endRef = useRef<HTMLDivElement>(null);
  const count = comments.data?.comments.length ?? 0;

  // Keep the newest comment in view.
  useEffect(() => {
    if (count > 0) endRef.current?.scrollIntoView({ block: "nearest" });
  }, [count]);

  const users = (mentionable.data ?? []).filter((user) => user._id !== me._id);
  const body = draftToBody(draft);
  const tooLong = body.length > MAX_BODY;

  function submit() {
    if (!body || tooLong || addComment.isPending) return;
    addComment.mutate(body, { onSuccess: () => setDraft(EMPTY_DRAFT) });
  }

  return (
    <div className="space-y-4">
      {comments.isPending ? (
        <div className="space-y-4" aria-busy="true" aria-label="Loading comments">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="flex gap-3">
              <Skeleton className="size-6 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-4 w-full" />
              </div>
            </div>
          ))}
        </div>
      ) : comments.isError ? (
        <Alert variant="destructive">
          <LuCircleAlert aria-hidden className="size-4" />
          <AlertTitle>Couldn&apos;t load comments</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            {getErrorMessage(comments.error)}
            <Button variant="outline" size="sm" onClick={() => void comments.refetch()}>
              <LuRefreshCw aria-hidden />
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : count === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center">
          <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <LuMessageSquare aria-hidden className="size-4" />
          </span>
          <p className="text-sm font-medium text-foreground">No comments yet</p>
          <p className="text-xs text-muted-foreground">
            {readOnly ? "Nobody has commented on this task." : "Start the conversation — mention a teammate with @."}
          </p>
        </div>
      ) : (
        <ol className="space-y-4" aria-label="Comments">
          {comments.data?.comments.map((comment) => (
            <CommentItem
              key={comment._id}
              taskId={taskId}
              comment={comment}
              me={me}
              users={users}
              readOnly={readOnly}
            />
          ))}
        </ol>
      )}
      <div ref={endRef} aria-hidden />

      {!readOnly && (
        <div className="space-y-2 border-t pt-4">
          <MentionTextarea
            id="task-comment"
            value={draft}
            onChange={setDraft}
            users={users}
            onSubmit={submit}
            placeholder="Write a comment…"
            aria-label="Write a comment"
            disabled={addComment.isPending}
          />
          <div className="flex items-center justify-between gap-2">
            <span className={`text-xs ${tooLong ? "text-destructive" : "text-muted-foreground"}`}>
              {tooLong ? `Too long (${body.length}/${MAX_BODY})` : ""}
            </span>
            <Button onClick={submit} disabled={!body || tooLong || addComment.isPending} size="sm">
              {addComment.isPending ? (
                <LuLoaderCircle aria-hidden className="animate-spin" />
              ) : (
                <LuSend aria-hidden />
              )}
              Comment
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function CommentItem({
  taskId,
  comment,
  me,
  users,
  readOnly,
}: {
  taskId: string;
  comment: TaskComment;
  me: { _id: string; role: Role };
  users: MentionableUser[];
  readOnly: boolean;
}) {
  const update = useUpdateComment(taskId);
  const remove = useDeleteComment(taskId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<MentionDraft>(EMPTY_DRAFT);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // View-only tasks: no edits or deletes, even on the caller's own older comments.
  const isAuthor = !readOnly && comment.author?._id === me._id;
  const canDelete = !readOnly && (isAuthor || me.role === "admin");

  function save() {
    const body = draftToBody(draft);
    if (!body || body.length > MAX_BODY) return;
    if (body === comment.body) {
      setEditing(false);
      return;
    }
    update.mutate({ commentId: comment._id, body }, { onSuccess: () => setEditing(false) });
  }

  return (
    <li className="group/comment flex gap-3">
      <UserAvatar user={comment.author ?? { name: "?" }} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium text-foreground">
            {comment.author?.name ?? "Deleted user"}
          </span>
          <time
            dateTime={comment.createdAt}
            className="text-xs text-muted-foreground"
            title={formatDateTime(comment.createdAt)}
          >
            {formatDistanceToNow(new Date(comment.createdAt), { addSuffix: true })}
          </time>
          {comment.editedAt && <span className="text-xs text-muted-foreground">(edited)</span>}
        </div>

        {editing ? (
          <div className="mt-1.5 space-y-2">
            <MentionTextarea
              id={`edit-comment-${comment._id}`}
              value={draft}
              onChange={setDraft}
              users={users}
              onSubmit={save}
              aria-label="Edit comment"
              autoFocus
              disabled={update.isPending}
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditing(false)}
                disabled={update.isPending}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={save} disabled={update.isPending}>
                {update.isPending && <LuLoaderCircle aria-hidden className="animate-spin" />}
                Save
              </Button>
            </div>
          </div>
        ) : (
          <CommentBody body={comment.body} className="mt-0.5" />
        )}

        {!editing && (isAuthor || canDelete) && (
          <div className="mt-1 flex items-center gap-1 opacity-100 transition-opacity duration-150 sm:opacity-0 sm:group-focus-within/comment:opacity-100 sm:group-hover/comment:opacity-100">
            {isAuthor && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setDraft(bodyToDraft(comment.body));
                  setEditing(true);
                }}
              >
                <LuPencil aria-hidden />
                Edit
              </Button>
            )}
            {canDelete &&
              (confirmDelete ? (
                <>
                  <Button
                    variant="destructive"
                    size="xs"
                    onClick={() => remove.mutate(comment._id)}
                    disabled={remove.isPending}
                  >
                    {remove.isPending ? (
                      <LuLoaderCircle aria-hidden className="animate-spin" />
                    ) : (
                      <LuTrash2 aria-hidden />
                    )}
                    Confirm delete
                  </Button>
                  <Button variant="ghost" size="xs" onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button variant="ghost" size="xs" onClick={() => setConfirmDelete(true)}>
                  <LuTrash2 aria-hidden />
                  Delete
                </Button>
              ))}
          </div>
        )}
      </div>
    </li>
  );
}
