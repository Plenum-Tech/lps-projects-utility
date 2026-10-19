import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { LuArrowLeft, LuDownload, LuLoaderCircle, LuPaperclip, LuPlus, LuScissors, LuSparkles, LuTags, LuTrash2, LuX } from "react-icons/lu";

import { AllocCell, CellLegend, cellTone, SaveBar, StatusDot, usePlanEdits } from "@/components/brands/alloc-cell";
import { monthLabel, MonthPicker, poolOptions, shortName } from "@/components/brands/brands-dashboard";
import { MultiSelect } from "@/components/globals/multi-select";
import { EmptyState, QueryError } from "@/components/globals/query-states";
import { FieldError, OptionSelect } from "@/components/projects/project-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useBrandDetail, useDeleteBrandFile, usePatchBrand, useSplitBrand, useUploadBrandFiles } from "@/hooks/use-brand-dashboard";
import { useExtractBrandScope } from "@/hooks/use-brands";
import { useAssignableUsers } from "@/hooks/use-task-meta";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api";
import { neededRoles, UNIT_ROLE } from "@/lib/brand-roles";
import { downloadFromApi } from "@/lib/download";
import { formatDate } from "@/lib/format";
import { SCOPE_LANGUAGES, SCOPE_UNITS } from "@/lib/scope";
import { cn } from "@/lib/utils";
import type { BrandDetailResponse } from "@/types";

// ---------------------------------------------------------------------------
// /brands/:id — one brand: scope → who delivers it, documents, team (the month's
// manpower plan, inline colour cells), leads, utilisation of its people, current
// projects, and Split brand. Everything in place (no dialogs).
// ---------------------------------------------------------------------------

const ACCEPT = ".docx,.pdf,.xlsx,image/jpeg,image/png,.jpg,.jpeg,.png";
type ScopeRow = { unit: string; what: string; quantity: number; languageList: string[]; sizes: number; source: string };

function Section({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-4 text-card-foreground">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

function UtilisationBar({ value, max }: { value: number; max: number }) {
  const tone = value > max ? "bg-red-600 dark:bg-red-400" : value >= max - 1 ? "bg-amber-500" : "bg-emerald-600 dark:bg-emerald-400";
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-28 overflow-hidden rounded-full bg-muted" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={`${value} of ${max} projects`}>
        <i className={cn("block h-full", tone)} style={{ width: `${Math.min(100, (100 * value) / Math.max(1, max))}%` }} />
      </div>
      <span className={cn("text-xs tabular-nums", value > max && "font-semibold text-destructive")}>
        {value}/{max}
      </span>
    </div>
  );
}

/** Scope upload → read → review → save (brand scope; leadership applies, others send for approval) + attach the files. */
function ScopeUpload({ brandId, onDone }: { brandId: string; onDone: () => void }) {
  const toast = useToast();
  const extract = useExtractBrandScope();
  const patch = usePatchBrand();
  const upload = useUploadBrandFiles();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [rows, setRows] = useState<ScopeRow[] | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const setRow = (i: number, p: Partial<ScopeRow>) => setRows((list) => list!.map((r, j) => (j === i ? { ...r, ...p } : r)));

  function read(list: File[]) {
    setFiles(list);
    setRows(null);
    extract.mutate(
      { files: list, text: "" },
      {
        onSuccess: (data) => {
          setRows(data.scope.map((r) => ({ ...r })));
          setNotes(data.notes);
        },
      },
    );
  }

  async function save() {
    if (!rows?.length) return;
    try {
      await patch.mutateAsync({
        id: brandId,
        scopeItems: rows.map((r) => ({ unit: r.unit, quantity: r.quantity, languages: Math.max(1, r.languageList.length), languageList: r.languageList, sizes: r.sizes, what: r.what, source: r.source })),
      });
      if (files.length) await upload.mutateAsync({ id: brandId, files });
      setFiles([]);
      setRows(null);
      setNotes([]);
      onDone();
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }

  const busy = extract.isPending || patch.isPending || upload.isPending;
  return (
    <div className="mt-3 space-y-3">
      <div
        className="rounded-lg border-2 border-dashed bg-muted/30 p-3 text-center text-sm"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          read(Array.from(e.dataTransfer.files).slice(0, 10));
        }}
      >
        Add / replace scope: <span className="font-medium">.docx · PDF · JPEG · Excel</span>
        <Button type="button" variant="outline" size="sm" className="ml-2" disabled={busy} onClick={() => input.current?.click()}>
          {extract.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuPaperclip aria-hidden />} Choose files…
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            const list = Array.from(e.target.files ?? []).slice(0, 10);
            e.target.value = "";
            if (list.length) read(list);
          }}
        />
        {files.length > 0 && <p className="mt-1 text-xs text-muted-foreground">{files.map((f) => f.name).join(", ")}</p>}
        {extract.isError && <FieldError>{getErrorMessage(extract.error)}</FieldError>}
      </div>
      {rows && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Scope read from the files — check and edit</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="py-1.5 pr-2 font-medium">Unit</th>
                  <th className="py-1.5 pr-2 font-medium">What</th>
                  <th className="py-1.5 pr-2 font-medium">Qty</th>
                  <th className="py-1.5 pr-2 font-medium">Languages</th>
                  <th className="py-1.5 pr-2 font-medium">From</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-1 pr-2"><OptionSelect aria-label={`Row ${i + 1} unit`} className="w-28" value={r.unit} onChange={(unit) => setRow(i, { unit })} options={SCOPE_UNITS.map((u) => ({ value: u, label: u }))} /></td>
                    <td className="py-1 pr-2"><Input aria-label={`Row ${i + 1} what`} value={r.what} maxLength={80} onChange={(e) => setRow(i, { what: e.target.value })} /></td>
                    <td className="py-1 pr-2"><Input aria-label={`Row ${i + 1} quantity`} type="number" min={1} className="w-20" value={r.quantity} onChange={(e) => setRow(i, { quantity: Math.max(1, Math.round(Number(e.target.value) || 1)) })} /></td>
                    <td className="py-1 pr-2">
                      <div className="flex gap-2">
                        {SCOPE_LANGUAGES.slice(0, 2).map((l) => (
                          <label key={l} className="flex items-center gap-1 text-xs">
                            <input type="checkbox" className="size-3.5 accent-primary" checked={r.languageList.includes(l)} onChange={() => setRow(i, { languageList: r.languageList.includes(l) ? r.languageList.filter((x) => x !== l) : [...r.languageList, l] })} />
                            {l}
                          </label>
                        ))}
                      </div>
                    </td>
                    <td className="max-w-32 truncate py-1 pr-2 text-xs text-muted-foreground">{r.source || "typed"}</td>
                    <td className="py-1"><Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove row ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}><LuX aria-hidden /></Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {notes.length > 0 && <ul className="list-disc pl-5 text-xs text-amber-800 dark:text-amber-300">{notes.map((n) => <li key={n}>{n}</li>)}</ul>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setRows([...rows, { unit: "Static", what: "", quantity: 1, languageList: ["English"], sizes: 1, source: "typed" }])}>
              <LuPlus aria-hidden /> Add row
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => { setRows(null); setFiles([]); }} disabled={busy}>Cancel</Button>
              <Button type="button" size="sm" onClick={() => void save()} disabled={busy || rows.length === 0}>
                {(patch.isPending || upload.isPending) && <LuLoaderCircle aria-hidden className="animate-spin" />}
                Save scope{files.length ? ` & attach ${files.length} file${files.length === 1 ? "" : "s"}` : ""}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Leadership's changes apply at once; anyone else's scope change goes to leadership for approval. The files are attached to the brand straight away.</p>
        </div>
      )}
    </div>
  );
}

function SplitPanel({ data, onClose }: { data: BrandDetailResponse; onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const split = useSplitBrand();
  const b = data.brand;
  const [name, setName] = useState("");
  const [organisation, setOrganisation] = useState(b.organisation || b.name);
  const [picked, setPicked] = useState<string[]>([]);
  const [tried, setTried] = useState(false);
  const nameError = !name.trim() ? "Enter the new brand's name" : name.includes("_") ? "Brand names can't contain “_”" : name.trim().toLowerCase() === b.name.toLowerCase() ? "Use a different name" : null;

  function submit() {
    setTried(true);
    if (nameError || picked.length === 0) return;
    split.mutate(
      { id: b._id, name: name.trim(), projectIds: picked, organisation: organisation.trim() },
      {
        onSuccess: (res) => {
          toast.success(res.pendingApproval ?? `${res.brand.name} created — ${res.moved ?? 0} project${res.moved === 1 ? "" : "s"} moved${res.plans?.length ? `, plan ${res.plans.map((p) => `${p.month} v${p.version}`).join(", ")}` : ""}.`);
          if (res.notes?.length) toast.error(res.notes.join(" "));
          onClose();
          if (!res.pendingApproval) void navigate(`/brands/${res.brand._id}?month=${data.month}`);
        },
      },
    );
  }

  return (
    <Section title="Split brand" actions={<Button type="button" variant="ghost" size="sm" onClick={onClose}><LuX aria-hidden /> Close</Button>}>
      <p className="mb-3 text-sm text-muted-foreground">
        Different scope = different brand. The ticked projects move to the new brand (names follow, codes stay) and their manpower plan lines go with them.
        {!data.canApprove && " The new brand goes to leadership for approval; the projects move when it's approved."}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="split-name">New brand name<span aria-hidden className="ml-0.5 text-destructive">*</span></Label>
          <Input id="split-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={`e.g. ${b.name} GCC`} aria-invalid={(tried && Boolean(nameError)) || undefined} />
          {tried && nameError && <FieldError>{nameError}</FieldError>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="split-org">Organisation <span className="font-normal text-muted-foreground">(optional)</span></Label>
          <Input id="split-org" value={organisation} maxLength={80} onChange={(e) => setOrganisation(e.target.value)} />
          <p className="text-xs text-muted-foreground">Groups brands of one client (Ajmal GCC, Ajmal 75, Ajmal UK).</p>
        </div>
      </div>
      <fieldset className="mt-3">
        <legend className="text-sm font-medium">Projects to move<span aria-hidden className="ml-0.5 text-destructive">*</span></legend>
        {b.projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">This brand has no open projects.</p>
        ) : (
          <ul className="mt-1.5 max-h-72 space-y-1 overflow-y-auto rounded-lg border p-2">
            {b.projects.map((p) => (
              <li key={p._id}>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4 accent-primary" checked={picked.includes(p._id)} onChange={() => setPicked(picked.includes(p._id) ? picked.filter((x) => x !== p._id) : [...picked, p._id])} />
                  <span className="break-all">{p.name}</span>
                  <span className="text-xs text-muted-foreground">{p.code}</span>
                  {p.current && <Badge variant="secondary">current</Badge>}
                </label>
              </li>
            ))}
          </ul>
        )}
        {tried && picked.length === 0 && <FieldError>Tick at least one project.</FieldError>}
      </fieldset>
      {split.isError && <FieldError>{getErrorMessage(split.error)}</FieldError>}
      <div className="mt-3 flex justify-end">
        <Button type="button" onClick={submit} disabled={split.isPending}>
          {split.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuScissors aria-hidden />}
          {data.canApprove ? "Split brand" : "Send split for approval"}
        </Button>
      </div>
    </Section>
  );
}

function LeadsEditor({ data }: { data: BrandDetailResponse }) {
  const b = data.brand;
  const people = useAssignableUsers(data.canManage);
  const patch = usePatchBrand();
  const [leads, setLeads] = useState(b.leads.map((l) => l._id));
  const [organisation, setOrganisation] = useState(b.organisation);
  useEffect(() => {
    setLeads(b.leads.map((l) => l._id));
    setOrganisation(b.organisation);
  }, [b._id, b.leads, b.organisation]);
  const options = useMemo(() => {
    const list = (people.data ?? []).map((u) => ({ value: u._id, label: u.name, description: u.email }));
    for (const l of b.leads) if (!list.some((o) => o.value === l._id)) list.push({ value: l._id, label: l.name, description: "" });
    return list;
  }, [people.data, b.leads]);
  const dirty = leads.join(",") !== b.leads.map((l) => l._id).join(",") || organisation.trim() !== b.organisation;

  if (!data.canManage) {
    return (
      <p className="text-sm">
        <span className="font-medium">Lead{b.leads.length === 1 ? "" : "s"}:</span> {b.leads.length ? b.leads.map((l) => l.name).join(", ") : <span className="text-muted-foreground">none</span>}
      </p>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] sm:items-end">
      <div className="space-y-1.5">
        <Label htmlFor="brand-leads">Lead(s)</Label>
        <MultiSelect id="brand-leads" options={options} value={leads} onValueChange={(v) => setLeads(v.slice(0, 5))} placeholder="Pick the lead(s)…" max={5} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="brand-org">Organisation</Label>
        <Input id="brand-org" value={organisation} maxLength={80} onChange={(e) => setOrganisation(e.target.value)} placeholder="e.g. Ajmal" />
      </div>
      <Button type="button" disabled={!dirty || patch.isPending} onClick={() => patch.mutate({ id: b._id, leads, organisation: organisation.trim() })}>
        {patch.isPending && <LuLoaderCircle aria-hidden className="animate-spin" />}
        Save
      </Button>
      <div className="flex items-start gap-2.5 sm:col-span-3">
        <Switch
          id="brand-retainer"
          checked={Boolean(b.monthlyRetainer)}
          disabled={patch.isPending}
          onCheckedChange={(checked) => patch.mutate({ id: b._id, monthlyRetainer: checked })}
        />
        <div className="space-y-0.5">
          <Label htmlFor="brand-retainer">Monthly retainer</Label>
          <p className="text-xs text-muted-foreground">
            On the 1st of each month the brand gets that month&apos;s project automatically: last month&apos;s project name
            with the new month, the brand&apos;s scope and the team from the new month&apos;s manpower plan.
          </p>
        </div>
      </div>
    </div>
  );
}

export function BrandPage({ id, month, onMonth }: { id: string; month: string; onMonth: (month: string) => void }) {
  const detail = useBrandDetail(id, month);
  // "Add scope" links from the Overview land on the scope section once the brand has loaded.
  const loaded = Boolean(detail.data);
  useEffect(() => {
    if (loaded && window.location.hash === "#scope") document.getElementById("scope")?.scrollIntoView({ behavior: "smooth" });
  }, [loaded]);
  const data = detail.data && detail.data.brand._id === id ? detail.data : undefined;
  const edits = usePlanEdits(month, Boolean(data?.canEditPlan));
  const removeFile = useDeleteBrandFile();
  const [splitting, setSplitting] = useState(false);
  const toast = useToast();

  if (detail.error && !data) {
    const notFound = (detail.error as { response?: { status?: number } })?.response?.status === 404;
    return notFound ? (
      <EmptyState icon={LuTags} title="Brand not found" description={<Link to="/brands" className="text-primary hover:underline">Back to Brands</Link>} />
    ) : (
      <QueryError title="Couldn't load the brand" error={detail.error} onRetry={() => void detail.refetch()} />
    );
  }
  if (!data) return <Skeleton className="h-[32rem] w-full" />;
  const b = data.brand;
  const max = data.max;
  const onBrand = new Set(Object.values(b.roles).flatMap((l) => l.map((p) => p._id)));
  const brandsOf = (pid: string) => (data.people[pid]?.brands ?? 0) + edits.brandDelta(pid, (brand) => brand === b._id && onBrand.has(pid));
  const nameOf = (pid: string) => data.people[pid]?.name ?? b.leads.find((l) => l._id === pid)?.name ?? "Unknown";
  const need = neededRoles(b.scopeItems);
  const cell = (role: string, label: string, needed: boolean) => {
    const current = (b.roles[role] ?? []).map((p) => p._id);
    const people = edits.get(b._id, role, current);
    return (
      <AllocCell
        label={`${label} for ${b.name}`}
        people={people}
        nameOf={nameOf}
        options={poolOptions(data, role, brandsOf)}
        tone={cellTone(people, needed && !b.notNeeded.includes(role), brandsOf, max)}
        editable={data.canEditPlan}
        edited={edits.isEdited(b._id, role)}
        brandsOf={brandsOf}
        onChange={(ids) => edits.set(b._id, role, current, ids)}
      />
    );
  };
  const roleLabel = new Map(data.roles.map((r) => [r.key, r.label]));

  return (
    <div className="space-y-4">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm">
        <Button variant="outline" size="sm" className="mr-2" render={<Link to={`/brands${month ? `?month=${month}` : ""}`} />}>
          <LuArrowLeft aria-hidden /> Back to Brands
        </Button>
        <Link to={`/brands${month ? `?month=${month}` : ""}`} className="text-primary hover:underline">Brands</Link>
        {b.organisation && b.organisation.trim().toLowerCase() !== b.name.trim().toLowerCase() && (
          <>
            <span className="mx-1.5 text-muted-foreground">›</span>
            <span className="text-muted-foreground">{b.organisation}</span>
          </>
        )}
        <span className="mx-1.5 text-muted-foreground">›</span>
        <span>{b.organisation ? shortName(b.name, b.organisation) : b.name}</span>
      </nav>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-heading text-3xl font-semibold tracking-tight">
            {b.organisation ? shortName(b.name, b.organisation) : b.name}
            {b.status === "pending" && <Badge variant="outline" className="ml-2 align-middle">waiting for approval</Badge>}
            {b.isPitch && <Badge variant="secondary" className="ml-2 align-middle">Pitch</Badge>}
            {b.monthlyRetainer && <Badge variant="outline" className="ml-2 align-middle">Monthly retainer</Badge>}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {b.organisation && <span className="mr-2 font-medium text-foreground">{b.organisation}</span>}
            {b.projectCount} open project{b.projectCount === 1 ? "" : "s"} · {b.current.length} current in {monthLabel(month)}
          </p>
          <div className="mt-2 flex flex-wrap gap-3 text-xs">
            {([["scope", "Scope"], ["docs", "Documents"], ["plan", "Manpower plan"], ["lead", "Lead"]] as const).map(([k, l]) => (
              <span key={k} className="inline-flex items-center gap-1.5"><StatusDot ok={b.checks[k]} /> {l}</span>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <MonthPicker month={month} onChange={onMonth} />
          {data.canCreate && b.status !== "pending" && (
            <Button type="button" variant="outline" onClick={() => setSplitting((s) => !s)} aria-expanded={splitting}>
              <LuScissors aria-hidden /> Split brand
            </Button>
          )}
        </div>
      </header>

      {splitting && <SplitPanel data={data} onClose={() => setSplitting(false)} />}

      <div id="scope" className="scroll-mt-4" />
      <Section title="Scope → who delivers it">
        {b.scopeItems.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="py-1.5 pr-2 font-medium">Unit</th>
                  <th className="py-1.5 pr-2 font-medium">What</th>
                  <th className="py-1.5 pr-2 font-medium">Qty</th>
                  <th className="py-1.5 pr-2 font-medium">Role</th>
                  <th className="py-1.5 font-medium">Person</th>
                </tr>
              </thead>
              <tbody>
                {b.scopeItems.map((r, i) => {
                  const role = UNIT_ROLE[r.unit] ?? "socialMedia";
                  const label = roleLabel.get(role) ?? role;
                  return (
                    <tr key={i} className="border-b last:border-0">
                      <td className="py-1.5 pr-2">{r.unit}</td>
                      <td className="py-1.5 pr-2">{r.what || "—"}</td>
                      <td className="py-1.5 pr-2 tabular-nums">{r.quantity}{r.languageList.length > 1 ? ` × ${r.languageList.length} lang.` : ""}</td>
                      <td className="py-1.5 pr-2">{label}</td>
                      <td className="py-1">{cell(role, label, true)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">No scope yet — flagged, not blocked. Projects keep their own scope until one is added.</p>
        )}
        {data.canManage && <ScopeUpload brandId={b._id} onDone={() => void detail.refetch()} />}
        <h3 className="mt-4 mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">Documents</h3>
        {b.files.length ? (
          <ul className="space-y-1">
            {b.files.map((f) => (
              <li key={f._id} className="flex flex-wrap items-center gap-2 text-sm">
                <LuPaperclip aria-hidden className="size-3.5 text-muted-foreground" />
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => void downloadFromApi(`/brands/${b._id}/files/${f._id}`, {}, f.filename).catch((e) => toast.error(getErrorMessage(e)))}
                >
                  {f.filename}
                </button>
                <span className="text-xs text-muted-foreground">{Math.max(1, Math.round(f.size / 1024))} KB</span>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Download ${f.filename}`} onClick={() => void downloadFromApi(`/brands/${b._id}/files/${f._id}`, {}, f.filename).catch((e) => toast.error(getErrorMessage(e)))}>
                  <LuDownload aria-hidden />
                </Button>
                {data.canManage && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${f.filename}`}
                    disabled={removeFile.isPending}
                    onClick={() => window.confirm(`Remove ${f.filename} from ${b.name}? Copies already on its projects stay.`) && removeFile.mutate({ id: b._id, fileId: f._id })}
                  >
                    <LuTrash2 aria-hidden />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-1.5 text-sm">
            <StatusDot ok={false} /> none on the brand
            {b.projectFiles > 0 && <span className="text-xs text-muted-foreground">({b.projectFiles} on its projects)</span>}
          </p>
        )}
        {b.scopeNotes.length > 0 && (
          <ul className="mt-3 list-disc pl-5 text-xs text-muted-foreground">{b.scopeNotes.map((n) => <li key={n}>{n}</li>)}</ul>
        )}
      </Section>

      <Section
        title={`Team · Manpower plan ${monthLabel(month)}${data.planVersion ? ` · version ${data.planVersion} (latest)` : " · no plan yet"}`}
        actions={<CellLegend max={max} />}
      >
        <p className="mb-2 text-xs text-muted-foreground">
          {b.planLines.length
            ? `Plan lines: ${b.planLines.map((l) => l.name).join(" · ")} — the same data as the Manpower plan.`
            : data.canEditPlan
              ? `Not in the ${monthLabel(month)} plan — pick people below to add a line.`
              : `Not in the ${monthLabel(month)} plan.`}
        </p>
        <div className="overflow-x-auto">
          <table className="text-sm">
            <tbody>
              {data.roles.map((r) => (
                <tr key={r.key} className="border-b last:border-0">
                  <td className="w-56 py-1 pr-3">{r.label}</td>
                  <td className="py-1">{cell(r.key, r.label, need.has(r.key))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <SaveBar
          count={edits.count}
          ready={edits.ready}
          saving={edits.save.isPending}
          onReset={edits.reset}
          onSave={() =>
            edits.submit(new Map([[b._id, { name: b.name, isPitch: b.isPitch }]]), `Brand ${b.name}: ${edits.count} team change${edits.count === 1 ? "" : "s"}`, () => void detail.refetch())
          }
        />
        <div className="mt-4">
          <LeadsEditor data={data} />
        </div>
      </Section>

      {data.utilisation && (
        <Section title={`Utilisation · ${monthLabel(month)}`}>
          {data.utilisation.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nobody on this brand in {monthLabel(month)} yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b text-left">
                    <th className="py-1.5 pr-2 font-medium">Person</th>
                    <th className="py-1.5 pr-2 font-medium">Role(s) on {b.name}</th>
                    <th className="py-1.5 pr-2 font-medium">Projects this month (max {max})</th>
                    <th className="py-1.5 pr-2 font-medium">Brands</th>
                    <th className="py-1.5 pr-2 text-right font-medium">Hours logged</th>
                  </tr>
                </thead>
                <tbody>
                  {data.utilisation.map((u) => (
                    <tr key={u.user._id} className="border-b last:border-0">
                      <td className="py-1.5 pr-2 font-medium">{u.user.name}</td>
                      <td className="py-1.5 pr-2 text-xs">{u.roles.map((r) => roleLabel.get(r) ?? (r === "others" ? "Others" : r)).join(", ")}</td>
                      <td className="py-1.5 pr-2"><UtilisationBar value={u.projects} max={u.max} /></td>
                      <td className={cn("py-1.5 pr-2 tabular-nums", u.brands > max && "font-semibold text-amber-700 dark:text-amber-400")}>{u.brands}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">
                        {u.hours} h <span className="text-xs text-muted-foreground">({u.brandHours} h on {b.name})</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted-foreground">Projects: the month's projects each person is on (green; amber at {max - 1}+; red above {max}). Hours: approved + pending time logs this month.</p>
            </div>
          )}
        </Section>
      )}

      <Section title="Current projects">
        {b.current.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="py-1.5 pr-2 font-medium">Project</th>
                  <th className="py-1.5 pr-2 font-medium">Dates</th>
                  <th className="py-1.5 pr-2 font-medium">Scope</th>
                  <th className="py-1.5 font-medium">Plan line</th>
                </tr>
              </thead>
              <tbody>
                {b.current.map((p) => (
                  <tr key={p._id} className="border-b last:border-0">
                    <td className="py-1.5 pr-2"><Link to={`/projects/${p._id}`} className="break-all hover:underline">{p.name}</Link></td>
                    <td className="py-1.5 pr-2 text-xs whitespace-nowrap">{formatDate(p.startDate)} → {formatDate(p.deadline)}</td>
                    <td className="py-1.5 pr-2 text-xs">{p.scope || "—"}</td>
                    <td className="py-1.5 text-xs">{p.planLine ? p.planLine.name : <span className="inline-flex items-center gap-1"><StatusDot ok={false} /> not linked</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">None in {monthLabel(month)}.</p>
        )}
      </Section>
      {extractHint}
    </div>
  );
}

const extractHint = (
  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
    <LuSparkles aria-hidden className="size-3.5" /> Scope files are read automatically (Word and Excel without AI; PDFs and images need the AI reader).
  </p>
);
