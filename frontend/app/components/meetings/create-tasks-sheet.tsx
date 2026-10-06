import { useEffect, useId, useMemo, useState } from "react";
import { LuClipboardCheck, LuLoaderCircle, LuTriangleAlert } from "react-icons/lu";

import { ManageLink } from "@/components/globals/manage-link";
import { MultiSelect, type MultiSelectOption } from "@/components/globals/multi-select";
import { UserPicker } from "@/components/globals/user-picker";
import { LabelColorDot } from "@/components/tasks/label-chip";
import { PriorityIndicator, UserAvatar } from "@/components/tasks/task-badges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentUser } from "@/hooks/use-auth";
import { useCreateMeetingTasks } from "@/hooks/use-meetings";
import { useMilestones, useProjectOptions } from "@/hooks/use-projects";
import { useTaskLabels } from "@/hooks/use-task-meta";
import { MAX_TASKS_PER_REQUEST } from "@/lib/meetings";
import { formatPlainDate } from "@/lib/time";
import type { MeetingDetail, MeetingTaskDraft, TaskPriority, UserRef } from "@/types";

const NO_PROJECT = "__none";
const NO_MILESTONE = "__none";

/** One task to create — an existing suggestion (`itemId`) or raw transcript lines. */
export interface TaskEntry {
  key: string;
  itemId?: string;
  segmentIdxs: number[];
  title: string;
  assignee: UserRef | null;
  dueDate: string | null;
  priority: TaskPriority;
}

/**
 * "Create N tasks" confirm sheet: shared defaults (project and milestone from
 * the meeting, labels, an optional description) for every included item.
 */
export function CreateTasksSheet({
  open,
  onOpenChange,
  meeting,
  entries,
  onCreated,
  people,
  peopleLoading = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meeting: MeetingDetail;
  entries: TaskEntry[];
  onCreated: () => void;
  /** Who rows can be assigned to (GET /meetings/:id/assignees). */
  people: UserRef[];
  peopleLoading?: boolean;
}) {
  const id = useId();
  const { data: me } = useCurrentUser();
  const create = useCreateMeetingTasks(meeting._id);
  const projects = useProjectOptions(open);
  const labels = useTaskLabels();

  const [project, setProject] = useState(NO_PROJECT);
  const [milestone, setMilestone] = useState(NO_MILESTONE);
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [description, setDescription] = useState("");
  const [titles, setTitles] = useState<Record<string, string>>({});
  // Assignee picked here for rows that arrive without one (the API needs one per task).
  const [picked, setPicked] = useState<Record<string, string | null>>({});
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!open) return;
    setProject(meeting.project && !meeting.project.archivedAt ? meeting.project._id : NO_PROJECT);
    setMilestone(NO_MILESTONE);
    setLabelIds([]);
    setDescription("");
    setTitles(Object.fromEntries(entries.map((entry) => [entry.key, entry.title])));
    setPicked({});
    setSubmitted(false);
  }, [open, meeting.project, entries]);

  const projectId = project === NO_PROJECT ? null : project;
  const milestones = useMilestones(projectId, open);

  const projectItems = useMemo(() => {
    const items: Record<string, string> = { [NO_PROJECT]: "No project (standalone tasks)" };
    for (const option of projects.data ?? []) items[option._id] = `${option.code} · ${option.name}`;
    if (meeting.project && !meeting.project.archivedAt && !items[meeting.project._id]) {
      items[meeting.project._id] = `${meeting.project.code} · ${meeting.project.name}`;
    }
    return items;
  }, [projects.data, meeting.project]);

  const milestoneItems = useMemo(() => {
    const items: Record<string, string> = { [NO_MILESTONE]: "No milestone" };
    for (const item of milestones.data ?? []) {
      if (item.status !== "complete") items[item._id] = item.title;
    }
    return items;
  }, [milestones.data]);

  const labelOptions = useMemo<MultiSelectOption[]>(
    () =>
      (labels.data ?? []).map((label) => ({
        value: label._id,
        label: label.name,
        icon: <LabelColorDot color={label.color} className="size-2" />,
      })),
    [labels.data]
  );

  const tooMany = entries.length > MAX_TASKS_PER_REQUEST;
  const emptyTitle = entries.some((entry) => !entry.itemId && !(titles[entry.key] ?? "").trim());
  const assigneeOf = (entry: TaskEntry) => entry.assignee?._id ?? picked[entry.key] ?? null;
  const unassigned = entries.filter((entry) => !assigneeOf(entry)).length;

  function submit() {
    setSubmitted(true);
    if (tooMany || emptyTitle || unassigned > 0) return;
    const shared: Omit<MeetingTaskDraft, "itemId"> = {
      project: projectId,
      milestone: projectId && milestone !== NO_MILESTONE ? milestone : null,
      ...(labelIds.length ? { labels: labelIds } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
    };
    const items: MeetingTaskDraft[] = entries.map((entry) => {
      const assignee = assigneeOf(entry);
      return entry.itemId
        ? {
            itemId: entry.itemId,
            ...(!entry.assignee && assignee ? { assignees: [assignee] } : {}),
            ...shared,
          }
        : {
            segmentIdxs: entry.segmentIdxs,
            title: (titles[entry.key] ?? entry.title).trim().slice(0, 200),
            ...(assignee ? { assignees: [assignee] } : {}),
            priority: entry.priority,
            dueDate: entry.dueDate,
            ...shared,
          };
    });
    create.mutate(items, {
      onSuccess: (result) => {
        if (result.created.length > 0) {
          onCreated();
          onOpenChange(false);
        }
      },
    });
  }

  const count = entries.length;

  return (
    <Sheet open={open} onOpenChange={(next) => !create.isPending && onOpenChange(next)}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-lg">
        <SheetHeader className="border-b pr-12">
          <SheetTitle>
            Create {count} task{count === 1 ? "" : "s"}
          </SheetTitle>
          <SheetDescription>
            Each task links back to its moment in “{meeting.title}”. Assignees are notified as usual;
            items you aren&apos;t allowed to create are skipped with a reason.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          <section aria-labelledby={`${id}-items`} className="space-y-2">
            <h3 id={`${id}-items`} className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Tasks
            </h3>
            <ul className="divide-y rounded-xl border">
              {entries.map((entry) => (
                <li key={entry.key} className="space-y-1.5 p-3">
                  {entry.itemId ? (
                    <p className="text-sm font-medium break-words text-foreground">{entry.title}</p>
                  ) : (
                    <Input
                      value={titles[entry.key] ?? ""}
                      onChange={(event) =>
                        setTitles((current) => ({ ...current, [entry.key]: event.target.value }))
                      }
                      maxLength={200}
                      aria-label="Task title"
                      placeholder="Task title"
                      aria-invalid={!(titles[entry.key] ?? "").trim() || undefined}
                    />
                  )}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {entry.assignee && (
                      <span className="inline-flex items-center gap-1.5">
                        <UserAvatar user={entry.assignee} className="size-5" />
                        {entry.assignee.name}
                        {entry.assignee._id === me?._id && " (you)"}
                      </span>
                    )}
                    <span>Due {formatPlainDate(entry.dueDate)}</span>
                    <PriorityIndicator priority={entry.priority} />
                  </div>
                  {!entry.assignee && (
                    <div className="space-y-1">
                      <UserPicker
                        users={people}
                        value={picked[entry.key] ?? null}
                        onChange={(value) => setPicked((current) => ({ ...current, [entry.key]: value }))}
                        loading={peopleLoading}
                        noneLabel="Unassigned"
                        placeholder="Pick an assignee…"
                        aria-label={`Assignee for ${titles[entry.key] ?? entry.title}`}
                        className="h-8"
                      />
                      {submitted && !picked[entry.key] && (
                        <p className="text-xs text-destructive" role="alert">
                          Pick an assignee
                        </p>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {submitted && unassigned > 0 && (
              <p className="flex items-start gap-1.5 text-xs text-destructive">
                <LuTriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                Pick an assignee for {unassigned} task{unassigned === 1 ? "" : "s"} — every task needs one.
              </p>
            )}
            {tooMany && (
              <p className="text-xs text-destructive">
                Create at most {MAX_TASKS_PER_REQUEST} tasks at a time — exclude some items.
              </p>
            )}
          </section>

          <div className="space-y-1.5">
            <Label htmlFor={`${id}-project`}>Project</Label>
            <Select
              value={project}
              onValueChange={(value) => {
                setProject(String(value ?? NO_PROJECT));
                setMilestone(NO_MILESTONE);
              }}
              items={projectItems}
            >
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

          <div className="space-y-1.5">
            <Label htmlFor={`${id}-milestone`}>Milestone</Label>
            <Select
              value={milestone}
              onValueChange={(value) => setMilestone(String(value ?? NO_MILESTONE))}
              items={milestoneItems}
              disabled={!projectId}
            >
              <SelectTrigger id={`${id}-milestone`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(milestoneItems).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!projectId && (
              <p className="text-xs text-muted-foreground">Milestones belong to a project.</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${id}-labels`}>Labels</Label>
            <MultiSelect
              id={`${id}-labels`}
              options={labelOptions}
              value={labelIds}
              onValueChange={setLabelIds}
              placeholder={labelOptions.length === 0 ? "No labels yet" : "Add labels…"}
              emptyText="No labels found."
            />
            {me?.role === "admin" && <ManageLink to="/settings/tasks">Manage labels</ManageLink>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${id}-description`}>Description (optional)</Label>
            <Textarea
              id={`${id}-description`}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              maxLength={1000}
              placeholder="Added above the meeting quote and link in every task."
            />
          </div>
        </div>

        <SheetFooter className="flex-row justify-end gap-2 border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending || tooMany || emptyTitle || count === 0}>
            {create.isPending ? (
              <LuLoaderCircle aria-hidden className="animate-spin" />
            ) : (
              <LuClipboardCheck aria-hidden />
            )}
            {create.isPending ? "Creating…" : `Create ${count} task${count === 1 ? "" : "s"}`}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
