import { useEffect, useState, type ReactNode } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  LuBellRing,
  LuCalendarDays,
  LuCircleAlert,
  LuCircleCheck,
  LuClipboardCheck,
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
} from "react-icons/lu";
import { Link } from "react-router";

import { ShortCode } from "@/components/projects/project-badges";
import { ActualDatesBlock } from "@/components/tasks/actual-dates";
import { EstimateEditor } from "@/components/tasks/estimate-field";
import { LabelChip } from "@/components/tasks/label-chip";
import { TimeLogPanel } from "@/components/timelogs/time-log-panel";
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
import { TaskComments } from "@/components/tasks/task-comments";
import { TaskFiles } from "@/components/tasks/task-files";
import { TaskFormDialog } from "@/components/tasks/task-form-dialog";
import { TaskHistory } from "@/components/tasks/task-history";
import { TaskNotes } from "@/components/tasks/task-notes";
import { TaskSubtasks } from "@/components/tasks/task-subtasks";
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
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRemindTask, useTask, useUpdateTaskStatus } from "@/hooks/use-tasks";
import { getErrorMessage } from "@/lib/api";
import { formatTimestamp } from "@/lib/meetings";
import { STATUS_META, describeRecurrence, formatDateOnly, formatEffort } from "@/lib/tasks";
import type { Role, Task, TaskPermissions } from "@/types";

type TabValue = "subtasks" | "comments" | "notes" | "files" | "time" | "history";

const TAB_VALUES: TabValue[] = ["subtasks", "comments", "notes", "files", "time", "history"];

/**
 * Task detail side sheet — opened by the `?task=<id>` search param. Full
 * screen on mobile. Actions are driven by the server-computed permissions.
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
  /** `?subtask=<id>` (email links): open the Subtasks tab with it expanded. */
  subtaskId?: string | null;
  /** `?tab=notes` etc. */
  tab?: string | null;
}) {
  const query = useTask(taskId);

  return (
    <Sheet open={Boolean(taskId)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-full gap-0 p-0 data-[side=right]:w-full sm:data-[side=right]:max-w-2xl"
      >
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
                <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
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
      </SheetContent>
    </Sheet>
  );
}

function TaskDetail({
  task,
  permissions,
  me,
  onClose,
  subtaskId,
  initialTab,
}: {
  task: Task;
  permissions: TaskPermissions;
  me: { _id: string; role: Role };
  onClose: () => void;
  subtaskId: string | null;
  initialTab: TabValue;
}) {
  const [tab, setTab] = useState<TabValue>(initialTab);
  // Follow later deep links (e.g. a notification click while the sheet is open).
  useEffect(() => {
    setTab(initialTab);
  }, [initialTab, subtaskId]);
  const [dialog, setDialog] = useState<"edit" | "submit" | "review" | "delete" | null>(null);
  const updateStatus = useUpdateTaskStatus();
  const remind = useRemindTask();

  const moveTargets = permissions.allowedStatuses.filter((status) => status !== task.status);
  const canReviewNow = permissions.canReview && task.status === "in_review";
  const doneSubtasks = task.subtasks.filter((sub) => sub.done).length;

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <SheetHeader className="gap-3 border-b p-4 pr-12 sm:p-6 sm:pr-14">
          <div className="flex flex-wrap items-center gap-2">
            {task.shortCode && <ShortCode code={task.shortCode} />}
            <StatusBadge status={task.status} />
            <PriorityIndicator priority={task.priority} />
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

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {permissions.canSubmit && (
              <Button size="sm" onClick={() => setDialog("submit")}>
                <LuSend aria-hidden />
                {permissions.skipsReview ? "Mark as complete" : "Submit for review"}
              </Button>
            )}
            {canReviewNow && (
              <Button size="sm" onClick={() => setDialog("review")}>
                <LuClipboardCheck aria-hidden />
                Review
              </Button>
            )}
            {moveTargets.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="outline" size="sm" disabled={updateStatus.isPending} />
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
                        onClick={() => updateStatus.mutate({ id: task._id, status })}
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
            {permissions.canEdit && (
              <Button variant="outline" size="sm" onClick={() => setDialog("edit")}>
                <LuPencil aria-hidden />
                Edit
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
          {permissions.readOnly && (
            <p className="flex items-center gap-1.5 rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <LuLock aria-hidden className="size-3.5" />
              This task belongs to an archived project and is read-only.
            </p>
          )}
          {task.lastManualReminderAt && permissions.canRemind && (
            <p className="text-xs text-muted-foreground">
              Last reminder sent{" "}
              {formatDistanceToNow(new Date(task.lastManualReminderAt), { addSuffix: true })}
            </p>
          )}
        </SheetHeader>

        <div className="space-y-5 p-4 sm:p-6">
          {/* Facts */}
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
            <Fact label="Assignees" className="sm:col-span-2">
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
                  </li>
                ))}
              </ul>
            </Fact>
            {task.project && (
              <Fact label="Project">
                <Link
                  to={`/projects/${task.project._id}`}
                  className="inline-flex items-center gap-1.5 rounded-sm font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
                >
                  <LuFolderKanban aria-hidden className="size-3.5 text-muted-foreground" />
                  {task.project.code} · {task.project.name}
                </Link>
              </Fact>
            )}
            {task.project && (
              <Fact label="Milestone">
                {task.milestone ? (
                  <span className="inline-flex items-center gap-1.5">
                    <LuFlag aria-hidden className="size-3.5 text-muted-foreground" />
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
            {task.sourceMeeting && typeof task.sourceMeeting.meeting === "object" && (
              <Fact label="Source" className="sm:col-span-2">
                <Link
                  to={`/meetings/${task.sourceMeeting.meeting._id}${
                    task.sourceMeeting.segmentIdx !== null ? `?seg=${task.sourceMeeting.segmentIdx}` : ""
                  }`}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-sm font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
                >
                  <LuMessagesSquare aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
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
                <LuCalendarDays aria-hidden className="size-3.5 text-muted-foreground" />
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
                  task.estimateMinutes && (task.loggedMinutes ?? 0) > task.estimateMinutes
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
                  <LuFolder aria-hidden className="size-3.5 text-muted-foreground" />
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
                    <LabelChip key={label._id} name={label.name} color={label.color} />
                  ))}
                </span>
              ) : (
                "—"
              )}
            </Fact>
          </dl>

          <ActualDatesBlock task={task} permissions={permissions} />

          {task.description && (
            <section aria-labelledby="task-description-heading" className="space-y-1.5">
              <h3
                id="task-description-heading"
                className="text-xs font-medium tracking-wide text-muted-foreground uppercase"
              >
                Description
              </h3>
              <p className="text-sm break-words whitespace-pre-wrap text-foreground">
                {task.description}
              </p>
            </section>
          )}

          {(task.submissionNotes || task.reviewNotes) && (
            <div className="grid gap-3">
              {task.submissionNotes && (
                <Callout
                  title={`Submission notes${task.submittedAt ? ` · ${formatDistanceToNow(new Date(task.submittedAt), { addSuffix: true })}` : ""}`}
                >
                  {task.submissionNotes}
                </Callout>
              )}
              {task.reviewNotes && (
                <Callout
                  tone={task.status === "rejected" ? "destructive" : "default"}
                  title={`Review by ${task.reviewedBy?.name ?? "reviewer"}`}
                >
                  {task.reviewNotes}
                </Callout>
              )}
            </div>
          )}

          <Tabs value={tab} onValueChange={(value) => setTab(value as TabValue)}>
            <TabsList className="no-scrollbar w-full justify-start overflow-x-auto sm:justify-center">
              <TabsTrigger value="subtasks">
                Subtasks
                {task.subtasks.length > 0 && (
                  <Count>
                    {doneSubtasks}/{task.subtasks.length}
                  </Count>
                )}
              </TabsTrigger>
              <TabsTrigger value="comments">
                Comments
                {task.commentCount > 0 && <Count>{task.commentCount}</Count>}
              </TabsTrigger>
              <TabsTrigger value="notes">Notes</TabsTrigger>
              <TabsTrigger value="files">
                Files
                {task.fileCount > 0 && <Count>{task.fileCount}</Count>}
              </TabsTrigger>
              {task.project && <TabsTrigger value="time">Time</TabsTrigger>}
              <TabsTrigger value="history">History</TabsTrigger>
            </TabsList>
            <TabsContent value="subtasks" className="pt-3">
              <TaskSubtasks
                task={task}
                permissions={permissions}
                me={me}
                focusSubtaskId={subtaskId}
              />
            </TabsContent>
            <TabsContent value="comments" className="pt-3">
              <TaskComments taskId={task._id} me={me} />
            </TabsContent>
            <TabsContent value="notes" className="pt-3">
              <TaskNotes taskId={task._id} me={me} readOnly={permissions.readOnly} />
            </TabsContent>
            <TabsContent value="files" className="pt-3">
              <TaskFiles
                taskId={task._id}
                me={me}
                canManageAll={permissions.canDelete || me.role === "admin"}
                subtasks={task.subtasks}
              />
            </TabsContent>
            {task.project && (
              <TabsContent value="time" className="pt-3">
                <TimeLogPanel
                  taskId={task._id}
                  canLogTime={Boolean(permissions.canLogTime)}
                  manualAllowed
                />
              </TabsContent>
            )}
            <TabsContent value="history" className="pt-3">
              <TaskHistory taskId={task._id} />
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <TaskFormDialog
        open={dialog === "edit"}
        onOpenChange={(open) => setDialog(open ? "edit" : null)}
        task={task}
      />
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

function Count({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-muted px-1.5 text-[0.7rem] text-muted-foreground tabular-nums">
      {children}
    </span>
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
      <p className="mt-1 text-sm whitespace-pre-wrap text-foreground">{children}</p>
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
