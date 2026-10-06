import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import {
  LuChevronRight,
  LuCircleCheck,
  LuClipboardCheck,
  LuListTodo,
  LuRotateCcw,
  LuX,
} from "react-icons/lu";

import { UserPicker } from "@/components/globals/user-picker";
import { EmptyState } from "@/components/globals/query-states";
import { StatusBadge } from "@/components/tasks/task-badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDismissActionItem, useUpdateActionItem } from "@/hooks/use-meetings";
import { ORIGIN_META, formatTimestamp, itemStart, taskRefLabel } from "@/lib/meetings";
import { PRIORITIES, PRIORITY_META, formatDateOnly } from "@/lib/tasks";
import { formatPlainDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import type {
  MeetingActionItem,
  MeetingDetail,
  MeetingPermissions,
  TaskPriority,
  UserRef,
} from "@/types";

const PRIORITY_ITEMS = Object.fromEntries(PRIORITIES.map((value) => [value, PRIORITY_META[value].label]));

/**
 * Right pane: Suggested (editable rows with an include checkbox), Created
 * (linked tasks) and Dismissed (collapsed, restorable) action items.
 */
export function ActionItemsPane({
  meeting,
  permissions,
  people,
  peopleLoading,
  onJump,
  onCreate,
}: {
  meeting: MeetingDetail;
  permissions: MeetingPermissions;
  people: UserRef[];
  peopleLoading: boolean;
  onJump: (segmentIdx: number) => void;
  onCreate: (items: MeetingActionItem[]) => void;
}) {
  const suggested = meeting.actionItems.filter((item) => item.status === "suggested");
  const created = meeting.actionItems.filter((item) => item.status === "task_created");
  const dismissed = meeting.actionItems.filter((item) => item.status === "dismissed");

  const [included, setIncluded] = useState<Set<string>>(() => new Set());
  // Drop ids that are no longer suggestions (created / dismissed elsewhere).
  const suggestedKey = suggested.map((item) => item._id).join(",");
  useEffect(() => {
    const ids = new Set(suggestedKey.split(",").filter(Boolean));
    setIncluded((current) => {
      const next = new Set([...current].filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [suggestedKey]);

  const includedItems = suggested.filter((item) => included.has(item._id));
  const allIncluded = suggested.length > 0 && includedItems.length === suggested.length;

  function setInclude(id: string, on: boolean) {
    setIncluded((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const canCreate = permissions.canCreateTasks;
  // Set when "Create" was pressed with unassigned rows; shows "Pick an assignee" on them.
  const [checkAssignees, setCheckAssignees] = useState(false);
  const missingAssignee = includedItems.filter((item) => !item.assignee).length;

  function handleCreate() {
    if (permissions.canEdit && missingAssignee > 0) {
      setCheckAssignees(true);
      return;
    }
    setCheckAssignees(false);
    onCreate(includedItems);
  }

  return (
    <div className="space-y-5">
      {/* Suggested */}
      <section aria-labelledby="suggested-heading" className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {canCreate && suggested.length > 0 && (
            <Checkbox
              checked={allIncluded}
              indeterminate={includedItems.length > 0 && !allIncluded}
              onCheckedChange={(value) =>
                setIncluded(value ? new Set(suggested.map((item) => item._id)) : new Set())
              }
              aria-label={allIncluded ? "Exclude all suggestions" : "Include all suggestions"}
            />
          )}
          <h2 id="suggested-heading" className="text-sm font-semibold text-foreground">
            Suggested
          </h2>
          <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
            {suggested.length}
          </span>
          {canCreate && (
            <Button
              size="sm"
              className="ml-auto"
              disabled={includedItems.length === 0}
              onClick={handleCreate}
            >
              <LuClipboardCheck aria-hidden />
              Create {includedItems.length || ""} task{includedItems.length === 1 ? "" : "s"}
            </Button>
          )}
        </div>

        {checkAssignees && missingAssignee > 0 && (
          <p className="text-xs text-destructive" role="alert">
            Pick an assignee for {missingAssignee} selected item{missingAssignee === 1 ? "" : "s"} before
            creating tasks.
          </p>
        )}

        {suggested.length === 0 ? (
          <EmptyState
            icon={LuListTodo}
            title="No suggestions"
            description={
              permissions.canEdit
                ? "Select lines in the transcript (checkboxes or text) to add an action item."
                : "Nothing is waiting to become a task."
            }
            className="py-8"
          />
        ) : (
          <ul className="space-y-2.5">
            {suggested.map((item) => (
              <SuggestionRow
                key={item._id}
                meetingId={meeting._id}
                item={item}
                start={itemStart(item, meeting.segments)}
                editable={permissions.canEdit}
                includable={canCreate}
                included={included.has(item._id)}
                onInclude={(on) => setInclude(item._id, on)}
                assigneeMissing={checkAssignees && included.has(item._id) && !item.assignee}
                people={people}
                peopleLoading={peopleLoading}
                onJump={onJump}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Created */}
      {created.length > 0 && (
        <section aria-labelledby="created-heading" className="space-y-2.5">
          <div className="flex items-center gap-2">
            <h2 id="created-heading" className="text-sm font-semibold text-foreground">
              Created
            </h2>
            <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
              {created.length}
            </span>
          </div>
          <ul className="divide-y rounded-xl border bg-card">
            {created.map((item) => (
              <li key={item._id} className="flex flex-wrap items-start gap-x-3 gap-y-1.5 p-3">
                <LuCircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  {item.task ? (
                    <Link
                      to={`/tasks?task=${item.task._id}`}
                      className="text-sm font-medium break-words text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
                    >
                      <span className="mr-1.5 font-mono text-xs text-muted-foreground">
                        {taskRefLabel(item.task)}
                      </span>
                      {item.task.title}
                    </Link>
                  ) : (
                    <p className="text-sm font-medium text-foreground">
                      {item.title}
                      <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                        (task deleted)
                      </span>
                    </p>
                  )}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {item.assignee?.name ?? item.assigneeName ?? "Unassigned"}
                    {item.task?.dueDate && ` · due ${formatDateOnly(item.task.dueDate)}`}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  {item.task && <StatusBadge status={item.task.status} />}
                  <JumpButton item={item} start={itemStart(item, meeting.segments)} onJump={onJump} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Dismissed */}
      {dismissed.length > 0 && (
        <DismissedGroup
          meetingId={meeting._id}
          items={dismissed}
          editable={permissions.canEdit}
        />
      )}
    </div>
  );
}

function JumpButton({
  item,
  start,
  onJump,
}: {
  item: MeetingActionItem;
  start: number | null;
  onJump: (idx: number) => void;
}) {
  const first = item.segmentIdxs[0];
  if (first === undefined) return null;
  return (
    <button
      type="button"
      onClick={() => onJump(first)}
      className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.7rem] text-muted-foreground tabular-nums outline-none hover:bg-muted/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      aria-label={`Show line ${first + 1} in the transcript`}
      title="Show in transcript"
    >
      {formatTimestamp(start) || `#${first + 1}`}
    </button>
  );
}

function SuggestionRow({
  meetingId,
  item,
  start,
  editable,
  includable,
  included,
  onInclude,
  assigneeMissing = false,
  people,
  peopleLoading,
  onJump,
}: {
  meetingId: string;
  item: MeetingActionItem;
  start: number | null;
  editable: boolean;
  includable: boolean;
  included: boolean;
  onInclude: (on: boolean) => void;
  assigneeMissing?: boolean;
  people: UserRef[];
  peopleLoading: boolean;
  onJump: (idx: number) => void;
}) {
  const update = useUpdateActionItem(meetingId);
  const dismiss = useDismissActionItem(meetingId);
  const [title, setTitle] = useState(item.title);
  const titleFocused = useRef(false);
  useEffect(() => {
    if (!titleFocused.current) setTitle(item.title);
  }, [item.title]);

  const titleInvalid = title.trim().length === 0;
  const origin = ORIGIN_META[item.origin];
  const save = (input: Parameters<typeof update.mutate>[0]["input"]) =>
    update.mutate({ itemId: item._id, input });

  function commitTitle() {
    titleFocused.current = false;
    const next = title.trim();
    if (!next) {
      setTitle(item.title);
      return;
    }
    if (next !== item.title) save({ title: next.slice(0, 200) });
  }

  const extraAssignee = useMemo(() => (item.assignee ? [item.assignee] : []), [item.assignee]);

  return (
    <li
      className={cn(
        "space-y-2.5 rounded-xl border bg-card p-3 transition-colors duration-150",
        included && "border-ring/50 bg-primary/5"
      )}
    >
      <div className="flex items-start gap-2.5">
        {includable && (
          <Checkbox
            className="mt-2"
            checked={included}
            onCheckedChange={(value) => onInclude(Boolean(value))}
            aria-label={`Include “${item.title}”`}
          />
        )}
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className={cn("h-5 px-1.5 text-[0.65rem]", origin.className)}>
              {origin.label}
            </Badge>
            <JumpButton item={item} start={start} onJump={onJump} />
            {editable && (
              <Button
                variant="ghost"
                size="icon-xs"
                className="ml-auto text-muted-foreground"
                onClick={() => dismiss.mutate(item._id)}
                disabled={dismiss.isPending}
                aria-label={`Dismiss “${item.title}”`}
                title="Dismiss"
              >
                <LuX aria-hidden />
              </Button>
            )}
          </div>
          {editable ? (
            <Input
              value={title}
              maxLength={200}
              onFocus={() => (titleFocused.current = true)}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={commitTitle}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  setTitle(item.title);
                  titleFocused.current = false;
                  event.currentTarget.blur();
                }
              }}
              aria-label="Action item title"
              aria-invalid={titleInvalid || undefined}
              className="h-8 font-medium"
            />
          ) : (
            <p className="text-sm font-medium break-words text-foreground">{item.title}</p>
          )}
        </div>
      </div>

      <blockquote className="line-clamp-2 border-l-2 pl-2.5 text-xs text-muted-foreground italic">
        {item.quote}
      </blockquote>

      {editable ? (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_9.5rem_7.5rem]">
          <UserPicker
            users={people}
            extra={extraAssignee}
            value={item.assignee?._id ?? null}
            onChange={(assignee) => save({ assignee })}
            loading={peopleLoading}
            noneLabel="Unassigned"
            placeholder={item.assigneeName ? `${item.assigneeName} (not in EMS)` : undefined}
            aria-label="Assignee"
            className="h-8"
          />
          <Input
            type="date"
            value={item.dueDate ?? ""}
            onChange={(event) => save({ dueDate: event.target.value || null })}
            aria-label="Due date"
            className="h-8"
          />
          <Select
            value={item.priority}
            onValueChange={(value) => value && save({ priority: value as TaskPriority })}
            items={PRIORITY_ITEMS}
          >
            <SelectTrigger aria-label="Priority" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRIORITIES.map((priority) => (
                <SelectItem key={priority} value={priority}>
                  <span aria-hidden className={cn("size-2 rounded-full", PRIORITY_META[priority].dot)} />
                  {PRIORITY_META[priority].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {assigneeMissing && (
            <p className="text-xs text-destructive sm:col-span-3" role="alert">
              Pick an assignee
            </p>
          )}
        </div>
      ) : (
        <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <div className="flex gap-1">
            <dt className="text-muted-foreground">Assignee</dt>
            <dd className="text-foreground">
              {item.assignee?.name ?? (item.assigneeName ? `${item.assigneeName} (not in EMS)` : "—")}
            </dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-muted-foreground">Due</dt>
            <dd className="text-foreground">{formatPlainDate(item.dueDate)}</dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-muted-foreground">Priority</dt>
            <dd className="text-foreground">{PRIORITY_META[item.priority].label}</dd>
          </div>
        </dl>
      )}
      {editable && !item.assignee && item.assigneeName && (
        <p className="text-xs text-muted-foreground">
          Named in the transcript: <span className="font-medium text-foreground">{item.assigneeName}</span>{" "}
          — not mapped to an EMS user.
        </p>
      )}
    </li>
  );
}

function DismissedGroup({
  meetingId,
  items,
  editable,
}: {
  meetingId: string;
  items: MeetingActionItem[];
  editable: boolean;
}) {
  const update = useUpdateActionItem(meetingId);
  return (
    <Collapsible className="rounded-xl border">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-semibold text-foreground outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50">
        <LuChevronRight
          aria-hidden
          className="size-4 text-muted-foreground transition-transform duration-150 group-data-[panel-open]:rotate-90"
        />
        Dismissed
        <span className="rounded-full bg-muted px-1.5 text-xs font-normal text-muted-foreground tabular-nums">
          {items.length}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="divide-y border-t">
          {items.map((item) => (
            <li key={item._id} className="flex items-center gap-3 px-3 py-2">
              <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground line-through">
                {item.title}
              </p>
              {editable && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => update.mutate({ itemId: item._id, input: { status: "suggested" } })}
                  disabled={update.isPending}
                >
                  <LuRotateCcw aria-hidden />
                  Restore
                </Button>
              )}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
