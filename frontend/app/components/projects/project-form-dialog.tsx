import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { LuArrowLeft, LuArrowRight, LuInfo, LuLoaderCircle, LuPlus, LuSave, LuSend, LuX } from "react-icons/lu";
import { ScopeItemsEditor } from "@/components/projects/scope-items-editor";
import { BrandFlowDialog } from "@/components/brands/brand-flow-dialog";
import { scopeTotal } from "@/lib/scope";
import { AttachmentsField } from "@/components/tasks/attachments-field";
import { api, getErrorMessage } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { namingMonthLabel } from "@/lib/projects";
import { useTeamLoad } from "@/hooks/use-team-load";
import type { ScopeItem } from "@/types";

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
  AUTO_ROW,
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
import { BrandNoScopePanel } from "@/components/brands/brand-no-scope-panel";
import { OtherScopeText } from "@/components/brands/scope-compare";
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
import { readinessReasonText, useBrandReadiness, useBrands, useCreateBrand } from "@/hooks/use-brands";
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
  stripComposedPrefix,
  tidyNamePart,
} from "@/lib/projects";
import { currencySymbol } from "@/lib/format";
import { shiftMonth } from "@/lib/manpower";
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
  /** Manpower plan row key, or AUTO_ROW. */
  manpowerRow: string;
  /** Structured scope rows. */
  scopeItems: ScopeItem[];
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

/**
 * Month for continuing `source` into: the month after it closed, or this month
 * when that has already passed (a new project mustn't start closed).
 */
export function continueMonth(source: Project): string {
  const current = todayKey().slice(0, 7);
  const closed = source.closesOn?.slice(0, 7) ?? source.naming?.month ?? current;
  const next = shiftMonth(closed, 1);
  return next > current ? next : current;
}

/** Last day ("YYYY-MM-DD") of a "YYYY-MM" month. */
function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
}

/**
 * "Continue in next month": a new project with the source's brand, type, name and
 * settings, in the next month. The scope comes from the brand and the team from the
 * new month's manpower plan — never from the previous project (status, progress and
 * dates start fresh too).
 */
function continueState(source: Project): FormState {
  const base = initialState(source);
  const month = continueMonth(source);
  const today = todayKey();
  const firstDay = `${month}-01`;
  return {
    ...base,
    month,
    code: "",
    title: source.naming?.title ?? source.name,
    summary: "",
    scopeItems: [],
    team: teamFromProject(undefined),
    manager: NONE,
    members: [],
    status: "",
    manpowerRow: AUTO_ROW,
    startDate: firstDay > today ? firstDay : today,
    deadline: monthEnd(month),
    progress: "0",
  };
}

/** Which brand scope rows a project already has (each project row matches one brand row). */
function matchBrandRows(brandRows: ScopeItem[], projectRows: ScopeItem[]): boolean[] {
  const key = (r: ScopeItem) => [r.unit.toLowerCase(), r.quantity, r.languages, [...(r.languageList ?? [])].sort().join(","), r.sizes].join("|");
  const left = projectRows.map(key);
  return brandRows.map((row) => {
    const i = left.indexOf(key(row));
    if (i < 0) return false;
    left.splice(i, 1);
    return true;
  });
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
    manpowerRow: project?.manpowerRow || AUTO_ROW,
    scopeItems: (project?.scopeItems ?? []).map((row) => ({ ...row })),
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

/** Brand picker option: a brand that isn't ready for new projects is disabled, with the reason. */
type BrandOption = OptionItem & { disabled?: boolean; reason?: string };

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
  continueFrom = null,
  defaultType,
  pitch = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present → edit mode. */
  project?: Project | null;
  /** Hide the budget field in edit mode when the caller can't see rates. */
  canViewRates?: boolean;
  /** Create mode, pre-filled from this (closed) project for the next month. */
  continueFrom?: Project | null;
  /** Create mode: the project type picked up front (Pitch & Growth → New pitch: "Pitch"). */
  defaultType?: string;
  /**
   * Create mode: a pitch (Pitch & Growth → New pitch). The type selector is hidden and the
   * type is fixed to Pitch; the brand needs no scope / plan line / lead yet. The normal form
   * can't pick Pitch — "the pitch flag drives the pitch fields".
   */
  pitch?: boolean;
}) {
  const isEdit = Boolean(project);
  const continuing = !project && Boolean(continueFrom);
  const navigate = useNavigate();
  const { data: user } = useCurrentUser();
  const isAdmin = user?.role === "admin";
  // New brands: brand creators only (Nazeer); leadership approves them.
  const brandCreator = Boolean(user?.access?.brandCreator);
  const isHeadOrAdmin = isAdmin || user?.role === "head";

  const createProject = useCreateProject();
  const updateProject = useUpdateProject();
  const statuses = useProjectStatuses();
  const categories = useProjectCategories();
  // Employees (project managers editing) get 403 here — only fetch for head/admin.
  const assignable = useAssignableUsers(open);

  const brands = useBrands(false, open);
  const types = useProjectTypes(open);
  // A pitch form: New pitch, or continuing / pre-set as a Pitch. Otherwise Pitch isn't offered.
  const pitchMode =
    !project &&
    (pitch || defaultType?.toLowerCase() === "pitch" || (Boolean(continueFrom) && continueFrom?.naming?.type.toLowerCase() === "pitch"));
  // New non-pitch projects: only brands that are ready (scope, current plan line, lead).
  const readiness = useBrandReadiness(open && !project && !pitchMode);
  const [brandSearch, setBrandSearch] = useState("");
  const [explainBrand, setExplainBrand] = useState<string | null>(null);
  const [showNotReady, setShowNotReady] = useState(false);
  // Legacy names: brand / type / month / name detected from the old name.
  const legacy = Boolean(project && !project.naming);
  const suggestion = useProjectNamingSuggestion(project?._id, open && legacy);
  const createBrand = useCreateBrand();
  const [newBrand, setNewBrand] = useState<string | null>(null);
  useRefetchOnFocus(categories.refetch, open && isAdmin);
  useRefetchOnFocus(brands.refetch, open && isAdmin);

  const freshState = (): FormState => {
    const state = !project && continueFrom ? continueState(continueFrom) : initialState(project);
    if (!project && !continueFrom && pitch) return { ...state, type: defaultType ?? "Pitch" };
    return !project && !continueFrom && defaultType ? { ...state, type: defaultType } : state;
  };
  const [form, setForm] = useState<FormState>(freshState);
  const [submitted, setSubmitted] = useState(false);
  // New projects: four steps (brand, project, scope, team). Editing shows everything.
  const [step, setStep] = useState(1);
  const wizard = !project;
  const showStep = (n: number) => !wizard || step === n;
  // New projects: files picked here are uploaded once the project exists.
  const [files, setFiles] = useState<File[]>([]);
  const toast = useToast();
  // AI score of the summary for the brand and type (on request).
  const [summaryScore, setSummaryScore] = useState<{ score: number | null; reason: string } | { error: string } | null>(null);
  const [scoring, setScoring] = useState(false);
  const pending = createProject.isPending || updateProject.isPending;
  // Brand with a scope: which of its rows this project covers (null = all of them).
  const [pickedRows, setPickedRows] = useState<boolean[] | null>(null);
  // New projects: the dates follow the month until the user changes them.
  const [datesTouched, setDatesTouched] = useState(false);
  // Pitch projects: Milestone 1 meeting / Milestone 2 meeting / Client presentation (required; become the lead's
  // tasks), the potential revenue (or TBC) and the lead (the project manager). No fee.
  const [pitchDates, setPitchDates] = useState({ clientPresentation: "", milestone1: "", milestone2: "" });
  const [pitchRevenue, setPitchRevenue] = useState({ amount: "", tbc: false });

  useEffect(() => {
    if (open) {
      setForm(freshState());
      setPickedRows(null);
      setPitchDates({ clientPresentation: "", milestone1: "", milestone2: "" });
      setPitchRevenue({ amount: "", tbc: false });
      setDatesTouched(Boolean(project || continueFrom));
      setSubmitted(false);
      setStep(1);
      setFiles([]);
      setSummaryScore(null);
      setNewBrand(null);
      setBrandSearch("");
      setExplainBrand(null);
      setShowNotReady(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project?._id, continueFrom?._id]);

  // New project: the period follows the month (1st – last day) until the dates are changed.
  useEffect(() => {
    if (!open || datesTouched || !MONTH_PATTERN.test(form.month)) return;
    const start = `${form.month}-01`;
    const end = monthEnd(form.month);
    if (form.startDate !== start || form.deadline !== end) {
      setForm((current) => ({ ...current, startDate: start, deadline: end }));
    }
  }, [open, datesTouched, form.month, form.startDate, form.deadline]);

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
    // Another brand: its scope rows are picked afresh (all of them by default).
    if (patch.brand !== undefined && patch.brand !== form.brand) setPickedRows(null);
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

  const teamLoad = useTeamLoad(form.month, open);
  const memberOptions = useMemo<MultiSelectOption[]>(
    () =>
      (assignable.data ?? []).map((person) => {
        // This month's load (projects with them on the team) — more than the plan's limit is flagged.
        const load = teamLoad.data?.load[person._id] ?? 0;
        const max = teamLoad.data?.max ?? 0;
        const loadText = teamLoad.data
          ? `${load}/${max} projects in ${namingMonthLabel(form.month)}${max && load >= max ? " — full" : ""}`
          : null;
        return {
          value: person._id,
          label: person.name,
          description: [loadText, person.department?.name].filter(Boolean).join(" · "),
        };
      }),
    [assignable.data, teamLoad.data, form.month],
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
  // New non-pitch projects: ready brands first; the others at the bottom, greyed and disabled with the reason.
  const readinessMonth = readiness.data?.month ?? null;
  const notReadyOf = (brandId: string) => {
    if (project || pitchMode || !readiness.data) return null;
    const r = readiness.data.brands[brandId];
    return r && !r.ready ? r.reasons : null;
  };
  const brandOptions = useMemo<BrandOption[]>(() => {
    const currentId = project?.brand?._id;
    const list: BrandOption[] = (brands.data ?? [])
      // Brands waiting for (or refused) leadership approval can't be picked yet.
      .filter((brand) => (brand.status ?? "approved") === "approved" || brand._id === currentId)
      .filter((brand) => brand.active || brand._id === currentId)
      .map((brand) => {
        const reasons = notReadyOf(brand._id);
        return {
          value: brand._id,
          label: brand.active ? brand.name : `${brand.name} (inactive)`,
          ...(reasons ? { disabled: true, reason: reasons.map((r) => readinessReasonText(r, readinessMonth!)).join(", ") } : {}),
          icon: (
            <span
              aria-hidden
              className={cn(
                "size-2 rounded-full",
                (LABEL_COLOR_META[brand.color] ?? LABEL_COLOR_META.muted).dot,
              )}
            />
          ),
        };
      });
    // Ready brands keep their order; the not-ready ones go to the bottom.
    return [...list.filter((o) => !o.disabled), ...list.filter((o) => o.disabled)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brands.data, project?.brand?._id, readiness.data, pitchMode]);
  const notReadyBrands = brandOptions.filter((o) => o.disabled);
  // Searching a brand that can't be picked explains why (when no ready brand matches).
  const searchTerm = brandSearch.trim().toLowerCase();
  const searchedNotReady = (() => {
    if (!searchTerm || form.brand !== NONE) return null;
    const matches = brandOptions.filter((o) => o.label.toLowerCase().includes(searchTerm));
    return matches.length > 0 && matches.every((o) => o.disabled) ? matches[0]!.value : null;
  })();
  const explainedId = explainBrand ?? searchedNotReady;
  const explained = explainedId ? brands.data?.find((b) => b._id === explainedId) : undefined;

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
    // New projects: Pitch is created from Pitch & Growth → New pitch, not picked here.
    const offered = project ? all : all.filter((name) => name.toLowerCase() !== "pitch");
    return offered.map((name) => ({ value: name, label: name }));
  }, [types.data, types.isError, project?.naming?.type, project]);

  const modeOptions: OptionItem[] = PROGRESS_MODES.map((mode) => ({
    value: mode,
    label: PROGRESS_MODE_META[mode].label,
    description: PROGRESS_MODE_META[mode].description,
  }));

  // ---- validation ---------------------------------------------------------
  const selectedBrand = brands.data?.find((brand) => brand._id === form.brand);
  // A brand with a scope (brand flow) fixes the scope of its projects: shown read-only.
  const brandScope = selectedBrand?.scopeItems?.length ? selectedBrand.scopeItems : null;
  // Rows picked for this project (default: all; editing: the ones the project has).
  // Editing and moving to another brand: the new brand's scope replaces the project's (all rows by default).
  const brandChanged = Boolean(project) && form.brand !== NONE && form.brand !== (project?.naming?.brand ?? project?.brand?._id ?? NONE);
  const picked: boolean[] = brandScope
    ? (pickedRows ?? (project && !brandChanged ? matchBrandRows(brandScope, project.scopeItems ?? []) : brandScope.map(() => true)))
    : [];
  const brandScopeRows: ScopeItem[] | null = brandScope
    ? brandScope
        .filter((_, index) => picked[index])
        .map(({ unit, quantity, languages, languageList, sizes }) => ({ unit, quantity, languages, sizes, ...(languageList?.length ? { languageList } : {}) }))
    : null;
  const [brandFlowOpen, setBrandFlowOpen] = useState(false);
  // A new project takes its scope from the brand: a brand without one can't get new
  // projects (pitches are the exception — pitch brands usually have no scope yet).
  // Readiness (scope, current plan line, lead) — the server refuses the others with 409 too.
  const selectedReasons = selectedBrand && !pitchMode && form.type.toLowerCase() !== "pitch" ? notReadyOf(selectedBrand._id) : null;
  const brandHasNoScope =
    !project && Boolean(selectedBrand) && form.type.toLowerCase() !== "pitch" && !pitchMode && (Boolean(selectedReasons) || !brandScope);
  const pitchTypeName =
    (types.data?.map((type) => type.name) ?? DEFAULT_PROJECT_TYPES).find((name) => name.toLowerCase() === "pitch") ?? "Pitch";
  // "_" is allowed in the name; a pasted whole name loses its Brand_Type_Month_ start.
  const title = stripComposedPrefix(form.title, selectedBrand?.name ?? "", form.type, form.month);
  const code = form.code.trim().toUpperCase();
  const brandError =
    form.brand === NONE
      ? "Pick a brand."
      : selectedBrand?.name.includes(NAMING_SEPARATOR)
        ? 'This brand\'s name contains "_" — rename it first.'
        : null;
  const typeError = form.type ? null : "Pick a type.";
  const monthError = MONTH_PATTERN.test(form.month) ? null : "Pick a month.";
  const isPitchType = !project && form.type.toLowerCase() === "pitch";
  const pitchError =
    isPitchType && (!pitchDates.clientPresentation || !pitchDates.milestone1 || !pitchDates.milestone2)
      ? "A pitch needs the Milestone 1 meeting, Milestone 2 meeting and Client presentation dates."
      : isPitchType && !pitchRevenue.tbc && !(Number(pitchRevenue.amount) > 0)
        ? "Enter the potential revenue, or tick TBC."
        : isPitchType && form.manager === NONE
          ? "Pick the pitch's lead."
          : null;
  const nameError = !title
    ? "A name is required."
    : title.length > NAMING_TITLE_MAX
      ? `Max ${NAMING_TITLE_MAX} characters.`
      : null;
  const scopeError = brandScope
    ? brandScopeRows!.length === 0
      ? "Pick at least one of the brand's scope rows."
      : null
    : !project && form.scopeItems.length === 0
      ? "Add at least one scope row."
      : null;
  const datesError = !form.startDate
    ? "Pick the start date."
    : form.deadline && form.deadline < form.startDate
      ? "The end date must be on or after the start date."
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
    brandHasNoScope ||
    brandError ||
    typeError ||
    monthError ||
    nameError ||
    codeError ||
    progressError ||
    summaryError ||
    scopeError ||
    datesError ||
    pitchError ||
    hours === "invalid" ||
    budget === "invalid",
  );
  const show = (error: string | null | boolean) => submitted && Boolean(error);
  // Per wizard step: what must be right before moving on.
  const stepErrors: Record<number, unknown[]> = {
    1: [brandError, brandHasNoScope],
    2: [typeError, monthError, nameError, pitchError, summaryError, progressError, hours === "invalid", budget === "invalid"],
    3: [scopeError, datesError],
    4: [],
  };
  function nextStep() {
    if (stepErrors[step]!.some(Boolean)) {
      setSubmitted(true);
      return;
    }
    setSubmitted(false);
    setStep((s) => Math.min(4, s + 1));
  }

  async function checkSummary() {
    setScoring(true);
    try {
      const { data } = await api.post<{ score: number | null; reason: string }>("/projects/summary-check", {
        brand: form.brand === NONE ? null : form.brand,
        type: form.type,
        name: preview,
        summary: form.summary,
        files: files.length,
      });
      setSummaryScore(data);
    } catch (error) {
      setSummaryScore({ error: getErrorMessage(error) });
    } finally {
      setScoring(false);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (wizard && step < 4) {
      nextStep();
      return;
    }
    // Last step: only the "Create project" button creates it (not Enter in a people box).
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    if (wizard && !(submitter instanceof HTMLButtonElement && submitter.type === "submit")) return;
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
        manpowerRow: form.manpowerRow === AUTO_ROW ? null : form.manpowerRow,
        scopeItems: brandScopeRows ?? form.scopeItems,
        startDate: form.startDate,
        deadline: form.deadline || null,
        status: form.status || undefined,
        progressMode: form.progressMode,
        hoursAllocated: hours,
        budget,
        isPublic: form.isPublic,
        manualTimeLogs: form.manualTimeLogs,
        requireTaskApproval: form.requireTaskApproval,
        ...(isPitchType
          ? {
              pitchDates,
              pitchLeads: manager ? [manager] : [],
              pitchRevenue: pitchRevenue.tbc ? null : Number(pitchRevenue.amount),
              pitchRevenueTbc: pitchRevenue.tbc,
            }
          : {}),
      };
      if (isAdmin && form.departments.length > 0)
        input.departments = form.departments;
      if (form.progressMode === "manual")
        input.progress = Math.round(progressValue);
      createProject.mutate(input, {
        onSuccess: async (data) => {
          // Files picked in the form, one by one (a failed one doesn't block the rest).
          const failed: string[] = [];
          for (const file of files) {
            const body = new FormData();
            body.append("files", file);
            try {
              await api.post(`/projects/${data.project._id}/files`, body, {
                headers: { "Content-Type": "multipart/form-data" },
                timeout: 120_000,
              });
            } catch {
              failed.push(file.name);
            }
          }
          if (failed.length) toast.error(`Couldn't upload: ${failed.join(", ")}. Add them on the project's Files tab.`);
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
    if (form.manpowerRow !== original.manpowerRow)
      input.manpowerRow = form.manpowerRow === AUTO_ROW ? null : form.manpowerRow;
    // A brand move brings the new brand's scope (server side): no scope rows with it.
    if (!brandChanged && brandScope) {
      if (pickedRows && JSON.stringify(brandScopeRows) !== JSON.stringify(original.scopeItems)) input.scopeItems = brandScopeRows!;
    } else if (!brandChanged && JSON.stringify(form.scopeItems) !== JSON.stringify(original.scopeItems)) input.scopeItems = form.scopeItems;
    if (form.startDate !== original.startDate) input.startDate = form.startDate;
    if (form.deadline !== original.deadline) input.deadline = form.deadline || null;
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
          <DialogTitle>{isEdit ? "Edit project" : continuing ? "Continue in next month" : pitchMode ? "New pitch" : "New project"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the project details and team. Status, rates and other members are managed from the project page."
              : continuing
                ? `A new project for ${continueFrom!.name}'s work in the next month, with the same name. Its scope comes from the brand and its team from the new month's manpower plan. Tasks stay in the old project.`
                : pitchMode
                  ? "A pitch / proactive project: the client's brand, the potential revenue, the lead and the three dates (they become the lead's tasks). The brand needs no scope yet."
                  : "Set up the project, its team and how progress is measured. Members are notified."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} noValidate className="space-y-5">
          {wizard && (
            <ol className="grid grid-cols-4 gap-1.5 text-xs" aria-label="Steps">
              {["Brand", "Project", "Scope", "Team"].map((label, index) => {
                const n = index + 1;
                return (
                  <li key={label}>
                    <button
                      type="button"
                      onClick={() => (n < step ? setStep(n) : n === step + 1 ? nextStep() : undefined)}
                      aria-current={n === step ? "step" : undefined}
                      className={cn(
                        "w-full rounded-md border px-2 py-1.5 text-left",
                        n === step
                          ? "border-primary bg-primary/10 font-medium text-primary"
                          : n < step
                            ? "text-foreground hover:bg-muted"
                            : "text-muted-foreground",
                      )}
                    >
                      {n} · {label}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
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
            <div className={cn("grid gap-4", (!wizard || step === 2) && "sm:grid-cols-3")}>
              {showStep(1) && (
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
                    onValueChange={(item) => {
                      if (item?.disabled) return;
                      setExplainBrand(null);
                      changeNamePart({ brand: item?.value ?? NONE });
                    }}
                    onInputValueChange={(text: string) => setBrandSearch(text)}
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
                        {(item: BrandOption) => (
                          <ComboboxItem key={item.value} value={item} disabled={item.disabled} className={cn(item.disabled && "opacity-60")}>
                            {item.icon}
                            <span className="min-w-0 flex-1 truncate">{item.label}</span>
                            {item.reason && <span className="shrink-0 text-xs text-muted-foreground">{item.reason}</span>}
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
                {brandChanged && selectedBrand && (
                  <p className="text-xs text-muted-foreground">
                    Moving to {selectedBrand.name}: the name becomes {selectedBrand.name}_…, the code stays, the manpower plan
                    line follows{brandScope ? ` and ${selectedBrand.name}'s scope replaces the project's` : " and the project keeps its scope"}.
                    {" "}Leadership's moves apply at once; anyone else's go for approval.
                  </p>
                )}
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
                {(() => {
                  // The selected brand isn't ready, or one the user asked about / searched for.
                  const panelBrand = brandHasNoScope && selectedBrand ? selectedBrand : explained;
                  if (!panelBrand) return null;
                  const reasons = notReadyOf(panelBrand._id) ?? (panelBrand === selectedBrand && !brandScope ? (["no_scope"] as const) : null);
                  if (!reasons) return null;
                  return (
                    <BrandNoScopePanel brand={panelBrand} reasons={[...reasons]} month={readinessMonth ?? undefined} onLeave={() => onOpenChange(false)}>
                      <Link
                        to="/pitches"
                        onClick={() => onOpenChange(false)}
                        className="text-xs font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:underline"
                      >
                        It&apos;s a pitch? Use Pitch &amp; Growth → New pitch (no scope or plan line needed)
                      </Link>
                    </BrandNoScopePanel>
                  );
                })()}
                {notReadyBrands.length > 0 && form.brand === NONE && newBrand === null && (
                  <div className="text-xs">
                    <button
                      type="button"
                      aria-expanded={showNotReady}
                      onClick={() => setShowNotReady((v) => !v)}
                      className="font-medium text-muted-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
                    >
                      Why can&apos;t I pick some brands? ({notReadyBrands.length} not ready)
                    </button>
                    {showNotReady && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {notReadyBrands.map((o) => (
                          <button
                            key={o.value}
                            type="button"
                            aria-pressed={explainBrand === o.value}
                            onClick={() => setExplainBrand(explainBrand === o.value ? null : o.value)}
                            className={cn(
                              "rounded-full border px-2 py-0.5 text-left hover:bg-muted",
                              explainBrand === o.value && "border-destructive/50 bg-destructive/5",
                            )}
                          >
                            {o.label} <span className="text-muted-foreground">· {o.reason}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {brandCreator && newBrand === null && (
                  <button
                    type="button"
                    onClick={() => setBrandFlowOpen(true)}
                    className="text-xs font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:underline"
                  >
                    + New brand (reads its scope from the brief)
                  </button>
                )}
              </div>
              )}
              {showStep(2) && (
              <>
              {pitchMode ? (
              <div className="space-y-1.5">
                <span className="text-sm font-medium">Type</span>
                <p className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm">{form.type || pitchTypeName}</p>
              </div>
              ) : (
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
                {!isEdit && (
                  <p className="text-xs text-muted-foreground">
                    Creating a pitch? Use{" "}
                    <Link to="/pitches" onClick={() => onOpenChange(false)} className="font-medium text-primary underline-offset-4 hover:underline">
                      Pitch &amp; Growth → New pitch
                    </Link>
                  </p>
                )}
                {isAdmin && (
                  <ManageLink to="/settings/projects">Manage types</ManageLink>
                )}
              </div>
              )}
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
              </>
              )}
            </div>


            {showStep(2) && (
            <>

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
                  Up to {NAMING_TITLE_MAX} characters.{" "}
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

            {isPitchType && (
              <fieldset className="space-y-2 rounded-lg border p-3">
                <legend className="px-1 text-sm font-medium">
                  Pitch<span aria-hidden className="ml-0.5 text-destructive">*</span>
                </legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="pitch-revenue" className="text-xs">Potential revenue (AED)</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        id="pitch-revenue"
                        type="number"
                        min={0}
                        step={1000}
                        placeholder="200000"
                        value={pitchRevenue.amount}
                        disabled={pitchRevenue.tbc}
                        onChange={(event) => setPitchRevenue((r) => ({ ...r, amount: event.target.value }))}
                      />
                      <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={pitchRevenue.tbc}
                          onChange={(event) => setPitchRevenue((r) => ({ ...r, tbc: event.target.checked }))}
                        />
                        TBC
                      </label>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="pitch-lead" className="text-xs">Lead</Label>
                    <OptionSelect
                      id="pitch-lead"
                      value={form.manager}
                      onChange={(value) => set("manager", value)}
                      options={managerOptions}
                      aria-label="Pitch lead"
                      invalid={show(pitchError) && form.manager === NONE}
                    />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  {(
                    [
                      ["milestone1", "Milestone 1 meeting"],
                      ["milestone2", "Milestone 2 meeting"],
                      ["clientPresentation", "Client presentation"],
                    ] as const
                  ).map(([key, label]) => (
                    <div key={key} className="space-y-1">
                      <Label htmlFor={`pitch-${key}`} className="text-xs">{label}</Label>
                      <Input
                        id={`pitch-${key}`}
                        type="date"
                        required
                        value={pitchDates[key]}
                        onChange={(event) => setPitchDates((d) => ({ ...d, [key]: event.target.value }))}
                        aria-invalid={(show(pitchError) && !pitchDates[key]) || undefined}
                      />
                    </div>
                  ))}
                </div>
                {show(pitchError) ? (
                  <FieldError>{pitchError}</FieldError>
                ) : (
                  <p className="text-xs text-muted-foreground">Each date becomes a high-priority task for the lead (the two milestone meetings are internal). The end date is on the next step.</p>
                )}
              </fieldset>
            )}
            </>
            )}
          </fieldset>

          {showStep(2) && (
          <>

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
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="project-summary">Summary</Label>
            </div>
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

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={checkSummary} disabled={scoring || !form.summary.trim()}>
              {scoring ? <LuLoaderCircle aria-hidden className="animate-spin" /> : null}
              Check summary (AI score)
            </Button>
            {summaryScore && "error" in summaryScore && (
              <span className="text-xs text-destructive">{summaryScore.error}</span>
            )}
            {summaryScore && !("error" in summaryScore) && (
              <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 font-medium",
                    (summaryScore.score ?? 0) >= 70
                      ? "bg-primary/10 text-primary"
                      : (summaryScore.score ?? 0) >= 40
                        ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                        : "bg-destructive/10 text-destructive",
                  )}
                >
                  Summary score {summaryScore.score ?? "—"}/100
                </span>
                {summaryScore.reason}
              </span>
            )}
          </div>
          <p className="-mt-3 text-xs text-muted-foreground">
            Scored for {selectedBrand?.name ?? "the brand"} and the {form.type || "project"} type: clear English, fits the
            brand and type, says what's delivered, and has a link or file.
          </p>

          {!project && (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">Brief, deck or references — uploaded when the project is created.</p>
              <AttachmentsField id="project-attachments" files={files} onChange={setFiles} disabled={pending} />
            </div>
          )}

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

          </>
          )}

          {showStep(3) && (
            <fieldset className="grid gap-4 sm:grid-cols-2">
              <legend className="mb-2 text-sm font-medium text-foreground">Project period</legend>
              <div className="space-y-1.5">
                <Label htmlFor="project-start">Start date<span aria-hidden className="ml-0.5 text-destructive">*</span></Label>
                <Input
                  id="project-start"
                  type="date"
                  value={form.startDate}
                  onChange={(event) => {
                    setDatesTouched(true);
                    set("startDate", event.target.value);
                  }}
                  aria-invalid={(show(datesError) && !form.startDate) || undefined}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="project-end">End date</Label>
                <Input
                  id="project-end"
                  type="date"
                  value={form.deadline}
                  min={form.startDate || undefined}
                  onChange={(event) => {
                    setDatesTouched(true);
                    set("deadline", event.target.value);
                  }}
                  aria-invalid={(show(datesError) && Boolean(form.deadline)) || undefined}
                />
              </div>
              <p className="text-xs text-muted-foreground sm:col-span-2">
                {datesTouched ? "The project runs between these dates." : "The month's first and last day — change them if the work runs longer or shorter."}
              </p>
              {show(datesError) && <div className="sm:col-span-2"><FieldError>{datesError}</FieldError></div>}
            </fieldset>
          )}

          {showStep(3) && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-foreground">Scope</legend>
              <p className="text-xs text-muted-foreground">
                Deliverables as rows: unit, quantity and the language / size multipliers (3 videos × 2 languages × 2
                sizes = 12). Tasks beyond a unit&apos;s total are flagged for an admin.
              </p>
              {brandScope ? (
                <div className="space-y-2">
                  <p className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-foreground">
                    🔒 <span className="font-medium">Scope comes from the brand {selectedBrand?.name}</span> — read from its
                    files when the brand was created, so rows can&apos;t be edited here. Tick the rows this project covers;
                    to change the rows themselves, edit the brand&apos;s scope (non-leadership changes go for approval).
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[30rem] text-sm">
                      <thead className="text-xs text-muted-foreground">
                        <tr className="border-b text-left">
                          <th className="w-8 py-1.5 pr-2 font-medium">
                            <input
                              type="checkbox"
                              aria-label="All of the brand's scope rows"
                              className="size-4 accent-primary"
                              checked={picked.every(Boolean)}
                              onChange={(event) => setPickedRows(brandScope.map(() => event.target.checked))}
                            />
                          </th>
                          <th className="py-1.5 pr-3 font-medium">Unit</th>
                          <th className="py-1.5 pr-3 font-medium">What</th>
                          <th className="py-1.5 pr-3 text-right font-medium">Qty</th>
                          <th className="py-1.5 pr-3 font-medium">Languages</th>
                          <th className="py-1.5 pr-3 text-right font-medium">Sizes</th>
                          <th className="py-1.5 text-right font-medium">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {brandScope.map((row, index) => (
                          <tr key={index} className={cn("border-b last:border-0", !picked[index] && "text-muted-foreground opacity-60")}>
                            <td className="py-1.5 pr-2">
                              <input
                                type="checkbox"
                                aria-label={`Include ${row.what || row.unit}`}
                                className="size-4 accent-primary"
                                checked={picked[index] ?? false}
                                onChange={(event) => setPickedRows(picked.map((on, i) => (i === index ? event.target.checked : on)))}
                              />
                            </td>
                            <td className="py-1.5 pr-3">{row.unit}</td>
                            <td className="py-1.5 pr-3 text-muted-foreground">{row.what || "—"}</td>
                            <td className="py-1.5 pr-3 text-right tabular-nums">{row.quantity}</td>
                            <td className="py-1.5 pr-3 text-xs">{row.languageList?.join(", ") || row.languages}</td>
                            <td className="py-1.5 pr-3 text-right tabular-nums">{row.sizes}</td>
                            <td className="py-1.5 text-right font-semibold tabular-nums">{scopeTotal(row)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-right text-xs text-muted-foreground">
                    {brandScopeRows!.length} of {brandScope.length} rows ·{" "}
                    {brandScopeRows!.reduce((n, row) => n + row.quantity, 0)} pieces for this project
                  </p>
                  {show(scopeError) && <FieldError>{scopeError}</FieldError>}
                  {(selectedBrand?.platforms?.length || selectedBrand?.scopeFiles?.length) && (
                    <p className="text-xs text-muted-foreground">
                      {selectedBrand?.platforms?.length ? `Platforms: ${selectedBrand.platforms.join(", ")}. ` : ""}
                      {selectedBrand?.scopeFiles?.length ? `The brand's files are attached to the project: ${selectedBrand.scopeFiles.map((f) => f.filename).join(", ")}.` : ""}
                    </p>
                  )}
                  {selectedBrand?.scopeNotes?.length ? (
                    <ul className="list-disc space-y-0.5 pl-5 text-xs text-amber-700 dark:text-amber-400">
                      {selectedBrand.scopeNotes.map((n) => <li key={n}>{n}</li>)}
                    </ul>
                  ) : null}
                  {selectedBrand?.scopeText?.trim() ? <OtherScopeText text={selectedBrand.scopeText} /> : null}
                </div>
              ) : (
                <>
                  <ScopeItemsEditor
                    value={form.scopeItems}
                    onChange={(rows) => set("scopeItems", rows)}
                    invalid={show(scopeError)}
                  />
                  {show(scopeError) && <FieldError>{scopeError}</FieldError>}
                </>
              )}
            </fieldset>
          )}

          {showStep(4) && (
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
            autoFill={continuing}
            planRow={form.manpowerRow}
            onPlanRowChange={(key) => set("manpowerRow", key)}
          />
          )}

          {showStep(2) && (
          <>
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
          </>
          )}

          <DialogFooter>
            {wizard && step > 1 ? (
              <Button type="button" variant="outline" onClick={() => setStep((s) => s - 1)} disabled={pending}>
                <LuArrowLeft aria-hidden />
                Back
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={pending}
              >
                Cancel
              </Button>
            )}
            {/* Separate keys: React must not turn the "Next" button into the submit button
                mid-click (the browser would then submit the form on the same click). */}
            {wizard && step < 4 ? (
              <Button key="wizard-next" type="button" onClick={nextStep}>
                Next: {["", "project", "scope", "team"][step]}
                <LuArrowRight aria-hidden />
              </Button>
            ) : (
              <Button key="wizard-submit" type="submit" disabled={pending}>
                {pending ? (
                  <LuLoaderCircle aria-hidden className="animate-spin" />
                ) : isEdit ? (
                  <LuSave aria-hidden />
                ) : (
                  <LuSend aria-hidden />
                )}
                {pending ? "Saving…" : isEdit ? "Save changes" : "Create project"}
              </Button>
            )}
          </DialogFooter>
        </form>
        {brandCreator && <BrandFlowDialog open={brandFlowOpen} onOpenChange={setBrandFlowOpen} />}
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
