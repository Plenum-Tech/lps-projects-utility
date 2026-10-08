import { useEffect, useMemo, useState, type FormEvent } from "react";
import { fromDateTimeInput, toDateTimeInput } from "@/lib/time";
import { useQueryClient } from "@tanstack/react-query";
import {
  LuCalendar,
  LuListChecks,
  LuLoaderCircle,
  LuPaperclip,
  LuPencil,
  LuPlus,
  LuSave,
  LuX,
} from "react-icons/lu";

import { ManageLink, useRefetchOnFocus } from "@/components/globals/manage-link";
import { MultiSelect, type MultiSelectOption } from "@/components/globals/multi-select";
import { EstimateField } from "@/components/tasks/estimate-field";
import { LabelColorDot } from "@/components/tasks/label-chip";
import { SubtaskFormDialog, type SubtaskDraft } from "@/components/tasks/subtask-form";
import { UserAvatar } from "@/components/tasks/task-badges";
import {
  RecurrenceField,
  recurrenceError,
} from "@/components/tasks/recurrence-field";
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
import { Textarea } from "@/components/ui/textarea";
import { useCurrentUser } from "@/hooks/use-auth";
import { useMilestones, useProject, useProjectOptions } from "@/hooks/use-projects";
import { useAssignableUsers, useTaskCategories, useTaskLabels } from "@/hooks/use-task-meta";
import { createSubtasksFromDrafts, taskKeys, useCreateTask, useUpdateTask } from "@/hooks/use-tasks";
import { useToast } from "@/hooks/use-toast";
import {
  PRIORITIES,
  PRIORITY_META,
  formatDateOnly,
  parseEstimate,
  splitEstimate,
  toDateInput,
} from "@/lib/tasks";
import type {
  RecurrenceInput,
  Task,
  TaskInput,
  TaskPriority,
  TaskUpdateInput,
  UserRef,
} from "@/types";

const NO_CATEGORY = "none";
const NO_PROJECT = "none";
const NO_MILESTONE = "none";
const MAX_ASSIGNEES = 20;
const MAX_LABELS = 10;
const MAX_SUBTASKS = 50;

interface FormState {
  title: string;
  description: string;
  assignees: string[];
  priority: TaskPriority;
  category: string;
  labels: string[];
  startDate: string;
  dueDate: string;
  subtasks: SubtaskDraft[];
  recurrence: RecurrenceInput | null;
  project: string;
  milestone: string;
  estimateHours: string;
  estimateMinutes: string;
  /** Edit only: <input type="datetime-local"> values ("" = automatic). */
  actualStart: string;
  actualEnd: string;
}

function initialState(task?: Task | null, defaultProjectId?: string): FormState {
  const estimate = splitEstimate(task?.estimateMinutes);
  return {
    estimateHours: estimate.hours,
    estimateMinutes: estimate.minutes,
    actualStart: task?.actualStartAt ? toDateTimeInput(task.actualStartAt) : "",
    actualEnd: task?.actualEndAt ? toDateTimeInput(task.actualEndAt) : "",
    project: task ? (task.project?._id ?? NO_PROJECT) : (defaultProjectId ?? NO_PROJECT),
    milestone: task?.milestone?._id ?? NO_MILESTONE,
    title: task?.title ?? "",
    description: task?.description ?? "",
    assignees: task?.assignees.map((user) => user._id) ?? [],
    priority: task?.priority ?? "medium",
    category: task?.category?._id ?? NO_CATEGORY,
    labels: task?.labels.map((label) => label._id) ?? [],
    startDate: toDateInput(task?.startDate),
    dueDate: toDateInput(task?.dueDate),
    subtasks: [],
    recurrence: task?.recurrence
      ? {
          every: task.recurrence.every,
          unit: task.recurrence.unit,
          cycles: task.recurrence.cycles,
        }
      : null,
  };
}

/** Actual start / end (datetime-local values): not in the future, end ≥ start. */
function actualDatesError(start: string, end: string): string | null {
  const limit = Date.now() + 2 * 60_000;
  if (start && new Date(start).getTime() > limit) return "The actual start can't be in the future.";
  if (end && new Date(end).getTime() > limit) return "The actual end can't be in the future.";
  if (start && end && end < start) return "The actual end can't be before the actual start.";
  return null;
}

function sameIds(a: string[], b: string[]) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * Create / edit a task (head & admin). In edit mode only changed fields are
 * sent, so an untouched recurrence keeps its schedule.
 */
export function TaskFormDialog({
  open,
  onOpenChange,
  task,
  onCreated,
  defaultProjectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present → edit mode. */
  task?: Task | null;
  onCreated?: (id: string) => void;
  /** Create mode: pre-select this project (project detail → Tasks tab). */
  defaultProjectId?: string;
}) {
  const isEdit = Boolean(task);
  const { data: me } = useCurrentUser();
  const isAdmin = me?.role === "admin";
  const isHeadOrAdmin = isAdmin || me?.role === "head";
  const createTask = useCreateTask();
  const updateTask = useUpdateTask();
  const assignable = useAssignableUsers(open && isHeadOrAdmin);
  const labels = useTaskLabels();
  const categories = useTaskCategories();
  const projects = useProjectOptions(open);
  // "Manage …" links open settings in a new tab; pick up new options on return.
  useRefetchOnFocus(labels.refetch, open && isAdmin);
  useRefetchOnFocus(categories.refetch, open && isAdmin);

  const [form, setForm] = useState<FormState>(() => initialState(task, defaultProjectId));
  const projectId = form.project === NO_PROJECT ? null : form.project;
  const projectDetail = useProject(open ? projectId : null);
  const milestones = useMilestones(projectId, open);
  useRefetchOnFocus(milestones.refetch, open && Boolean(projectId) && isHeadOrAdmin);
  const [submitted, setSubmitted] = useState(false);
  const queryClient = useQueryClient();
  const toast = useToast();
  /** Creating the drafted subtasks (and their files) after the task is saved. */
  const [savingSubtasks, setSavingSubtasks] = useState(false);
  const pending = createTask.isPending || updateTask.isPending || savingSubtasks;

  useEffect(() => {
    if (open) {
      setForm(initialState(task, defaultProjectId));
      setSubmitted(false);
    }
    // Reset only when the dialog opens or switches task.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task?._id]);

  // People a drafted subtask may be assigned to — mirrors the server's rule:
  // the task's assignees, me (the creator), project members, and for
  // heads/admins anyone they can assign.
  const draftPeople = useMemo<UserRef[]>(() => {
    const people = new Map<string, UserRef>();
    const add = (user: UserRef) => {
      if (!people.has(user._id)) people.set(user._id, { _id: user._id, name: user.name, email: user.email });
    };
    if (me) add({ _id: me._id, name: me.name, email: me.email });
    const pool = [
      ...(projectDetail.data?.project.members.map((member) => member.user) ?? []),
      ...(assignable.data ?? []),
    ];
    for (const id of form.assignees) {
      const user = pool.find((candidate) => candidate._id === id);
      if (user) add(user);
    }
    for (const member of projectDetail.data?.project.members ?? []) add(member.user);
    if (isHeadOrAdmin) for (const user of assignable.data ?? []) add(user);
    return [...people.values()];
  }, [me, projectDetail.data, assignable.data, form.assignees, isHeadOrAdmin]);

  // A disabled query stays `isPending` forever (non-heads never fetch the
  // assignable list) — only report loading for queries actually fetching.
  const loadingPeople = assignable.isLoading || (Boolean(projectId) && projectDetail.isLoading);
  const peopleError = assignable.isError || (Boolean(projectId) && projectDetail.isError);

  const assigneeOptions = useMemo<MultiSelectOption[]>(() => {
    const options = new Map<string, MultiSelectOption>();
    if (projectId) {
      // Project tasks: members first; managers may also pick non-members
      // (the server adds them to the project).
      for (const member of projectDetail.data?.project.members ?? []) {
        options.set(member.user._id, {
          value: member.user._id,
          label: member.user.name,
          description: `${member.user.email} · Member`,
        });
      }
      if (projectDetail.data?.permissions.canManageMembers) {
        for (const user of assignable.data ?? []) {
          if (!options.has(user._id)) {
            options.set(user._id, {
              value: user._id,
              label: user.name,
              description: `${user.email} · Will be added to the project`,
            });
          }
        }
      }
    } else {
      for (const user of assignable.data ?? []) {
        options.set(user._id, {
          value: user._id,
          label: user.name,
          description: [user.email, user.department?.name].filter(Boolean).join(" · "),
        });
      }
    }
    // Keep current assignees selectable even if outside the assignable list.
    for (const user of task?.assignees ?? []) {
      if (!options.has(user._id)) {
        options.set(user._id, { value: user._id, label: user.name, description: user.email });
      }
    }
    return [...options.values()];
  }, [assignable.data, task, projectId, projectDetail.data]);

  // Projects the caller may add tasks to: heads/admins → any visible project,
  // employees → projects they manage. Archived / completed ones are excluded.
  const projectChoices = useMemo(
    () =>
      (projects.data ?? []).filter(
        (project) =>
          !project.archivedAt &&
          !project.status.isCompleted &&
          (isHeadOrAdmin || project.manager?._id === me?._id)
      ),
    [projects.data, isHeadOrAdmin, me?._id]
  );
  const projectItems: Record<string, string> = isHeadOrAdmin ? { [NO_PROJECT]: "No project" } : {};
  for (const project of projectChoices) projectItems[project._id] = `${project.code} · ${project.name}`;
  // Keep the current/default project selectable even if filtered out.
  if (projectId && !projectItems[projectId]) {
    const current = task?.project ?? projects.data?.find((project) => project._id === projectId);
    if (current) projectItems[projectId] = `${current.code} · ${current.name}`;
  }

  const milestoneItems: Record<string, string> = { [NO_MILESTONE]: "No milestone" };
  for (const milestone of milestones.data ?? []) {
    milestoneItems[milestone._id] =
      milestone.status === "complete" ? `${milestone.title} (complete)` : milestone.title;
  }
  const selectedMilestone = milestones.data?.find((milestone) => milestone._id === form.milestone);
  const milestoneDueWarning = Boolean(
    selectedMilestone?.endDate &&
      form.dueDate &&
      form.dueDate > selectedMilestone.endDate.slice(0, 10)
  );

  const labelOptions = useMemo<MultiSelectOption[]>(
    () =>
      (labels.data ?? []).map((label) => ({
        value: label._id,
        label: label.name,
        icon: <LabelColorDot color={label.color} className="size-2" />,
      })),
    [labels.data]
  );

  const categoryItems: Record<string, string> = { [NO_CATEGORY]: "No category" };
  for (const category of categories.data ?? []) categoryItems[category._id] = category.name;

  const titleInvalid = submitted && (form.title.trim() === "" || form.title.trim().length > 200);
  const assigneesInvalid = submitted && form.assignees.length === 0;
  const datesInvalid =
    submitted && form.startDate !== "" && form.dueDate !== "" && form.startDate > form.dueDate;
  const descriptionInvalid = submitted && form.description.length > 2000;
  const recurrenceInvalid = Boolean(recurrenceError(form.recurrence));
  const projectInvalid = submitted && !isHeadOrAdmin && !projectId;
  const estimate = parseEstimate(form.estimateHours, form.estimateMinutes);
  const estimateInvalid = submitted && estimate === "invalid";
  const actualError = actualDatesError(form.actualStart, form.actualEnd);
  const actualInvalid = submitted && Boolean(actualError);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    const title = form.title.trim();
    if (
      !title ||
      title.length > 200 ||
      form.assignees.length === 0 ||
      form.description.length > 2000 ||
      (form.startDate && form.dueDate && form.startDate > form.dueDate) ||
      recurrenceInvalid ||
      (!isHeadOrAdmin && !projectId) ||
      estimate === "invalid" ||
      (isEdit && actualError)
    ) {
      return;
    }

    const category = form.category === NO_CATEGORY ? null : form.category;
    const milestone = form.milestone === NO_MILESTONE ? null : form.milestone;

    if (!task) {
      const input: TaskInput = {
        title,
        description: form.description.trim() || undefined,
        assignees: form.assignees,
        priority: form.priority,
        startDate: form.startDate || null,
        dueDate: form.dueDate || null,
        labels: form.labels,
        category,
        recurrence: form.recurrence,
        ...(estimate !== null ? { estimateMinutes: estimate } : {}),
        ...(projectId ? { project: projectId } : {}),
        ...(projectId && milestone ? { milestone } : {}),
      };
      // Drafted subtasks are created through the subtask endpoint after the
      // task exists, so each gets its dates, assignee, description, files and
      // the subtask emails — the create-task call only takes bare titles.
      const drafts = form.subtasks;
      createTask.mutate(input, {
        onSuccess: async (data) => {
          const taskId = data.task._id;
          if (drafts.length > 0) {
            setSavingSubtasks(true);
            const result = await createSubtasksFromDrafts(taskId, drafts);
            setSavingSubtasks(false);
            void queryClient.invalidateQueries({ queryKey: taskKeys.all });
            if (result.failedSubtasks.length > 0) {
              toast.error(
                `Task created, but ${result.failedSubtasks.length} subtask(s) couldn't be added: ${result.failedSubtasks.join(", ")}. Add them from the task's Subtasks tab.`
              );
            }
            if (result.failedFiles.length > 0) {
              toast.warning(`Some files didn't upload: ${result.failedFiles.join(", ")}`);
            }
          }
          onOpenChange(false);
          onCreated?.(taskId);
        },
      });
      return;
    }

    // Edit: send only what changed.
    const original = initialState(task);
    const input: TaskUpdateInput = {};
    if (title !== original.title) input.title = title;
    if (form.description.trim() !== original.description.trim()) {
      input.description = form.description.trim();
    }
    if (!sameIds(form.assignees, original.assignees)) input.assignees = form.assignees;
    if (form.priority !== original.priority) input.priority = form.priority;
    if (form.category !== original.category) input.category = category;
    if (!sameIds(form.labels, original.labels)) input.labels = form.labels;
    if (form.startDate !== original.startDate) input.startDate = form.startDate || null;
    if (form.dueDate !== original.dueDate) input.dueDate = form.dueDate || null;
    if (JSON.stringify(form.recurrence) !== JSON.stringify(original.recurrence)) {
      input.recurrence = form.recurrence;
    }
    if (estimate !== (task.estimateMinutes ?? null)) input.estimateMinutes = estimate;
    if (form.project !== original.project) input.project = projectId;
    if (form.milestone !== original.milestone) input.milestone = projectId ? milestone : null;
    // Emptying an actual date returns it to automatic.
    if (form.actualStart !== original.actualStart) {
      input.actualStartAt = form.actualStart ? fromDateTimeInput(form.actualStart) : null;
    }
    if (form.actualEnd !== original.actualEnd) {
      input.actualEndAt = form.actualEnd ? fromDateTimeInput(form.actualEnd) : null;
    }

    if (Object.keys(input).length === 0) {
      onOpenChange(false);
      return;
    }
    updateTask.mutate({ id: task._id, input }, { onSuccess: () => onOpenChange(false) });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit task" : "New task"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the details. Newly added assignees are notified."
              : "Assign work to one or more people. Everyone assigned gets notified."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              value={form.title}
              onChange={(event) => set("title", event.target.value)}
              maxLength={200}
              placeholder="e.g. Prepare the Q4 onboarding deck"
              aria-invalid={titleInvalid || undefined}
              aria-describedby={titleInvalid ? "task-title-error" : undefined}
              autoFocus
            />
            {titleInvalid && (
              <p id="task-title-error" className="text-xs text-destructive">
                A title is required (max 200 characters).
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="task-description">Description</Label>
            <Textarea
              id="task-description"
              value={form.description}
              onChange={(event) => set("description", event.target.value)}
              rows={3}
              placeholder="What needs to be done? Add context, links, acceptance criteria…"
              aria-invalid={descriptionInvalid || undefined}
            />
            {descriptionInvalid && (
              <p className="text-xs text-destructive">Keep the description under 2000 characters.</p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="task-project">Project</Label>
              <Select
                value={form.project}
                onValueChange={(value) =>
                  setForm((current) => ({
                    ...current,
                    project: String(value ?? NO_PROJECT),
                    milestone: NO_MILESTONE,
                  }))
                }
                items={projectItems}
                disabled={Boolean(defaultProjectId) && !isEdit}
              >
                <SelectTrigger
                  id="task-project"
                  className="w-full"
                  aria-invalid={projectInvalid || undefined}
                >
                  <SelectValue placeholder={projects.isPending ? "Loading…" : "Choose a project"} />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(projectItems).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {projectInvalid && (
                <p className="text-xs text-destructive">Choose one of the projects you manage.</p>
              )}
              {isEdit && task?.project && form.project !== task.project._id && (
                <p className="text-xs text-muted-foreground">
                  Moving the task gives it a new short code.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="task-milestone">Milestone</Label>
              <Select
                value={form.milestone}
                onValueChange={(value) => set("milestone", String(value ?? NO_MILESTONE))}
                items={milestoneItems}
                disabled={!projectId}
              >
                <SelectTrigger id="task-milestone" className="w-full">
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
              {projectId && isHeadOrAdmin && (
                <ManageLink to={`/projects/${projectId}?tab=milestones`}>Manage milestones</ManageLink>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="task-assignees">Assignees</Label>
            <MultiSelect
              id="task-assignees"
              options={assigneeOptions}
              value={form.assignees}
              onValueChange={(value) => set("assignees", value)}
              placeholder={loadingPeople ? "Loading people…" : "Search people…"}
              emptyText={peopleError ? "Couldn't load people." : "No one found."}
              invalid={assigneesInvalid}
              max={MAX_ASSIGNEES}
              aria-describedby={assigneesInvalid ? "task-assignees-error" : undefined}
            />
            {assigneesInvalid && (
              <p id="task-assignees-error" className="text-xs text-destructive">
                Assign at least one person.
              </p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="task-priority">Priority</Label>
              <Select
                value={form.priority}
                onValueChange={(value) => set("priority", value as TaskPriority)}
                items={Object.fromEntries(PRIORITIES.map((p) => [p, PRIORITY_META[p].label]))}
              >
                <SelectTrigger id="task-priority" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((priority) => (
                    <SelectItem key={priority} value={priority}>
                      <span
                        aria-hidden
                        className={`size-2 rounded-full ${PRIORITY_META[priority].dot}`}
                      />
                      {PRIORITY_META[priority].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="task-category">Category</Label>
              <Select
                value={form.category}
                onValueChange={(value) => set("category", String(value ?? NO_CATEGORY))}
                items={categoryItems}
              >
                <SelectTrigger id="task-category" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(categoryItems).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {isAdmin && <ManageLink to="/settings/tasks">Manage categories</ManageLink>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="task-start">Start date</Label>
              <Input
                id="task-start"
                type="date"
                value={form.startDate}
                onChange={(event) => set("startDate", event.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="task-due">Due date</Label>
              <Input
                id="task-due"
                type="date"
                value={form.dueDate}
                min={form.startDate || undefined}
                onChange={(event) => set("dueDate", event.target.value)}
                aria-invalid={datesInvalid || undefined}
                aria-describedby={datesInvalid ? "task-dates-error" : undefined}
              />
            </div>
            {datesInvalid && (
              <p id="task-dates-error" className="text-xs text-destructive sm:col-span-2">
                The due date can&apos;t be before the start date.
              </p>
            )}
            {milestoneDueWarning && (
              <p className="text-xs text-muted-foreground sm:col-span-2" role="status">
                Heads up: the due date is after the milestone&apos;s end date.
              </p>
            )}
          </div>

          <EstimateField
            hours={form.estimateHours}
            minutes={form.estimateMinutes}
            onChange={(value) =>
              setForm((current) => ({
                ...current,
                estimateHours: value.hours,
                estimateMinutes: value.minutes,
              }))
            }
            invalid={estimateInvalid}
          />

          {isEdit && (
            <fieldset className="space-y-1.5">
              <legend className="mb-1.5 text-sm leading-none font-medium">Actual dates</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="task-actual-start" className="text-xs text-muted-foreground">
                    Actual start
                  </Label>
                  <Input
                    id="task-actual-start"
                    type="datetime-local"
                    value={form.actualStart}
                    max={toDateTimeInput(new Date())}
                    onChange={(event) => set("actualStart", event.target.value)}
                    aria-invalid={actualInvalid || undefined}
                    aria-describedby="task-actual-hint"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="task-actual-end" className="text-xs text-muted-foreground">
                    Actual end
                  </Label>
                  <Input
                    id="task-actual-end"
                    type="datetime-local"
                    value={form.actualEnd}
                    min={form.actualStart || undefined}
                    max={toDateTimeInput(new Date())}
                    onChange={(event) => set("actualEnd", event.target.value)}
                    aria-invalid={actualInvalid || undefined}
                    aria-describedby="task-actual-hint"
                  />
                </div>
              </div>
              <p
                id="task-actual-hint"
                className={actualInvalid ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
              >
                {actualInvalid
                  ? actualError
                  : "Optional — filled automatically. Edited values aren't changed automatically; clear a field to return it to automatic."}
              </p>
            </fieldset>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="task-labels">Labels</Label>
            <MultiSelect
              id="task-labels"
              options={labelOptions}
              value={form.labels}
              onValueChange={(value) => set("labels", value)}
              placeholder={
                labelOptions.length === 0 ? "No labels yet — an admin can add some" : "Add labels…"
              }
              emptyText="No labels found."
              max={MAX_LABELS}
              disabled={labelOptions.length === 0}
            />
            {isAdmin && <ManageLink to="/settings/tasks">Manage labels</ManageLink>}
          </div>

          {!isEdit && me && (
            <SubtaskDrafts
              value={form.subtasks}
              onChange={(value) => set("subtasks", value)}
              people={draftPeople}
              me={me}
              taskTitle={form.title.trim()}
              taskDueDate={form.dueDate || null}
              disabled={pending}
            />
          )}

          <RecurrenceField
            value={form.recurrence}
            onChange={(value) => set("recurrence", value)}
            showError={submitted}
          />
          {form.recurrence && !form.startDate && !form.dueDate && (
            <p className="-mt-2 text-xs text-muted-foreground">
              Tip: set a start or due date so each copy gets sensible dates.
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? (
                <LuLoaderCircle aria-hidden className="animate-spin" />
              ) : isEdit ? (
                <LuSave aria-hidden />
              ) : (
                <LuPlus aria-hidden />
              )}
              {pending ? "Saving…" : isEdit ? "Save changes" : "Create task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Subtasks drafted with the full subtask form (title, dates, assignee,
 * description, files). They're created right after the task is saved.
 */
function SubtaskDrafts({
  value,
  onChange,
  people,
  me,
  taskTitle,
  taskDueDate,
  disabled,
}: {
  value: SubtaskDraft[];
  onChange: (value: SubtaskDraft[]) => void;
  people: UserRef[];
  me: { _id: string };
  taskTitle: string;
  taskDueDate: string | null;
  disabled?: boolean;
}) {
  /** null = closed, -1 = adding, otherwise the index being edited. */
  const [editing, setEditing] = useState<number | null>(null);
  const initial = editing !== null && editing >= 0 ? (value[editing] ?? null) : null;

  function save(draft: SubtaskDraft) {
    if (editing !== null && editing >= 0) {
      onChange(value.map((item, index) => (index === editing ? draft : item)));
    } else {
      onChange([...value, draft]);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-2">
          <LuListChecks aria-hidden className="size-4 text-muted-foreground" />
          Subtasks
          {value.length > 0 && (
            <span className="text-xs font-normal text-muted-foreground tabular-nums">({value.length})</span>
          )}
        </Label>
        <span className="text-xs text-muted-foreground">Optional</span>
      </div>

      {value.length > 0 && (
        <ul className="space-y-1.5" aria-label="Subtasks to create">
          {value.map((draft, index) => {
            const dates = [draft.startDate, draft.dueDate]
              .map((date) => (date ? formatDateOnly(date) : null))
              .filter(Boolean)
              .join(" → ");
            return (
              <li
                key={`${draft.title}-${index}`}
                className="flex items-start gap-2 rounded-lg border bg-muted/20 px-3 py-2"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="truncate text-sm font-medium" title={draft.title}>
                    {draft.title}
                  </p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      {draft.assignee ? (
                        <>
                          <UserAvatar user={draft.assignee} />
                          {draft.assignee._id === me._id ? "You" : draft.assignee.name}
                        </>
                      ) : (
                        "Unassigned"
                      )}
                    </span>
                    {dates && (
                      <span className="inline-flex items-center gap-1">
                        <LuCalendar aria-hidden className="size-3" />
                        {dates}
                      </span>
                    )}
                    {draft.files.length > 0 && (
                      <span className="inline-flex items-center gap-1">
                        <LuPaperclip aria-hidden className="size-3" />
                        {draft.files.length} file{draft.files.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                  {draft.description && (
                    <p className="line-clamp-2 text-xs text-muted-foreground">{draft.description}</p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setEditing(index)}
                  disabled={disabled}
                  aria-label={`Edit subtask ${draft.title}`}
                >
                  <LuPencil aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onChange(value.filter((_, i) => i !== index))}
                  disabled={disabled}
                  aria-label={`Remove subtask ${draft.title}`}
                >
                  <LuX aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setEditing(-1)}
        disabled={disabled || value.length >= MAX_SUBTASKS}
      >
        <LuPlus aria-hidden />
        Add subtask
      </Button>

      <SubtaskFormDialog
        task={{ _id: "", title: taskTitle, shortCode: null, dueDate: taskDueDate }}
        subtask={null}
        me={me}
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        draft={{ initial, people, onSave: save }}
      />
    </div>
  );
}

