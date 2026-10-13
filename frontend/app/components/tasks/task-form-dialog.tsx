import { RichTextEditor, richTextPlain } from "@/components/globals/rich-text";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { fromDateTimeInput, toDateTimeInput } from "@/lib/time";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
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

import {
  ManageLink,
  useRefetchOnFocus,
} from "@/components/globals/manage-link";
import {
  MultiSelect,
  type MultiSelectOption,
} from "@/components/globals/multi-select";
import { AttachmentsField } from "@/components/tasks/attachments-field";
import { ReworkTaskPicker, type ReworkTaskOption } from "@/components/tasks/rework-panel";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";

interface ProjectOption {
  value: string;
  label: string;
  /** Lower-cased name + code, "_" as spaces: what the search matches. */
  search: string;
}

/** Every typed word must appear (any order): "ajmal gcc" finds "Ajmal_Program_Oct2026_GCC Retainer". */
function matchesProject(option: ProjectOption, query: string): boolean {
  const words = query.toLowerCase().replace(/[_·]/g, " ").split(/\s+/).filter(Boolean);
  return words.every((word) => option.search.includes(word));
}
import { TaskWorkSections, type WorkTab } from "@/components/tasks/task-work-sections";
import { EstimateField } from "@/components/tasks/estimate-field";
import { LabelColorDot } from "@/components/tasks/label-chip";
import {
  SubtaskFormDialog,
  type SubtaskDraft,
} from "@/components/tasks/subtask-form";
import { UserAvatar } from "@/components/tasks/task-badges";
import {
  RecurrenceField,
  recurrenceError,
} from "@/components/tasks/recurrence-field";
import { Button } from "@/components/ui/button";
import {
  PageDrawerCard,
  PageDrawerContent,
} from "@/components/globals/page-drawer";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
import {
  useMilestones,
  useProject,
  useProjectOptions,
} from "@/hooks/use-projects";
import {
  useAssignableUsers,
  useTaskCategories,
  useTaskLabels,
} from "@/hooks/use-task-meta";
import {
  createSubtasksFromDrafts,
  uploadTaskFilesNow,
  taskKeys,
  useCreateTask,
  useUpdateTask,
} from "@/hooks/use-tasks";
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
  TaskIteration,
  RecurrenceInput,
  Task,
  TaskInput,
  TaskPermissions,
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
  /** Controlled name: scope unit, quantity, short name. */
  unit: string;
  quantity: string;
  shortName: string;
  iteration: "" | TaskIteration;
  /** Rework: the original task's id. */
  reworkOf: string;
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

function initialState(
  task?: Task | null,
  defaultProjectId?: string,
  defaultIteration?: TaskIteration,
  defaultReworkOf?: ReworkTaskOption | null,
): FormState {
  const estimate = splitEstimate(task?.estimateMinutes);
  return {
    estimateHours: estimate.hours,
    estimateMinutes: estimate.minutes,
    actualStart: task?.actualStartAt ? toDateTimeInput(task.actualStartAt) : "",
    actualEnd: task?.actualEndAt ? toDateTimeInput(task.actualEndAt) : "",
    project: task
      ? (task.project?._id ?? NO_PROJECT)
      : (defaultProjectId ?? NO_PROJECT),
    milestone: task?.milestone?._id ?? NO_MILESTONE,
    title: task?.title ?? "",
    unit: task?.titleParts?.unit ?? "",
    quantity: task?.titleParts ? String(task.titleParts.quantity) : "1",
    shortName: task?.titleParts?.shortName ?? "",
    iteration: task?.iteration ?? defaultIteration ?? "",
    reworkOf: task ? (task.reworkOf?._id ?? "") : (defaultReworkOf?.value ?? ""),
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
  if (start && new Date(start).getTime() > limit)
    return "The actual start can't be in the future.";
  if (end && new Date(end).getTime() > limit)
    return "The actual end can't be in the future.";
  if (start && end && end < start)
    return "The actual end can't be before the actual start.";
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
  defaultIteration,
  defaultReworkOf,
  permissions,
  workOnly = false,
  initialWorkTab,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present → edit mode. */
  task?: Task | null;
  onCreated?: (id: string) => void;
  /** Create mode: pre-select this project (project detail → Tasks tab). */
  defaultProjectId?: string;
  /** Create mode: pre-select the iteration ("rework" from a task's Add rework). */
  defaultIteration?: TaskIteration;
  /** Create mode: the original task a rework is for (pre-selected). */
  defaultReworkOf?: ReworkTaskOption | null;
  /** Edit mode: the task's permissions — shows its comments, files and time below the form. */
  permissions?: TaskPermissions;
  /** Assignees who can't edit the task: only comments, files and time. */
  workOnly?: boolean;
  /** Which of comments / files / time to open first. */
  initialWorkTab?: WorkTab;
}) {
  const isEdit = Boolean(task);
  const { data: me } = useCurrentUser();
  const isAdmin = me?.role === "admin";
  const isHeadOrAdmin = isAdmin || me?.role === "head";
  const createTask = useCreateTask();
  const updateTask = useUpdateTask();
  const assignable = useAssignableUsers(open);
  const labels = useTaskLabels();
  const categories = useTaskCategories();
  const projects = useProjectOptions(open);
  // "Manage …" links open settings in a new tab; pick up new options on return.
  useRefetchOnFocus(labels.refetch, open && isAdmin);
  useRefetchOnFocus(categories.refetch, open && isAdmin);

  const [form, setForm] = useState<FormState>(() =>
    initialState(task, defaultProjectId, defaultIteration, defaultReworkOf),
  );
  const projectId = form.project === NO_PROJECT ? null : form.project;
  const projectDetail = useProject(open ? projectId : null);
  const milestones = useMilestones(projectId, open);
  useRefetchOnFocus(
    milestones.refetch,
    open && Boolean(projectId) && isHeadOrAdmin,
  );
  const [submitted, setSubmitted] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  /** Creating the drafted subtasks (and their files) after the task is saved. */
  const [savingSubtasks, setSavingSubtasks] = useState(false);
  // Files picked in the form; uploaded after the task is saved.
  const [attachments, setAttachments] = useState<File[]>([]);
  const [savingFiles, setSavingFiles] = useState(false);
  const pending =
    createTask.isPending ||
    updateTask.isPending ||
    savingSubtasks ||
    savingFiles;

  useEffect(() => {
    if (open) {
      setForm(initialState(task, defaultProjectId, defaultIteration, defaultReworkOf));
      setAttachments([]);
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
      if (!people.has(user._id))
        people.set(user._id, {
          _id: user._id,
          name: user.name,
          email: user.email,
        });
    };
    if (me) add({ _id: me._id, name: me.name, email: me.email });
    const pool = [
      ...(projectDetail.data?.project.members.map((member) => member.user) ??
        []),
      ...(assignable.data ?? []),
    ];
    for (const id of form.assignees) {
      const user = pool.find((candidate) => candidate._id === id);
      if (user) add(user);
    }
    for (const member of projectDetail.data?.project.members ?? [])
      add(member.user);
    for (const user of assignable.data ?? []) add(user);
    return [...people.values()];
  }, [me, projectDetail.data, assignable.data, form.assignees, isHeadOrAdmin]);

  // A disabled query stays `isPending` forever (non-heads never fetch the
  // assignable list) — only report loading for queries actually fetching.
  const loadingPeople =
    assignable.isLoading || (Boolean(projectId) && projectDetail.isLoading);
  const peopleError =
    assignable.isError || (Boolean(projectId) && projectDetail.isError);

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
      if (projectDetail.data?.permissions.canManageMembers || projectDetail.data?.permissions.canCreateTasks) {
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
          description: [user.email, user.department?.name]
            .filter(Boolean)
            .join(" · "),
        });
      }
    }
    // Keep current assignees selectable even if outside the assignable list.
    for (const user of task?.assignees ?? []) {
      if (!options.has(user._id)) {
        options.set(user._id, {
          value: user._id,
          label: user.name,
          description: user.email,
        });
      }
    }
    return [...options.values()];
  }, [assignable.data, task, projectId, projectDetail.data]);

  // Projects the caller may add tasks to: heads/admins → any visible project,
  // employees → projects they manage or are a member of. Archived / completed ones are excluded.
  const projectChoices = useMemo(
    () =>
      (projects.data ?? []).filter(
        (project) =>
          !project.archivedAt &&
          !project.status.isCompleted &&
          !project.expired &&
          (!project.approval || project.approval.status === "approved") &&
          (isHeadOrAdmin ||
            project.manager?._id === me?._id ||
            project.members.some((member) => member.user?._id === me?._id)),
      ),
    [projects.data, isHeadOrAdmin, me?._id],
  );
  // Every new task sits under a project; "No project" only for an older task that has none.
  const projectItems: Record<string, string> =
    isEdit && !task?.project ? { [NO_PROJECT]: "No project" } : {};
  for (const project of projectChoices)
    projectItems[project._id] = project.name;
  // Keep the task's current project selectable even if filtered out (a new
  // task can't go into a closed project, so its default must still be open).
  const defaultProject = projects.data?.find((project) => project._id === projectId);
  const defaultClosed =
    !isEdit &&
    Boolean(defaultProject?.expired || (defaultProject?.approval && defaultProject.approval.status !== "approved"));
  if (projectId && !projectItems[projectId] && !defaultClosed) {
    const current =
      task?.project ??
      projects.data?.find((project) => project._id === projectId);
    if (current) projectItems[projectId] = current.name;
  }

  const milestoneItems: Record<string, string> = {
    [NO_MILESTONE]: "No milestone",
  };
  for (const milestone of milestones.data ?? []) {
    milestoneItems[milestone._id] =
      milestone.status === "complete"
        ? `${milestone.title} (complete)`
        : milestone.title;
  }
  const selectedMilestone = milestones.data?.find(
    (milestone) => milestone._id === form.milestone,
  );
  const milestoneDueWarning = Boolean(
    selectedMilestone?.endDate &&
    form.dueDate &&
    form.dueDate > selectedMilestone.endDate.slice(0, 10),
  );

  const labelOptions = useMemo<MultiSelectOption[]>(
    () =>
      (labels.data ?? []).map((label) => ({
        value: label._id,
        label: label.name,
        icon: <LabelColorDot color={label.color} className="size-2" />,
      })),
    [labels.data],
  );

  const categoryItems: Record<string, string> = {
    [NO_CATEGORY]: "No category",
  };
  for (const category of categories.data ?? [])
    categoryItems[category._id] = category.name;

  // New rework: only the original task is asked for; the name is versioned by the server.
  const reworkCreate = !task && form.iteration === "rework";
  // New tasks and rules-era tasks use the controlled name; older tasks keep a free title.
  const controlledName = (!task || Boolean(task.titleParts)) && !reworkCreate;
  const quantityNumber = Number(form.quantity);
  const partsError = !controlledName
    ? null
    : !form.unit.trim()
      ? "Enter the scope unit (e.g. Video, Post, Banner)."
      : !Number.isInteger(quantityNumber) || quantityNumber < 1
        ? "Quantity must be a whole number, 1 or more."
        : !form.shortName.trim()
          ? "Enter a short name."
          : null;
  const composedTitle = controlledName
    ? `${form.unit.trim()} ${Number.isInteger(quantityNumber) && quantityNumber > 0 ? quantityNumber : "?"} – ${form.shortName.trim()}`
    : form.title.trim();
  const titleInvalid = controlledName
    ? submitted && Boolean(partsError)
    : submitted && (form.title.trim() === "" || form.title.trim().length > 200);
  const rulesApply = !task || Boolean(task.iteration);
  const iterationInvalid = submitted && rulesApply && !form.iteration;
  const reworkMissing = !task && form.iteration === "rework" && !form.reworkOf;
  // New work and rework: a written brief or an attached file.
  // The brief may be formatted (HTML): count its text.
  const descriptionText = richTextPlain(form.description);
  const briefMissing = !task && descriptionText.trim() === "" && attachments.length === 0;
  const dueMissing = reworkCreate && form.dueDate === "";
  const briefInvalid = submitted && briefMissing;
  const assigneesInvalid = submitted && form.assignees.length === 0;
  const datesInvalid =
    submitted &&
    form.startDate !== "" &&
    form.dueDate !== "" &&
    form.startDate > form.dueDate;
  const descriptionTooLong = descriptionText.length > 2000 || form.description.length > 20000;
  const descriptionInvalid = submitted && descriptionTooLong;
  const recurrenceInvalid = Boolean(recurrenceError(form.recurrence));
  const projectInvalid =
    submitted && (!task || Boolean(task.project)) && !projectId;
  const estimate = parseEstimate(form.estimateHours, form.estimateMinutes);
  // Estimated time is optional.
  const estimateMissing = false;
  const estimateInvalid =
    submitted && (estimate === "invalid" || estimateMissing);
  const actualError = actualDatesError(form.actualStart, form.actualEnd);
  const actualInvalid = submitted && Boolean(actualError);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    const title = composedTitle;
    if (
      (reworkCreate ? false : controlledName ? Boolean(partsError) : !title || title.length > 200) ||
      dueMissing ||
      (rulesApply && !form.iteration) ||
      reworkMissing ||
      briefMissing ||
      ((!task || Boolean(task.project)) && !projectId) ||
      estimateMissing ||
      form.assignees.length === 0 ||
      descriptionTooLong ||
      (form.startDate && form.dueDate && form.startDate > form.dueDate) ||
      recurrenceInvalid ||
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
        // Rework: the server names it after the original task with a version (R1, R2 …).
        ...(reworkCreate
          ? {}
          : {
              titleParts: {
                unit: form.unit.trim(),
                quantity: quantityNumber,
                shortName: form.shortName.trim(),
              },
            }),
        ...(form.iteration ? { iteration: form.iteration } : {}),
        ...(form.iteration === "rework" && form.reworkOf ? { reworkOf: form.reworkOf } : {}),
        hasAttachments: attachments.length > 0,
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
                `Task created, but ${result.failedSubtasks.length} subtask(s) couldn't be added: ${result.failedSubtasks.join(", ")}. Add them from the task's Subtasks tab.`,
              );
            }
            if (result.failedFiles.length > 0) {
              toast.warning(
                `Some files didn't upload: ${result.failedFiles.join(", ")}`,
              );
            }
          }
          await uploadAttachments(taskId);
          onOpenChange(false);
          onCreated?.(taskId);
        },
      });
      return;
    }

    // Edit: send only what changed.
    const original = initialState(task);
    const input: TaskUpdateInput = {};
    if (controlledName) {
      if (
        form.unit.trim() !== original.unit ||
        form.quantity !== original.quantity ||
        form.shortName.trim() !== original.shortName
      ) {
        input.titleParts = {
          unit: form.unit.trim(),
          quantity: quantityNumber,
          shortName: form.shortName.trim(),
        };
      }
    } else if (title !== original.title) {
      input.title = title;
    }
    if (form.iteration && form.iteration !== original.iteration)
      input.iteration = form.iteration;
    if (form.description.trim() !== original.description.trim()) {
      input.description = form.description.trim();
    }
    if (!sameIds(form.assignees, original.assignees))
      input.assignees = form.assignees;
    if (form.priority !== original.priority) input.priority = form.priority;
    if (form.category !== original.category) input.category = category;
    if (!sameIds(form.labels, original.labels)) input.labels = form.labels;
    if (form.startDate !== original.startDate)
      input.startDate = form.startDate || null;
    if (form.dueDate !== original.dueDate) input.dueDate = form.dueDate || null;
    if (
      JSON.stringify(form.recurrence) !== JSON.stringify(original.recurrence)
    ) {
      input.recurrence = form.recurrence;
    }
    if (estimate !== (task.estimateMinutes ?? null))
      input.estimateMinutes = estimate;
    if (form.project !== original.project) input.project = projectId;
    if (form.milestone !== original.milestone)
      input.milestone = projectId ? milestone : null;
    // Emptying an actual date returns it to automatic.
    if (form.actualStart !== original.actualStart) {
      input.actualStartAt = form.actualStart
        ? fromDateTimeInput(form.actualStart)
        : null;
    }
    if (form.actualEnd !== original.actualEnd) {
      input.actualEndAt = form.actualEnd
        ? fromDateTimeInput(form.actualEnd)
        : null;
    }

    if (Object.keys(input).length === 0) {
      void uploadAttachments(task._id).then(() => onOpenChange(false));
      return;
    }
    updateTask.mutate(
      { id: task._id, input },
      {
        onSuccess: async () => {
          await uploadAttachments(task._id);
          onOpenChange(false);
        },
      },
    );
  }

  /** Uploads the picked files to the saved task; failures are named in a toast. */
  async function uploadAttachments(taskId: string) {
    if (attachments.length === 0) return;
    setSavingFiles(true);
    const failed = await uploadTaskFilesNow(queryClient, taskId, attachments);
    setSavingFiles(false);
    if (failed.length > 0) {
      toast.warning(
        `Some files didn't upload: ${failed.join(", ")}. Add them from the task's Files tab.`,
      );
    }
  }

  const iterationField = rulesApply ? (
    <fieldset className="space-y-1.5">
                  <legend className="text-sm font-medium">Iteration<span aria-hidden className="ml-0.5 text-destructive">*</span></legend>
                  <RadioGroup
                    value={form.iteration}
                    onValueChange={(value) =>
                      set("iteration", value as TaskIteration)
                    }
                    className="flex flex-wrap gap-4"
                  >
                    <label className="flex cursor-pointer items-center gap-2 text-sm">
                      <RadioGroupItem value="new" />
                      New work
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 text-sm">
                      <RadioGroupItem value="rework" />
                      Rework (a new task linked to the original)
                    </label>
                  </RadioGroup>
                  {iterationInvalid && (
                    <p className="text-xs text-destructive">
                      Choose new work or rework.
                    </p>
                  )}
                </fieldset>
  ) : null;
  const projectOptions: ProjectOption[] = Object.entries(projectItems).map(([value, label]) => {
    const code = projects.data?.find((p) => p._id === value)?.code ?? task?.project?.code ?? "";
    return { value, label, search: `${label} ${code}`.toLowerCase().replace(/[_·]/g, " ") };
  });
  // Rework tasks name the original task (same project); shown in its Rework tab.
  const reworkField =
    !task && form.iteration === "rework" ? (
      <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="task-rework-project">
          Project<span aria-hidden className="ml-0.5 text-destructive">*</span>
        </Label>
        <Combobox
          items={projectOptions}
          value={projectOptions.find((o) => o.value === form.project) ?? null}
          onValueChange={(option: ProjectOption | null) =>
            setForm((current) => ({
              ...current,
              project: option?.value ?? NO_PROJECT,
              milestone: NO_MILESTONE,
              // A new project means a new list of tasks.
              reworkOf: option?.value === current.project ? current.reworkOf : "",
            }))
          }
          filter={matchesProject}
          isItemEqualToValue={(x: ProjectOption, y: ProjectOption) => x.value === y.value}
          disabled={Boolean(defaultReworkOf)}
        >
          <ComboboxInput
            id="task-rework-project"
            className="w-full"
            placeholder={projects.isPending ? "Loading…" : "Search projects by name…"}
            aria-invalid={projectInvalid || undefined}
          />
          <ComboboxContent>
            <ComboboxEmpty>No projects found.</ComboboxEmpty>
            <ComboboxList>
              {(option: ProjectOption) => (
                <ComboboxItem key={option.value} value={option}>
                  {option.label}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
        {projectInvalid && <p className="text-xs text-destructive">Choose the project first.</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="task-rework-of">
          Task to rework<span aria-hidden className="ml-0.5 text-destructive">*</span>
        </Label>
        <ReworkTaskPicker
          id="task-rework-of"
          requireProject
          projectId={projectId}
          value={form.reworkOf}
          onChange={(value) => set("reworkOf", value)}
          initial={defaultReworkOf}
          invalid={submitted && reworkMissing}
        />
        {submitted && reworkMissing && (
          <p className="text-xs text-destructive">Choose the task this rework is for.</p>
        )}
        {form.reworkOf && projectId && !projectItems[projectId] && (
          <p className="text-xs text-destructive">You can't add tasks to this task's project.</p>
        )}
        <p className="text-xs text-muted-foreground">
          The rework is a new task in the same project, named after the original with a version (R1, R2 …),
          and appears in the original task&apos;s Rework tab.
        </p>
      </div>
      </div>
    ) : null;

  return (
    <Sheet open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <PageDrawerContent>
        <div className="show-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 pt-12 sm:p-6 lg:pt-6">
          <SheetHeader className="p-0">
            <SheetTitle className="text-2xl font-semibold">
              {isEdit ? "Update Task" : "Add Task"}
            </SheetTitle>
            <SheetDescription>
              {workOnly
                ? `${task?.title ?? ""} — add comments, files and time.`
                : isEdit
                  ? "Update the details, comments, files and time. Newly added assignees are notified."
                  : "Assign work to one or more people. Everyone assigned gets notified."}
            </SheetDescription>
          </SheetHeader>

          {!workOnly && (
          <PageDrawerCard title="Task Info">
            <form onSubmit={handleSubmit} noValidate className="space-y-4">
              {iterationField}
              {reworkField}
              {reworkCreate ? null : controlledName ? (
                <div className="space-y-1.5">
                  <Label htmlFor="task-unit">Task name<span aria-hidden className="ml-0.5 text-destructive">*</span></Label>
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_6rem_minmax(0,2fr)]">
                    <Input
                      id="task-unit"
                      value={form.unit}
                      onChange={(event) => set("unit", event.target.value)}
                      maxLength={40}
                      placeholder="Scope unit (e.g. Video)"
                      aria-label="Scope unit"
                      aria-invalid={titleInvalid || undefined}
                      autoFocus
                    />
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      value={form.quantity}
                      onChange={(event) => set("quantity", event.target.value)}
                      aria-label="Quantity"
                      aria-invalid={titleInvalid || undefined}
                    />
                    <Input
                      value={form.shortName}
                      onChange={(event) => set("shortName", event.target.value)}
                      maxLength={80}
                      placeholder="Short name (e.g. Launch teaser)"
                      aria-label="Short name"
                      aria-invalid={titleInvalid || undefined}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Title:{" "}
                    <span className="font-medium text-foreground">
                      {composedTitle}
                    </span>{" "}
                    — brand and month come from the project.
                  </p>
                  {titleInvalid && partsError && (
                    <p
                      id="task-title-error"
                      className="text-xs text-destructive"
                    >
                      {partsError}
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor="task-title">Title</Label>
                  <Input
                    id="task-title"
                    value={form.title}
                    onChange={(event) => set("title", event.target.value)}
                    maxLength={200}
                    placeholder="e.g. Prepare the Q4 onboarding deck"
                    aria-invalid={titleInvalid || undefined}
                    aria-describedby={
                      titleInvalid ? "task-title-error" : undefined
                    }
                    autoFocus
                  />
                  {titleInvalid && (
                    <p
                      id="task-title-error"
                      className="text-xs text-destructive"
                    >
                      A title is required (max 200 characters).
                    </p>
                  )}
                </div>
              )}


              <div className="space-y-1.5">
                <Label htmlFor="task-description">
                  Brief<span aria-hidden className="ml-0.5 text-destructive">*</span>{" "}
                  <span className="font-normal text-muted-foreground">
                    (a description or an attached file is required)
                  </span>
                </Label>
                <RichTextEditor
                  id="task-description"
                  value={form.description}
                  onChange={(html) => set("description", html)}
                  placeholder="What needs to be done? Add context, links, acceptance criteria…"
                  invalid={descriptionInvalid}
                />
                {descriptionInvalid && (
                  <p className="text-xs text-destructive">
                    Keep the description under 2000 characters.
                  </p>
                )}
                {briefInvalid && (
                  <p className="text-xs text-destructive">
                    Add the brief: write a description or attach a file.
                  </p>
                )}
              </div>

              <AttachmentsField
                files={attachments}
                onChange={setAttachments}
                disabled={pending}
                existingCount={task?.fileCount ?? 0}
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="task-project">Project<span aria-hidden className="ml-0.5 text-destructive">*</span></Label>
                  {/* Searchable: type part of the code or name. */}
                  <Combobox
                    items={projectOptions}
                    filter={matchesProject}
                    value={projectOptions.find((o) => o.value === form.project) ?? null}
                    onValueChange={(option: ProjectOption | null) =>
                      setForm((current) => ({
                        ...current,
                        project: option?.value ?? NO_PROJECT,
                        milestone: NO_MILESTONE,
                        reworkOf: "",
                      }))
                    }
                    isItemEqualToValue={(x: ProjectOption, y: ProjectOption) => x.value === y.value}
                    disabled={(Boolean(defaultProjectId) && !isEdit) || reworkCreate}
                  >
                    <ComboboxInput
                      id="task-project"
                      className="w-full"
                      placeholder={projects.isPending ? "Loading…" : "Search projects by code or name…"}
                      aria-invalid={projectInvalid || undefined}
                    />
                    <ComboboxContent>
                      <ComboboxEmpty>No projects found.</ComboboxEmpty>
                      <ComboboxList>
                        {(option: ProjectOption) => (
                          <ComboboxItem key={option.value} value={option}>
                            {option.label}
                          </ComboboxItem>
                        )}
                      </ComboboxList>
                    </ComboboxContent>
                  </Combobox>
                  {projectInvalid && (
                    <p className="text-xs text-destructive">
                      Every task belongs to a project — choose one.
                    </p>
                  )}
                  {!isEdit && !projects.isPending && projectChoices.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      You aren&apos;t on any open project yet. Create a project (Projects → Add project), or ask a
                      project&apos;s manager to add you to its team.
                    </p>
                  )}
                  {isEdit &&
                    task?.project &&
                    form.project !== task.project._id && (
                      <p className="text-xs text-muted-foreground">
                        Moving the task gives it a new short code.
                      </p>
                    )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="task-milestone">Milestone</Label>
                  <Select
                    value={form.milestone}
                    onValueChange={(value) =>
                      set("milestone", String(value ?? NO_MILESTONE))
                    }
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
                    <p className="text-xs text-muted-foreground">
                      Milestones belong to a project.
                    </p>
                  )}
                  {projectId && isHeadOrAdmin && (
                    <ManageLink to={`/projects/${projectId}?tab=milestones`}>
                      Manage milestones
                    </ManageLink>
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="task-assignees">Assignees<span aria-hidden className="ml-0.5 text-destructive">*</span></Label>
                <MultiSelect
                  id="task-assignees"
                  options={assigneeOptions}
                  value={form.assignees}
                  onValueChange={(value) => set("assignees", value)}
                  placeholder={
                    loadingPeople ? "Loading people…" : "Search people…"
                  }
                  emptyText={
                    peopleError ? "Couldn't load people." : "No one found."
                  }
                  invalid={assigneesInvalid}
                  max={MAX_ASSIGNEES}
                  aria-describedby={
                    assigneesInvalid ? "task-assignees-error" : undefined
                  }
                />
                {assigneesInvalid && (
                  <p
                    id="task-assignees-error"
                    className="text-xs text-destructive"
                  >
                    Assign at least one person.
                  </p>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="task-priority">Priority</Label>
                  <Select
                    value={form.priority}
                    onValueChange={(value) =>
                      set("priority", value as TaskPriority)
                    }
                    items={Object.fromEntries(
                      PRIORITIES.map((p) => [p, PRIORITY_META[p].label]),
                    )}
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
                    onValueChange={(value) =>
                      set("category", String(value ?? NO_CATEGORY))
                    }
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
                  {isAdmin && (
                    <ManageLink to="/settings/tasks">
                      Manage categories
                    </ManageLink>
                  )}
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
                  <Label htmlFor="task-due">
                    Due date
                    {reworkCreate && <span aria-hidden className="ml-0.5 text-destructive">*</span>}
                  </Label>
                  <Input
                    id="task-due"
                    type="date"
                    value={form.dueDate}
                    min={form.startDate || undefined}
                    onChange={(event) => set("dueDate", event.target.value)}
                    aria-invalid={datesInvalid || undefined}
                    aria-describedby={
                      datesInvalid ? "task-dates-error" : undefined
                    }
                  />
                </div>
                {submitted && dueMissing && (
                  <p className="text-xs text-destructive sm:col-span-2">Choose the due date for this rework.</p>
                )}
                {datesInvalid && (
                  <p
                    id="task-dates-error"
                    className="text-xs text-destructive sm:col-span-2"
                  >
                    The due date can&apos;t be before the start date.
                  </p>
                )}
                {milestoneDueWarning && (
                  <p
                    className="text-xs text-muted-foreground sm:col-span-2"
                    role="status"
                  >
                    Heads up: the due date is after the milestone&apos;s end
                    date.
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
                invalid={submitted && estimate === "invalid"}
              />

              {isEdit && permissions?.canEditActualDates !== false && (
                <fieldset className="space-y-1.5">
                  <legend className="mb-1.5 text-sm leading-none font-medium">
                    Actual dates
                  </legend>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label
                        htmlFor="task-actual-start"
                        className="text-xs text-muted-foreground"
                      >
                        Actual start
                      </Label>
                      <Input
                        id="task-actual-start"
                        type="datetime-local"
                        value={form.actualStart}
                        max={toDateTimeInput(new Date())}
                        onChange={(event) =>
                          set("actualStart", event.target.value)
                        }
                        aria-invalid={actualInvalid || undefined}
                        aria-describedby="task-actual-hint"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label
                        htmlFor="task-actual-end"
                        className="text-xs text-muted-foreground"
                      >
                        Actual end
                      </Label>
                      <Input
                        id="task-actual-end"
                        type="datetime-local"
                        value={form.actualEnd}
                        min={form.actualStart || undefined}
                        max={toDateTimeInput(new Date())}
                        onChange={(event) =>
                          set("actualEnd", event.target.value)
                        }
                        aria-invalid={actualInvalid || undefined}
                        aria-describedby="task-actual-hint"
                      />
                    </div>
                  </div>
                  <p
                    id="task-actual-hint"
                    className={
                      actualInvalid
                        ? "text-xs text-destructive"
                        : "text-xs text-muted-foreground"
                    }
                  >
                    {actualInvalid
                      ? actualError
                      : "Filled automatically from the time logs; you can edit them. Edited values stay as entered — clear a field to return it to automatic."}
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
                    labelOptions.length === 0
                      ? "No labels yet — an admin can add some"
                      : "Add labels…"
                  }
                  emptyText="No labels found."
                  max={MAX_LABELS}
                  disabled={labelOptions.length === 0}
                />
                {isAdmin && (
                  <ManageLink to="/settings/tasks">Manage labels</ManageLink>
                )}
              </div>


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


              <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end">
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
                  {savingFiles
                    ? "Uploading files…"
                    : pending
                      ? "Saving…"
                      : isEdit
                        ? "Save changes"
                        : "Create task"}
                </Button>
              </div>
            </form>
          </PageDrawerCard>
          )}
          {task && permissions && me && (
            <TaskWorkSections
              task={task}
              permissions={permissions}
              me={{ _id: me._id, role: me.role }}
              initialTab={initialWorkTab}
            />
          )}
        </div>
      </PageDrawerContent>
    </Sheet>
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
  const initial =
    editing !== null && editing >= 0 ? (value[editing] ?? null) : null;

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
            <span className="text-xs font-normal text-muted-foreground tabular-nums">
              ({value.length})
            </span>
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
                  <p
                    className="truncate text-sm font-medium"
                    title={draft.title}
                  >
                    {draft.title}
                  </p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      {draft.assignee ? (
                        <>
                          <UserAvatar user={draft.assignee} />
                          {draft.assignee._id === me._id
                            ? "You"
                            : draft.assignee.name}
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
                        {draft.files.length} file
                        {draft.files.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                  {draft.description && (
                    <p className="line-clamp-2 text-xs text-muted-foreground">
                      {draft.description}
                    </p>
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
        task={{
          _id: "",
          title: taskTitle,
          shortCode: null,
          dueDate: taskDueDate,
        }}
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
