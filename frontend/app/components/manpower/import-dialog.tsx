import { useEffect, useMemo, useRef, useState } from "react";
import { LuFileSpreadsheet, LuLoaderCircle, LuTriangleAlert, LuUndo2, LuUpload } from "react-icons/lu";

import { UserPicker } from "@/components/globals/user-picker";
import { FieldError } from "@/components/projects/project-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useBrands } from "@/hooks/use-brands";
import { useManpowerImport, useManpowerImportPreview, useManpowerImportSheets } from "@/hooks/use-manpower";
import { useAssignableUsers } from "@/hooks/use-task-meta";
import { getErrorMessage } from "@/lib/api";
import { namingMonthLabel } from "@/lib/projects";
import { cn } from "@/lib/utils";
import type { ManpowerImportLine, ManpowerImportMappings, ManpowerImportPreview, ManpowerImportSheets } from "@/types";

// ---------------------------------------------------------------------------
// Manpower plan → Import Excel: a month sheet of the planning workbook becomes the
// month's next version. Choose the file → pick the sheet and month → preview (nothing
// saved; fix brands and names) → Import. Saved quietly like an edit on the page:
// leadership's import is live at once ("Send email" later), anyone else's waits
// ("Send for approval").
// ---------------------------------------------------------------------------

const MAX_MB = 10;
const NO_BRAND = "__none";

interface BrandOption {
  value: string;
  label: string;
}

/** Searchable brand picker (approved brands) with "No brand". */
function BrandPicker({
  brands,
  value,
  onChange,
  "aria-label": ariaLabel,
}: {
  brands: BrandOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  "aria-label": string;
}) {
  const options = useMemo(() => [{ value: NO_BRAND, label: "No brand" }, ...brands], [brands]);
  const selected = options.find((o) => o.value === (value ?? NO_BRAND)) ?? options[0];
  return (
    <Combobox
      items={options}
      value={selected}
      onValueChange={(item: BrandOption | null) => onChange(!item || item.value === NO_BRAND ? null : item.value)}
      isItemEqualToValue={(item: BrandOption, current: BrandOption) => item.value === current.value}
      itemToStringLabel={(item: BrandOption) => (item.value === NO_BRAND ? "" : item.label)}
      autoHighlight
    >
      <ComboboxInput aria-label={ariaLabel} placeholder="No brand — search brands…" className="h-8 w-full" />
      <ComboboxContent sideOffset={4}>
        <ComboboxEmpty>No brand matches.</ComboboxEmpty>
        <ComboboxList>
          {(option: BrandOption) => (
            <ComboboxItem key={option.value} value={option}>
              <span className={cn("truncate", option.value === NO_BRAND && "text-muted-foreground")}>{option.label}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

const STATUS_BADGE: Record<ManpowerImportLine["status"], { label: string; variant: "secondary" | "outline" }> = {
  added: { label: "New", variant: "secondary" },
  changed: { label: "Changed", variant: "secondary" },
  same: { label: "Same", variant: "outline" },
};

export function ManpowerImportDialog({
  open,
  onOpenChange,
  month: pageMonth,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The page's month (the sheet named for it is picked first). */
  month: string;
  onImported: (month: string) => void;
}) {
  const sheetsQuery = useManpowerImportSheets();
  const previewQuery = useManpowerImportPreview();
  const save = useManpowerImport();
  const brands = useBrands(false, open);
  const users = useAssignableUsers(open);
  const input = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [workbook, setWorkbook] = useState<ManpowerImportSheets | null>(null);
  const [sheet, setSheet] = useState("");
  const [month, setMonth] = useState(pageMonth);
  const [brandFix, setBrandFix] = useState<Record<string, string | null>>({});
  const [nameFix, setNameFix] = useState<Record<string, { id: string | null; name: string; count: number }>>({});
  const [preview, setPreview] = useState<ManpowerImportPreview | null>(null);
  const [onlyWarnings, setOnlyWarnings] = useState(false);
  const [note, setNote] = useState("");

  // A fresh start each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setFile(null);
    setFileError(null);
    setWorkbook(null);
    setSheet("");
    setMonth(pageMonth);
    setBrandFix({});
    setNameFix({});
    setPreview(null);
    setOnlyWarnings(false);
    setNote("");
    sheetsQuery.reset();
    previewQuery.reset();
    save.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const mappings = useMemo<ManpowerImportMappings>(
    () => ({ brands: brandFix, names: Object.fromEntries(Object.entries(nameFix).map(([k, v]) => [k, v.id])) }),
    [brandFix, nameFix],
  );

  // Preview again whenever the sheet, month or a fix changes (the latest answer wins).
  const latest = useRef(0);
  useEffect(() => {
    if (!file || !sheet || !/^\d{4}-\d{2}$/.test(month)) return;
    const id = ++latest.current;
    const t = setTimeout(() => {
      previewQuery.mutate(
        { file, sheet, month, mappings },
        { onSuccess: (data) => id === latest.current && setPreview(data) },
      );
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, sheet, month, mappings]);

  function choose(next: File) {
    setFileError(null);
    if (!/\.xlsx$/i.test(next.name)) return setFileError("Choose an .xlsx workbook");
    if (next.size > MAX_MB * 1024 * 1024) return setFileError(`The file can be at most ${MAX_MB} MB`);
    sheetsQuery.mutate(
      { file: next, month: pageMonth },
      {
        onSuccess: (data) => {
          setFile(next);
          setWorkbook(data);
          setSheet(data.suggested.sheet ?? "");
          setMonth(data.suggested.month ?? pageMonth);
          setBrandFix({});
          setNameFix({});
          setPreview(null);
        },
      },
    );
  }

  const brandOptions = useMemo<BrandOption[]>(
    () =>
      (brands.data ?? [])
        .filter((b) => (b.status ?? "approved") === "approved")
        .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name))
        .map((b) => ({ value: b._id, label: b.active ? b.name : `${b.name} (inactive)` })),
    [brands.data],
  );

  const shown = preview && preview.sheet === sheet && preview.month === month ? preview : null;
  const roleLabel = useMemo(() => new Map((shown?.roles ?? []).map((r) => [r.key, r.label])), [shown]);
  const lines = shown ? (onlyWarnings ? shown.lines.filter((l) => l.warnings.length) : shown.lines) : [];
  const fixedNames = Object.entries(nameFix);
  const sheetItems = Object.fromEntries(
    (workbook?.sheets ?? []).filter((s) => s.readable).map((s) => [s.name, `${s.name} · ${s.rows} rows${s.hidden ? " · hidden" : ""}`]),
  );
  const nothingNew = Boolean(shown?.base && shown.diff.changed + shown.diff.added + shown.diff.removed === 0);
  const busy = previewQuery.isPending || save.isPending;

  function runImport() {
    if (!file || !shown) return;
    save.mutate(
      { file, sheet, month, mappings, note: note.trim(), baseVersion: shown.base?.version ?? null },
      {
        onSuccess: (data) => {
          onOpenChange(false);
          onImported(data.month);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !save.isPending && onOpenChange(next)}>
      <DialogContent className="max-h-[92vh] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-7xl">
        <DialogHeader>
          <DialogTitle>Import from Excel</DialogTitle>
          <DialogDescription>
            A month sheet of the planning workbook becomes the month&apos;s next version. Check the preview, fix brands and names,
            then import. The file isn&apos;t stored.
          </DialogDescription>
        </DialogHeader>

        {/* 1. File, sheet, month */}
        <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-muted/30 p-3">
          <div className="space-y-1">
            <Label className="text-xs">Workbook</Label>
            <div className="flex items-center gap-2">
              <Button type="button" variant={file ? "outline" : "default"} size="sm" onClick={() => input.current?.click()} disabled={sheetsQuery.isPending || save.isPending}>
                {sheetsQuery.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuFileSpreadsheet aria-hidden />}
                {file ? "Change file" : "Choose the workbook (.xlsx)"}
              </Button>
              {file && <span className="max-w-64 truncate text-sm" title={file.name}>{file.name}</span>}
            </div>
            <input
              ref={input}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={(e) => {
                const next = e.target.files?.[0];
                e.target.value = "";
                if (next) choose(next);
              }}
            />
          </div>
          {workbook && (
            <>
              <div className="min-w-56 space-y-1">
                <Label className="text-xs">Sheet</Label>
                <Select value={sheet} onValueChange={(v) => setSheet(String(v ?? ""))} items={sheetItems}>
                  <SelectTrigger size="sm" className="w-full" aria-label="Sheet">
                    <SelectValue placeholder="Pick a sheet" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(sheetItems).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="mp-import-month" className="text-xs">
                  Into month
                </Label>
                <Input id="mp-import-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="h-8 w-44" />
              </div>
              {previewQuery.isPending && (
                <span className="flex items-center gap-1.5 pb-1.5 text-xs text-muted-foreground">
                  <LuLoaderCircle aria-hidden className="animate-spin" /> Reading the sheet…
                </span>
              )}
            </>
          )}
        </div>
        {fileError && <FieldError>{fileError}</FieldError>}
        {sheetsQuery.isError && <FieldError>{getErrorMessage(sheetsQuery.error)}</FieldError>}
        {previewQuery.isError && !previewQuery.isPending && <FieldError>{getErrorMessage(previewQuery.error)}</FieldError>}
        {workbook && !sheet && <p className="text-sm text-muted-foreground">Pick the sheet to import.</p>}

        {/* 2. Preview */}
        {shown && (
          <div className={cn("space-y-3", previewQuery.isPending && "opacity-70")}>
            <div className="space-y-1 text-sm">
              <p>
                <span className="font-semibold">{shown.summary.lines}</span> lines ({shown.summary.pitches} pitches) ·{" "}
                <span className="font-semibold">{shown.summary.people}</span> people · {shown.summary.openSlots} open slots
                {shown.summary.warnings > 0 && (
                  <>
                    {" "}· <span className="font-semibold text-amber-700 dark:text-amber-400">{shown.summary.warnings} to check</span>
                  </>
                )}
              </p>
              <p className="text-muted-foreground">
                {shown.base ? (
                  <>
                    Compared with version {shown.base.version}
                    {shown.base.status === "pending" ? " (waiting for approval — the import replaces it)" : ""}:{" "}
                    <span className="font-medium text-foreground">
                      {shown.diff.changed} line{shown.diff.changed === 1 ? "" : "s"} changed, {shown.diff.added} added, {shown.diff.removed} removed
                    </span>
                    {shown.diff.removedLines.length > 0 && ` (removed: ${shown.diff.removedLines.join(", ")})`}.
                  </>
                ) : (
                  <>{namingMonthLabel(month)} has no plan yet — every line is new.</>
                )}{" "}
                Saves as version {shown.nextVersion},{" "}
                {shown.savesApproved
                  ? "live at once (quietly — use “Send email” on the plan when you're ready)."
                  : "waiting for approval (quietly — use “Send for approval” on the plan when you're ready)."}
              </p>
              {shown.ignoredColumns.length > 0 && (
                <p className="text-xs text-muted-foreground">Columns not in the plan (ignored): {shown.ignoredColumns.join(", ")}</p>
              )}
            </div>

            {(shown.names.length > 0 || fixedNames.length > 0) && (
              <div className="rounded-lg border p-3">
                <p className="text-sm font-medium">Names with no user</p>
                <p className="mb-2 text-xs text-muted-foreground">
                  Pick who a name is (every place it&apos;s written), or keep it as an open slot.
                </p>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {shown.names.map((n) => (
                    <div key={n.key} className="flex items-center gap-2">
                      <span className="w-32 shrink-0 truncate text-sm" title={n.name}>
                        “{n.name}” <span className="text-xs text-muted-foreground">×{n.count}</span>
                      </span>
                      <UserPicker
                        users={users.data ?? []}
                        value={null}
                        loading={users.isPending}
                        noneLabel="Open slot"
                        placeholder="Open slot — pick a person…"
                        aria-label={`Who is ${n.name}`}
                        className="h-8"
                        onChange={(id) => id && setNameFix((m) => ({ ...m, [n.key]: { id, name: n.name, count: n.count } }))}
                      />
                    </div>
                  ))}
                  {fixedNames.map(([key, fix]) => (
                    <div key={key} className="flex items-center gap-2 text-sm">
                      <span className="w-32 shrink-0 truncate" title={fix.name}>
                        “{fix.name}” <span className="text-xs text-muted-foreground">×{fix.count}</span>
                      </span>
                      <span className="min-w-0 flex-1 truncate font-medium">
                        → {fix.id ? ((users.data ?? []).find((u) => u._id === fix.id)?.name ?? "…") : "open slot"}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Undo ${fix.name}`}
                        onClick={() => setNameFix(({ [key]: _gone, ...rest }) => rest)}
                      >
                        <LuUndo2 aria-hidden />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="size-4 accent-primary" checked={onlyWarnings} onChange={(e) => setOnlyWarnings(e.target.checked)} />
                Only lines to check ({shown.summary.warnings})
              </label>
            </div>

            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[64rem] text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr className="text-left">
                    <th className="px-2 py-2 font-medium">Line</th>
                    <th className="w-64 px-2 py-2 font-medium">Brand</th>
                    <th className="px-2 py-2 font-medium">People per role · open slots</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.line} className="border-t align-top">
                      <td className="w-72 px-2 py-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium">{l.name}</span>
                          {l.section === "pitch" && <Badge variant="outline">Pitch</Badge>}
                          {shown.base && <Badge variant={STATUS_BADGE[l.status].variant}>{STATUS_BADGE[l.status].label}</Badge>}
                        </div>
                        {l.sheetName !== l.name && <p className="text-xs text-muted-foreground">Sheet: {l.sheetName}</p>}
                        {l.warnings.length > 0 && (
                          <ul className="mt-1 space-y-0.5 text-xs text-amber-700 dark:text-amber-400">
                            {l.warnings.map((w) => (
                              <li key={w.kind} className="flex gap-1">
                                <LuTriangleAlert aria-hidden className="mt-0.5 size-3 shrink-0" />
                                {w.text}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        <BrandPicker
                          brands={
                            l.brand && !brandOptions.some((b) => b.value === l.brand!._id)
                              ? [{ value: l.brand._id, label: `${l.brand.name} (${l.brand.status})` }, ...brandOptions]
                              : brandOptions
                          }
                          value={l.brand?._id ?? null}
                          onChange={(id) => setBrandFix((m) => ({ ...m, [l.line]: id }))}
                          aria-label={`Brand for ${l.sheetName}`}
                        />
                        {!l.brandAuto && (
                          <button
                            type="button"
                            className="mt-1 text-xs text-primary underline underline-offset-2"
                            onClick={() => setBrandFix(({ [l.line]: _gone, ...rest }) => rest)}
                          >
                            Use the automatic match
                          </button>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        {l.cells.length === 0 ? (
                          <span className="text-xs text-muted-foreground">Nobody planned</span>
                        ) : (
                          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                            {l.cells.map((c) => (
                              <span key={c.role} className="inline-flex flex-wrap items-center gap-1">
                                <span className="text-muted-foreground">{roleLabel.get(c.role) ?? c.role}:</span>
                                {c.notNeeded && <span>—</span>}
                                {c.people.map((p) => (
                                  <span key={p._id} className="font-medium">
                                    {p.name.split(" ")[0]}
                                  </span>
                                ))}
                                {c.slots.map((s) => (
                                  <span
                                    key={s.label}
                                    className={cn(
                                      "rounded border border-dashed px-1",
                                      s.unknown && "border-amber-500 text-amber-700 dark:text-amber-400",
                                    )}
                                    title={s.unknown ? "No user with this name — pick who it is above, or keep it as an open slot" : "Open slot"}
                                  >
                                    {s.label}
                                  </span>
                                ))}
                                {c.note && <span className="text-muted-foreground">({c.note})</span>}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <DialogFooter className="flex-wrap items-center gap-2 sm:justify-between">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional) — the version says “Imported from <file> · <sheet>”"
            maxLength={150}
            className="h-8 sm:max-w-md"
            aria-label="Version note"
            disabled={!shown}
          />
          <div className="flex items-center gap-2">
            {nothingNew && <span className="text-xs text-muted-foreground">Nothing new — the sheet matches version {shown!.base!.version}.</span>}
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={runImport} disabled={!shown || busy || nothingNew}>
              {save.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuUpload aria-hidden />}
              {shown ? `Import as version ${shown.nextVersion}${shown.savesApproved ? "" : " (for approval)"}` : "Import"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
