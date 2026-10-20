import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { LuHourglass, LuLoaderCircle, LuSave, LuUndo2 } from "react-icons/lu";

import { Button } from "@/components/ui/button";
import { useManpowerPlan, useSaveManpowerPlan } from "@/hooks/use-manpower";
import { useAssignableUsers } from "@/hooks/use-task-meta";
import { formatDate, formatTimeOfDay } from "@/lib/format";
import { firstName, newRowKey, rowToInput } from "@/lib/manpower";
import { cn } from "@/lib/utils";
import type { BrandPersonLoad, BrandSummary, ManpowerRowInput, PendingPlanInfo } from "@/types";

// ---------------------------------------------------------------------------
// Colour-only allocation cells (Brands → Allocation, the brand page, New brand):
// green = assigned, red = needed by the scope but nobody, amber = someone on more
// brands than the max, grey = not needed. Clicking an editable cell turns it into
// a searchable list right in the cell (no pop-up): click a person to add or
// take them off, or "Nobody" to clear the cell.
// ---------------------------------------------------------------------------

export type CellTone = "ok" | "miss" | "load" | "na";

export const CELL_TONE: Record<CellTone, string> = {
  ok: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  miss: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
  load: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  na: "bg-muted text-muted-foreground",
};

/** Green / red status dot (flag only — nothing is blocked). */
export function StatusDot({ ok, label }: { ok: boolean; label?: string }) {
  return (
    <span
      role="img"
      aria-label={label ?? (ok ? "Set" : "Missing")}
      className={cn("inline-block size-2.5 shrink-0 rounded-full", ok ? "bg-emerald-600 dark:bg-emerald-400" : "bg-red-600 dark:bg-red-400")}
    />
  );
}

/** A cell whose proposed people (plan version waiting for approval) differ from the approved ones. */
export const PENDING_CELL = "outline-2 outline-dashed outline-amber-500 outline-offset-1";

export function CellLegend({ max, className, pending }: { max: number; className?: string; pending?: boolean }) {
  const items: Array<[CellTone, string]> = [
    ["ok", "Assigned"],
    ["miss", "Needed by scope, nobody"],
    ["load", `Person on more than ${max} brands`],
    ["na", "Not needed"],
  ];
  return (
    <div className={cn("flex flex-wrap gap-x-4 gap-y-1 text-xs", className)}>
      {items.map(([tone, label]) => (
        <span key={tone} className="inline-flex items-center gap-1.5">
          <i aria-hidden className={cn("inline-block size-3.5 rounded", CELL_TONE[tone])} />
          {label}
        </span>
      ))}
      {pending && (
        <span className="inline-flex items-center gap-1.5">
          <i aria-hidden className={cn("inline-block size-3.5 rounded", PENDING_CELL)} />
          Waiting for approval
        </span>
      )}
    </div>
  );
}

/**
 * A brand's cell for a role: the people shown (the proposed ones when the month has a plan
 * version waiting for approval), the approved ones, and whether they differ.
 */
export function teamCell(b: Pick<BrandSummary, "roles" | "pending">, role: string): { current: string[]; approved: string[]; pending: boolean } {
  const approved = (b.roles[role] ?? []).map((p) => p._id);
  if (!b.pending) return { current: approved, approved, pending: false };
  const proposed = (b.pending.roles[role] ?? []).map((p) => p._id);
  const same = [...approved].sort().join(",") === [...proposed].sort().join(",");
  return { current: proposed, approved, pending: !same };
}

/**
 * A person's name for the Brands pages: the names the server sent (plan, pending plan, leads),
 * the people map, then anyone assignable (someone just picked via the full list) — never "Unknown"
 * for a real person.
 */
export function useNameOf(names: Record<string, string> | undefined, people: Record<string, BrandPersonLoad> | undefined, extra?: (id: string) => string | undefined) {
  const everyone = useAssignableUsers(true);
  const byId = useMemo(() => new Map((everyone.data ?? []).map((u) => [u._id, u.name])), [everyone.data]);
  return useCallback(
    (id: string) => names?.[id] ?? people?.[id]?.name ?? extra?.(id) ?? byId.get(id) ?? "Unknown",
    [names, people, extra, byId],
  );
}

/** "version 10 (latest approved) · version 13 waiting for approval". */
export function planVersionText(planVersion: number | null, pending: PendingPlanInfo | null | undefined): string {
  const approved = planVersion ? `version ${planVersion} (latest approved)` : "no approved plan yet";
  return pending ? `${approved} · version ${pending.version} waiting for approval` : approved;
}

/** "Plan changes waiting for approval — version 13 by Nazeer, 20 Oct 4:04 PM (View request)". */
export function PendingPlanBanner({ pending, savesApproved, className }: { pending: PendingPlanInfo; savesApproved?: boolean; className?: string }) {
  return (
    <div role="status" className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-foreground", className)}>
      <LuHourglass aria-hidden className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <span>
        <span className="font-medium">Plan changes waiting for approval</span> — version {pending.version}
        {pending.by ? ` by ${pending.by.name}` : ""}, {formatDate(pending.at)} {formatTimeOfDay(pending.at)}
        {pending.note ? <span className="text-muted-foreground"> · {pending.note}</span> : null}
      </span>
      {pending.changeRequestId && (
        <Link to={`/approvals/${pending.changeRequestId}`} className="text-primary underline underline-offset-2">
          View request
        </Link>
      )}
      <span className="w-full text-xs text-muted-foreground">
        Cells with a dashed amber outline show the proposed people.
        {savesApproved
          ? " Your changes are approved at once; the waiting changes are kept on top of them."
          : " Your changes are added to the ones waiting."}
      </span>
    </div>
  );
}

export interface CellOption {
  id: string;
  name: string;
  /** Brands the person is on this month. */
  brands: number;
}

export function cellTone(people: string[], need: boolean, brandsOf: (id: string) => number, max: number): CellTone {
  if (people.length === 0) return need ? "miss" : "na";
  return people.some((id) => brandsOf(id) > max) ? "load" : "ok";
}

/**
 * One allocation cell. Read-only cells only show the colour and names; editable
 * ones become an inline select when clicked.
 */
export function AllocCell({
  label,
  people,
  nameOf,
  options,
  tone,
  editable,
  onChange,
  edited,
  brandsOf,
  pending,
  approved,
}: {
  /** "Designer for Ajmal GCC" (select label). */
  label: string;
  people: string[];
  nameOf: (id: string) => string;
  /** People offered (least busy first). */
  options: CellOption[];
  tone: CellTone;
  editable: boolean;
  onChange: (ids: string[]) => void;
  /** Changed and not saved yet. */
  edited?: boolean;
  /** Brands a person is on (for people outside the pool). */
  brandsOf?: (id: string) => number;
  /** The people shown are proposed by a plan version waiting for approval (they differ from `approved`). */
  pending?: boolean;
  /** The approved people (shown in the title of a pending cell). */
  approved?: string[];
}) {
  const [open, setOpen] = useState(false);
  const text = people.length ? people.map((id) => firstName(nameOf(id))).join(", ") : tone === "miss" ? "nobody" : "—";
  const names = people.length ? people.map((id) => nameOf(id)).join("\n") : tone === "miss" ? "Needed by the scope" : "";
  const title = pending
    ? `⏳ Waiting for approval\nProposed: ${people.length ? people.map((id) => nameOf(id)).join(", ") : "nobody"}\nApproved: ${approved?.length ? approved.map((id) => nameOf(id)).join(", ") : "nobody"}`
    : names;
  const cls = cn(
    "block min-w-[5.5rem] max-w-[14rem] truncate rounded-md px-2 py-1 text-left text-xs",
    CELL_TONE[tone],
    pending && PENDING_CELL,
    edited && "ring-2 ring-primary/60",
  );
  const shown = pending ? `⏳ ${text}` : text;
  if (!editable) {
    return (
      <span className={cls} title={title}>
        {shown}
      </span>
    );
  }
  if (open) {
    return (
      <PersonPicker
        label={label}
        people={people}
        nameOf={nameOf}
        options={options}
        brandsOf={brandsOf}
        className={cn(CELL_TONE[tone], "block rounded-md")}
        onChange={onChange}
        onClose={() => setOpen(false)}
      />
    );
  }
  return (
    <button
      type="button"
      className={cn(cls, "cursor-pointer hover:brightness-95")}
      title={title || "Click to choose"}
      aria-label={`${label}: ${people.length ? people.map(nameOf).join(", ") : "nobody"}${pending ? " (waiting for approval)" : ""}. Change`}
      onClick={() => setOpen(true)}
    >
      {shown}
    </button>
  );
}

/**
 * The open state of a cell: a searchable list right in the cell (no pop-up).
 * People already in the cell first (✓), then the plan pool least busy first,
 * then everyone else. Click / Enter toggles a person; Escape or leaving closes.
 */
export function PersonPicker({
  label,
  people,
  nameOf,
  options,
  brandsOf,
  className,
  onChange,
  onClose,
  showBrands = true,
  children,
}: {
  label: string;
  people: string[];
  nameOf: (id: string) => string;
  options: CellOption[];
  brandsOf?: (id: string) => number;
  className: string;
  onChange: (ids: string[]) => void;
  onClose: () => void;
  /** "· N brands" after each name (Brands views); off on the Manpower page. */
  showBrands?: boolean;
  /** Extra fields under the list (Manpower page: not needed, open slots, note); part of the picker for closing. */
  children?: ReactNode;
}) {
  const everyone = useAssignableUsers(true);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const list = useMemo(() => {
    const seen = new Set<string>();
    const out: CellOption[] = [];
    const push = (o: CellOption) => {
      if (seen.has(o.id)) return;
      seen.add(o.id);
      out.push(o);
    };
    for (const id of people) push(options.find((o) => o.id === id) ?? { id, name: nameOf(id), brands: brandsOf?.(id) ?? 0 });
    for (const o of options) push(o);
    const rest = (everyone.data ?? [])
      .filter((u) => !seen.has(u._id))
      .map((u) => ({ id: u._id, name: u.name, brands: brandsOf?.(u._id) ?? 0 }))
      .sort((a, b) => a.brands - b.brands || a.name.localeCompare(b.name));
    for (const o of rest) push(o);
    const term = q.trim().toLowerCase();
    return term ? out.filter((o) => o.name.toLowerCase().includes(term)) : out;
  }, [people, options, everyone.data, q, nameOf, brandsOf]);
  // Row 0 = "Nobody"; rows 1.. = people.
  const rows = list.length + 1;
  const toggle = (id: string | null) => {
    if (id === null) onChange([]);
    else onChange(people.includes(id) ? people.filter((x) => x !== id) : [...people, id]);
  };

  return (
    <div
      className={cn(className, "w-56 space-y-1 p-1")}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onClose();
      }}
    >
      <input
        autoFocus
        type="text"
        role="combobox"
        aria-label={label}
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={`${listId}-${active}`}
        placeholder="Search people…"
        value={q}
        className="w-full rounded border bg-background px-1.5 py-0.5 text-xs text-foreground"
        onChange={(e) => {
          setQ(e.target.value);
          setActive(e.target.value ? 1 : 0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(rows - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            toggle(active === 0 ? null : (list[active - 1]?.id ?? null));
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <ul id={listId} role="listbox" aria-multiselectable className="max-h-48 overflow-y-auto rounded border bg-background text-xs text-foreground">
        {[null, ...list].map((o, i) => {
          const on = o ? people.includes(o.id) : people.length === 0;
          return (
            <li
              key={o?.id ?? "__none"}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={on}
              className={cn("flex cursor-pointer items-center gap-1 px-1.5 py-0.5", i === active && "bg-muted", !o && "italic text-muted-foreground")}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => toggle(o?.id ?? null)}
            >
              <span aria-hidden className="w-3 shrink-0">{o && on ? "✓" : ""}</span>
              {o ? (
                <span className="truncate">
                  {o.name}
                  {showBrands && <span className="text-muted-foreground"> · {o.brands} brand{o.brands === 1 ? "" : "s"}</span>}
                </span>
              ) : (
                "Nobody"
              )}
            </li>
          );
        })}
        {list.length === 0 && <li className="px-1.5 py-0.5 text-muted-foreground">{everyone.isPending ? "Loading people…" : "No one matches"}</li>}
      </ul>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unsaved cell edits → one new manpower plan version (the Manpower page's save path).
// ---------------------------------------------------------------------------

type BrandInfo = { name: string; isPitch: boolean };

/** Applies (brand, role) → people edits to the plan's rows; a brand without a line gets one. */
export function applyCellEdits(rows: ManpowerRowInput[], edits: Record<string, string[]>, brands: Map<string, BrandInfo>): ManpowerRowInput[] {
  const out = rows.map((r) => ({ ...r, cells: r.cells.map((c) => ({ ...c, users: [...c.users], placeholders: [...c.placeholders] })) }));
  for (const [key, ids] of Object.entries(edits)) {
    const [brandId, role] = key.split("|") as [string, string];
    let lines = out.filter((r) => r.brand === brandId);
    if (lines.length === 0) {
      if (ids.length === 0) continue;
      const b = brands.get(brandId);
      const row: ManpowerRowInput = { key: newRowKey(), section: b?.isPitch ? "pitch" : "active", brand: brandId, type: null, name: (b?.name ?? "Brand").slice(0, 120), cells: [] };
      out.push(row);
      lines = [row];
    }
    const want = new Set(ids);
    for (const line of lines) {
      const cell = line.cells.find((c) => c.role === role);
      if (cell) cell.users = cell.users.filter((u) => want.has(u));
    }
    const present = new Set(lines.flatMap((l) => l.cells.find((c) => c.role === role)?.users ?? []));
    const missing = ids.filter((id) => !present.has(id));
    if (missing.length) {
      const target = lines.find((l) => l.cells.some((c) => c.role === role)) ?? lines[0]!;
      let cell = target.cells.find((c) => c.role === role);
      if (!cell) {
        cell = { role, users: [], placeholders: [], notNeeded: false, note: "" };
        target.cells.push(cell);
      }
      cell.users.push(...missing);
    }
    for (const line of lines) {
      const cell = line.cells.find((c) => c.role === role);
      if (cell?.users.length) cell.notNeeded = false;
    }
  }
  return out;
}

/**
 * Cell edits for one month: `get(brand, role, current)` gives the people shown,
 * `set` records a change, `save()` writes one plan version (approval rules as on
 * the Manpower page). `fromPending`: the version waiting for approval when the
 * viewer's saves wait for approval too — their edits are made on it (base = that
 * version), so what they changed before stays and adds up.
 */
export function usePlanEdits(month: string, enabled: boolean, fromPending: number | null = null) {
  const latest = useManpowerPlan(month, null, enabled && fromPending === null);
  const pendingPlan = useManpowerPlan(month, fromPending, enabled && fromPending !== null);
  const plan = fromPending !== null ? pendingPlan : latest;
  const save = useSaveManpowerPlan();
  const [edits, setEdits] = useState<Record<string, string[]>>({});
  const [original, setOriginal] = useState<Record<string, string[]>>({});
  const count = Object.keys(edits).length;
  // 404 = no plan for the month yet: the first save creates version 1.
  const noPlan = (plan.error as { response?: { status?: number } } | null)?.response?.status === 404;
  const loaded = Boolean(plan.data && plan.data.month === month && (fromPending === null || plan.data.version === fromPending));
  const ready = loaded || noPlan;

  const api = useMemo(
    () => ({
      get: (brand: string, role: string, current: string[]) => edits[`${brand}|${role}`] ?? current,
      isEdited: (brand: string, role: string) => `${brand}|${role}` in edits,
      set: (brand: string, role: string, current: string[], ids: string[]) => {
        const key = `${brand}|${role}`;
        const base = key in original ? original[key]! : current;
        if (!(key in original)) setOriginal((o) => ({ ...o, [key]: current }));
        const same = [...base].sort().join(",") === [...ids].sort().join(",");
        setEdits((e) => {
          const next = { ...e };
          if (same) delete next[key];
          else next[key] = ids;
          return next;
        });
      },
      /** Extra / fewer brands per person from the unsaved edits (for the "· N brands" counts). */
      brandDelta: (id: string, onBrand: (brand: string) => boolean) => {
        let d = 0;
        const touched = new Set(Object.keys(edits).map((k) => k.split("|")[0]!));
        for (const brand of touched) {
          const now = Object.entries(edits).some(([k, ids]) => k.startsWith(`${brand}|`) && ids.includes(id));
          const before = onBrand(brand);
          if (now && !before) d++;
          // Taken off every edited role of a brand they were on (other roles may still hold them).
          if (!now && before && Object.entries(original).some(([k, ids]) => k.startsWith(`${brand}|`) && ids.includes(id))) {
            const stillElsewhere = Object.entries(original).some(([k, ids]) => k.startsWith(`${brand}|`) && !(k in edits) && ids.includes(id));
            if (!stillElsewhere) d--;
          }
        }
        return d;
      },
    }),
    [edits, original],
  );

  function reset() {
    setEdits({});
    setOriginal({});
  }

  function submit(brands: Map<string, BrandInfo>, note: string, onDone?: () => void) {
    if (!ready || count === 0) return;
    const base = loaded ? plan.data! : null;
    const rows = base ? base.plan.rows.map(rowToInput) : [];
    save.mutate(
      { month, baseVersion: base ? (fromPending ?? base.latestVersion) : null, rows: applyCellEdits(rows, edits, brands), note },
      {
        onSuccess: () => {
          reset();
          onDone?.();
        },
      },
    );
  }

  return { ...api, count, ready, plan, save, submit, reset };
}

/** Sticky "Save changes (n)" bar for unsaved cell edits. */
export function SaveBar({ count, saving, ready, onSave, onReset, hint }: { count: number; saving: boolean; ready: boolean; onSave: () => void; onReset: () => void; hint?: string }) {
  if (count === 0) return null;
  return (
    <div className="sticky bottom-3 z-20 mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card/95 p-3 shadow-lg backdrop-blur">
      <p className="text-sm">
        <span className="font-medium">{count} unsaved change{count === 1 ? "" : "s"}</span>
        <span className="ml-2 text-xs text-muted-foreground">{hint ?? "Saved as a new version of the manpower plan — the same data as the Manpower page."}</span>
      </p>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onReset} disabled={saving}>
          <LuUndo2 aria-hidden /> Discard
        </Button>
        <Button type="button" size="sm" onClick={onSave} disabled={saving || !ready}>
          {saving ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuSave aria-hidden />}
          Save changes ({count})
        </Button>
      </div>
    </div>
  );
}
