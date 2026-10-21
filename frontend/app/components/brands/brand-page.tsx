import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { LuArrowLeft, LuArrowRightLeft, LuCircleX, LuClock, LuDownload, LuExternalLink, LuLoaderCircle, LuPaperclip, LuPencil, LuPlus, LuScissors, LuSparkles, LuTags, LuTrash2, LuUndo2, LuX } from "react-icons/lu";

import { AllocCell, CellLegend, cellTone, PendingPlanBanner, planVersionText, SaveBar, StatusDot, teamCell, useNameOf, usePlanEdits } from "@/components/brands/alloc-cell";
import { monthLabel, MonthPicker, poolOptions, shortName } from "@/components/brands/brands-dashboard";
import { MatchBadge, OtherScopeChange, OtherScopeField, OtherScopeText, ScopeDiffView, ScopeMatchBox, ScopeTotalCheck, ScopeTotalField } from "@/components/brands/scope-compare";
import { MultiSelect } from "@/components/globals/multi-select";
import { EmptyState, QueryError } from "@/components/globals/query-states";
import { FieldError, OptionSelect } from "@/components/projects/project-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useBrandDetail, useDeleteBrandFile, useMovePreview, useMoveProjects, usePatchBrand, useRenameBrand, useSplitBrand, useUploadBrandFiles } from "@/hooks/use-brand-dashboard";
import { useBrandScopeVersions, useScopeMatch } from "@/hooks/use-brand-scope";
import { useBrands, useExtractBrandScope } from "@/hooks/use-brands";
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from "@/components/ui/combobox";
import { useAssignableUsers } from "@/hooks/use-task-meta";
import { useDismissChange, useWithdrawChange } from "@/hooks/use-project-approval";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api";
import { neededRoles, UNIT_ROLE } from "@/lib/brand-roles";
import { PlanLeads } from "@/components/brands/plan-leads";
import { downloadFromApi } from "@/lib/download";
import { formatDate, formatTimeOfDay } from "@/lib/format";
import { SCOPE_LANGUAGES, SCOPE_UNITS } from "@/lib/scope";
import { diffScope } from "@/lib/scope-diff";
import { cn } from "@/lib/utils";
import type { BrandDetailResponse, BrandMoveItem, BrandScopeItem, BrandScopeRequest, BrandScopeVersion, ScopeExtraction, StatedTotal } from "@/types";

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

/**
 * Scope upload → read → review → save, or edit the current rows by hand (brand scope; leadership
 * applies, others send for approval) + attach the files. Before saving: what changes against the
 * current version, and how close the rows are to the agreement (advice only). The "Other scope"
 * text (not itemised as rows) is read / edited and saved with the rows.
 */
/** A scope change request opened in the editor to fix and send again (waiting or rejected). */
export interface ScopeResend {
  requestId: string;
  status: "pending" | "rejected";
  rows: ScopeRow[];
  text: string;
  total: StatedTotal | null;
  /** Changes on every "Edit and resend" click, so the editor is filled again. */
  nonce: number;
}

const toScopeRow = (r: BrandScopeItem): ScopeRow => ({
  unit: r.unit,
  what: r.what ?? "",
  quantity: r.quantity,
  languageList: [...(r.languageList?.length ? r.languageList : ["English"])],
  sizes: r.sizes,
  source: r.source ?? "",
});

function ScopeUpload({
  brandId,
  current,
  currentText,
  currentTotal,
  resend,
  onCancelResend,
  onDone,
}: {
  brandId: string;
  current: ScopeRow[];
  currentText: string;
  currentTotal: StatedTotal | null;
  /** "Edit and resend": the editor starts from that request's proposal (not the current scope). */
  resend: ScopeResend | null;
  onCancelResend: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const extract = useExtractBrandScope();
  const patch = usePatchBrand();
  const upload = useUploadBrandFiles();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  // Scope pasted / typed as text (read the same way as a file).
  const [text, setText] = useState("");
  const [usedText, setUsedText] = useState(false);
  const [rows, setRows] = useState<ScopeRow[] | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [otherScope, setOtherScope] = useState("");
  // The read result of the new files: the agreement the rows are compared with (else the brand's).
  const [extraction, setExtraction] = useState<ScopeExtraction | null>(null);
  // The agreement's stated total ("96 content pieces per month"): the rows are checked against it.
  const [total, setTotal] = useState<StatedTotal | null>(null);
  const editor = useRef<HTMLDivElement>(null);
  // "Edit and resend": fill the editor with the request's proposal.
  useEffect(() => {
    if (!resend) return;
    setFiles([]);
    setText("");
    setUsedText(false);
    setExtraction(null);
    setNotes([]);
    setRows(resend.rows.map((r) => ({ ...r, languageList: [...r.languageList] })));
    setOtherScope(resend.text);
    setTotal(resend.total);
    requestAnimationFrame(() => editor.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [resend?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  const setRow = (i: number, p: Partial<ScopeRow>) => setRows((list) => list!.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const diff = useMemo(() => (rows ? diffScope(current, rows) : null), [rows, current]);
  const match = useScopeMatch({ rows: rows ?? [], extraction, brandId: extraction ? null : brandId, otherScope, enabled: Boolean(rows) });
  const textChanged = rows !== null && otherScope.replace(/\s+/g, " ").trim() !== currentText.replace(/\s+/g, " ").trim();

  function read(list: File[], typed = "") {
    setFiles(list);
    setUsedText(Boolean(typed.trim()));
    setRows(null);
    setExtraction(null);
    extract.mutate(
      { files: list, text: typed },
      {
        onSuccess: (data) => {
          setRows(data.scope.map((r) => ({ ...r })));
          setNotes(data.notes);
          setOtherScope(data.otherScope ?? "");
          setTotal(data.statedTotal ?? null);
          setExtraction(data);
        },
      },
    );
  }

  function editCurrent() {
    setFiles([]);
    setExtraction(null);
    setNotes([]);
    setOtherScope(currentText);
    setTotal(currentTotal);
    setRows(current.map((r) => ({ ...r, languageList: [...r.languageList] })));
  }

  function reset() {
    setRows(null);
    setFiles([]);
    setUsedText(false);
    setExtraction(null);
    setOtherScope("");
    setTotal(null);
    setNotes([]);
    if (resend) onCancelResend();
  }

  async function save() {
    if (!rows?.length) return;
    try {
      // Files first, so the new scope version lists them.
      if (files.length) await upload.mutateAsync({ id: brandId, files });
      await patch.mutateAsync({
        id: brandId,
        scopeItems: rows.map((r) => ({ unit: r.unit, quantity: r.quantity, languages: Math.max(1, r.languageList.length), languageList: r.languageList, sizes: r.sizes, what: r.what, source: r.source })),
        scopeText: otherScope.trim(),
        scopeTotal: total,
        scopeSource: files.length || usedText ? "upload" : "edit",
        ...(extraction ? { agreement: { scope: extraction.scope, texts: extraction.texts.map((t) => ({ source: t.source, text: t.text })) } } : {}),
      });
      setFiles([]);
      setText("");
      setUsedText(false);
      setRows(null);
      setNotes([]);
      setExtraction(null);
      setTotal(null);
      if (resend) onCancelResend();
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
        {(current.length > 0 || currentText.trim() !== "") && !rows && (
          <Button type="button" variant="ghost" size="sm" className="ml-1" disabled={busy} onClick={editCurrent}>
            <LuPencil aria-hidden /> Edit scope
          </Button>
        )}
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
        <div className="mt-3 space-y-1.5 text-left">
          <Label htmlFor={`scope-text-${brandId}`} className="text-xs text-muted-foreground">
            …or paste the scope as text (e.g. from an email: “8 static posts, 10 reels in English and Arabic”)
          </Label>
          <Textarea
            id={`scope-text-${brandId}`}
            value={text}
            maxLength={20000}
            rows={3}
            placeholder="Paste or type the scope…"
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex justify-end">
            <Button type="button" variant="outline" size="sm" disabled={busy || !text.trim()} onClick={() => read([], text)}>
              {extract.isPending && usedText ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuSparkles aria-hidden />} Read the text
            </Button>
          </div>
        </div>
        {extract.isError && <FieldError>{getErrorMessage(extract.error)}</FieldError>}
      </div>
      {rows && (
        <div ref={editor} className="scroll-mt-4 space-y-2">
          <p className="text-sm font-medium">
            {files.length
              ? "Scope read from the files — check and edit"
              : usedText
                ? "Scope read from the text — check and edit"
                : resend
                  ? resend.status === "pending"
                    ? "Edit the scope change waiting for approval — resending replaces it"
                    : "Fix the rejected scope change and send it again"
                  : "Edit the scope rows"}
          </p>
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
          <ScopeTotalField id={`scope-total-${brandId}`} value={total} onChange={setTotal} />
          <ScopeTotalCheck total={total} rows={rows} />
          {notes.length > 0 && <ul className="list-disc pl-5 text-xs text-amber-800 dark:text-amber-300">{notes.map((n) => <li key={n}>{n}</li>)}</ul>}
          <OtherScopeField id={`other-scope-${brandId}`} value={otherScope} onChange={setOtherScope} />
          <ScopeMatchBox
            match={match.data?.match}
            loading={match.isFetching}
            note={match.data && !match.data.match ? match.data.reason : match.isError ? "Couldn't compare with the agreement right now." : null}
          />
          {diff && (
            <div className="rounded-lg border p-3">
              <ScopeDiffView diff={diff} title="What will change against the current version" emptyText={textChanged ? "No row changes against the current version." : "No change against the current version."} />
              {textChanged && <OtherScopeChange className="mt-2" from={currentText} to={otherScope} />}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setRows([...rows, { unit: "Static", what: "", quantity: 1, languageList: ["English"], sizes: 1, source: "typed" }])}>
              <LuPlus aria-hidden /> Add row
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={reset} disabled={busy}>Cancel</Button>
              <Button type="button" size="sm" onClick={() => void save()} disabled={busy || rows.length === 0}>
                {(patch.isPending || upload.isPending) && <LuLoaderCircle aria-hidden className="animate-spin" />}
                {resend ? "Resend for approval" : "Save scope"}
                {files.length ? ` & attach ${files.length} file${files.length === 1 ? "" : "s"}` : ""}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Leadership's changes apply at once; anyone else's scope change goes to leadership for approval. The files are attached to the brand straight away.</p>
        </div>
      )}
    </div>
  );
}

/** "20 Oct 2026, 4:30 PM". */
const when = (value: string | null | undefined) => (value ? `${formatDate(value)}, ${formatTimeOfDay(value)}` : "");

/** The proposed rows of a scope request, compact and read-only. */
function ProposedRows({ rows }: { rows: BrandScopeItem[] }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">No scope rows proposed.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[28rem] text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b text-left">
            <th className="py-1 pr-2 font-medium">Unit</th>
            <th className="py-1 pr-2 font-medium">What</th>
            <th className="py-1 pr-2 font-medium">Qty</th>
            <th className="py-1 font-medium">Languages</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b last:border-0">
              <td className="py-1 pr-2">{r.unit}</td>
              <td className="py-1 pr-2">{r.what || "—"}</td>
              <td className="py-1 pr-2 tabular-nums">{r.quantity}</td>
              <td className="py-1 text-xs text-muted-foreground">{(r.languageList ?? []).join(", ") || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** What a scope request proposes: rows, the agreement total check and the Other scope sections. */
function ProposedScope({ request }: { request: BrandScopeRequest }) {
  return (
    <div className="mt-3 space-y-2">
      <p className="flex items-center gap-2 text-sm font-medium">
        <Badge variant="outline">Proposed</Badge> Scope rows{request.rowsChanged ? "" : " (unchanged)"}
      </p>
      <ProposedRows rows={request.scopeItems} />
      <ScopeTotalCheck total={request.scopeTotal} rows={request.scopeItems} />
      {request.textChanged && (
        <OtherScopeText
          text={request.scopeText}
          title={
            <span className="flex items-center gap-2">
              <Badge variant="outline">Proposed</Badge> Other scope (not itemised)
            </span>
          }
        />
      )}
      {request.textChanged && !request.scopeText.trim() && <p className="text-sm text-muted-foreground">Proposed: no Other scope.</p>}
    </div>
  );
}

/** A scope change waiting for approval: who sent it, view / edit and resend / withdraw, and what it proposes. */
function PendingScopeBanner({ request, onEdit }: { request: NonNullable<BrandDetailResponse["pendingScope"]>; onEdit: () => void }) {
  const withdraw = useWithdrawChange();
  return (
    <div className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="flex items-center gap-2 text-sm text-amber-900 dark:text-amber-200">
          <LuClock aria-hidden className="size-4 shrink-0" />
          <span>
            <span className="font-semibold">Scope change waiting for approval</span> — sent by {request.requestedBy?.name ?? "someone"} on {when(request.createdAt)}
          </span>
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" render={<Link to={`/approvals/${request._id}`} />}>
            <LuExternalLink aria-hidden /> View request
          </Button>
          {request.canEdit && (
            <Button type="button" variant="outline" size="sm" onClick={onEdit}>
              <LuPencil aria-hidden /> Edit and resend
            </Button>
          )}
          {request.canWithdraw && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={withdraw.isPending}
              onClick={() => window.confirm("Withdraw this scope change? Leadership won't see it any more; nothing changes on the brand.") && withdraw.mutate(request._id)}
            >
              {withdraw.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuUndo2 aria-hidden />} Withdraw
            </Button>
          )}
        </div>
      </div>
      <ProposedScope request={request} />
    </div>
  );
}

/** The last scope change was rejected: by whom, why; edit and resend, or dismiss. */
function RejectedScopeBanner({ request, onEdit }: { request: NonNullable<BrandDetailResponse["lastRejectedScope"]>; onEdit: () => void }) {
  const dismiss = useDismissChange();
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="flex items-center gap-2 text-sm text-destructive">
          <LuCircleX aria-hidden className="size-4 shrink-0" />
          <span>
            <span className="font-semibold">Scope change rejected</span> by {request.decidedBy?.name ?? "leadership"} on {when(request.decidedAt)}
            {request.reason ? ` — reason: ${request.reason}` : ""}
          </span>
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? "Hide proposal" : "Show proposal"}
          </Button>
          <Button variant="outline" size="sm" render={<Link to={`/approvals/${request._id}`} />}>
            <LuExternalLink aria-hidden /> View request
          </Button>
          {request.canEdit && (
            <Button type="button" variant="outline" size="sm" onClick={onEdit}>
              <LuPencil aria-hidden /> Edit and resend
            </Button>
          )}
          {request.canDismiss && (
            <Button type="button" variant="ghost" size="sm" disabled={dismiss.isPending} onClick={() => dismiss.mutate(request._id)}>
              <LuX aria-hidden /> Dismiss
            </Button>
          )}
        </div>
      </div>
      {open && <ProposedScope request={request} />}
    </div>
  );
}

const SOURCE_LABEL: Record<BrandScopeVersion["source"], string> = { create: "Created", upload: "Uploaded", edit: "Edited", approval: "Approved change" };

/** The brand's scope history: what changed in the latest version, and every older version's diff. */
function ScopeHistory({ brandId }: { brandId: string }) {
  const versions = useBrandScopeVersions(brandId);
  const [open, setOpen] = useState<number | null>(null);
  const list = versions.data ?? [];
  if (versions.isPending) return <Skeleton className="mt-3 h-10 w-full" />;
  if (!list.length) return null;
  const latest = list[0]!;
  const who = (v: BrandScopeVersion) =>
    `${SOURCE_LABEL[v.source]}${v.by ? ` by ${v.by.name}` : ""}${v.approvedBy ? `, approved by ${v.approvedBy.name}` : ""} · ${formatDate(v.at)}`;
  return (
    <div className="mt-3 space-y-2">
      {list.length > 1 && (
        <div className="rounded-lg border p-3">
          <ScopeDiffView diff={latest.diff} title={`Changed since the last version (v${latest.version - 1} → v${latest.version})`} emptyText="No row changes in the latest version." />
          {latest.textDiff && <OtherScopeChange className="mt-2" from={latest.textDiff.from} to={latest.textDiff.to} />}
          <p className="mt-1 text-xs text-muted-foreground">{who(latest)}</p>
        </div>
      )}
      <details className="rounded-lg border">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Version history ({list.length})</summary>
        <ul className="divide-y border-t text-sm">
          {list.map((v) => (
            <li key={v.version} className="px-3 py-2">
              <button type="button" className="flex w-full flex-wrap items-center justify-between gap-2 text-left" aria-expanded={open === v.version} onClick={() => setOpen(open === v.version ? null : v.version)}>
                <span>
                  <span className="font-medium">Version {v.version}</span>
                  {v === latest && <Badge variant="secondary" className="ml-2">current</Badge>}
                  <span className="ml-2 text-xs text-muted-foreground">{who(v)}</span>
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {v.scopeMatch && <MatchBadge score={v.scopeMatch.score} />}
                  {v.items.length} row{v.items.length === 1 ? "" : "s"}
                  {v.diff.added.length + v.diff.removed.length + v.diff.changed.length > 0 && (
                    <span>
                      · <span className="text-emerald-700 dark:text-emerald-400">+{v.diff.added.length}</span> <span className="text-red-700 dark:text-red-400">−{v.diff.removed.length}</span>{" "}
                      <span className="text-amber-700 dark:text-amber-400">~{v.diff.changed.length}</span>
                    </span>
                  )}
                  {v.textDiff && v.version > 1 && <span>· other scope changed</span>}
                </span>
              </button>
              {open === v.version && (
                <div className="mt-2 space-y-2">
                  <ScopeDiffView diff={v.diff} title={v.version === 1 ? "First version" : `Against version ${v.version - 1}`} emptyText="Same rows as the version before." />
                  {v.textDiff && v.version > 1 && <OtherScopeChange from={v.textDiff.from} to={v.textDiff.to} />}
                  {v.version === 1 && <OtherScopeText text={v.scopeText} />}
                  {v.files.length > 0 && <p className="text-xs text-muted-foreground">Documents: {v.files.join(", ")}</p>}
                </div>
              )}
            </li>
          ))}
        </ul>
      </details>
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
  // A brand keeps at least one lead (new projects need one); the server refuses clearing them too.
  const clearsLeads = leads.length === 0 && b.leads.length > 0;

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
        {clearsLeads && <p className="text-xs text-destructive">A brand needs at least one lead.</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="brand-org">Organisation</Label>
        <Input id="brand-org" value={organisation} maxLength={80} onChange={(e) => setOrganisation(e.target.value)} placeholder="e.g. Ajmal" />
      </div>
      <Button type="button" disabled={!dirty || clearsLeads || patch.isPending} onClick={() => patch.mutate({ id: b._id, leads, organisation: organisation.trim() })}>
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

/** Inline rename (brand header; admins only, applied at once): name, short name, and whether the projects' names follow. */
function RenameBar({ data, onClose }: { data: BrandDetailResponse; onClose: () => void }) {
  const b = data.brand;
  const rename = useRenameBrand();
  const [name, setName] = useState(b.name);
  const [short, setShort] = useState(b.shortName ?? "");
  const [renameProjects, setRenameProjects] = useState(true);
  const [tried, setTried] = useState(false);
  const trimmed = name.trim().replace(/\s+/g, " ");
  const nameError = !trimmed ? "Enter the brand's name" : trimmed.length > 80 ? "Max 80 characters" : trimmed.includes("_") ? "Brand names can't contain “_”" : null;
  const shortError = short.trim().length > 20 ? "Max 20 characters" : null;
  const unchanged = trimmed === b.name && short.trim() === (b.shortName ?? "");
  // A structured name starts with the brand: "Brand_Type_MonYYYY_Title".
  const structured = b.projects.filter((p) => p.name.toLowerCase().startsWith(`${b.name.toLowerCase()}_`));
  const example = structured[0];

  function save() {
    setTried(true);
    if (nameError || shortError || unchanged) return;
    rename.mutate({ id: b._id, name: trimmed, shortName: short.trim(), renameProjects }, { onSuccess: onClose });
  }

  return (
    <div className="mt-2 w-full max-w-2xl space-y-2 rounded-lg border bg-muted/30 p-3" role="group" aria-label="Rename brand">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-1">
          <Label htmlFor="brand-rename">Brand name</Label>
          <Input
            id="brand-rename"
            value={name}
            maxLength={80}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") onClose();
            }}
            aria-invalid={(tried && Boolean(nameError)) || undefined}
          />
          {tried && nameError && <FieldError>{nameError}</FieldError>}
        </div>
        <div className="space-y-1">
          <Label htmlFor="brand-rename-short">Short name <span className="font-normal text-muted-foreground">(optional)</span></Label>
          <Input id="brand-rename-short" value={short} maxLength={20} onChange={(e) => setShort(e.target.value)} placeholder="e.g. EMR" />
          {shortError && <FieldError>{shortError}</FieldError>}
        </div>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={renameProjects} onChange={(e) => setRenameProjects(e.target.checked)} />
        <span>
          Also rename its projects
          <span className="block text-xs text-muted-foreground">
            {structured.length
              ? `${structured.length} open project${structured.length === 1 ? "" : "s"} named ${b.name}_…${example && trimmed && !nameError ? ` — e.g. ${example.name} → ${trimmed}${example.name.slice(b.name.length)}` : ""}. Codes stay; free-form names are left alone.`
              : "Projects named Brand_Type_Month_Name get the new brand name; codes stay."}{" "}
            Manpower plan lines of the brand always take the new name.
          </span>
        </span>
      </label>
      {rename.isError && <FieldError>{getErrorMessage(rename.error)}</FieldError>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={rename.isPending}>Cancel</Button>
        <Button type="button" size="sm" onClick={save} disabled={rename.isPending || unchanged}>
          {rename.isPending && <LuLoaderCircle aria-hidden className="animate-spin" />}
          Save
        </Button>
      </div>
    </div>
  );
}

const LINE_ACTION: Record<BrandMoveItem["line"]["action"], (l: BrandMoveItem["line"]) => string> = {
  relink: (l) => `joins ${l.name}`,
  move: (l) => `${l.from} moves with it${l.name !== l.from ? ` (as ${l.name})` : ""}`,
  new: (l) => `new line ${l.name}`,
  none: () => "no plan for its month",
};

/** Inline "Move to another brand…" bar for the ticked projects: target picker, per-project preview, Move. */
function MoveBar({ data, picked, onDone, onCancel }: { data: BrandDetailResponse; picked: string[]; onDone: () => void; onCancel: () => void }) {
  const b = data.brand;
  const toast = useToast();
  const brands = useBrands(true);
  const [target, setTarget] = useState<string | null>(null);
  const preview = useMovePreview(b._id, picked, target);
  const move = useMoveProjects();
  const options = useMemo(
    () =>
      (brands.data ?? [])
        .filter((x) => x._id !== b._id && x.active && (x.status ?? "approved") === "approved")
        .map((x) => ({ value: x._id, label: x.name })),
    [brands.data, b._id],
  );

  function submit() {
    if (!target) return;
    move.mutate(
      { id: b._id, projectIds: picked, targetBrandId: target },
      {
        onSuccess: (res) => {
          if (res.pendingApproval) toast.success(res.pendingApproval);
          else toast.success(`${res.moved ?? 0} project${res.moved === 1 ? "" : "s"} moved${res.plans?.length ? ` — plan ${res.plans.map((p) => `${p.month} v${p.version}`).join(", ")}` : ""}.`);
          if (res.errors?.length) toast.error(res.errors.join(" "));
          onDone();
        },
      },
    );
  }

  const p = preview.data;
  return (
    <div className="mb-3 space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3" role="group" aria-label="Move projects to another brand">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-56 flex-1 space-y-1">
          <Label htmlFor="move-target">Move {picked.length} project{picked.length === 1 ? "" : "s"} to</Label>
          <Combobox
            items={options}
            value={options.find((o) => o.value === target) ?? null}
            onValueChange={(item: { value: string; label: string } | null) => setTarget(item?.value ?? null)}
            disabled={brands.isPending}
            autoHighlight
          >
            <ComboboxInput id="move-target" placeholder={brands.isPending ? "Loading brands…" : "Search brands…"} className="w-full" />
            <ComboboxContent sideOffset={4}>
              <ComboboxEmpty>No brands found.</ComboboxEmpty>
              <ComboboxList>
                {(item: { value: string; label: string }) => (
                  <ComboboxItem key={item.value} value={item}>
                    {item.label}
                  </ComboboxItem>
                )}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={move.isPending}>Cancel</Button>
        <Button type="button" size="sm" onClick={submit} disabled={!target || !p || move.isPending || preview.isFetching}>
          {move.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuArrowRightLeft aria-hidden />}
          {p && !p.applies ? "Send move for approval" : "Move"}
        </Button>
      </div>
      {!target ? (
        <p className="text-xs text-muted-foreground">Pick the brand. Names follow the new brand (codes stay), the manpower plan line follows, and the new brand&apos;s scope replaces the project&apos;s when it has one.</p>
      ) : preview.isPending || preview.isFetching ? (
        <Skeleton className="h-16 w-full" />
      ) : preview.isError ? (
        <FieldError>{getErrorMessage(preview.error)}</FieldError>
      ) : p ? (
        <div className="space-y-2">
          <p className="text-xs">
            Scope:{" "}
            {p.to.hasScope ? (
              <span className="font-medium">replaced by {p.to.name}&apos;s scope (its rows, other scope, platforms, notes and documents)</span>
            ) : (
              <span className="font-medium">kept — {p.to.name} has no scope</span>
            )}
            {!p.applies && <span className="text-muted-foreground"> · Leadership approves the move before anything changes.</span>}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="py-1 pr-2 font-medium">Project</th>
                  <th className="py-1 pr-2 font-medium">New name</th>
                  <th className="py-1 font-medium">Plan line</th>
                </tr>
              </thead>
              <tbody>
                {p.items.map((i) => (
                  <tr key={i.projectId} className="border-b align-top last:border-0">
                    <td className="py-1 pr-2"><span className="break-all">{i.oldName}</span> <span className="text-muted-foreground">{i.code}</span></td>
                    <td className="py-1 pr-2 break-all">{i.newName === i.oldName ? <span className="text-muted-foreground">unchanged (free-form name)</span> : i.newName}</td>
                    <td className="py-1">{LINE_ACTION[i.line.action](i.line)}{i.month ? <span className="text-muted-foreground"> · {monthLabel(i.month)}</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {p.notes.length > 0 && <ul className="list-disc pl-5 text-xs text-amber-800 dark:text-amber-300">{p.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
        </div>
      ) : null}
      {move.isError && <FieldError>{getErrorMessage(move.error)}</FieldError>}
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
  // A non-leader's edits start from the version waiting for approval (their earlier changes show and add up).
  const edits = usePlanEdits(month, Boolean(data?.canEditPlan), !data?.planSavesApproved ? (data?.pendingPlan?.version ?? null) : null);
  const leadName = useCallback((pid: string) => data?.brand.leads.find((l) => l._id === pid)?.name, [data]);
  const nameOf = useNameOf(data?.names, data?.people, leadName);
  const removeFile = useDeleteBrandFile();
  const [splitting, setSplitting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  // Projects list: the month's projects, or every open one; ticked ones can move to another brand.
  const [allProjects, setAllProjects] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [moving, setMoving] = useState(false);
  const toast = useToast();
  useEffect(() => {
    setPicked([]);
    setMoving(false);
    setRenaming(false);
  }, [id]);
  const togglePicked = (pid: string) => setPicked((list) => (list.includes(pid) ? list.filter((x) => x !== pid) : [...list, pid]));
  // "Edit and resend" of a waiting / rejected scope change: the editor opens with its proposal.
  const [resend, setResend] = useState<ScopeResend | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const startResend = (request: BrandScopeRequest, status: ScopeResend["status"]) =>
    setResend({ requestId: request._id, status, rows: request.scopeItems.map(toScopeRow), text: request.scopeText, total: request.scopeTotal, nonce: Date.now() });
  useEffect(() => setResend(null), [id]);
  // The request being edited was withdrawn, approved or replaced elsewhere: leave "resend" mode.
  const liveRequestIds = [detail.data?.pendingScope?._id, detail.data?.lastRejectedScope?._id];
  useEffect(() => {
    if (resend && detail.data && !liveRequestIds.includes(resend.requestId)) setResend(null);
  }, [resend, detail.data]); // eslint-disable-line react-hooks/exhaustive-deps
  // ?editScope=1 (the rejection notice, Approvals "Edit and resend"): open the editor once the brand has loaded.
  const editRequested = searchParams.get("editScope") === "1";
  useEffect(() => {
    if (!editRequested || !detail.data || detail.data.brand._id !== id) return;
    const pending = detail.data.pendingScope;
    const rejected = detail.data.lastRejectedScope;
    if (pending?.canEdit) startResend(pending, "pending");
    else if (rejected?.canEdit) startResend(rejected, "rejected");
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete("editScope");
        return next;
      },
      { replace: true },
    );
  }, [editRequested, detail.data, id]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const need = neededRoles(b.scopeItems);
  const notNeeded = b.pending?.notNeeded ?? b.notNeeded;
  const cell = (role: string, label: string, needed: boolean) => {
    // Shown (and edited from): the proposed people when a plan version waits for approval.
    const { current, approved, pending } = teamCell(b, role);
    const people = edits.get(b._id, role, current);
    return (
      <AllocCell
        label={`${label} for ${b.name}`}
        people={people}
        nameOf={nameOf}
        options={poolOptions(data, role, brandsOf)}
        tone={cellTone(people, needed && !notNeeded.includes(role), brandsOf, max)}
        editable={data.canEditPlan}
        edited={edits.isEdited(b._id, role)}
        pending={pending && !edits.isEdited(b._id, role)}
        approved={approved}
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
            {data.canRename && !renaming && (
              <Button type="button" variant="ghost" size="sm" className="ml-1 align-middle" onClick={() => setRenaming(true)} aria-label={`Rename ${b.name}`}>
                <LuPencil aria-hidden /> Rename
              </Button>
            )}
          </h1>
          {renaming && <RenameBar data={data} onClose={() => setRenaming(false)} />}
          <p className="mt-1 text-sm text-muted-foreground">
            {b.organisation && <span className="mr-2 font-medium text-foreground">{b.organisation}</span>}
            {b.projectCount} open project{b.projectCount === 1 ? "" : "s"} · {b.current.length} current in {monthLabel(month)}
          </p>
          <div className="mt-2 flex flex-wrap gap-3 text-xs">
            {([["scope", "Scope"], ["docs", "Documents"], ["plan", "Manpower plan"], ["lead", "Lead"]] as const).map(([k, l]) => (
              <span key={k} className="inline-flex items-center gap-1.5"><StatusDot ok={b.checks[k]} /> {l}</span>
            ))}
          </div>
          <p className="mt-2 flex flex-wrap items-center gap-x-2 text-xs">
            <span className="font-medium">Leads in {monthLabel(month)}&apos;s plan:</span>
            <PlanLeads roles={b.roles} />
          </p>
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
        {data.pendingScope && <PendingScopeBanner request={data.pendingScope} onEdit={() => startResend(data.pendingScope!, "pending")} />}
        {!data.pendingScope && data.lastRejectedScope && (
          <RejectedScopeBanner request={data.lastRejectedScope} onEdit={() => startResend(data.lastRejectedScope!, "rejected")} />
        )}
        {(data.pendingScope || data.lastRejectedScope) && b.scopeItems.length > 0 && <h3 className="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">Current approved scope</h3>}
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
          <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
            {data.pendingScope
              ? "No approved scope yet — a change is waiting for approval. Projects keep their own scope until it's approved."
              : "No scope yet — flagged, not blocked. Projects keep their own scope until one is added."}
          </p>
        )}
        {b.scopeItems.length > 0 && <ScopeTotalCheck className="mt-3" total={b.scopeTotal} rows={b.scopeItems} />}
        <OtherScopeText className="mt-3" text={b.scopeText ?? ""} />
        {b.scopeMatch && (
          <ScopeMatchBox
            className="mt-3"
            at={b.scopeMatch.at}
            match={{ score: b.scopeMatch.score, missingFromScope: b.scopeMatch.missing, extraInScope: b.scopeMatch.extra, changedQty: b.scopeMatch.changed, source: b.scopeMatch.source }}
          />
        )}
        <ScopeHistory brandId={b._id} />
        {(data.canManage || data.pendingScope?.canEdit || data.lastRejectedScope?.canEdit) && (
          <ScopeUpload
            key={resend ? `resend-${resend.nonce}` : "edit"}
            brandId={b._id}
            current={b.scopeItems.map((r) => ({ unit: r.unit, what: r.what, quantity: r.quantity, languageList: r.languageList, sizes: r.sizes, source: r.source ?? "" }))}
            currentText={b.scopeText ?? ""}
            currentTotal={b.scopeTotal ?? null}
            resend={resend}
            onCancelResend={() => setResend(null)}
            onDone={() => void detail.refetch()}
          />
        )}
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
        title={`Team · Manpower plan ${monthLabel(month)} · ${planVersionText(data.planVersion, data.pendingPlan)}`}
        actions={<CellLegend max={max} pending={Boolean(data.pendingPlan)} />}
      >
        {data.pendingPlan && <PendingPlanBanner className="mb-2" pending={data.pendingPlan} savesApproved={data.planSavesApproved} />}
        {new Set(b.planLines.map((l) => l.name.replace(/\s+/g, " ").trim().toLowerCase())).size < b.planLines.length && (
          <p className="mb-2 text-xs">
            <span className="rounded bg-amber-100 px-1.5 py-px text-xs font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">duplicate line</span>{" "}
            <span className="text-muted-foreground">Two plan lines have the same name — remove one on the Manpower plan page.</span>
          </p>
        )}
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

      <Section
        title={allProjects ? `Open projects (${b.projects.length})` : "Current projects"}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setAllProjects((v) => !v)} aria-pressed={allProjects}>
              {allProjects ? `Only ${monthLabel(month)}` : `All open projects (${b.projects.length})`}
            </Button>
            {data.canManage && picked.length > 0 && !moving && (
              <Button type="button" variant="outline" size="sm" onClick={() => setMoving(true)}>
                <LuArrowRightLeft aria-hidden /> Move to another brand…
              </Button>
            )}
          </div>
        }
      >
        {moving && picked.length > 0 && (
          <MoveBar
            data={data}
            picked={picked}
            onCancel={() => setMoving(false)}
            onDone={() => {
              setMoving(false);
              setPicked([]);
              void detail.refetch();
            }}
          />
        )}
        {allProjects ? (
          b.projects.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem] text-sm">
                <tbody>
                  {b.projects.map((p) => (
                    <tr key={p._id} className="border-b last:border-0">
                      {data.canManage && (
                        <td className="w-8 py-1.5 pr-2 align-top">
                          <input type="checkbox" className="size-4 accent-primary" aria-label={`Select ${p.name}`} checked={picked.includes(p._id)} onChange={() => togglePicked(p._id)} />
                        </td>
                      )}
                      <td className="py-1.5 pr-2"><Link to={`/projects/${p._id}`} className="break-all hover:underline">{p.name}</Link></td>
                      <td className="py-1.5 pr-2 text-xs text-muted-foreground">{p.code}</td>
                      <td className="py-1.5 text-xs">{p.current && <Badge variant="secondary">current</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">This brand has no open projects.</p>
          )
        ) : b.current.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b text-left">
                  {data.canManage && (
                    <th className="w-8 py-1.5 pr-2 font-medium">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        aria-label="Select all current projects"
                        checked={b.current.every((p) => picked.includes(p._id))}
                        onChange={(e) =>
                          setPicked((list) => (e.target.checked ? [...new Set([...list, ...b.current.map((p) => p._id)])] : list.filter((x) => !b.current.some((p) => p._id === x))))
                        }
                      />
                    </th>
                  )}
                  <th className="py-1.5 pr-2 font-medium">Project</th>
                  <th className="py-1.5 pr-2 font-medium">Dates</th>
                  <th className="py-1.5 pr-2 font-medium">Scope</th>
                  <th className="py-1.5 font-medium">Plan line</th>
                </tr>
              </thead>
              <tbody>
                {b.current.map((p) => (
                  <tr key={p._id} className="border-b last:border-0">
                    {data.canManage && (
                      <td className="w-8 py-1.5 pr-2 align-top">
                        <input type="checkbox" className="size-4 accent-primary" aria-label={`Select ${p.name}`} checked={picked.includes(p._id)} onChange={() => togglePicked(p._id)} />
                      </td>
                    )}
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
          <p className="text-sm text-muted-foreground">None in {monthLabel(month)}.{b.projects.length ? " Show all open projects to move older ones." : ""}</p>
        )}
        {data.canManage && picked.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            {picked.length} selected ·{" "}
            <button type="button" className="text-primary hover:underline" onClick={() => setPicked([])}>
              clear
            </button>
          </p>
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
