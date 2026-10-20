import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { LuCopy, LuFilePlus, LuHistory, LuLoaderCircle, LuPencil, LuSave, LuUsers } from "react-icons/lu";

import { ConfirmDialog } from "@/components/globals/confirm-dialog";
import type { MultiSelectOption } from "@/components/globals/multi-select";
import { EmptyState, PageHeader, QueryError } from "@/components/globals/query-states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useBrands } from "@/hooks/use-brands";
import { useManpowerMonths, useManpowerPlan, useSaveManpowerPlan } from "@/hooks/use-manpower";
import { useProjectTypes } from "@/hooks/use-project-meta";
import { useAssignableUsers } from "@/hooks/use-task-meta";
import { formatDateTime } from "@/lib/format";
import { MANPOWER_ROLE_FALLBACK, newRowKey, shiftMonth } from "@/lib/manpower";
import { namingMonthLabel } from "@/lib/projects";
import { todayKey } from "@/lib/tasks";
import type { ManpowerPlanResponse, ManpowerRowInput, ManpowerSection } from "@/types";

import { InlineCellEditor, RowDialog, type CellValue } from "./plan-editors";
import { PeopleView } from "./people-view";
import { PlanTable, type TableRow } from "./plan-table";
import { UnlinkedProjects } from "./unlinked-projects";

const SOURCE_LABEL = { import: "Imported", edit: "Edited", copy: "Copied" } as const;

export function planRowsToTable(data: ManpowerPlanResponse): TableRow[] {
  return data.plan.rows.map((r) => ({
    key: r.key,
    section: r.section,
    brand: r.brand ? { _id: r.brand._id, name: r.brand.name, color: r.brand.color } : null,
    type: r.type,
    // Stored names as they are: a save never renames lines nobody touched (several lines
    // of one brand keep what tells them apart, e.g. "Ajmal AA videos").
    name: r.name,
    cells: r.cells.map((c) => ({ ...c, users: c.users.map((u) => ({ _id: u._id, name: u.name })) })),
  }));
}

function tableToInput(rows: TableRow[]): ManpowerRowInput[] {
  return rows.map((r) => ({
    key: r.key,
    section: r.section,
    brand: r.brand?._id ?? null,
    type: r.type,
    name: r.name,
    cells: r.cells.map((c) => ({
      role: c.role,
      users: c.users.map((u) => u._id),
      placeholders: c.placeholders,
      notNeeded: c.notNeeded,
      note: c.note,
    })),
  }));
}

interface Draft {
  rows: TableRow[];
  baseVersion: number | null;
  source: "edit" | "copy";
  note: string;
  maxProjects: string;
  dirty: boolean;
}


const STATUS_LABEL: Record<string, string> = {
  pending: "Waiting for approval",
  rejected: "Not approved",
  superseded: "Replaced",
  approved: "Approved",
};

/** " · latest" / " · waiting for approval" … after "Version N". */
function versionSuffix(v: { version: number; status?: string }, latest: number | null): string {
  if (v.status && v.status !== "approved") return ` · ${STATUS_LABEL[v.status]?.toLowerCase() ?? v.status}`;
  return v.version === latest ? " · latest" : "";
}

/**
 * Manpower plan: all brands × roles for a month, each person's allocation
 * (clashes and availability), and the version history. Admins and heads read; leadership and Nazeer edit,
 * and every save becomes a new version.
 */
export function ManpowerPage() {
  const [params, setParams] = useSearchParams();
  const thisMonth = todayKey().slice(0, 7);
  const months = useManpowerMonths();
  const planMonths = months.data?.months ?? [];
  const roles = months.data?.roles ?? MANPOWER_ROLE_FALLBACK;
  // Leadership and Nazeer change the plan; other admins and heads read it.
  const canEdit = months.data?.canEdit === true;

  const month = /^\d{4}-\d{2}$/.test(params.get("month") ?? "")
    ? params.get("month")!
    : planMonths.some((m) => m.month === thisMonth) || planMonths.length === 0
      ? thisMonth
      : planMonths[0]!.month;
  const versionParam = Number(params.get("v"));
  const version = Number.isInteger(versionParam) && versionParam > 0 ? versionParam : null;
  const tab = params.get("tab") ?? "plan";

  function setParam(patch: Record<string, string | null>) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [k, v] of Object.entries(patch)) {
          if (v === null || v === "") next.delete(k);
          else next.set(k, v);
        }
        return next;
      },
      { replace: true },
    );
  }

  const plan = useManpowerPlan(month, version, months.isSuccess);
  const notFound = (plan.error as { response?: { status?: number } } | null)?.response?.status === 404;
  const data = plan.data && plan.data.month === month && !notFound ? plan.data : null;

  // Copy source for a month without a plan: the latest earlier month that has one.
  const copyFrom = planMonths.find((m) => m.month < month)?.month ?? null;
  const copySource = useManpowerPlan(copyFrom ?? "", null, canEdit && notFound && Boolean(copyFrom));

  const [highlight, setHighlight] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [cellEdit, setCellEdit] = useState<{ rowKey: string; role: string } | null>(null);
  const [rowEdit, setRowEdit] = useState<{ rowKey?: string; section: ManpowerSection } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const save = useSaveManpowerPlan();

  // Reset when switching month or version.
  useEffect(() => {
    setDraft(null);
    setHighlight(null);
  }, [month, version]);

  // A non-leader's "Edit plan" while a version waits for approval: open that version, then edit
  // from it (their earlier changes show; the save adds to them).
  const [editPending, setEditPending] = useState(false);
  useEffect(() => {
    if (!editPending || !data || data.pendingVersion == null || data.version !== data.pendingVersion) return;
    setEditPending(false);
    startEdit(planRowsToTable(data), data.pendingVersion, "edit");
  }, [editPending, data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    if (!draft?.dirty) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [draft?.dirty]);

  const editing = draft !== null;
  const brands = useBrands(false, canEdit && editing);
  const types = useProjectTypes(canEdit && editing);
  const assignable = useAssignableUsers(canEdit && editing);
  const peopleOptions = useMemo<MultiSelectOption[]>(
    () =>
      (assignable.data ?? []).map((u) => ({
        value: u._id,
        label: u.name,
        description: [u.department?.name].filter(Boolean).join(" · ") || undefined,
      })),
    [assignable.data],
  );
  const nameById = useMemo(() => new Map((assignable.data ?? []).map((u) => [u._id, u.name])), [assignable.data]);

  const monthOptions = useMemo(() => {
    const set = new Map<string, string>();
    for (const m of [shiftMonth(thisMonth, 1), thisMonth, month]) set.set(m, namingMonthLabel(m));
    for (const m of planMonths) set.set(m.month, `${namingMonthLabel(m.month)} · v${m.latestVersion}`);
    return [...set.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [planMonths, thisMonth, month]);

  const viewRows = editing ? draft.rows : data ? planRowsToTable(data) : [];
  const q = search.trim().toLowerCase();
  const shownRows = q
    ? viewRows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.brand?.name.toLowerCase().includes(q) ||
          r.cells.some((c) => c.users.some((u) => u.name.toLowerCase().includes(q)) || c.placeholders.some((p) => p.toLowerCase().includes(q))),
      )
    : viewRows;

  function startEdit(rows: TableRow[], baseVersion: number | null, source: "edit" | "copy") {
    setDraft({
      rows: rows.map((r) => ({ ...r, cells: r.cells.map((c) => ({ ...c, users: [...c.users], placeholders: [...c.placeholders] })) })),
      baseVersion,
      source,
      note: "",
      maxProjects: String(data?.plan.maxProjectsPerPerson ?? months.data?.limits.defaultMaxProjectsPerPerson ?? 6),
      dirty: source === "copy",
    });
    setParam({ tab: "plan" });
  }

  function updateRows(fn: (rows: TableRow[]) => TableRow[]) {
    setDraft((d) => (d ? { ...d, rows: fn(d.rows), dirty: true } : d));
  }

  function saveDraft() {
    if (!draft) return;
    const max = Number(draft.maxProjects);
    save.mutate(
      {
        month,
        baseVersion: draft.baseVersion,
        rows: tableToInput(draft.rows),
        note: draft.note.trim(),
        maxProjectsPerPerson: Number.isInteger(max) && max >= 1 ? max : undefined,
        source: draft.source,
      },
      {
        onSuccess: () => {
          setDraft(null);
          setParam({ v: null });
        },
      },
    );
  }

  // Cell edits apply to the draft at once (the cell's inline editor; no pop-up).
  function applyCell(rowKey: string, role: string, value: CellValue) {
    updateRows((rows) =>
      rows.map((r) => {
        if (r.key !== rowKey) return r;
        const others = r.cells.filter((c) => c.role !== role);
        const empty = !value.notNeeded && value.users.length === 0 && value.placeholders.length === 0 && !value.note.trim();
        if (empty) return { ...r, cells: others };
        const cell = {
          role,
          users: value.users.map((id) => ({ _id: id, name: nameById.get(id) ?? r.cells.flatMap((c) => c.users).find((u) => u._id === id)?.name ?? "…" })),
          placeholders: value.placeholders,
          notNeeded: value.notNeeded,
          note: value.note,
        };
        const order = roles.map((x) => x.key);
        return { ...r, cells: [...others, cell].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role)) };
      }),
    );
  }

  const editingRow = rowEdit?.rowKey && draft ? draft.rows.find((r) => r.key === rowEdit.rowKey) : undefined;
  const highlightName = highlight ? data?.people.find((p) => p.user._id === highlight)?.user.name : null;

  return (
    <div className="mx-auto w-full max-w-[110rem] space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Manpower plan"
        description="Who is allocated to each brand and project, month by month. Delivery Pulse uses the latest version of each month for on-map / off-map."
        actions={
          !editing && (
            <>
              <Select
                value={month}
                onValueChange={(v) => setParam({ month: String(v), v: null })}
                items={Object.fromEntries(monthOptions)}
              >
                <SelectTrigger size="sm" aria-label="Month" className="min-w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {monthOptions.map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {data && (
                <Select
                  value={String(data.version)}
                  onValueChange={(v) => setParam({ v: Number(v) === data.latestVersion ? null : String(v) })}
                  items={Object.fromEntries(
                    data.versions.map((v) => [String(v.version), `Version ${v.version}${versionSuffix(v, data.latestVersion)}`]),
                  )}
                >
                  <SelectTrigger size="sm" aria-label="Version" className="min-w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {data.versions.map((v) => (
                      <SelectItem key={v.version} value={String(v.version)}>
                        Version {v.version}
                        {versionSuffix(v, data.latestVersion)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {canEdit && data && (() => {
                // Edits from the waiting version use it as their base (the server adds them to it).
                const onPending = data.pendingVersion != null && data.version === data.pendingVersion;
                const pendingFirst = !data.savesApproved && data.pendingVersion != null && !onPending && data.version === data.latestVersion;
                return (
                  <Button
                    size="sm"
                    onClick={() => {
                      if (pendingFirst) {
                        setEditPending(true);
                        setParam({ v: String(data.pendingVersion) });
                      } else startEdit(planRowsToTable(data), onPending ? data.pendingVersion! : data.latestVersion, "edit");
                    }}
                  >
                    <LuPencil aria-hidden />
                    {pendingFirst ? `Edit plan (from version ${data.pendingVersion}, waiting)` : data.version === data.latestVersion || onPending ? "Edit plan" : "Edit from this version"}
                  </Button>
                );
              })()}
            </>
          )
        }
      />

      {months.isError && <QueryError title="Couldn't load the plan" error={months.error} onRetry={() => void months.refetch()} />}

      {editing && (
        <div className="sticky top-2 z-30 flex flex-wrap items-end gap-3 rounded-xl border bg-background/95 p-3 shadow-sm backdrop-blur">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-medium text-foreground">
              Editing {namingMonthLabel(month)}
              {` · saves as version ${(data?.versions[0]?.version ?? 0) + 1}`}
              {draft.baseVersion != null && data?.pendingVersion === draft.baseVersion ? ` (adds to version ${draft.baseVersion}, waiting for approval)` : ""}
            </p>
            <Input
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value, dirty: true })}
              placeholder="What changed? (optional, shown in the version history)"
              maxLength={300}
              className="h-8"
              aria-label="Version note"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="mp-max" className="text-xs">
              Flag people on more than
            </Label>
            <div className="flex items-center gap-1.5 text-sm">
              <Input
                id="mp-max"
                type="number"
                min={1}
                max={100}
                value={draft.maxProjects}
                onChange={(e) => setDraft({ ...draft, maxProjects: e.target.value, dirty: true })}
                className="h-8 w-16"
              />
              lines
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => (draft.dirty ? setConfirmDiscard(true) : setDraft(null))} disabled={save.isPending}>
              Cancel
            </Button>
            <Button size="sm" onClick={saveDraft} disabled={save.isPending}>
              {save.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuSave aria-hidden />}
              Save version
            </Button>
          </div>
        </div>
      )}

      {plan.isPending && months.isSuccess && !editing && <Skeleton className="h-96 w-full rounded-xl" />}

      {plan.isError && !notFound && !editing && (
        <QueryError title="Couldn't load this month" error={plan.error} onRetry={() => void plan.refetch()} />
      )}

      {notFound && !editing && (
        <EmptyState
          icon={LuUsers}
          title={`No plan for ${namingMonthLabel(month)} yet`}
          description={
            canEdit
              ? copyFrom
                ? `Start from ${namingMonthLabel(copyFrom)}'s latest version and adjust, or start blank.`
                : "Start a blank plan for this month."
              : "Leadership hasn't planned this month yet."
          }
        >
          {canEdit && (
            <div className="flex flex-wrap justify-center gap-2">
              {copyFrom && (
                <Button
                  onClick={() =>
                    copySource.data &&
                    startEdit(
                      planRowsToTable(copySource.data).map((r) => ({ ...r, key: newRowKey() })),
                      null,
                      "copy",
                    )
                  }
                  disabled={!copySource.data}
                >
                  <LuCopy aria-hidden />
                  Copy {namingMonthLabel(copyFrom)}
                </Button>
              )}
              <Button variant="outline" onClick={() => startEdit([], null, "edit")}>
                <LuFilePlus aria-hidden />
                Start blank
              </Button>
            </div>
          )}
        </EmptyState>
      )}

      {(data || editing) && (
        <Tabs value={editing ? "plan" : tab} onValueChange={(v) => setParam({ tab: String(v) === "plan" ? null : String(v) })}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <TabsList>
              <TabsTrigger value="plan">Plan</TabsTrigger>
              <TabsTrigger value="people" disabled={editing}>
                People
              </TabsTrigger>
              <TabsTrigger value="versions" disabled={editing}>
                Versions
              </TabsTrigger>
            </TabsList>
            {(editing ? true : tab === "plan") && (
              <div className="flex flex-wrap items-center gap-2">
                {highlightName && !editing && (
                  <Badge variant="secondary" className="gap-1">
                    Highlighting {highlightName}
                    <button type="button" className="ml-1 hover:text-foreground" onClick={() => setHighlight(null)} aria-label="Clear highlight">
                      ×
                    </button>
                  </Badge>
                )}
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search brand, project or person…"
                  className="h-8 w-64"
                  aria-label="Search the plan"
                />
              </div>
            )}
          </div>

          <TabsContent value="plan" className="mt-4 space-y-2">
            {data && !editing && data.pendingVersion != null && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-foreground">
                {data.version === data.pendingVersion ? (
                  <>
                    This version is <span className="font-medium">waiting for leadership approval</span>.{" "}
                    {data.latestVersion != null
                      ? `The plan keeps using version ${data.latestVersion} until it's approved.`
                      : "It's used once it's approved."}
                  </>
                ) : (
                  <>
                    Version {data.pendingVersion} is <span className="font-medium">waiting for leadership approval</span>.{" "}
                    <button
                      type="button"
                      className="text-primary underline underline-offset-2"
                      onClick={() => setParam({ v: String(data.pendingVersion) })}
                    >
                      View it
                    </button>
                  </>
                )}
              </div>
            )}
            {data && !editing && (
              <p className="text-xs text-muted-foreground">
                Version {data.version} · {SOURCE_LABEL[data.plan.source]} {formatDateTime(data.plan.createdAt)}
                {data.plan.createdBy ? ` by ${data.plan.createdBy.name}` : ""}
                {data.plan.note ? ` · ${data.plan.note}` : ""}
                {data.version !== data.latestVersion && " · not the latest version"}
              </p>
            )}
            <PlanTable
              rows={shownRows}
              roles={roles}
              links={editing ? undefined : data?.links}
              scope={editing ? undefined : data?.scope}
              highlight={editing ? null : highlight}
              editing={editing}
              onEditCell={(rowKey, roleKey) => setCellEdit({ rowKey, role: roleKey })}
              activeCell={cellEdit}
              renderCellEditor={(row, role) => (
                <InlineCellEditor
                  label={`${role.label} on ${row.name}`}
                  cell={row.cells.find((c) => c.role === role.key)}
                  people={peopleOptions}
                  onChange={(value) => applyCell(row.key, role.key, value)}
                  onClose={() => setCellEdit(null)}
                />
              )}
              onEditRow={(rowKey) => setRowEdit({ rowKey, section: "active" })}
              onAddRow={(section) => setRowEdit({ section })}
            />
            <p className="text-xs text-muted-foreground">
              Dashed chips are open slots or names that don&apos;t match anyone in the app. “—” means the role isn&apos;t needed.
            </p>
            {data && !editing && data.version === data.latestVersion && (
              <UnlinkedProjects projects={data.unlinkedProjects ?? []} rows={data.plan.rows} canEdit={canEdit} />
            )}
          </TabsContent>

          {data && (
            <TabsContent value="people" className="mt-4">
              <PeopleView
                data={data}
                roles={roles}
                rows={planRowsToTable(data)}
                canEdit={canEdit && !editing && data.version === data.latestVersion}
                saving={save.isPending}
                onSave={(next, note, done) =>
                  save.mutate({ month, baseVersion: data.latestVersion, rows: tableToInput(next), note }, { onSuccess: done })
                }
                onHighlight={(id) => {
                  setHighlight(id);
                  setParam({ tab: null });
                }}
              />
            </TabsContent>
          )}

          {data && (
            <TabsContent value="versions" className="mt-4">
              <div className="overflow-x-auto rounded-xl border bg-card">
                <table className="w-full text-sm">
                  <thead className="bg-muted text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Version</th>
                      <th className="px-3 py-2 font-medium">Saved</th>
                      <th className="px-3 py-2 font-medium">By</th>
                      <th className="px-3 py-2 font-medium">How</th>
                      <th className="px-3 py-2 text-right font-medium">Lines</th>
                      <th className="px-3 py-2 font-medium">Note</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.versions.map((v) => (
                      <tr key={v.version} className="border-t">
                        <td className="px-3 py-2 font-medium">
                          v{v.version}
                          {v.version === data.latestVersion && (
                            <Badge variant="secondary" className="ml-2">
                              Latest
                            </Badge>
                          )}
                          {v.status && v.status !== "approved" && (
                            <Badge variant={v.status === "rejected" ? "destructive" : "outline"} className="ml-2">
                              {STATUS_LABEL[v.status]}
                            </Badge>
                          )}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{formatDateTime(v.createdAt)}</td>
                        <td className="px-3 py-2">{v.createdBy?.name ?? "Import"}</td>
                        <td className="px-3 py-2">{SOURCE_LABEL[v.source]}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{v.rowCount}</td>
                        <td className="px-3 py-2 text-muted-foreground">{v.note || "—"}</td>
                        <td className="px-3 py-2 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setParam({ v: v.version === data.latestVersion ? null : String(v.version), tab: null })}
                            disabled={v.version === data.version}
                          >
                            <LuHistory aria-hidden />
                            {v.version === data.version ? "Viewing" : "View"}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </TabsContent>
          )}
        </Tabs>
      )}

      {draft && (
        <>
          <RowDialog
            open={rowEdit !== null}
            onOpenChange={(open) => !open && setRowEdit(null)}
            row={editingRow}
            section={rowEdit?.section ?? "active"}
            brands={brands.data ?? []}
            types={(types.data ?? []).map((t) => t.name)}
            otherLines={draft.rows.filter((r) => r.key !== editingRow?.key).map((r) => ({ brand: r.brand?._id ?? null, name: r.name }))}
            onSave={(value) => {
              const brand = value.brand ? (brands.data ?? []).find((b) => b._id === value.brand) : null;
              const brandRef = brand ? { _id: brand._id, name: brand.name, color: brand.color } : null;
              if (editingRow) {
                updateRows((rows) =>
                  rows.map((r) => (r.key === editingRow.key ? { ...r, name: value.name, brand: brandRef, type: value.type, section: value.section } : r)),
                );
              } else {
                updateRows((rows) => [...rows, { key: newRowKey(), name: value.name, brand: brandRef, type: value.type, section: value.section, cells: [] }]);
              }
            }}
            onDelete={editingRow ? () => updateRows((rows) => rows.filter((r) => r.key !== editingRow.key)) : undefined}
          />
          <ConfirmDialog
            open={confirmDiscard}
            onOpenChange={setConfirmDiscard}
            title="Discard your changes?"
            description="Nothing is saved until you press Save version."
            confirmLabel="Discard"
            destructive
            onConfirm={() => {
              setConfirmDiscard(false);
              setDraft(null);
            }}
          />
        </>
      )}
    </div>
  );
}
