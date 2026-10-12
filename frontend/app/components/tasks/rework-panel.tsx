import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LuLoaderCircle, LuRefreshCw } from "react-icons/lu";

import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { api, getErrorMessage } from "@/lib/api";
import type { MentionableUsersResponse, TaskListResponse } from "@/types";

const NOBODY = "__nobody";

interface TaskOption {
  value: string;
  label: string;
  assignees: Array<{ _id: string; name: string }>;
}

function Req() {
  return (
    <span aria-hidden className="ml-0.5 text-destructive">
      *
    </span>
  );
}

/**
 * Rework never becomes a task of its own: the user picks the original task and
 * adds a rework item inside it (what used to be a subtask). Nothing else on the
 * task changes.
 */
export function ReworkPanel({
  projectItems,
  initialProject,
  initialTask,
  onDone,
  onCancel,
}: {
  /** Projects the user can work in: id → label. */
  projectItems: Record<string, string>;
  initialProject: string;
  /** Pre-selected task (opened from a task): the user only fills in the rest. */
  initialTask?: TaskOption;
  onDone: (taskId: string) => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [project, setProject] = useState(initialProject && projectItems[initialProject] ? initialProject : "");
  const [taskId, setTaskId] = useState(initialTask && project ? initialTask.value : "");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [assignee, setAssignee] = useState(NOBODY);
  const [dueDate, setDueDate] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);

  const tasks = useQuery({
    queryKey: ["tasks", "rework-picker", project],
    queryFn: async () =>
      (await api.get<TaskListResponse>("/tasks", { params: { project, limit: 300, sort: "-createdAt" } })).data.tasks,
    enabled: Boolean(project),
    staleTime: 30_000,
  });
  const options = useMemo<TaskOption[]>(() => {
    const list = (tasks.data ?? []).map((t) => ({
      value: t._id,
      label: `${t.shortCode ?? (t.number ? `#${t.number}` : "")} · ${t.title}`,
      assignees: (t.assignees ?? []).map((a) => ({ _id: a._id, name: a.name })),
    }));
    if (initialTask && project === initialProject && !list.some((o) => o.value === initialTask.value)) list.unshift(initialTask);
    return list;
  }, [tasks.data, initialTask, project, initialProject]);
  const selected = options.find((o) => o.value === taskId) ?? null;
  // Rework can go to anyone, not only the task's assignees.
  const people = useQuery({
    queryKey: ["tasks", taskId, "subtask-assignees"],
    queryFn: async () => (await api.get<MentionableUsersResponse>(`/tasks/${taskId}/subtask-assignees`)).data.users,
    enabled: Boolean(taskId),
    staleTime: 60_000,
  });

  // Default the rework to the task's first assignee.
  useEffect(() => {
    setAssignee(selected?.assignees[0]?._id ?? NOBODY);
  }, [selected?.value]); // eslint-disable-line react-hooks/exhaustive-deps

  const errors = {
    project: !project ? "Choose the project." : null,
    task: !taskId ? "Choose the task this rework belongs to." : null,
    title: !title.trim() ? "Say what needs reworking." : title.trim().length > 200 ? "Keep it under 200 characters." : null,
  };
  const invalid = Boolean(errors.project || errors.task || errors.title);

  async function submit(event: FormEvent) {
    event.preventDefault();
    event.stopPropagation();
    setSubmitted(true);
    if (invalid || saving) return;
    setSaving(true);
    try {
      await api.post(`/tasks/${taskId}/subtasks`, {
        title: title.trim(),
        description: details.trim() || undefined,
        assignee: assignee === NOBODY ? null : assignee,
        dueDate: dueDate || null,
      });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      toast.success(`Rework added to ${selected?.label.split(" · ")[0] || "the task"}`);
      onDone(taskId);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  const assigneeItems: Record<string, string> = { [NOBODY]: "Not assigned" };
  for (const a of selected?.assignees ?? []) assigneeItems[a._id] = `${a.name} (on the task)`;
  for (const u of people.data ?? []) if (!assigneeItems[u._id]) assigneeItems[u._id] = u.name;

  return (
    <form onSubmit={submit} noValidate className="space-y-4 rounded-lg border border-dashed p-4">
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <LuRefreshCw aria-hidden className="mt-0.5 size-4 shrink-0" />
        Rework is added inside the original task as a rework item. The task itself doesn&apos;t change.
      </p>

      <div className="space-y-1.5">
        <Label htmlFor="rework-project">
          Project
          <Req />
        </Label>
        <Select
          value={project || null}
          onValueChange={(value) => {
            setProject(String(value ?? ""));
            setTaskId("");
          }}
          items={projectItems}
        >
          <SelectTrigger id="rework-project" className="w-full" aria-invalid={(submitted && Boolean(errors.project)) || undefined}>
            <SelectValue placeholder="Choose a project" />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(projectItems).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {submitted && errors.project && <p className="text-xs text-destructive">{errors.project}</p>}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="rework-task">
          Task to rework
          <Req />
        </Label>
        <Combobox
          items={options}
          value={selected}
          onValueChange={(option: TaskOption | null) => setTaskId(option?.value ?? "")}
          isItemEqualToValue={(a: TaskOption, b: TaskOption) => a.value === b.value}
          disabled={!project}
        >
          <ComboboxInput
            id="rework-task"
            placeholder={!project ? "Choose the project first" : tasks.isPending ? "Loading tasks…" : "Search the project's tasks…"}
            aria-invalid={(submitted && Boolean(errors.task)) || undefined}
            className="w-full"
          />
          <ComboboxContent>
            <ComboboxEmpty>{tasks.isError ? "Couldn't load tasks." : "No tasks found."}</ComboboxEmpty>
            <ComboboxList>
              {(option: TaskOption) => (
                <ComboboxItem key={option.value} value={option}>
                  {option.label}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
        {submitted && errors.task && <p className="text-xs text-destructive">{errors.task}</p>}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="rework-title">
          What needs reworking
          <Req />
        </Label>
        <Input
          id="rework-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          placeholder="e.g. Client feedback round 2 — change the end card"
          aria-invalid={(submitted && Boolean(errors.title)) || undefined}
        />
        {submitted && errors.title && <p className="text-xs text-destructive">{errors.title}</p>}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="rework-details">Details</Label>
        <Textarea id="rework-details" value={details} onChange={(e) => setDetails(e.target.value)} rows={3} maxLength={2000} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="rework-assignee">Assigned to</Label>
          <Select value={assignee} onValueChange={(v) => setAssignee(String(v ?? NOBODY))} items={assigneeItems} disabled={!selected}>
            <SelectTrigger id="rework-assignee" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(assigneeItems).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rework-due">Due date</Label>
          <Input id="rework-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
      </div>

      <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuRefreshCw aria-hidden />}
          Add rework
        </Button>
      </div>
    </form>
  );
}
