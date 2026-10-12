import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { LuInfo, LuLoaderCircle, LuPlus, LuSave, LuX } from "react-icons/lu";

import {
  ManageLink,
  useRefetchOnFocus,
} from "@/components/globals/manage-link";
import {
  MultiSelect,
  type MultiSelectOption,
} from "@/components/globals/multi-select";
import {
  ProjectTeamFields,
  sameTeam,
  teamFromProject,
  teamToInput,
  type TeamValue,
} from "@/components/projects/project-team-fields";
import {
  FieldError,
  OptionSelect,
  SwitchRow,
  type OptionItem,
} from "@/components/projects/project-fields";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
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
import { useBrands, useCreateBrand } from "@/hooks/use-brands";
import { useDepartments } from "@/hooks/use-departments";
import {
  useProjectCategories,
  useProjectStatuses,
  useProjectTypes,
} from "@/hooks/use-project-meta";
import {
  useCreateProject,
  useProjectNamingSuggestion,
  useUpdateProject,
} from "@/hooks/use-projects";
import { useAssignableUsers } from "@/hooks/use-task-meta";
import {
  composeProjectName,
  DEFAULT_PROJECT_TYPES,
  NAMING_SEPARATOR,
  NAMING_TITLE_MAX,
  PROGRESS_MODES,
  PROGRESS_MODE_META,
  previewProjectCode,
  statusColor,
  tidyNamePart,
} from "@/lib/projects";
import { currencySymbol } from "@/lib/format";
import { LABEL_COLOR_META, toDateInput, todayKey } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type {
  ProgressMode,
  Project,
  ProjectInput,
  ProjectNaming,
  ProjectUpdateInput,
} from "@/types";

const NONE = "none";
const MAX_SUMMARY = 2000;

interface FormState {
  /** Structured name parts (brand is `brand` below). */
  type: string;
  month: string;
  title: string;
  code: string;
  summary: string;
  category: string;
  brand: string;
  departments: string[];
  manager: string;
  members: string[];
  /** Role → user ids (manpower plan roles + "others"). */
  team: TeamValue;
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
    type: project?.naming?.type ?? "",
    month: project?.naming?.month ?? (project ? "" : todayKey().slice(0, 7)),
    title: project?.naming?.title ?? "",
    code: project?.code ?? "",
    summary: project?.summary ?? "",
    category: project?.category?._id ?? NONE,
    brand: project?.naming?.brand ?? project?.brand?._id ?? NONE,
    departments: project?.departments.map((department) => department._id) ?? [],
    manager: project?.manager?._id ?? NONE,
    members: [],
    team: teamFromProject(project?.team),
    status: project?.status._id ?? "",
    startDate: project ? toDateInput(project.startDate) : todayKey(),
    deadline: toDateInput(project?.deadline),
    progressMode: project?.progressMode ?? "task_completion",
    progress: project ? String(project.progress) : "0",
    hoursAllocated: numberText(project?.hoursAllocated),
    budget: numberText(project?.budget),
    isPublic: project?.isPublic ?? false,
    manualTimeLogs: project?.manualTimeLogs ?? true,
    requireTaskApproval: project?.requireTaskApproval ?? false,
  };
}

function parseOptionalNumber(text: string): number | null | "invalid" {
  if (text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : "invalid";
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function sameNaming(a: ProjectNaming | null | undefined, b: ProjectNaming) {
  return (
    Boolean(a) &&
    a!.brand === b.brand &&
    a!.type === b.type &&
    a!.month === b.month &&
    a!.title === b.title
  );
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
  const assignable = useAssignableUsers(open);

  const brands = useBrands(false, open);
  const types = useProjectTypes(open);
  // Legacy names: brand / type / month / name detected from the old name.
  const legacy = Boolean(project && !project.naming);
  const suggestion = useProjectNamingSuggestion(project?._id, open && legacy);
  const createBrand = useCreateBrand();
  const [newBrand, setNewBrand] = useState<string | null>(null);
  useRefetchOnFocus(categories.refetch, open && isAdmin);
  useRefetchOnFocus(brands.refetch, open && isAdmin);

  const [form, setForm] = useState<FormState>(() => initialState(project));
  const [submitted, setSubmitted] = useState(false);
  const pending = createProject.isPending || updateProject.isPending;

  useEffect(() => {
    if (open) {
      setForm(initialState(project));
      setSubmitted(false);
      setNewBrand(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project?._id]);

  // Legacy project: pre-fill the four name fields once the detection arrives.
  const suggested = suggestion.data;
  useEffect(() => {
    if (!open || !legacy || !suggested) return;
    setForm((current) => ({
      ...current,
      brand: suggested.brand ?? current.brand,
      type: suggested.type ?? current.type,
      month: suggested.month || current.month,
      title: suggested.title
        .replaceAll(NAMING_SEPARATOR, " ")
        .slice(0, NAMING_TITLE_MAX),
    }));
  }, [open, legacy, suggested]);

  // Default status for new projects.
  useEffect(() => {
    if (!open || isEdit || form.status) return;
    const fallback =
      statuses.data?.find((status) => status.isDefault) ?? statuses.data?.[0];
    if (fallback) setForm((current) => ({ ...current, status: fallback._id }));
  }, [open, isEdit, form.status, statuses.data]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  /** Brand / type change (the code preview follows them). */
  function changeNamePart(patch: Partial<Pick<FormState, "brand" | "type">>) {
    setForm((current) => ({ ...current, ...patch }));
  }

  function addBrand() {
    const name = tidyNamePart(newBrand ?? "");
    if (!name || name.includes(NAMING_SEPARATOR)) return;
    createBrand.mutate(
      { name },
      {
        onSuccess: (brand) => {
          setNewBrand(null);
          // Leadership's brands are approved at once; others wait for approval.
          if ((brand.status ?? "approved") === "approved") changeNamePart({ brand: brand._id });
        },
      },
    );
  }

  const memberOptions = useMemo<MultiSelectOption[]>(
    () =>
      (assignable.data ?? []).map((person) => ({
        value: person._id,
        label: person.name,
        description: [person.email, person.department?.name]
          .filter(Boolean)
          .join(" · "),
      })),
    [assignable.data],
  );

  const managerOptions = useMemo<OptionItem[]>(() => {
    const options = new Map<string, OptionItem>();
    options.set(NONE, { value: NONE, label: "No manager" });
    if (user)
      options.set(user._id, { value: user._id, label: `${user.name} (you)` });
    for (const member of project?.members ?? []) {
      options.set(member.user._id, {
        value: member.user._id,
        label: member.user.name,
        description: member.user.email,
      });
    }
    for (const person of assignable.data ?? []) {
      if (!options.has(person._id)) {
        options.set(person._id, {
          value: person._id,
          label: person.name,
          description: person.email,
        });
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
      ...(categories.data ?? []).map((category) => ({
        value: category._id,
        label: category.name,
      })),
    ],
    [categories.data],
  );

  // Active brands, plus the project's current one even if it was deactivated since.
  const brandOptions = useMemo<OptionItem[]>(() => {
    const currentId = project?.brand?._id;
    return [
      ...(brands.data ?? [])
        // Brands waiting for (or refused) leadership approval can't be picked yet.
        .filter((brand) => (brand.status ?? "approved") === "approved" || brand._id === currentId)
        .filter((brand) => brand.active || brand._id === currentId)
        .map((brand) => ({
          value: brand._id,
          label: brand.active ? brand.name : `${brand.name} (inactive)`,
          icon: (
            <span
              aria-hidden
              className={cn(
                "size-2 rounded-full",
                (LABEL_COLOR_META[brand.color] ?? LABEL_COLOR_META.muted).dot,
              )}
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
              className={cn(
                "size-2 rounded-full",
                statusColor(status.color).dot,
              )}
            />
          ),
        })),
    [statuses.data],
  );

  // Configured types, plus the project's current type if it was removed from Settings since.
  const typeOptions = useMemo<OptionItem[]>(() => {
    const names =
      types.data?.map((type) => type.name) ??
      (types.isError ? DEFAULT_PROJECT_TYPES : []);
    const current = project?.naming?.type;
    const all =
      current &&
      !names.some((name) => name.toLowerCase() === current.toLowerCase())
        ? [...names, current]
        : names;
    return all.map((name) => ({ value: name, label: name }));
  }, [types.data, types.isError, project?.naming?.type]);

  const modeOptions: OptionItem[] = PROGRESS_MODES.map((mode) => ({
    value: mode,
    label: PROGRESS_MODE_META[mode].label,
    description: PROGRESS_MODE_META[mode].description,
  }));

  // ---- validation ---------------------------------------------------------
  const selectedBrand = brands.data?.find((brand) => brand._id === form.brand);
  const title = tidyNamePart(form.title);
  const code = form.code.trim().toUpperCase();
  const brandError =
    form.brand === NONE
      ? "Pick a brand."
      : selectedBrand?.name.includes(NAMING_SEPARATOR)
        ? 'This brand\'s name contains "_" — rename it first.'
        : null;
  const typeError = form.type ? null : "Pick a type.";
  const monthError = MONTH_PATTERN.test(form.month) ? null : "Pick a month.";
  const nameError = !title
    ? "A name is required."
    : title.length > NAMING_TITLE_MAX
      ? `Max ${NAMING_TITLE_MAX} characters.`
      : title.includes(NAMING_SEPARATOR)
        ? "Underscores separate the parts — use a space or dash instead."
        : null;
  const preview = composeProjectName({
    brand: selectedBrand?.name ?? "",
    type: form.type,
    month: form.month,
    title,
  });
  const namingLoading = legacy && suggestion.isPending;
  // Codes are generated by the server (fixed, unique): nothing to validate here.
  const codeError = null;
  const codePreview = isEdit
    ? code
    : previewProjectCode(selectedBrand?.shortName || selectedBrand?.name || "", form.type, form.month);
  const hours = parseOptionalNumber(form.hoursAllocated);
  const budget = parseOptionalNumber(form.budget);
  const progressValue = Number(form.progress);
  const progressError =
    form.progressMode === "manual" &&
    (!Number.isFinite(progressValue) ||
      progressValue < 0 ||
      progressValue > 100)
      ? "Enter a percentage between 0 and 100."
      : null;
  const summaryError =
    form.summary.length > MAX_SUMMARY ? "Keep the summary shorter." : null;
  const hasErrors = Boolean(
    brandError ||
    typeError ||
    monthError ||
    nameError ||
    codeError ||
    progressError ||
    summaryError ||
    hours === "invalid" ||
    budget === "invalid",
  );
  const show = (error: string | null | boolean) => submitted && Boolean(error);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (
      hasErrors ||
      namingLoading ||
      hours === "invalid" ||
      budget === "invalid"
    )
      return;

    const category = form.category === NONE ? null : form.category;
    const manager = form.manager === NONE ? null : form.manager;
    // The server composes the name (Brand_Type_MonYYYY_Name) and keeps Project.brand in sync.
    const naming: ProjectNaming = {
      brand: form.brand,
      type: form.type,
      month: form.month,
      title,
    };

    if (!project) {
      const input: ProjectInput = {
        naming,
        summary: form.summary.trim() || undefined,
        category,
        manager,
        members: form.members,
        team: teamToInput(form.team),
        status: form.status || undefined,
        progressMode: form.progressMode,
        hoursAllocated: hours,
        budget,
        isPublic: form.isPublic,
        manualTimeLogs: form.manualTimeLogs,
        requireTaskApproval: form.requireTaskApproval,
      };
      if (isAdmin && form.departments.length > 0)
        input.departments = form.departments;
      if (form.progressMode === "manual")
        input.progress = Math.round(progressValue);
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
    // Legacy names are converted on save; structured ones only when a part changed.
    if (!sameNaming(project.naming, naming)) input.naming = naming;
    if (form.summary.trim() !== original.summary.trim())
      input.summary = form.summary.trim();
    if (form.category !== original.category) input.category = category;
    if (isAdmin && !sameIds(form.departments, original.departments)) {
      input.departments = form.departments;
    }
    if (form.manager !== original.manager) input.manager = manager;
    if (!sameTeam(form.team, original.team)) input.team = teamToInput(form.team);
    if (form.progressMode !== original.progressMode)
      input.progressMode = form.progressMode;
    if (form.progressMode === "manual" && form.progress !== original.progress) {
      input.progress = Math.round(progressValue);
    }
    if (form.hoursAllocated !== original.hoursAllocated)
      input.hoursAllocated = hours;
    if (canViewRates && form.budget !== original.budget) input.budget = budget;
    if (form.isPublic !== original.isPublic) input.isPublic = form.isPublic;
    if (form.manualTimeLogs !== original.manualTimeLogs)
      input.manualTimeLogs = form.manualTimeLogs;
    if (form.requireTaskApproval !== original.requireTaskApproval) {
      input.requireTaskApproval = form.requireTaskApproval;
    }

    if (Object.keys(input).length === 0) {
      onOpenChange(false);
      return;
    }
    updateProject.mutate(
      { id: project._id, input },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit project" : "New project"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the project details and team. Status, rates and other members are managed from the project page."
              : "Set up the project, its team and how progress is measured. Members are notified."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} noValidate className="space-y-5">
          {legacy && project && (
            <div className="flex gap-2.5 rounded-lg border border-dashed bg-muted/40 px-3 py-2.5 text-sm">
              <LuInfo
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              />
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium text-foreground">
                  This project has a legacy name
                </p>
                <p className="break-words text-muted-foreground">
                  “{project.name}”. Check the fields below — saving renames it
                  to the new format.
                  {suggested &&
                    !suggested.typeDetected &&
                    " No type was found in the old name."}
                  {suggested?.monthSource === "startDate" &&
                    " The month comes from the start date."}
                </p>
              </div>
            </div>
          )}

          <fieldset className="space-y-4" disabled={namingLoading}>
            <legend className="sr-only">Project name</legend>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="project-brand">Brand<span aria-hidden className="ml-0.5 text-destructive">*</span></Label>
                {newBrand === null ? (
                  <Combobox
                    items={brandOptions}
                    value={
                      brandOptions.find(
                        (option) => option.value === form.brand,
                      ) ?? null
                    }
                    onValueChange={(item) =>
                      changeNamePart({ brand: item?.value ?? NONE })
                    }
                    disabled={brands.isPending || namingLoading}
                    autoHighlight
                  >
                    <ComboboxInput
                      id="project-brand"
                      placeholder={
                        brands.isPending ? "Loading brands…" : "Search brands…"
                      }
                      className="w-full"
                      aria-invalid={show(brandError) || undefined}
                    />
                    <ComboboxContent sideOffset={4}>
                      <ComboboxEmpty>No brands found.</ComboboxEmpty>
                      <ComboboxList>
                        {(item: OptionItem) => (
                          <ComboboxItem key={item.value} value={item}>
                            {item.icon}
                            {item.label}
                          </ComboboxItem>
                        )}
                      </ComboboxList>
                    </ComboboxContent>
                  </Combobox>
                ) : (
                  <div className="flex gap-1.5">
                    <Input
                      id="project-brand"
                      value={newBrand}
                      onChange={(event) => setNewBrand(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addBrand();
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          setNewBrand(null);
                        }
                      }}
                      maxLength={80}
                      placeholder="New brand name"
                      aria-label="New brand name"
                      autoFocus
                    />
                    <Button
                      type="button"
                      size="icon"
                      onClick={addBrand}
                      disabled={
                        createBrand.isPending ||
                        !tidyNamePart(newBrand) ||
                        newBrand.includes(NAMING_SEPARATOR)
                      }
                      aria-label="Add brand"
                    >
                      {createBrand.isPending ? (
                        <LuLoaderCircle aria-hidden className="animate-spin" />
                      ) : (
                        <LuPlus aria-hidden />
                      )}
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      onClick={() => setNewBrand(null)}
                      aria-label="Cancel new brand"
                    >
                      <LuX aria-hidden />
                    </Button>
                  </div>
                )}
                {show(brandError) && <FieldError>{brandError}</FieldError>}
                {newBrand !== null && newBrand.includes(NAMING_SEPARATOR) && (
                  <FieldError>Brand names can’t contain “_”.</FieldError>
                )}
                {(brands.data ?? []).some((brand) => brand.status === "pending") && (
                  <p className="text-xs text-muted-foreground">
                    Waiting for leadership approval:{" "}
                    {(brands.data ?? [])
                      .filter((brand) => brand.status === "pending")
                      .map((brand) => brand.name)
                      .join(", ")}
                  </p>
                )}
                {newBrand === null && (
                  <button
                    type="button"
                    onClick={() => setNewBrand("")}
                    className="text-xs font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:underline"
                  >
                    + New brand
                  </button>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="project-type">Type<span aria-hidden className="ml-0.5 text-destructive">*</span></Label>
                <OptionSelect
                  id="project-type"
                  value={form.type}
                  onChange={(value) => changeNamePart({ type: value })}
                  options={typeOptions}
                  disabled={types.isPending || namingLoading}
                  invalid={show(typeError)}
                  placeholder="Select a type…"
                  aria-label="Type"
                />
                {show(typeError) && <FieldError>{typeError}</FieldError>}
                {isAdmin && (
                  <ManageLink to="/settings/projects">Manage types</ManageLink>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="project-month">Month<span aria-hidden className="ml-0.5 text-destructive">*</span></Label>
                <Input
                  id="project-month"
                  type="month"
                  value={form.month}
                  onChange={(event) => set("month", event.target.value)}
                  aria-invalid={show(monthError) || undefined}
                />
                {show(monthError) && <FieldError>{monthError}</FieldError>}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="project-name">Name<span aria-hidden className="ml-0.5 text-destructive">*</span></Label>
              <Input
                id="project-name"
                value={form.title}
                onChange={(event) => set("title", event.target.value)}
                maxLength={NAMING_TITLE_MAX + 20}
                placeholder="e.g. JGE Launch"
                aria-invalid={show(nameError) || undefined}
                aria-describedby="project-name-hint"
                autoFocus={!isEdit}
              />
              {show(nameError) ? (
                <FieldError id="project-name-hint">{nameError}</FieldError>
              ) : (
                <p
                  id="project-name-hint"
                  className="text-xs text-muted-foreground"
                >
                  Up to {NAMING_TITLE_MAX} characters, no underscores.{" "}
                  {title.length}/{NAMING_TITLE_MAX}
                </p>
              )}
            </div>

            <div
              className="rounded-lg border bg-muted/40 px-3 py-2 text-sm"
              aria-live="polite"
            >
              <span className="text-muted-foreground">Project name: </span>
              <code className="font-mono font-medium break-all text-foreground">
                {namingLoading ? "Detecting from the old name…" : preview}
              </code>
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="project-code">Code</Label>
              <Input
                id="project-code"
                value={codePreview}
                readOnly
                placeholder="Assigned when you save"
                className="bg-muted/40 font-mono uppercase"
                aria-describedby="project-code-hint"
              />
              <p id="project-code-hint" className="text-xs text-muted-foreground">
                {isEdit
                  ? "Fixed — project codes can't be changed."
                  : "Assigned automatically (brand, type, month) and unique — a number is added if it's taken. It can't be changed later."}
              </p>
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
              {isAdmin && (
                <ManageLink to="/settings/projects">
                  Manage categories
                </ManageLink>
              )}
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


          </div>

          <ProjectTeamFields
            value={form.team}
            onChange={(team) => set("team", team)}
            options={memberOptions}
            loading={assignable.isPending}
            naming={{
              brand: form.brand === NONE ? "" : form.brand,
              month: form.month,
              type: form.type,
              title,
            }}
            enabled={open}
          />

          <Separator />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="project-progress-mode">
                Progress calculation
              </Label>
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
                {show(progressError) && (
                  <FieldError>{progressError}</FieldError>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2">
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
    [departments.data],
  );
  return (
    <div className="space-y-1.5 sm:col-span-2">
      <Label htmlFor="project-departments">Departments</Label>
      <MultiSelect
        id="project-departments"
        options={options}
        value={value}
        onValueChange={onChange}
        placeholder={
          departments.isPending ? "Loading departments…" : "Select departments…"
        }
        emptyText={
          departments.isError
            ? "Couldn't load departments."
            : "No departments found."
        }
      />
      <ManageLink to="/admin/departments">Manage departments</ManageLink>
    </div>
  );
}
