import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { LuCircleCheck, LuCircleX, LuFileSpreadsheet, LuLoaderCircle, LuMinus, LuTriangleAlert } from "react-icons/lu";

import { FieldError, OptionSelect } from "@/components/projects/project-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { usePreviewPitchImport, useRunPitchImport } from "@/hooks/use-brands";
import { useAssignableUsers } from "@/hooks/use-task-meta";
import { getErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { PitchImportResult, PitchImportRow } from "@/types";

// ---------------------------------------------------------------------------
// Projects → Import pitch sheet: the "Proactive & Pitches" tracker becomes Pitch
// projects (one per row; the client's brand is reused or created) with the
// lead's Client presentation / Milestone 1 / Milestone 2 tasks on their dates.
// ---------------------------------------------------------------------------

const fmt = (iso: string | null) =>
  iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";

type Row = PitchImportRow & { on: boolean };

export function PitchImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const preview = usePreviewPitchImport();
  const run = useRunPitchImport();
  const people = useAssignableUsers(open);
  const input = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [canCreateBrands, setCanCreateBrands] = useState(false);
  const [results, setResults] = useState<PitchImportResult[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setRows(null);
    setResults(null);
    preview.reset();
    run.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const peopleOptions = (people.data ?? []).map((u) => ({ value: u._id, label: u.name }));
  const nameOf = (id: string) => people.data?.find((u) => u._id === id)?.name ?? "?";
  // A pitch needs a lead and all three dates (Client presentation, Milestone 1, Milestone 2).
  const datesOk = (r: Row) => r.tasks.every((t) => t.dueDate);
  const ready = (r: Row) => !r.exists && r.leads.length > 0 && datesOk(r) && (r.brand ? r.brand.status === "approved" : canCreateBrands);
  const picked = (rows ?? []).filter((r) => r.on && ready(r));
  const set = (i: number, patch: Partial<Row>) => setRows((list) => list!.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  function load(file: File) {
    preview.mutate(file, {
      onSuccess: (data) => {
        setCanCreateBrands(data.canCreateBrands);
        setRows(data.rows.map((r) => ({ ...r, on: !r.exists && r.leads.length > 0 && r.tasks.every((t) => t.dueDate) })));
      },
    });
  }

  function create() {
    run.mutate(
      picked.map((r) => ({
        client: r.client,
        title: r.title,
        month: r.month,
        revenue: r.revenue,
        revenueTbc: r.revenueTbc,
        status: r.status,
        leads: r.leads,
        tasks: r.tasks.filter((t) => t.dueDate),
      })),
      { onSuccess: setResults },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !run.isPending && onOpenChange(next)}>
      <DialogContent className="max-h-[92vh] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>Import pitch sheet</DialogTitle>
          <DialogDescription>
            Each row becomes a Pitch project of its client (the brand is reused or created), with the lead&apos;s tasks:
            Client presentation, Milestone 1 and Milestone 2 on their dates. Rows already imported are skipped.
          </DialogDescription>
        </DialogHeader>

        {!rows && (
          <div className="rounded-lg border-2 border-dashed bg-muted/30 p-6 text-center">
            <Button type="button" onClick={() => input.current?.click()} disabled={preview.isPending}>
              {preview.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuFileSpreadsheet aria-hidden />}
              Choose the pitch tracker (.xlsx)
            </Button>
            <input
              ref={input}
              type="file"
              accept=".xlsx"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) load(file);
              }}
            />
            <p className="mt-2 text-xs text-muted-foreground">Columns: Client Name, Campaign/Idea, Revenue Potential, Client Pres, Milestone 1, Milestone 2, Status, Lead.</p>
            {preview.isError && <div className="mt-2"><FieldError>{getErrorMessage(preview.error)}</FieldError></div>}
          </div>
        )}

        {rows && !results && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <p>
                <span className="font-semibold">{rows.length}</span> rows · <span className="font-semibold">{picked.length}</span> to create ·{" "}
                {rows.filter((r) => r.exists).length} already imported
              </p>
              {picked.length === 0 && (
                <p className="w-full text-xs text-muted-foreground">
                  Nothing to create yet: rows marked “Already imported” exist as projects; for a row without a lead, pick the
                  lead and it&apos;s ticked.
                </p>
              )}
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setRows(rows.map((r) => ({ ...r, on: ready(r) })))}>Tick all ready</Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setRows(rows.map((r) => ({ ...r, on: false })))}>Untick all</Button>
              </div>
            </div>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[60rem] text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr className="text-left">
                    <th className="w-8 px-2 py-2" />
                    <th className="px-2 py-2 font-medium">Client / project</th>
                    <th className="px-2 py-2 text-right font-medium">Revenue</th>
                    <th className="px-2 py-2 font-medium">Lead</th>
                    <th className="px-2 py-2 font-medium">Lead tasks</th>
                    <th className="px-2 py-2 font-medium">Status (sheet)</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const blocked = r.exists
                      ? "Already imported"
                      : r.brand && r.brand.status !== "approved"
                        ? `Brand ${r.brand.status}`
                        : !r.brand && !canCreateBrands
                          ? "New brand: only Nazeer can create it"
                          : null;
                    return (
                      <tr key={i} className={cn("border-t align-top", (!r.on || blocked) && "text-muted-foreground")}>
                        <td className="px-2 py-2">
                          <input
                            type="checkbox"
                            aria-label={`Import ${r.projectName}`}
                            className="size-4 accent-primary"
                            checked={r.on && !blocked}
                            disabled={Boolean(blocked) || r.leads.length === 0 || !datesOk(r)}
                            onChange={(e) => set(i, { on: e.target.checked })}
                          />
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium text-foreground">{r.client}</span>
                            <Badge variant={r.brand ? "secondary" : "outline"}>{r.brand ? "existing brand" : "new brand"}</Badge>
                            {blocked && <Badge variant="outline">{blocked}</Badge>}
                          </div>
                          <p className="mt-0.5 break-all text-xs">{r.projectName}</p>
                          {r.warnings.length > 0 && (
                            <ul className="mt-1 space-y-0.5 text-xs text-amber-700 dark:text-amber-400">
                              {r.warnings.map((w) => (
                                <li key={w} className="flex gap-1"><LuTriangleAlert aria-hidden className="mt-0.5 size-3 shrink-0" />{w}</li>
                              ))}
                            </ul>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">{r.revenue ? `AED ${r.revenue.toLocaleString("en-US")}` : "TBC"}</td>
                        <td className="w-48 px-2 py-2">
                          <OptionSelect
                            aria-label={`Lead for ${r.client}`}
                            value={r.leads[0] ?? ""}
                            placeholder={r.leadText ? `“${r.leadText}” — pick` : "Pick the lead…"}
                            options={peopleOptions}
                            onChange={(id) => set(i, { leads: id ? [id, ...r.leads.slice(1).filter((x) => x !== id)] : [], on: Boolean(id) && !blocked && datesOk(r) })}
                          />
                          {r.leads.length > 1 && <p className="mt-1 text-xs">+ {r.leads.slice(1).map(nameOf).join(", ")}</p>}
                        </td>
                        <td className="px-2 py-2 text-xs">
                          {r.tasks.map((t, k) =>
                            t.dueDate && !r.exists ? (
                              <p key={t.title}>{t.title}: {fmt(t.dueDate)}</p>
                            ) : r.exists ? (
                              <p key={t.title}>{t.title}: {t.dueDate ? fmt(t.dueDate) : "—"}</p>
                            ) : (
                              <label key={t.title} className="mb-1 flex items-center gap-1.5 text-destructive">
                                <span className="w-28 shrink-0">{t.title} *</span>
                                <input
                                  type="date"
                                  aria-label={`${t.title} date for ${r.client}`}
                                  className="rounded border border-destructive/50 bg-background px-1 py-0.5 text-foreground"
                                  onChange={(e) => {
                                    const tasks = r.tasks.map((x, j) => (j === k ? { ...x, dueDate: e.target.value || null } : x));
                                    const next = { ...r, tasks };
                                    set(i, { tasks, on: !blocked && next.leads.length > 0 && tasks.every((x) => x.dueDate) });
                                  }}
                                />
                              </label>
                            ),
                          )}
                        </td>
                        <td className="max-w-56 px-2 py-2 text-xs">{r.status || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {run.isError && <FieldError>{getErrorMessage(run.error)}</FieldError>}
          </div>
        )}

        {results && (
          <div className="space-y-2">
            <p className="text-sm">
              <span className="font-semibold">{results.filter((r) => r.status === "created").length}</span> created ·{" "}
              {results.filter((r) => r.status === "skipped").length} skipped · {results.filter((r) => r.status === "failed").length} failed
            </p>
            <ul className="divide-y rounded-lg border text-sm">
              {results.map((r, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  {r.status === "created" ? (
                    <LuCircleCheck aria-hidden className="size-4 text-primary" />
                  ) : r.status === "skipped" ? (
                    <LuMinus aria-hidden className="size-4 text-muted-foreground" />
                  ) : (
                    <LuCircleX aria-hidden className="size-4 text-destructive" />
                  )}
                  <span className="font-medium">{r.client}</span>
                  <span className="text-muted-foreground">· {r.title}</span>
                  <span className={cn("text-xs", r.status === "failed" ? "text-destructive" : "text-muted-foreground")}>{r.message}</span>
                  {r.projectId && (
                    <Link to={`/projects/${r.projectId}`} className="ml-auto text-xs text-primary underline-offset-2 hover:underline" onClick={() => onOpenChange(false)}>
                      Open project
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter className="sticky bottom-0 z-10 gap-2 bg-background sm:justify-between">
          {rows && !results ? (
            <Button type="button" variant="outline" onClick={() => setRows(null)} disabled={run.isPending}>Choose another file</Button>
          ) : (
            <span />
          )}
          {rows && !results ? (
            <Button type="button" onClick={create} disabled={run.isPending || picked.length === 0}>
              {run.isPending && <LuLoaderCircle aria-hidden className="animate-spin" />}
              {run.isPending ? "Creating…" : `Create ${picked.length} pitch${picked.length === 1 ? "" : "es"}`}
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
