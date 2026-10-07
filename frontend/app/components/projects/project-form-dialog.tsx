import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { LuLoaderCircle, LuPlus, LuSave } from "react-icons/lu";

import { ManageLink, useRefetchOnFocus } from "@/components/globals/manage-link";
import { MultiSelect, type MultiSelectOption } from "@/components/globals/multi-select";
import {
  FieldError,
  OptionSelect,
  SwitchRow,
  type OptionItem,
} from "@/components/projects/project-fields";
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
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentUser } from "@/hooks/use-auth";
import { useBrands } from "@/hooks/use-brands";
import { useDepartments } from "@/hooks/use-departments";
import { useProjectCategories, useProjectStatuses } from "@/hooks/use-project-meta";
import { useCreateProject, useUpdateProject } from "@/hooks/use-projects";
import { useAssignableUsers } from "@/hooks/use-task-meta";
import {
  PROGRESS_MODES,
  PROGRESS_MODE_META,
  PROJECT_CODE_PATTERN,
  statusColor,
  suggestCode,
} from "@/lib/projects";
import { currencySymbol } from "@/lib/format";
import { LABEL_COLOR_META, toDateInput, todayKey } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { ProgressMode, Project, ProjectInput, ProjectUpdateInput } from "@/types";

const NONE = "none";
const MAX_SUMMARY = 2000;

interface FormState {
  name: string;
  code: string;
  summary: string;
  category: string;
  brand: string;
  departments: string[];
  manager: string;
  members: string[];
  status: string;
  startDate: string;
  deadline: string;
  progressMode: ProgressMode;
  progress: string;
  hoursAllocated: string;
  budget: string;
  isPublic: boolean;
  manualTimeLogs: boolean;
  requireTaskApproval: boolean;
}

function numberText(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

function initialState(project?: Project | null): FormState {
  return {
    name: project?.name ?? "",
    code: project?.code ?? "",
    summary: project?.summary ?? "",
    category: project?.category?._id ?? NONE,
    brand: project?.brand?._id ?? NONE,
    departments: project?.departments.map((department) => department._id) ?? [],
    manager: project?.manager?._id ?? NONE,
    members: [],
    status: project?.status._id ?? "",
    startDate: project ? toDateInput(project.startDate) : todayKey(),
    deadline: toDateInput(project?.deadline),
    progressMode: project?.progressMode ?? "task_completion",
    progress: project ? String(project.progress) : "0",
    hoursAllocated: numberText(project?.hoursAllocated),
    budget: numberText(project?.budget),
    isPublic: project?.isPublic ?? false,
    manualTimeLogs: project?.manualTimeLogs ?? true,
    requireTaskApproval: project?.requireTaskApproval ?? true,
  };
}

function parseOptionalNumber(text: string): number | null | "invalid" {
  if (text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : "invalid";
}

function sameIds(a: string[], b: string[]) {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

/**
 * Create (head/admin) or edit (project managers) a project. Edit mode PATCHes
 * only the changed fields and never touches status or members.
 */
export function ProjectFormDialog({
  open,
  onOpenChange,
  project,
  canViewRates = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present → edit mode. */
  project?: Project | null;
  /** Hide the budget field in edit mode when the caller can't see rates. */
  canViewRates?: boolean;
}) {
  const isEdit = Boolean(project);
  const navigate = useNavigate();
  const { data: user } = useCurrentUser();
  const isAdmin = user?.role === "admin";
  const isHeadOrAdmin = isAdmin || user?.role === "head";

  const createProject = useCreateProject();
  const updateProject = useUpdateProject();
  const statuses = useProjectStatuses();
  const categories = useProjectCategories();
  // Employees (project managers editing) get 403 here — only fetch for head/admin.
  const assignable = useAssignableUsers(open && isHeadOrAdmin);

  const brands = useBrands(false, open);
  useRefetchOnFocus(categories.refetch, open && isAdmin);
  useRefetchOnFocus(brands.refetch, open && isAdmin);

  const [form, setForm] = useState<FormState>(() => initialState(project));
  const [codeTouched, setCodeTouched] = useState(isEdit);
  const [submitted, setSubmitted] = useState(false);
  const pending = createProject.isPending || updateProject.isPending;

  useEffect(() => {
    if (open) {
      setForm(initialState(project));
      setCodeTouched(Boolean(project));
      setSubmitted(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project?._id]);

  // Default status for new projects.
  useEffect(() => {
    if (!open || isEdit || form.status) return;
    const fallback = statuses.data?.find((status) => status.isDefault) ?? statuses.data?.[0];
    if (fallback) setForm((current) => ({ ...current, status: fallback._id }));
  }, [open, isEdit, form.status, statuses.data]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function changeName(name: string) {
    setForm((current) => ({
      ...current,
      name,
      code: codeTouched ? current.code : suggestCode(name),
    }));
  }

  const memberOptions = useMemo<MultiSelectOption[]>(
    () =>
      (assignable.data ?? []).map((person) => ({
        value: person._id,
        label: person.name,
        description: [person.email, person.department?.name].filter(Boolean).join(" · "),
      })),
    [assignable.data]
  );

  const managerOptions = useMemo<OptionItem[]>(() => {
    const options = new Map<string, OptionItem>();
    options.set(NONE, { value: NONE, label: "No manager" });
    if (user) options.set(user._id, { value: user._id, label: `${user.name} (you)` });
    for (const member of project?.members ?? []) {
      options.set(member.user._id, {
        value: member.user._id,
        label: member.user.name,
        description: member.user.email,
      });
    }
    for (const person of assignable.data ?? []) {
      if (!options.has(person._id)) {
        options.set(person._id, { value: person._id, label: person.name, description: person.email });
      }
    }
    if (project?.manager && !options.has(project.manager._id)) {
      options.set(project.manager._id, {
        value: project.manager._id,
        label: project.manager.name,
        description: project.manager.email,
      });
    }
    return [...options.values()];
  }, [assignable.data, project, user]);

  const categoryOptions = useMemo<OptionItem[]>(
    () => [
      { value: NONE, label: "No category" },
      ...(categories.data ?? []).map((category) => ({ value: category._id, label: category.name })),
    ],
    [categories.data]
  );

  // Active brands, plus the project's current one even if it was deactivated since.
  const brandOptions = useMemo<OptionItem[]>(() => {
    const currentId = project?.brand?._id;
    return [
      { value: NONE, label: "No brand" },
      ...(brands.data ?? [])
        .filter((brand) => brand.active || brand._id === currentId)
        .map((brand) => ({
          value: brand._id,
          label: brand.active ? brand.name : `${brand.name} (inactive)`,
          icon: (
            <span
              aria-hidden
              className={cn("size-2 rounded-full", (LABEL_COLOR_META[brand.color] ?? LABEL_COLOR_META.muted).dot)}
            />
          ),
        })),
    ];
  }, [brands.data, project?.brand?._id]);

  const statusOptions = useMemo<OptionItem[]>(
    () =>
      (statuses.data ?? [])
        .filter((status) => status.active)
        .map((status) => ({
          value: status._id,
          label: status.name,
          icon: (
            <span
              aria-hidden
              className={cn("size-2 rounded-full", statusColor(status.color).dot)}
            />
          ),
        })),
    [statuses.data]
  );

  const modeOptions: OptionItem[] = PROGRESS_MODES.map((mode) => ({
    value: mode,
    label: PROGRESS_MODE_META[mode].label,
    description: PROGRESS_MODE_META[mode].description,
  }));

  // ---- validation ---------------------------------------------------------
  const name = form.name.trim();
  const code = form.code.trim().toUpperCase();
  const nameError = !name ? "A name is required." : name.length > 120 ? "Max 120 characters." : null;
  const codeError = PROJECT_CODE_PATTERN.test(code)
    ? null
    : "2–10 uppercase letters or digits (e.g. WEB).";
  const datesError =
    form.deadline && form.startDate && form.deadline < form.startDate
      ? "The deadline can't be before the start date."
      : null;
  const hours = parseOptionalNumber(form.hoursAllocated);
  const budget = parseOptionalNumber(form.budget);
  const progressValue = Number(form.progress);
  const progressError =
    form.progressMode === "manual" &&
    (!Number.isFinite(progressValue) || progressValue < 0 || progressValue > 100)
      ? "Enter a percentage between 0 and 100."
      : null;
  const summaryError = form.summary.length > MAX_SUMMARY ? "Keep the summary shorter." : null;
  const hasErrors = Boolean(
    nameError ||
      codeError ||
      datesError ||
      progressError ||
      summaryError ||
      hours === "invalid" ||
      budget === "invalid"
  );
  const show = (error: string | null | boolean) => submitted && Boolean(error);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (hasErrors || hours === "invalid" || budget === "invalid") return;

    const category = form.category === NONE ? null : form.category;
    const brand = form.brand === NONE ? null : form.brand;
    const manager = form.manager === NONE ? null : form.manager;

    if (!project) {
      const input: ProjectInput = {
        name,
        code,
        summary: form.summary.trim() || undefined,
        category,
        brand,
        manager,
        members: form.members,
        status: form.status || undefined,
        startDate: form.startDate || undefined,
        deadline: form.deadline || null,
        progressMode: form.progressMode,
        hoursAllocated: hours,
        budget,
        isPublic: form.isPublic,
        manualTimeLogs: form.manualTimeLogs,
        requireTaskApproval: form.requireTaskApproval,
      };
      if (isAdmin && form.departments.length > 0) input.departments = form.departments;
      if (form.progressMode === "manual") input.progress = Math.round(progressValue);
      createProject.mutate(input, {
        onSuccess: (data) => {
          onOpenChange(false);
          void navigate(`/projects/${data.project._id}`);
        },
      });
      return;
    }

    const original = initialState(project);
    const input: ProjectUpdateInput = {};
    if (name !== original.name) input.name = name;
    if (code !== original.code) input.code = code;
    if (form.summary.trim() !== original.summary.trim()) input.summary = form.summary.trim();
    if (form.category !== original.category) input.category = category;
    if (form.brand !== original.brand) input.brand = brand;
    if (isAdmin && !sameIds(form.departments, original.departments)) {
      input.departments = form.departments;
    }
    if (form.manager !== original.manager) input.manager = manager;
    if (form.startDate !== original.startDate && form.startDate) input.startDate = form.startDate;
    if (form.deadline !== original.deadline) input.deadline = form.deadline || null;
    if (form.progressMode !== original.progressMode) input.progressMode = form.progressMode;
    if (form.progressMode === "manual" && form.progress !== original.progress) {
      input.progress = Math.round(progressValue);
    }
    if (form.hoursAllocated !== original.hoursAllocated) input.hoursAllocated = hours;
    if (canViewRates && form.budget !== original.budget) input.budget = budget;
    if (form.isPublic !== original.isPublic) input.isPublic = form.isPublic;
    if (form.manualTimeLogs !== original.manualTimeLogs) input.manualTimeLogs = form.manualTimeLogs;
    if (form.requireTaskApproval !== original.requireTaskApproval) {
      input.requireTaskApproval = form.requireTaskApproval;
    }

    if (Object.keys(input).length === 0) {
      onOpenChange(false);
      return;
    }
    updateProject.mutate({ id: project._id, input }, { onSuccess: () => onOpenChange(false) });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit project" : "New project"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the project details. Status and members are managed from the project page."
              : "Set up the project, its team and how progress is measured. Members are notified."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} noValidate className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
            <div className="space-y-1.5">
              <Label htmlFor="project-name">Name</Label>
              <Input
                id="project-name"
                value={form.name}
                onChange={(event) => changeName(event.target.value)}
                maxLength={120}
                placeholder="e.g. Website redesign"
                aria-invalid={show(nameError) || undefined}
                aria-describedby={show(nameError) ? "project-name-error" : undefined}
                autoFocus
              />
              {show(nameError) && <FieldError id="project-name-error">{nameError}</FieldError>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="project-code">Code</Label>
              <Input
                id="project-code"
                value={form.code}
                onChange={(event) => {
                  setCodeTouched(true);
                  set("code", event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""));
                }}
                maxLength={10}
                placeholder="WEB"
                className="font-mono uppercase"
                aria-invalid={show(codeError) || undefined}
                aria-describedby="project-code-hint"
              />
              {show(codeError) ? (
                <FieldError id="project-code-hint">{codeError}</FieldError>
              ) : (
                <p id="project-code-hint" className="text-xs text-muted-foreground">
                  {isEdit ? "Only new tasks use a new code." : "Prefixes task codes (WEB-1)."}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="project-summary">Summary</Label>
            <Textarea
              id="project-summary"
              value={form.summary}
              onChange={(event) => set("summary", event.target.value)}
              rows={3}
              placeholder="Goals, scope and anything the team should know."
              aria-invalid={show(summaryError) || undefined}
            />
            {show(summaryError) && <FieldError>{summaryError}</FieldError>}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="project-category">Category</Label>
              <OptionSelect
                id="project-category"
                value={form.category}
                onChange={(value) => set("category", value)}
                options={categoryOptions}
              />
              {isAdmin && <ManageLink to="/settings/projects">Manage categories</ManageLink>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="project-brand">Brand</Label>
              <OptionSelect
                id="project-brand"
                value={form.brand}
                onChange={(value) => set("brand", value)}
                options={brandOptions}
                disabled={brands.isPending}
              />
              {isAdmin && <ManageLink to="/settings/brands">Manage brands</ManageLink>}
            </div>

            {!isEdit && (
              <div className="space-y-1.5">
                <Label htmlFor="project-status">Status</Label>
                <OptionSelect
                  id="project-status"
                  value={form.status}
                  onChange={(value) => set("status", value)}
                  options={statusOptions}
                  disabled={statuses.isPending}
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="project-manager">Project manager</Label>
              <OptionSelect
                id="project-manager"
                value={form.manager}
                onChange={(value) => set("manager", value)}
                options={managerOptions}
              />
              <p className="text-xs text-muted-foreground">Added as a member automatically.</p>
            </div>

            {isAdmin && (
              <AdminDepartmentsField
                value={form.departments}
                onChange={(value) => set("departments", value)}
              />
            )}
          </div>

          {!isEdit && (
            <div className="space-y-1.5">
              <Label htmlFor="project-members">Members</Label>
              <MultiSelect
                id="project-members"
                options={memberOptions}
                value={form.members}
                onValueChange={(value) => set("members", value)}
                placeholder={assignable.isPending ? "Loading people…" : "Search people…"}
                emptyText={assignable.isError ? "Couldn't load people." : "No one found."}
              />
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="project-start">Start date</Label>
              <Input
                id="project-start"
                type="date"
                value={form.startDate}
                onChange={(event) => set("startDate", event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="project-deadline">
                Deadline <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="project-deadline"
                type="date"
                value={form.deadline}
                min={form.startDate || undefined}
                onChange={(event) => set("deadline", event.target.value)}
                aria-invalid={show(datesError) || undefined}
                aria-describedby={show(datesError) ? "project-dates-error" : undefined}
              />
            </div>
            {show(datesError) && (
              <div className="sm:col-span-2">
                <FieldError id="project-dates-error">{datesError}</FieldError>
              </div>
            )}
          </div>

          <Separator />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="project-progress-mode">Progress calculation</Label>
              <OptionSelect
                id="project-progress-mode"
                value={form.progressMode}
                onChange={(value) => set("progressMode", value as ProgressMode)}
                options={modeOptions}
              />
              <p className="text-xs text-muted-foreground">
                {PROGRESS_MODE_META[form.progressMode].description}
              </p>
            </div>
            {form.progressMode === "manual" && (
              <div className="space-y-1.5">
                <Label htmlFor="project-progress">Progress (%)</Label>
                <Input
                  id="project-progress"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={100}
                  value={form.progress}
                  onChange={(event) => set("progress", event.target.value)}
                  aria-invalid={show(progressError) || undefined}
                />
                {show(progressError) && <FieldError>{progressError}</FieldError>}
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="project-hours">
                Hours allocated <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="project-hours"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.5"
                value={form.hoursAllocated}
                onChange={(event) => set("hoursAllocated", event.target.value)}
                placeholder="No limit"
                aria-invalid={(submitted && hours === "invalid") || undefined}
              />
              {submitted && hours === "invalid" && <FieldError>Enter a positive number.</FieldError>}
            </div>
            {canViewRates && (
              <div className="space-y-1.5">
                <Label htmlFor="project-budget">
                  Budget ({currencySymbol()}) <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="project-budget"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  value={form.budget}
                  onChange={(event) => set("budget", event.target.value)}
                  placeholder="0"
                  aria-invalid={(submitted && budget === "invalid") || undefined}
                />
                {submitted && budget === "invalid" && (
                  <FieldError>Enter a positive number.</FieldError>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <SwitchRow
              id="project-public"
              label="Public project"
              description="Everyone in the organisation can view it, not just members."
              checked={form.isPublic}
              onCheckedChange={(value) => set("isPublic", value)}
            />
            <SwitchRow
              id="project-manual-logs"
              label="Allow manual time logs"
              description="Members can add time entries by hand (managers always can)."
              checked={form.manualTimeLogs}
              onCheckedChange={(value) => set("manualTimeLogs", value)}
            />
            <SwitchRow
              id="project-task-approval"
              label="Require task approval"
              description="Submitted tasks wait for review before they count as completed."
              checked={form.requireTaskApproval}
              onCheckedChange={(value) => set("requireTaskApproval", value)}
            />
          </div>

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
              {pending ? "Saving…" : isEdit ? "Save changes" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Admin-only (mounted only for admins so heads never hit the 403 endpoint). */
function AdminDepartmentsField({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const departments = useDepartments();
  useRefetchOnFocus(departments.refetch);
  const options = useMemo<MultiSelectOption[]>(
    () =>
      (departments.data?.departments ?? []).map((department) => ({
        value: department._id,
        label: department.name,
      })),
    [departments.data]
  );
  return (
    <div className="space-y-1.5 sm:col-span-2">
      <Label htmlFor="project-departments">Departments</Label>
      <MultiSelect
        id="project-departments"
        options={options}
        value={value}
        onValueChange={onChange}
        placeholder={departments.isPending ? "Loading departments…" : "Select departments…"}
        emptyText={departments.isError ? "Couldn't load departments." : "No departments found."}
      />
      <ManageLink to="/admin/departments">Manage departments</ManageLink>
    </div>
  );
}
