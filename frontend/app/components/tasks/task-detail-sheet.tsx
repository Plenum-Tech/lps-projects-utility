import { CompletionSummary } from "@/components/tasks/completion-summary";
import { RichText } from "@/components/globals/rich-text";
import { useEffect, useState, type ReactNode } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  LuBellRing,
  LuCalendarDays,
  LuCircleAlert,
  LuCircleCheck,
  LuClipboardCheck,
  LuEye,
  LuFolder,
  LuFolderKanban,
  LuFlag,
  LuLoaderCircle,
  LuLock,
  LuMessagesSquare,
  LuPencil,
  LuRefreshCw,
  LuRepeat,
  LuSend,
  LuTrash2,
  LuUserPlus,
  LuMessageSquare,
  LuPaperclip,
} from "react-icons/lu";
import { Link } from "react-router";

import { ShortCode } from "@/components/projects/project-badges";
import { ActualDatesBlock } from "@/components/tasks/actual-dates";
import { TaskTimeEntries } from "@/components/tasks/task-time-entries";
import { MissingTimePrompt } from "@/components/tasks/missing-time";
import { OverScopeBanner } from "@/components/tasks/over-scope";
import { EstimateEditor } from "@/components/tasks/estimate-field";
import { LabelChip } from "@/components/tasks/label-chip";
import {
  PearityGenerateButton,
  PearityTagSection,
} from "@/components/tasks/pearity";
import {
  DeleteTaskDialog,
  ReviewTaskDialog,
  SubmitTaskDialog,
} from "@/components/tasks/task-action-dialogs";
import {
  DueDateChip,
  PriorityIndicator,
  StatusBadge,
  UserAvatar,
} from "@/components/tasks/task-badges";
import { TaskFormDialog } from "@/components/tasks/task-form-dialog";
import { TaskSubtasks } from "@/components/tasks/task-subtasks";
import { ReworkHistory, ReworkSourceBadge, reworkTaskLabel } from "@/components/tasks/rework-panel";
import { PearityJourney } from "@/components/tasks/task-history";
import { TaskTimerAction } from "@/components/tasks/task-timer-button";
import type { WorkTab } from "@/components/tasks/task-work-sections";
import { TaskComments } from "@/components/tasks/task-comments";
import { GuestBadge, InviteGuestDialog } from "@/components/tasks/invite-guest-dialog";
import { TaskFiles } from "@/components/tasks/task-files";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { PageDrawerContent } from "@/components/globals/page-drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-auth";
import { useRemindTask, useTask, useUpdateTaskStatus } from "@/hooks/use-tasks";
import { getErrorMessage } from "@/lib/api";
import { formatTimestamp } from "@/lib/meetings";
import {
  STATUS_META,
  describeRecurrence,
  formatDateOnly,
  formatEffort,
} from "@/lib/tasks";
import type { Role, Task, TaskPermissions } from "@/types";

type TabValue =
  "subtasks" | "comments" | "notes" | "files" | "time" | "history";

const TAB_VALUES: TabValue[] = [
  "subtasks",
  "comments",
  "notes",
  "files",
  "time",
  "history",
];

/**
 * Task detail side sheet — opened by the `?task=<id>` search param. Full
 * screen on mobile. Actions are driven by the server-computed permissions;
 * `access: "read"` (anyone else's task) opens it view only.
 */
export function TaskDetailSheet({
  taskId,
  me,
  onClose,
  subtaskId,
  tab,
}: {
  taskId: string | null;
  me: { _id: string; role: Role };
  onClose: () => void;
  /** `?subtask=<id>` (email links): open the Rework tab with it expanded. */
  subtaskId?: string | null;
  /** `?tab=notes` etc. */
  tab?: string | null;
}) {
  const query = useTask(taskId);

  return (
    <Sheet open={Boolean(taskId)} onOpenChange={(open) => !open && onClose()}>
      <PageDrawerContent>
        {query.isPending ? (
          <DetailSkeleton />
        ) : query.isError || !query.data ? (
          <div className="flex flex-1 flex-col gap-4 p-6">
            <SheetHeader className="p-0">
              <SheetTitle>Task unavailable</SheetTitle>
              <SheetDescription>
                It may have been deleted, or you no longer have access.
              </SheetDescription>
            </SheetHeader>
            <Alert variant="destructive">
              <LuCircleAlert aria-hidden className="size-4" />
              <AlertTitle>Couldn&apos;t open this task</AlertTitle>
              <AlertDescription className="flex flex-wrap items-center gap-2">
                {getErrorMessage(query.error)}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void query.refetch()}
                >
                  <LuRefreshCw aria-hidden />
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        ) : (
          <TaskDetail
            key={query.data.task._id}
            task={query.data.task}
            permissions={query.data.permissions}
            viewOnly={query.data.access === "read"}
            me={me}
            onClose={onClose}
            subtaskId={subtaskId ?? null}
            initialTab={
              subtaskId
                ? "subtasks"
                : TAB_VALUES.includes(tab as TabValue)
                  ? (tab as TabValue)
                  : "subtasks"
            }
          />
        )}
      </PageDrawerContent>
    </Sheet>
  );
}

function TaskDetail({
  task,
  permissions,
  viewOnly,
  me,
  onClose,
  subtaskId,
  initialTab,
}: {
  task: Task;
  permissions: TaskPermissions;
  /** Opened without view access (server `access: "read"`): no actions at all. */
  viewOnly: boolean;
  me: { _id: string; role: Role };
  onClose: () => void;
  subtaskId: string | null;
  initialTab: TabValue;
}) {
  const [dialog, setDialog] = useState<
    "edit" | "update" | "submit" | "review" | "delete" | "rework" | "invite" | null
  >(null);
  // Outside guests work from this sheet (time, files, comments, submit) — no edit form, project or Pearity.
  const guest = Boolean(useCurrentUser().data?.isGuest);
  // Comments, files and time live in Edit (editors) / Update (others).
  const workTab: WorkTab | undefined =
    initialTab === "comments" || initialTab === "files" || initialTab === "time" ? initialTab : undefined;
  const isWorker = task.assignees.some((a) => a._id === me._id);
  const canWork =
    !guest &&
    !permissions.readOnly &&
    !viewOnly &&
    (permissions.canEdit || Boolean(permissions.canLogTime) || isWorker);
  useEffect(() => {
    // Links to ?tab=comments|files|time open the form on that section.
    if (workTab && canWork) setDialog(permissions.canEdit ? "edit" : "update");
  }, [workTab]); // eslint-disable-line react-hooks/exhaustive-deps
  const updateStatus = useUpdateTaskStatus();
  const remind = useRemindTask();

  const moveTargets = permissions.allowedStatuses.filter(
    (status) => status !== task.status,
  );
  const canReviewNow = permissions.canReview && task.status === "in_review";
  // Rework is a new task in the same project, so it needs task-create rights there.
  const canAddRework =
    Boolean(task.project) && !permissions.readOnly && !viewOnly && Boolean(permissions.canDuplicate);

  return (
    <>
      <div className="show-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 pt-12 sm:p-6 lg:pt-6">
        <SheetHeader className="gap-3 rounded-xl border bg-card p-4 shadow-xs sm:p-6">
          <div className="flex flex-wrap items-center gap-2">
            {task.shortCode && <ShortCode code={task.shortCode} />}
            {task.tag && (
              <span
                className="rounded-md border px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                title="Task tag (brand, month, type, project name, scope unit and quantity) — the same tag Pearity uses"
              >
                {task.tag}
              </span>
            )}
            {typeof task.number === "number" && (
              <span
                className="font-mono text-xs text-muted-foreground"
                title="Task number (same as the Worksuite task id for imported tasks)"
              >
                #{task.number}
              </span>
            )}
            <StatusBadge status={task.status} />
            <PriorityIndicator priority={task.priority} />
            {task.iteration && (
              <span
                className={
                  task.iteration === "rework"
                    ? "rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 text-xs font-medium text-warn"
                    : "rounded-full border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground"
                }
              >
                {task.iteration === "rework" ? "Rework" : "New work"}
              </span>
            )}
            {task.iteration === "rework" && <ReworkSourceBadge source={task.reworkSource} />}
            {task.recurrence && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <LuRepeat aria-hidden className="size-3.5" />
                {describeRecurrence(task.recurrence)}
              </span>
            )}
          </div>
          <SheetTitle className="text-lg leading-snug font-semibold sm:text-xl">
            {task.title}
          </SheetTitle>
          <SheetDescription>
            Created by {task.assignedBy?.name ?? "someone"}{" "}
            {formatDistanceToNow(new Date(task.createdAt), { addSuffix: true })}
            {task.department && ` · ${task.department.name}`}
          </SheetDescription>
          {task.reworkOf && (
            <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
              <LuRefreshCw aria-hidden className="size-3.5" />
              Rework of
              <Link to={`/tasks?task=${task.reworkOf._id}`} className="font-medium text-foreground underline-offset-2 hover:underline">
                {reworkTaskLabel(task.reworkOf)}
              </Link>
            </p>
          )}

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {permissions.canSubmit && (
              <Button size="sm" onClick={() => setDialog("submit")}>
                <LuSend aria-hidden />
                {permissions.skipsReview
                  ? "Mark as complete"
                  : "Submit for review"}
              </Button>
            )}
            {canReviewNow && (
              <Button size="sm" onClick={() => setDialog("review")}>
                <LuClipboardCheck aria-hidden />
                Review
              </Button>
            )}
            {!viewOnly && <TaskTimerAction task={task} me={me} />}
            {moveTargets.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={updateStatus.isPending}
                    />
                  }
                >
                  {updateStatus.isPending ? (
                    <LuLoaderCircle aria-hidden className="animate-spin" />
                  ) : (
                    <LuCircleCheck aria-hidden />
                  )}
                  Move to…
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Change status</DropdownMenuLabel>
                    {moveTargets.map((status) => (
                      <DropdownMenuItem
                        key={status}
                        onClick={() => {
                          // Completing opens "Mark as complete" (time spent, final file, note).
                          if (status === "completed" && permissions.canSubmit) {
                            setDialog("submit");
                            return;
                          }
                          updateStatus.mutate({ id: task._id, status });
                        }}
                      >
                        <span
                          aria-hidden
                          className={`size-2 rounded-full ${STATUS_META[status].dot}`}
                        />
                        {STATUS_META[status].label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {!viewOnly && !guest && <PearityGenerateButton task={task} />}
            {canAddRework && (
              <Button variant="outline" size="sm" onClick={() => setDialog("rework")}>
                <LuRefreshCw aria-hidden />
                Add rework
              </Button>
            )}
            {permissions.canEdit ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDialog("edit")}
              >
                <LuPencil aria-hidden />
                Edit
              </Button>
            ) : (
              canWork && (
                <Button variant="outline" size="sm" onClick={() => setDialog("update")}>
                  <LuPencil aria-hidden />
                  Update
                </Button>
              )
            )}
            {permissions.canInviteGuests && !viewOnly && (
              <Button variant="outline" size="sm" onClick={() => setDialog("invite")}>
                <LuUserPlus aria-hidden />
                Invite outside person
              </Button>
            )}
            {permissions.canRemind && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => remind.mutate(task._id)}
                disabled={remind.isPending || task.status === "completed"}
              >
                {remind.isPending ? (
                  <LuLoaderCircle aria-hidden className="animate-spin" />
                ) : (
                  <LuBellRing aria-hidden />
                )}
                Send reminder
              </Button>
            )}
            {permissions.canDelete && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setDialog("delete")}
              >
                <LuTrash2 aria-hidden />
                Delete
              </Button>
            )}
          </div>
          {permissions.readOnly ? (
            <p className="flex items-center gap-1.5 rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <LuLock aria-hidden className="size-3.5" />
              This task belongs to an archived project and is read-only.
            </p>
          ) : (
            viewOnly && (
              <p className="flex items-center gap-1.5 rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                <LuEye aria-hidden className="size-3.5" />
                View only — you aren&apos;t on this task, so you can read it but not change it.
              </p>
            )
          )}
          {task.lastManualReminderAt && permissions.canRemind && (
            <p className="text-xs text-muted-foreground">
              Last reminder sent{" "}
              {formatDistanceToNow(new Date(task.lastManualReminderAt), {
                addSuffix: true,
              })}
            </p>
          )}
        </SheetHeader>

        <section className="rounded-xl border bg-card shadow-xs">
          <h3 className="border-b px-4 py-4 text-lg font-medium sm:px-6">
            Task Info
          </h3>
          <div className="space-y-5 p-4 sm:p-6">
            {/* Facts */}
            <dl className="grid grid-cols-1 gap-x-6 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <Fact label="Assignees" className="sm:col-span-2 lg:col-span-4">
                <ul className="flex flex-wrap gap-2">
                  {task.assignees.map((user) => (
                    <li
                      key={user._id}
                      className="flex items-center gap-1.5 rounded-full border bg-background py-0.5 pr-2.5 pl-0.5"
                    >
                      <UserAvatar user={user} />
                      <span className="text-xs font-medium">
                        {user.name}
                        {user._id === me._id && " (you)"}
                      </span>
                      {user.isGuest && <GuestBadge />}
                    </li>
                  ))}
                </ul>
              </Fact>
              {task.project && (
                <Fact label="Project">
                  {viewOnly || guest ? (
                    // View only / guests: the caller can't open the project itself.
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <LuFolderKanban
                        aria-hidden
                        className="size-3.5 text-muted-foreground"
                      />
                      {task.project.code} · {task.project.name}
                    </span>
                  ) : (
                    <Link
                      to={`/projects/${task.project._id}`}
                      className="inline-flex items-center gap-1.5 rounded-sm font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
                    >
                      <LuFolderKanban
                        aria-hidden
                        className="size-3.5 text-muted-foreground"
                      />
                      {task.project.code} · {task.project.name}
                    </Link>
                  )}
                </Fact>
              )}
              {task.project && (
                <Fact label="Milestone">
                  {task.milestone ? (
                    <span className="inline-flex items-center gap-1.5">
                      <LuFlag
                        aria-hidden
                        className="size-3.5 text-muted-foreground"
                      />
                      {task.milestone.title}
                      {task.milestone.endDate && (
                        <span className="text-xs text-muted-foreground">
                          · ends {formatDateOnly(task.milestone.endDate)}
                        </span>
                      )}
                    </span>
                  ) : (
                    "—"
                  )}
                </Fact>
              )}
              {task.sourceMeeting &&
                typeof task.sourceMeeting.meeting === "object" && (
                  <Fact label="Source" className="sm:col-span-2 lg:col-span-4">
                    <Link
                      to={`/meetings/${task.sourceMeeting.meeting._id}${
                        task.sourceMeeting.segmentIdx !== null
                          ? `?seg=${task.sourceMeeting.segmentIdx}`
                          : ""
                      }`}
                      className="inline-flex max-w-full items-center gap-1.5 rounded-sm font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
                    >
                      <LuMessagesSquare
                        aria-hidden
                        className="size-3.5 shrink-0 text-muted-foreground"
                      />
                      <span className="truncate">
                        From meeting: {task.sourceMeeting.meeting.title}
                        {formatTimestamp(task.sourceMeeting.start) &&
                          ` · ${formatTimestamp(task.sourceMeeting.start)}`}
                      </span>
                    </Link>
                  </Fact>
                )}
              <Fact label="Planned start">
                <span className="inline-flex items-center gap-1.5">
                  <LuCalendarDays
                    aria-hidden
                    className="size-3.5 text-muted-foreground"
                  />
                  {formatDateOnly(task.startDate, true)}
                </span>
              </Fact>
              <Fact label="Due date">
                {task.dueDate ? <DueDateChip task={task} /> : "—"}
              </Fact>
              <Fact label="Estimated time">
                <EstimateEditor
                  taskId={task._id}
                  value={task.estimateMinutes}
                  canEdit={permissions.canEdit}
                />
              </Fact>
              <Fact label="Hours logged">
                <span
                  className={
                    task.estimateMinutes &&
                    (task.loggedMinutes ?? 0) > task.estimateMinutes
                      ? "font-medium text-destructive tabular-nums"
                      : "tabular-nums"
                  }
                >
                  {formatEffort(task.loggedMinutes ?? 0)}
                  {task.estimateMinutes ? (
                    <span className="text-xs font-normal text-muted-foreground">
                      {" "}
                      of {formatEffort(task.estimateMinutes)}
                    </span>
                  ) : null}
                </span>
              </Fact>
              <Fact label="Category">
                {task.category ? (
                  <span className="inline-flex items-center gap-1.5">
                    <LuFolder
                      aria-hidden
                      className="size-3.5 text-muted-foreground"
                    />
                    {task.category.name}
                  </span>
                ) : (
                  "—"
                )}
              </Fact>
              <Fact label="Labels">
                {task.labels.length ? (
                  <span className="flex flex-wrap gap-1">
                    {task.labels.map((label) => (
                      <LabelChip
                        key={label._id}
                        name={label.name}
                        color={label.color}
                      />
                    ))}
                  </span>
                ) : (
                  "—"
                )}
              </Fact>
            </dl>

            <OverScopeBanner task={task} />

            <MissingTimePrompt task={task} />

            <ActualDatesBlock task={task} permissions={permissions} />

            {/* Every time entry on the task, row by row. */}
            <TaskTimeEntries taskId={task._id} />

            <PearityTagSection task={task} readOnly={viewOnly} />

            {task.description && (
              <section
                aria-labelledby="task-description-heading"
                className="space-y-1.5"
              >
                <h3
                  id="task-description-heading"
                  className="text-xs font-medium tracking-wide text-muted-foreground uppercase"
                >
                  Description
                </h3>
                <RichText value={task.description} />
                {typeof task.briefCheck?.score === "number" && (
                  <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span
                      className={
                        task.briefCheck.score >= 70
                          ? "rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary"
                          : task.briefCheck.score >= 40
                            ? "rounded-full bg-warn/10 px-2 py-0.5 font-medium text-warn"
                            : "rounded-full bg-destructive/10 px-2 py-0.5 font-medium text-destructive"
                      }
                      title="AI brief quality: English, clear, on-brand, actionable; a link or file scores higher"
                    >
                      Brief score {task.briefCheck.score}/100
                    </span>
                    {task.briefCheck.reason}
                  </p>
                )}
              </section>
            )}

            {/* The brief's files and the comments, as boxes like Time entries (also in Edit / Update). */}
            <section aria-labelledby="task-files-heading" className="space-y-2 rounded-lg border bg-muted/20 p-3 sm:p-4">
              <h3
                id="task-files-heading"
                className="flex flex-wrap items-center gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase"
              >
                <LuPaperclip aria-hidden className="size-4" />
                Files
                <span className="font-normal tracking-normal normal-case">· {task.fileCount}</span>
              </h3>
              <TaskFiles
                taskId={task._id}
                me={{ _id: me._id, role: me.role }}
                canManageAll={permissions.canDelete || (me.role === "admin" && !guest)}
                subtasks={task.subtasks}
                readOnly={viewOnly}
                canDeleteOwn={!guest}
              />
            </section>
            <section aria-labelledby="task-comments-heading" className="space-y-2 rounded-lg border bg-muted/20 p-3 sm:p-4">
              <h3
                id="task-comments-heading"
                className="flex flex-wrap items-center gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase"
              >
                <LuMessageSquare aria-hidden className="size-4" />
                Comments
                <span className="font-normal tracking-normal normal-case">· {task.commentCount}</span>
              </h3>
              <TaskComments taskId={task._id} me={{ _id: me._id, role: me.role }} readOnly={viewOnly} />
            </section>

            {/* What was entered when the task was completed. */}
            <CompletionSummary task={task} />

            {task.reviewNotes && (
              <div className="grid gap-3">
                {task.reviewNotes && (
                  <Callout
                    tone={
                      task.status === "rejected" ? "destructive" : "default"
                    }
                    title={`Review by ${task.reviewedBy?.name ?? "reviewer"}`}
                  >
                    {task.reviewNotes}
                  </Callout>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Pearity generation / DAM / review steps (only when there are any). */}
        <PearityJourney taskId={task._id} />

        {/* Below the task: its rework history. Comments, files and time are in Edit / Update. */}
        <section className="space-y-4 rounded-xl border bg-card p-4 shadow-xs sm:p-6">
          <ReworkHistory
            taskId={task._id}
            onAdd={canAddRework ? () => setDialog("rework") : undefined}
          />
          {/* Rework items added inside the task before rework became its own task. */}
          {task.subtasks.length > 0 && (
            <TaskSubtasks
              task={task}
              permissions={permissions}
              me={me}
              focusSubtaskId={subtaskId}
              legacyOnly
            />
          )}
        </section>
      </div>

      {/* Not mounted for guests: the form loads people, projects, labels (all refused to them). */}
      {!guest && (
        <TaskFormDialog
          open={dialog === "edit" || dialog === "update"}
          onOpenChange={(open) => setDialog(open ? (permissions.canEdit ? "edit" : "update") : null)}
          task={task}
          permissions={permissions}
          workOnly={dialog === "update"}
          initialWorkTab={workTab}
        />
      )}
      {task.project && !guest && (
        <TaskFormDialog
          open={dialog === "rework"}
          onOpenChange={(open) => setDialog(open ? "rework" : null)}
          defaultProjectId={task.project._id}
          defaultIteration="rework"
          defaultReworkOf={{ value: task._id, label: reworkTaskLabel(task) }}
        />
      )}
      <SubmitTaskDialog
        task={task}
        open={dialog === "submit"}
        onOpenChange={(open) => setDialog(open ? "submit" : null)}
      />
      <ReviewTaskDialog
        task={task}
        open={dialog === "review"}
        onOpenChange={(open) => setDialog(open ? "review" : null)}
      />
      {permissions.canInviteGuests && (
        <InviteGuestDialog
          task={task}
          open={dialog === "invite"}
          onOpenChange={(open) => setDialog(open ? "invite" : null)}
        />
      )}
      <DeleteTaskDialog
        task={task}
        open={dialog === "delete"}
        onOpenChange={(open) => setDialog(open ? "delete" : null)}
        onDeleted={onClose}
      />
    </>
  );
}

function Fact({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  );
}

function Callout({
  title,
  children,
  tone = "default",
}: {
  title: string;
  children: ReactNode;
  tone?: "default" | "destructive";
}) {
  return (
    <div
      className={
        tone === "destructive"
          ? "rounded-lg border border-destructive/30 bg-destructive/5 p-3"
          : "rounded-lg border bg-muted/40 p-3"
      }
    >
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <p className="mt-1 text-sm whitespace-pre-wrap text-foreground">
        {children}
      </p>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6 p-6" aria-busy="true" aria-label="Loading task">
      <SheetTitle className="sr-only">Loading task</SheetTitle>
      <div className="space-y-3">
        <div className="flex gap-2">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-5 w-14" />
        </div>
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-10" />
        ))}
      </div>
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}
