import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  LuArrowLeft,
  LuArrowRight,
  LuFileSpreadsheet,
  LuFileText,
  LuLoaderCircle,
  LuPlus,
  LuSparkles,
  LuTriangleAlert,
  LuX,
} from "react-icons/lu";

import { OtherScopeField, ScopeMatchBox, ScopeTotalCheck, ScopeTotalField } from "@/components/brands/scope-compare";
import { MultiSelect } from "@/components/globals/multi-select";
import { FieldError, OptionSelect } from "@/components/projects/project-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useScopeMatch } from "@/hooks/use-brand-scope";
import { useBrands, useCreateBrandFlow, useExtractBrandScope, useReadPitchSheet } from "@/hooks/use-brands";
import { useManpowerPlan } from "@/hooks/use-manpower";
import { useAssignableUsers } from "@/hooks/use-task-meta";
import { useTeamLoad } from "@/hooks/use-team-load";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api";
import { rolesFromScope } from "@/lib/brand-roles";
import { MANPOWER_ROLE_FALLBACK } from "@/lib/manpower";
import { SCOPE_LANGUAGES, SCOPE_UNITS } from "@/lib/scope";
import { stripComposedPrefix } from "@/lib/projects";
import { cn } from "@/lib/utils";
import type { LeadMatch, PitchSheetRow, ScopeExtraction, StatedTotal } from "@/types";

// ---------------------------------------------------------------------------
// Brands → New brand: 1. brand (+ potential revenue for a pitch), 2. scope read
// from images / PDFs / text, 3. lead (+ presentation / milestone tasks) and the
// team picked from the manpower plan by the scope, then Create.
// ---------------------------------------------------------------------------

type Row = { unit: string; what: string; quantity: number; languageList: string[]; sizes: number; source: string };
type LeadTask = { on: boolean; title: string; dueDate: string; from: string };

const MAX_FILES = 10;
const ACCEPT = "image/*,.pdf,.doc,.docx,.xlsx,.xls,.ppt,.pptx,.txt";
/** The agreement itself: PDF, image, Word or Excel (required for a brand; a pitch has no agreement yet). */
const isAgreementFile = (f: File) =>
  f.type === "application/pdf" || f.type.startsWith("image/") || /\.(pdf|png|jpe?g|webp|gif|heic|docx?|xlsx?)$/i.test(f.name);
const roleLabel = new Map(MANPOWER_ROLE_FALLBACK.map((r) => [r.key, r.label]));
const thisMonth = () => new Date().toISOString().slice(0, 7);
const rowTotal = (r: Row) => r.quantity * Math.max(1, r.languageList.length) * r.sizes;
const fmtDate = (iso: string) =>
  iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";

export function BrandFlowDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const brands = useBrands(false, open);
  const people = useAssignableUsers(open);
  const extract = useExtractBrandScope();
  const readSheet = useReadPitchSheet();
  const create = useCreateBrandFlow();

  const [step, setStep] = useState(1);
  const [tried, setTried] = useState(0);
  // Step 1
  const [isPitch, setIsPitch] = useState(true);
  const [name, setName] = useState("");
  const [organisation, setOrganisation] = useState("");
  const [revenue, setRevenue] = useState("");
  const [tbc, setTbc] = useState(false);
  const [sheetRows, setSheetRows] = useState<PitchSheetRow[] | null>(null);
  const [sheetRow, setSheetRow] = useState<PitchSheetRow | null>(null);
  const sheetInput = useRef<HTMLInputElement>(null);
  // Step 2
  const [files, setFiles] = useState<File[]>([]);
  const [typed, setTyped] = useState("");
  const [result, setResult] = useState<ScopeExtraction | null>(null);
  const [title, setTitle] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  // "Other scope": the agreement's scope text that isn't a row (editable, saved with the scope).
  const [otherScope, setOtherScope] = useState("");
  // The agreement's stated total ("96 content pieces per month"): a check for the rows, not a row.
  const [scopeTotal, setScopeTotal] = useState<StatedTotal | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Review the uploaded files next to the extracted scope (inline, no pop-up).
  const [shown, setShown] = useState<number | null>(null);
  const fileUrls = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => fileUrls.forEach((u) => URL.revokeObjectURL(u)), [fileUrls]);
  // Step 3
  // Project period (optional): read from the files or typed. The project's month follows the start.
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const month = startDate ? startDate.slice(0, 7) : thisMonth();
  const monthEnd = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const periodError = startDate && endDate && endDate < startDate ? "The end date must be on or after the start date." : null;
  const [leads, setLeads] = useState<string[]>([]);
  // Lead names read from the documents (matched to users or not) — shown in step 3.
  const [leadFound, setLeadFound] = useState<LeadMatch[]>([]);
  const [tasks, setTasks] = useState<LeadTask[]>([]);
  const [team, setTeam] = useState<Record<string, string[]>>({});
  const [teamTouched, setTeamTouched] = useState(false);
  const plan = useManpowerPlan(month, null, open && step === 3);
  const load = useTeamLoad(month, open && step === 3);

  useEffect(() => {
    if (!open) return;
    setStep(1); setTried(0); setIsPitch(true); setName(""); setOrganisation(""); setRevenue(""); setTbc(false);
    setSheetRows(null); setSheetRow(null); setFiles([]); setTyped(""); setResult(null); setTitle(""); setRows([]);
    setPlatforms([]); setNotes([]); setOtherScope(""); setScopeTotal(null); setLeads([]); setTasks([]); setTeam({}); setTeamTouched(false);
    setStartDate(""); setEndDate(""); setShown(null); setLeadFound([]);
    extract.reset(); create.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // --- Step 1 ---------------------------------------------------------------
  const nameKey = name.trim().replace(/\s+/g, " ").toLowerCase();
  const sameBrand = (brands.data ?? []).find((b) => b.name.trim().toLowerCase() === nameKey);
  const similar = nameKey.length >= 3
    ? (brands.data ?? []).filter((b) => b.name.toLowerCase() !== nameKey && (b.name.toLowerCase().includes(nameKey) || nameKey.includes(b.name.toLowerCase()))).slice(0, 5)
    : [];
  const nameError = !name.trim() ? "Enter the brand name" : name.includes("_") ? "Brand names can't contain “_”" : sameBrand ? `“${sameBrand.name}” already exists` : null;
  const revenueError = isPitch && !tbc && !(Number(revenue) > 0) ? "Enter the potential revenue, or tick TBC" : null;

  function matchLead(text: string): string[] {
    const list = people.data ?? [];
    return text
      .split(/[/,&]| and /i)
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean)
      .map((part) => list.find((u) => u.name.toLowerCase() === part) ?? list.find((u) => u.name.toLowerCase().startsWith(part)))
      .filter((u): u is NonNullable<typeof u> => Boolean(u))
      .map((u) => u._id);
  }

  function pickSheetRow(index: string) {
    const row = sheetRows?.[Number(index)];
    if (!row) return;
    setSheetRow(row);
    setIsPitch(true);
    setName(row.client);
    setTbc(row.revenueTbc || row.revenue === null);
    setRevenue(row.revenue ? String(row.revenue) : "");
    if (row.campaign) setTitle(row.campaign);
    const matched = matchLead(row.lead);
    if (matched.length) setLeads(matched.slice(0, 5));
  }

  // --- Step 2 ---------------------------------------------------------------
  function addFiles(list: FileList | null) {
    if (!list) return;
    const next = [...files];
    for (const file of Array.from(list)) {
      if (next.length >= MAX_FILES) break;
      if (!next.some((f) => f.name === file.name && f.size === file.size)) next.push(file);
    }
    setFiles(next);
  }

  function runExtract() {
    extract.mutate(
      { files, text: typed },
      {
        onSuccess: (data) => {
          setResult(data);
          setRows(data.scope.map((r) => ({ ...r })));
          setPlatforms(data.platforms);
          setNotes(data.notes);
          setOtherScope(data.otherScope ?? "");
          setScopeTotal(data.statedTotal ?? null);
          if (!title.trim() && data.projectName) setTitle(data.projectName);
          if (!startDate && data.dates.startDate) setStartDate(data.dates.startDate);
          if (!endDate && data.dates.endDate) setEndDate(data.dates.endDate);
          if (isPitch && !sheetRow && !revenue && data.revenue) setRevenue(String(data.revenue));
          // The lead named in the document ("Account Lead: …") is pre-selected when they're a user.
          const found = data.leadMatches ?? [];
          setLeadFound(found);
          const ids = found.flatMap((l) => (l.user ? [l.user._id] : []));
          if (ids.length) setLeads((current) => [...new Set([...current, ...ids])].slice(0, 5));
        },
      },
    );
  }
  const setRow = (i: number, patch: Partial<Row>) => setRows((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const pieces = rows.reduce((n, r) => n + r.quantity, 0);
  const hasAgreement = files.some(isAgreementFile);
  const agreementMissing = !isPitch && !hasAgreement;
  // How close the rows (as edited) are to what the agreement says — advice only.
  const match = useScopeMatch({ rows, extraction: result, otherScope, enabled: open && step === 2 && Boolean(result) });
  const deliverables = rows.reduce((n, r) => n + rowTotal(r), 0);

  // --- Step 3 ---------------------------------------------------------------
  const roles = useMemo(
    () => rolesFromScope(rows, notes, (result?.texts ?? []).map((t) => t.text).join(" ")),
    [rows, notes, result],
  );
  // Every manpower position: the ones the SOW asks for first (pre-filled), then the rest to fill if needed.
  const allRoles = useMemo(() => {
    const why = new Map(roles.map((r) => [r.key, r.why]));
    const fromSow = MANPOWER_ROLE_FALLBACK.filter((r) => why.has(r.key)).sort(
      (a, b) => roles.findIndex((x) => x.key === a.key) - roles.findIndex((x) => x.key === b.key),
    );
    const rest = MANPOWER_ROLE_FALLBACK.filter((r) => !why.has(r.key));
    return [...fromSow, ...rest].map((r) => ({ key: r.key, label: r.label, why: why.get(r.key) ?? null }));
  }, [roles]);
  // People holding each role in the month's plan, least busy first.
  const holders = useMemo(() => {
    const byRole = new Map<string, Map<string, string>>();
    for (const row of plan.data?.plan.rows ?? []) {
      for (const cell of row.cells) {
        const map = byRole.get(cell.role) ?? new Map<string, string>();
        for (const u of cell.users) map.set(u._id, u.name);
        byRole.set(cell.role, map);
      }
    }
    const loadOf = (id: string) => load.data?.load[id] ?? 0;
    return new Map([...byRole].map(([role, map]) => [role, [...map].map(([id, n]) => ({ id, name: n })).sort((a, b) => loadOf(a.id) - loadOf(b.id) || a.name.localeCompare(b.name))]));
  }, [plan.data, load.data]);
  const max = load.data?.max ?? 6;

  // Suggest the least-busy holder per role once the plan is in.
  useEffect(() => {
    if (step !== 3 || teamTouched || !plan.data) return;
    const next: Record<string, string[]> = {};
    for (const r of roles) {
      const first = holders.get(r.key)?.[0];
      next[r.key] = first ? [first.id] : [];
    }
    setTeam(next);
  }, [step, teamTouched, plan.data, roles, holders]);

  function goStep3() {
    const found = result?.dates;
    const sheet = sheetRow;
    const pick = (sheetDate: PitchSheetRow["clientPresentation"] | undefined, fromFile: string | null | undefined) =>
      sheetDate?.date
        ? { dueDate: sheetDate.date, from: sheetDate.monthOnly ? `pitch sheet (“${sheetDate.text}” — check)` : "pitch sheet" }
        : fromFile
          ? { dueDate: fromFile, from: "your files" }
          : { dueDate: "", from: "" };
    if (tasks.length === 0) {
      setTasks(
        [
          { title: "Milestone 1 meeting", ...pick(sheet?.milestone1, found?.milestone1) },
          { title: "Milestone 2 meeting", ...pick(sheet?.milestone2, found?.milestone2) },
          { title: "Client presentation", ...pick(sheet?.clientPresentation, found?.clientPresentation) },
        ].map((t) => ({ ...t, on: Boolean(t.dueDate) })),
      );
    }
    setStep(3);
  }

  function toggle(role: string, id: string) {
    setTeamTouched(true);
    setTeam((t) => {
      const list = t[role] ?? [];
      return { ...t, [role]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] };
    });
  }

  function next() {
    setTried(step);
    if (step === 1) {
      if (nameError || revenueError) return;
      setTried(0);
      setStep(2);
    } else if (step === 2) {
      if (agreementMissing || !rows.length || !title.trim() || periodError) return;
      setTried(0);
      goStep3();
    }
  }

  const peopleOptions = (people.data ?? []).map((u) => ({ value: u._id, label: u.name, description: u.email }));
  const nameOf = (id: string) => people.data?.find((u) => u._id === id)?.name ?? holders.get("")?.find((h) => h.id === id)?.name ?? "—";
  const activeTasks = isPitch ? tasks.filter((t) => t.dueDate) : [];
  // A pitch needs all three dates: Milestone 1 meeting, Milestone 2 meeting, Client presentation.
  const pitchDatesMissing = isPitch ? tasks.filter((t) => !t.dueDate).map((t) => t.title) : [];
  const teamPeople = [...new Set(allRoles.flatMap((r) => team[r.key] ?? []))];
  // A pitch's project is a Pitch; anything else starts as a Project (no choice to make here).
  const typeForName = isPitch ? "Pitch" : "Project";
  // "_" is allowed in the name; a pasted whole name loses its Brand_Type_Month_ start.
  const cleanTitle = stripComposedPrefix(title, name, typeForName, month);

  function submit() {
    setTried(3);
    if (!leads.length || pitchDatesMissing.length) return;
    const data = {
      name: name.trim(),
      organisation: organisation.trim(),
      isPitch,
      revenue: isPitch && !tbc ? Number(revenue) : null,
      revenueTbc: isPitch && tbc,
      scopeItems: rows.map((r) => ({
        unit: r.unit,
        quantity: r.quantity,
        languages: Math.max(1, r.languageList.length),
        languageList: r.languageList,
        sizes: r.sizes,
        what: r.what,
        source: r.source,
      })),
      platforms,
      notes,
      scopeText: otherScope.trim(),
      scopeTotal,
      projectType: typeForName,
      month,
      title: cleanTitle,
      leads,
      team: allRoles.map((r) => ({ role: r.key, users: team[r.key] ?? [] })).filter((t) => t.users.length),
      tasks: [],
      ...(isPitch
        ? {
            pitchDates: {
              milestone1: tasks.find((t) => t.title.startsWith("Milestone 1"))?.dueDate ?? "",
              milestone2: tasks.find((t) => t.title.startsWith("Milestone 2"))?.dueDate ?? "",
              clientPresentation: tasks.find((t) => t.title === "Client presentation")?.dueDate ?? "",
            },
          }
        : {}),
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
      // What the agreement says: stored on the brand and compared with the rows above.
      ...(result ? { agreement: { scope: result.scope, texts: result.texts.map((t) => ({ source: t.source, text: t.text })) } } : {}),
    };
    create.mutate(
      { data, files },
      {
        onSuccess: (res) => {
          if (res.pendingApproval) toast.success(res.pendingApproval);
          else toast.success(`${res.brand.name} created${res.project ? ` with ${res.project.name}` : ""}.`);
          if (res.warnings?.length) toast.error(`Some lead tasks weren't created: ${res.warnings.join("; ")}`);
          onOpenChange(false);
          if (res.project) void navigate(`/projects/${res.project._id}`);
        },
      },
    );
  }

  const monthLabel = new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const projectName = `${name.trim() || "Brand"}_${typeForName}_${new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })}${month.slice(0, 4)}_${cleanTitle || "Project"}`;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Escape / a click outside shouldn't throw away a half-done brand.
        const dirty = Boolean(name.trim() || files.length || typed.trim() || rows.length);
        if (!next && (create.isPending || (dirty && !window.confirm("Close the new brand? What you entered will be lost.")))) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[92vh] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>New brand</DialogTitle>
          <DialogDescription>Three steps. Nothing is created until you click Create brand.</DialogDescription>
        </DialogHeader>

        <ol className="grid grid-cols-3 gap-1.5 text-xs" aria-label="Steps">
          {["Brand", "Scope from files", "Lead & create"].map((label, i) => (
            <li key={label}>
              <button
                type="button"
                onClick={() => (i + 1 < step ? setStep(i + 1) : undefined)}
                aria-current={i + 1 === step ? "step" : undefined}
                className={cn(
                  "w-full rounded-md border px-2 py-1.5 text-left",
                  i + 1 === step ? "border-primary bg-primary/10 font-medium text-primary" : i + 1 < step ? "text-foreground hover:bg-muted" : "text-muted-foreground",
                )}
              >
                {i + 1} · {label}
              </button>
            </li>
          ))}
        </ol>

        {step === 1 && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed p-3">
              <Button type="button" variant="outline" size="sm" onClick={() => sheetInput.current?.click()} disabled={readSheet.isPending}>
                {readSheet.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuFileSpreadsheet aria-hidden />}
                Fill from pitch sheet…
              </Button>
              <input
                ref={sheetInput}
                type="file"
                accept=".xlsx"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) readSheet.mutate(file, { onSuccess: setSheetRows });
                }}
              />
              <span className="text-xs text-muted-foreground">Upload the pitch tracker (.xlsx) and pick a row.</span>
              {readSheet.isError && <FieldError>{getErrorMessage(readSheet.error)}</FieldError>}
              {sheetRows && (
                <div className="w-full">
                  <OptionSelect
                    aria-label="Pitch sheet row"
                    value={sheetRow ? String(sheetRows.indexOf(sheetRow)) : ""}
                    onChange={pickSheetRow}
                    placeholder="Pick a row…"
                    options={sheetRows.map((r, i) => ({
                      value: String(i),
                      label: `${r.client}${r.campaign ? ` · ${r.campaign}` : ""}`,
                      description: [r.revenue ? `AED ${r.revenue.toLocaleString("en-US")}` : r.revenueTbc ? "TBC" : "", r.lead && `lead ${r.lead}`].filter(Boolean).join(" · "),
                    }))}
                  />
                </div>
              )}
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Is this a pitch?</legend>
              <div className="flex flex-wrap items-center gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input type="radio" name="brand-kind" checked={isPitch} onChange={() => setIsPitch(true)} className="size-4 accent-primary" /> Pitch
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="brand-kind" checked={!isPitch} onChange={() => setIsPitch(false)} className="size-4 accent-primary" /> Not a pitch
                </label>
              </div>
            </fieldset>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="brand-flow-name">Brand name<span aria-hidden className="ml-0.5 text-destructive">*</span></Label>
                <Input id="brand-flow-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Ajman Accountability Authority" aria-invalid={(tried >= 1 && Boolean(nameError)) || undefined} />
                {tried >= 1 && nameError ? <FieldError>{nameError}</FieldError> : similar.length > 0 && <p className="text-xs text-amber-700 dark:text-amber-400">Similar brands: {similar.map((b) => b.name).join(", ")}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="brand-flow-org">Organisation <span className="font-normal text-muted-foreground">(optional)</span></Label>
                <Input id="brand-flow-org" value={organisation} onChange={(e) => setOrganisation(e.target.value)} maxLength={80} placeholder="e.g. Ajmal" list="brand-flow-orgs" />
                <datalist id="brand-flow-orgs">
                  {[...new Set((brands.data ?? []).map((b) => b.organisation ?? "").filter(Boolean))].sort().map((o) => <option key={o} value={o} />)}
                </datalist>
                <p className="text-xs text-muted-foreground">Groups brands of one client (Ajmal GCC, Ajmal 75, Ajmal UK). Different scope = different brand.</p>
              </div>
              {isPitch && (
                <div className="space-y-1.5">
                  <Label htmlFor="brand-flow-revenue">Potential revenue (AED)<span aria-hidden className="ml-0.5 text-destructive">*</span></Label>
                  <Input id="brand-flow-revenue" type="number" min={0} step={1000} value={revenue} onChange={(e) => setRevenue(e.target.value)} disabled={tbc} placeholder="200000" aria-invalid={(tried >= 1 && Boolean(revenueError)) || undefined} />
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={tbc} onChange={(e) => setTbc(e.target.checked)} className="size-4 accent-primary" /> Not known yet (TBC)
                  </label>
                  {tried >= 1 && revenueError && <FieldError>{revenueError}</FieldError>}
                </div>
              )}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <div
              className="rounded-lg border-2 border-dashed bg-muted/30 p-4 text-center"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                addFiles(e.dataTransfer.files);
              }}
            >
              {!isPitch && (
                <p className="mb-1 text-sm font-medium">
                  Upload the agreement<span aria-hidden className="ml-0.5 text-destructive">*</span>
                  <span className="ml-1 font-normal text-muted-foreground">— the signed agreement / SOW the scope comes from</span>
                </p>
              )}
              <p className="text-sm">
                <span className="font-medium">Drop images or PDFs here</span> or{" "}
                <button type="button" className="font-medium text-primary underline-offset-4 hover:underline" onClick={() => fileInput.current?.click()}>
                  choose files
                </button>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {isPitch ? "Brief, SOW, screenshots" : "Agreement, SOW, screenshots"} · PDF, image, Word, Excel · up to {MAX_FILES} files, 10 MB each
              </p>
              <input ref={fileInput} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
            </div>
            {tried >= 2 && agreementMissing && (
              <FieldError>Upload the agreement (PDF, image, Word or Excel) — typed text alone isn&apos;t enough for a brand.</FieldError>
            )}
            {files.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className={cn("flex items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs", shown === i && "border-primary")}>
                    {f.type.startsWith("image/") ? (
                      <img src={fileUrls[i]} alt="" className="size-6 rounded object-cover" />
                    ) : (
                      <LuFileText aria-hidden className="size-3.5 text-muted-foreground" />
                    )}
                    <button type="button" className="max-w-48 truncate text-left hover:underline" onClick={() => setShown(shown === i ? null : i)} aria-pressed={shown === i}>
                      {f.name}
                    </button>
                    <button type="button" aria-label={`Remove ${f.name}`} onClick={() => { setShown(null); setFiles(files.filter((_, j) => j !== i)); }} className="text-muted-foreground hover:text-foreground">
                      <LuX aria-hidden className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {shown !== null && files[shown] && (
              <div className="space-y-1.5 rounded-lg border p-2">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate font-medium">{files[shown]!.name}</span>
                  <span className="flex gap-3">
                    <a href={fileUrls[shown]} target="_blank" rel="noreferrer" className="text-primary hover:underline">Open in a new tab</a>
                    <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setShown(null)}>Hide</button>
                  </span>
                </div>
                {files[shown]!.type.startsWith("image/") ? (
                  <img src={fileUrls[shown]} alt={files[shown]!.name} className="max-h-[28rem] w-full rounded object-contain" />
                ) : files[shown]!.type === "application/pdf" || /\.pdf$/i.test(files[shown]!.name) ? (
                  <iframe src={fileUrls[shown]} title={files[shown]!.name} className="h-[28rem] w-full rounded border-0 bg-white" />
                ) : (
                  <p className="text-xs text-muted-foreground">Word / Excel / PowerPoint files can't be shown here — use “Open in a new tab”, or see the text read from it below.</p>
                )}
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="brand-flow-text">
                {isPitch ? "Or type / paste the scope" : "Also type / paste"} <span className="font-normal text-muted-foreground">{isPitch ? "" : "(optional — in addition to the agreement)"}</span>
              </Label>
              <Textarea id="brand-flow-text" rows={4} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={"e.g. 8x engagement posts, 10x reels, 12x stories in English & Arabic\nClient presentation: 26 Oct 2026"} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={runExtract} disabled={extract.isPending || (!files.length && !typed.trim())}>
                {extract.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuSparkles aria-hidden />}
                {extract.isPending ? "Reading…" : result ? "Read again" : "Read files & extract scope"}
              </Button>
              {extract.isError && <FieldError>{getErrorMessage(extract.error)}</FieldError>}
            </div>

            {result && (
              <div className="space-y-4">
                <details className="rounded-lg border">
                  <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                    Text read from your inputs ({result.texts.length}){!result.usedAI && <span className="ml-2 text-xs font-normal text-muted-foreground">read without AI</span>}
                  </summary>
                  <div className="space-y-2 border-t p-3">
                    {result.texts.map((t) => (
                      <div key={t.source}>
                        <p className="text-xs font-medium">{t.source}{!t.read && <span className="ml-1 text-amber-700 dark:text-amber-400">— couldn't read</span>}</p>
                        {t.text && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-xs">{t.text}</pre>}
                      </div>
                    ))}
                  </div>
                </details>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="brand-flow-title">Project name<span aria-hidden className="ml-0.5 text-destructive">*</span></Label>
                    <Input id="brand-flow-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} aria-invalid={(tried >= 2 && !title.trim()) || undefined} />
                    <p className="break-all text-xs text-muted-foreground">Project: {projectName}</p>
                    {tried >= 2 && !title.trim() && <FieldError>Enter the project name (the tracker's Campaign/Idea).</FieldError>}
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-sm font-medium">Platforms</p>
                    <div className="flex flex-wrap gap-1.5">
                      {platforms.length ? platforms.map((p) => <Badge key={p} variant="secondary">{p}</Badge>) : <span className="text-xs text-muted-foreground">None found</span>}
                    </div>
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="brand-flow-start">
                      Start date <span className="font-normal text-muted-foreground">(optional)</span>
                      {result.dates.startDate && startDate === result.dates.startDate && <Badge variant="secondary" className="ml-1.5">from your files</Badge>}
                    </Label>
                    <Input id="brand-flow-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                    <p className="text-xs text-muted-foreground">Empty = the 1st of the month. The project's month follows the start date.</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="brand-flow-end">
                      End date <span className="font-normal text-muted-foreground">(optional)</span>
                      {result.dates.endDate && endDate === result.dates.endDate && <Badge variant="secondary" className="ml-1.5">from your files</Badge>}
                    </Label>
                    <Input id="brand-flow-end" type="date" value={endDate} min={startDate || undefined} onChange={(e) => setEndDate(e.target.value)} aria-invalid={Boolean(periodError) || undefined} />
                    <p className="text-xs text-muted-foreground">The project's deadline. Empty = {fmtDate(monthEnd)} (end of the month).</p>
                    {periodError && <FieldError>{periodError}</FieldError>}
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium">Scope</p>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[40rem] text-sm">
                      <thead className="text-xs text-muted-foreground">
                        <tr className="border-b text-left">
                          <th className="py-1.5 pr-2 font-medium">Unit</th>
                          <th className="py-1.5 pr-2 font-medium">What</th>
                          <th className="py-1.5 pr-2 font-medium">Qty</th>
                          <th className="py-1.5 pr-2 font-medium">Languages</th>
                          <th className="py-1.5 pr-2 font-medium">Sizes</th>
                          <th className="py-1.5 pr-2 text-right font-medium">Total</th>
                          <th className="py-1.5 font-medium">From</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r, i) => (
                          <tr key={i} className="border-b last:border-0">
                            <td className="py-1.5 pr-2"><OptionSelect aria-label={`Row ${i + 1} unit`} className="w-28" value={r.unit} onChange={(unit) => setRow(i, { unit })} options={SCOPE_UNITS.map((u) => ({ value: u, label: u }))} /></td>
                            <td className="py-1.5 pr-2"><Input aria-label={`Row ${i + 1} what`} value={r.what} onChange={(e) => setRow(i, { what: e.target.value })} maxLength={80} /></td>
                            <td className="py-1.5 pr-2"><Input aria-label={`Row ${i + 1} quantity`} type="number" min={1} className="w-20" value={r.quantity} onChange={(e) => setRow(i, { quantity: Math.max(1, Math.round(Number(e.target.value) || 1)) })} /></td>
                            <td className="py-1.5 pr-2">
                              <div className="flex flex-wrap gap-1">
                                {SCOPE_LANGUAGES.slice(0, 2).map((l) => (
                                  <label key={l} className="flex items-center gap-1 text-xs">
                                    <input type="checkbox" className="size-3.5 accent-primary" checked={r.languageList.includes(l)} onChange={() => setRow(i, { languageList: r.languageList.includes(l) ? r.languageList.filter((x) => x !== l) : [...r.languageList, l] })} />
                                    {l}
                                  </label>
                                ))}
                              </div>
                            </td>
                            <td className="py-1.5 pr-2"><Input aria-label={`Row ${i + 1} sizes`} type="number" min={1} className="w-16" value={r.sizes} onChange={(e) => setRow(i, { sizes: Math.max(1, Math.round(Number(e.target.value) || 1)) })} /></td>
                            <td className="py-1.5 pr-2 text-right font-semibold tabular-nums">{rowTotal(r)}</td>
                            <td className="max-w-28 truncate py-1.5 pr-2 text-xs text-muted-foreground">{r.source || "typed"}</td>
                            <td className="py-1.5"><Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove row ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}><LuX aria-hidden /></Button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => setRows([...rows, { unit: "Static", what: "", quantity: 1, languageList: ["English"], sizes: 1, source: "typed" }])}>
                      <LuPlus aria-hidden /> Add row
                    </Button>
                    <p className="text-sm"><span className="font-semibold tabular-nums">{pieces}</span> pieces · {deliverables} deliverables with languages and sizes</p>
                  </div>
                  {tried >= 2 && !rows.length && <FieldError>Add at least one scope row.</FieldError>}
                  <ScopeTotalField id="brand-flow-scope-total" value={scopeTotal} onChange={setScopeTotal} />
                  <ScopeTotalCheck total={scopeTotal} rows={rows} />
                  <OtherScopeField id="brand-flow-other-scope" value={otherScope} onChange={setOtherScope} />
                  <ScopeMatchBox
                    match={match.data?.match}
                    loading={match.isFetching}
                    note={match.data && !match.data.match ? match.data.reason : match.isError ? "Couldn't compare with the agreement right now." : null}
                  />
                </div>

                {notes.length > 0 && (
                  <div className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
                    <p className="flex items-center gap-1.5 font-medium"><LuTriangleAlert aria-hidden className="size-4" /> Check these</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5">{notes.map((n) => <li key={n}>{n}</li>)}</ul>
                  </div>
                )}
              </div>
            )}
            {tried >= 2 && !result && <FieldError>Add a file or type the scope, then read it.</FieldError>}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5">
            <div className="space-y-1.5">
              <Label htmlFor="brand-flow-leads">Lead<span aria-hidden className="ml-0.5 text-destructive">*</span></Label>
              <MultiSelect id="brand-flow-leads" options={peopleOptions} value={leads} onValueChange={(v) => setLeads(v.slice(0, 5))} placeholder="Pick the lead(s)…" max={5} invalid={tried >= 3 && !leads.length} />
              {tried >= 3 && !leads.length && <FieldError>Pick the lead.</FieldError>}
              {leadFound.map((l) =>
                l.user ? (
                  <p key={l.name} className="text-xs text-emerald-700 dark:text-emerald-400">
                    Lead read from {l.source || "your files"}: {l.user.name}
                    {l.user.name.toLowerCase() !== l.name.toLowerCase() ? ` (“${l.name}”)` : ""}
                  </p>
                ) : (
                  <p key={l.name} className="text-xs text-amber-700 dark:text-amber-400">
                    Found “{l.name}” in the document{l.source ? ` (${l.source})` : ""} — no matching user
                  </p>
                ),
              )}
              {leads.length > 0 && load.data && (
                <p className="text-xs text-muted-foreground">
                  {leads.map((id) => `${nameOf(id)}: ${load.data!.load[id] ?? 0}/${max} projects in ${monthLabel}`).join(" · ")}
                </p>
              )}
            </div>

            {isPitch ? (
              <div className="space-y-2">
                <p className="text-sm font-medium">
                  Pitch dates<span aria-hidden className="ml-0.5 text-destructive">*</span>
                  <span className="ml-1 font-normal text-muted-foreground">— all three required; each becomes a task for the lead</span>
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[32rem] text-sm">
                    <tbody>
                      {tasks.map((t, i) => (
                        <tr key={i} className="border-b last:border-0">
                          <td className="w-48 py-1.5 pr-2 font-medium">{t.title}</td>
                          <td className="py-1.5 pr-2"><Input aria-label={`${t.title} date`} type="date" required value={t.dueDate} aria-invalid={(tried >= 3 && !t.dueDate) || undefined} onChange={(e) => setTasks(tasks.map((x, j) => (j === i ? { ...x, dueDate: e.target.value, on: true, from: e.target.value ? x.from || "typed" : "" } : x)))} /></td>
                          <td className="py-1.5 text-xs text-muted-foreground">{t.from || <span className="text-amber-700 dark:text-amber-400">no date</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {tried >= 3 && pitchDatesMissing.length > 0 ? (
                  <FieldError>Add the {pitchDatesMissing.join(", ")} date{pitchDatesMissing.length === 1 ? "" : "s"} — a pitch can't be created without them.</FieldError>
                ) : (
                  <p className="text-xs text-muted-foreground">Assigned to the lead(s) in the new project, as high-priority tasks.</p>
                )}
              </div>
            ) : (
              <p className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">Not a pitch: no presentation / milestone tasks are created.</p>
            )}

            <div className="space-y-2">
              <p className="text-sm font-medium">Team — all manpower positions</p>
              <p className="text-xs text-muted-foreground">
                Positions the SOW asks for are filled in for you ({roles.length}); fill any other position you need. Chips are the people who hold the role in the {monthLabel} manpower plan, least busy first (projects / max {max}) — or add anyone.
              </p>
              {plan.isPending && (
                <p className="flex items-center gap-2 text-xs text-muted-foreground"><LuLoaderCircle aria-hidden className="size-3.5 animate-spin" /> Loading the manpower plan…</p>
              )}
              {plan.isError && (
                <p className="text-xs text-amber-700 dark:text-amber-400">No manpower plan for {monthLabel} yet — pick people with “Add anyone”.</p>
              )}
              <div className="space-y-2">
                {allRoles.map((r) => {
                  const picked = team[r.key] ?? [];
                  const list = [...(holders.get(r.key) ?? [])];
                  for (const id of picked) if (!list.some((p) => p.id === id)) list.push({ id, name: nameOf(id) });
                  const others = peopleOptions.filter((o) => !list.some((p) => p.id === o.value));
                  return (
                    <div key={r.key} className={cn("rounded-lg border p-3", r.why ? "border-primary/40" : "", !r.why && !picked.length && "bg-muted/20")}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-medium">
                          {r.label}
                          {picked.length > 0 && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({picked.length})</span>}
                        </p>
                        {r.why ? (
                          <Badge variant="secondary" className="text-xs font-normal">From the SOW: {r.why}</Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">Not in the SOW — fill if needed</span>
                        )}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {list.map((p) => {
                          const on = picked.includes(p.id);
                          const n = (load.data?.load[p.id] ?? 0) + (on ? 1 : 0);
                          return (
                            <button
                              key={p.id}
                              type="button"
                              aria-pressed={on}
                              onClick={() => toggle(r.key, p.id)}
                              className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs", on ? "border-primary bg-primary/10 font-medium text-primary" : "hover:bg-muted")}
                            >
                              {on ? "✓" : "+"} {p.name}
                              <span className={cn("tabular-nums", n > max ? "font-semibold text-destructive" : "text-muted-foreground")}>{n}/{max}</span>
                            </button>
                          );
                        })}
                        {others.length > 0 && (
                          <OptionSelect
                            aria-label={`Add anyone as ${r.label}`}
                            className="h-7 w-40 text-xs"
                            value=""
                            placeholder="+ Add anyone…"
                            options={others}
                            onChange={(id) => id && toggle(r.key, id)}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="rounded-lg bg-muted/40 p-3 text-sm">
              <p className="font-medium">When you click Create brand</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                <li>The brand <span className="text-foreground">{name.trim()}</span> is created{isPitch ? ` (potential revenue ${tbc ? "TBC" : `AED ${Number(revenue).toLocaleString("en-US")}`})` : ""}. If you aren't leadership, it waits for Aasim, Rania or Bala — and so does everything below.</li>
                <li>The project <span className="break-all text-foreground">{projectName}</span> with the scope above ({pieces} pieces), running {fmtDate(startDate || `${month}-01`)} – {fmtDate(endDate || monthEnd)}; its scope is locked to the brand. Your files are attached.</li>
                {isPitch && <li>{activeTasks.length} task{activeTasks.length === 1 ? "" : "s"} for the lead: {activeTasks.map((t) => `${t.title} (${fmtDate(t.dueDate)})`).join(", ") || "none"}.</li>}
                <li>{teamPeople.length} people on the team, written to the {monthLabel} manpower plan.</li>
              </ul>
            </div>
            {create.isError && <FieldError>{getErrorMessage(create.error)}</FieldError>}
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          {step > 1 ? (
            <Button type="button" variant="outline" onClick={() => setStep(step - 1)} disabled={create.isPending}>
              <LuArrowLeft aria-hidden /> Back
            </Button>
          ) : (
            <span />
          )}
          {step < 3 ? (
            <Button key="brand-next" type="button" onClick={next}>
              Next: {step === 1 ? "scope" : "lead"} <LuArrowRight aria-hidden />
            </Button>
          ) : (
            <Button key="brand-create" type="button" onClick={submit} disabled={create.isPending}>
              {create.isPending && <LuLoaderCircle aria-hidden className="animate-spin" />}
              Create brand
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
