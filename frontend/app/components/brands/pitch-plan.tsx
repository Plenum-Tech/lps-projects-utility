import { Fragment, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router";
import {
  LuCalendarClock,
  LuChevronDown,
  LuCircleCheck,
  LuCircleSlash,
  LuExternalLink,
  LuFileSpreadsheet,
  LuFileUp,
  LuLoaderCircle,
  LuMessageSquareText,
  LuPencil,
  LuPlus,
  LuPresentation,
  LuRotateCcw,
} from "react-icons/lu";

import { CELL_TONE, PersonPicker, type CellTone } from "@/components/brands/alloc-cell";
import { PitchImportDialog } from "@/components/brands/pitch-import-dialog";
import { PitchOutcomeDialog, type PitchOutcomeMode, type PitchOutcomeTarget } from "@/components/brands/pitch-outcome-dialog";
import { shortName } from "@/components/brands/brands-dashboard";
import { EmptyState, PageHeader, QueryError } from "@/components/globals/query-states";
import { ProjectFormDialog } from "@/components/projects/project-form-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { PitchEditError, usePitchEdit, usePitchOutcome, usePitches, usePitchesExport, type PitchEdit } from "@/hooks/use-brand-dashboard";
import { getErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { PitchRow, PitchStepKey, PitchTone } from "@/types";

// ---------------------------------------------------------------------------
// Pitch & Growth Tracker (/pitches): pitches / proactive projects by month, laid out like the
// Manpower plan grid. Dates, revenue, lead and end date edit in the cell (no
// pop-up) for leadership, Nazeer and the pitch's lead / manager; a step cell opens
// a menu to record its outcome (Held / Not held with notes, Rescheduled). The status
// comes from the pitch's three tasks (Milestone 1 meeting, Milestone 2 meeting,
// Client presentation); a missed date is emailed once to lead, manager and leadership.
// ---------------------------------------------------------------------------

/** "2026-Q4" for today (browser date). */
export function thisQuarter(): string {
  const now = new Date();
  return `${now.getFullYear()}-Q${Math.floor(now.getMonth() / 3) + 1}`;
}

export const isQuarter = (value: string | null): value is string => /^\d{4}-Q[1-4]$/.test(value ?? "");

function shiftQuarter(quarter: string, by: number): string {
  const index = Number(quarter.slice(0, 4)) * 4 + Number(quarter.slice(6)) - 1 + by;
  return `${Math.floor(index / 4)}-Q${(index % 4) + 1}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const quarterLabel = (q: string) => `${q.slice(5)} ${q.slice(0, 4)}`;
const quarterOption = (q: string) => {
  const first = (Number(q.slice(6)) - 1) * 3;
  return `${quarterLabel(q)} · ${MONTHS[first]} – ${MONTHS[first + 2]}`;
};
/** "2026-10-20" → "20 Oct 2026" — the one date format of the plan, its Excel and emails. */
export const pitchDate = (key: string) => `${Number(key.slice(8, 10))} ${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
const groupLabel = (group: string | null) => (group ? `${MONTHS_LONG[Number(group.slice(5, 7)) - 1]} ${group.slice(0, 4)}` : "Dates not set");
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const aed = (n: number) => `AED ${n.toLocaleString("en-US")}`;
const aedShort = (n: number) => (n >= 1_000_000 ? `AED ${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M` : n >= 1000 ? `AED ${Math.round(n / 1000)}K` : aed(n));

const STEP_COLUMNS: Array<{ key: PitchStepKey; label: string }> = [
  { key: "milestone1", label: "Milestone 1 meeting" },
  { key: "milestone2", label: "Milestone 2 meeting" },
  { key: "clientPresentation", label: "Client presentation" },
];

const TONE: Record<CellTone | "plain", string> = { ...CELL_TONE, plain: "bg-transparent text-foreground" };
const DOT: Record<PitchTone, string> = {
  ok: "bg-emerald-600 dark:bg-emerald-400",
  done: "bg-emerald-600 dark:bg-emerald-400",
  soon: "bg-amber-500",
  missed: "bg-red-600 dark:bg-red-400",
  none: "bg-muted-foreground",
};
const STATUS_TEXT: Record<PitchTone, string> = {
  ok: "text-foreground",
  done: "text-emerald-800 dark:text-emerald-300",
  soon: "text-amber-800 dark:text-amber-300",
  missed: "text-red-800 dark:text-red-300",
  none: "text-muted-foreground",
};

type Show = "all" | "missed" | "week" | "nodates";

function stepTone(row: PitchRow, key: PitchStepKey, today: string): CellTone | "plain" {
  const s = row.steps.find((x) => x.key === key);
  if (s?.outcome === "not_held") return "na";
  if (s?.done) return "ok";
  if (!s?.due) return "na";
  const n = days(today, s.due);
  if (n < 0) return "miss";
  return n <= 2 ? "load" : "plain";
}

function stepText(row: PitchRow, key: PitchStepKey, today: string): ReactNode {
  const s = row.steps.find((x) => x.key === key);
  if (s?.outcome === "not_held") return `⊘ Not held${s.due ? ` · ${pitchDate(s.due)}` : ""}`;
  if (s?.done) return `✓ Held${s.due ? ` · ${pitchDate(s.due)}` : ""}`;
  if (!s?.due) return "—";
  const n = days(today, s.due);
  const tag = s.outcome === "rescheduled" && (
    <span className="ml-1 rounded bg-background/70 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground ring-1 ring-border">
      rescheduled
    </span>
  );
  if (n < 0)
    return (
      <>
        ✕ {pitchDate(s.due)} · missed{tag}
      </>
    );
  return (
    <>
      {pitchDate(s.due)}
      {n === 0 ? " · today" : n <= 2 ? ` · in ${n}d` : ""}
      {tag}
    </>
  );
}

/** Hover text for a step cell: its outcome note (and where a rescheduled date came from). */
function stepHint(row: PitchRow, key: PitchStepKey): string | undefined {
  const s = row.steps.find((x) => x.key === key);
  if (!s) return undefined;
  const parts: string[] = [];
  if (s.outcome === "not_held") parts.push(`Not held${s.outcomeNote ? `: ${s.outcomeNote}` : ""}`);
  else if (s.outcome === "held" && s.outcomeNote) parts.push(`Notes: ${s.outcomeNote}`);
  else if (s.outcome === "rescheduled") {
    parts.push(`Rescheduled${s.rescheduledFrom ? ` from ${pitchDate(s.rescheduledFrom)}` : ""}${s.outcomeNote ? `: ${s.outcomeNote}` : ""}`);
  }
  return parts.join("\n") || undefined;
}

/** The cell's editor, right in the cell: commits on Enter or when focus leaves it; Escape cancels. */
function EditBox({ onCommit, onCancel, children }: { onCommit: () => void; onCancel: () => void; children: ReactNode }) {
  return (
    <div
      className="flex items-center gap-1 rounded-md bg-muted p-0.5"
      // Clicking a label ("held", "TBC") must not take focus out of the cell (that would save and close it).
      onMouseDown={(e) => {
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onCommit();
      }}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      {children}
    </div>
  );
}

const inputCls = "h-6 rounded border bg-background px-1 text-xs text-foreground";

interface CellError {
  cell: string;
  message: string;
  taskId: string | null;
}

export function PitchPlan({ quarter, onQuarterChange, canImport = false }: { quarter: string; onQuarterChange: (quarter: string) => void; canImport?: boolean }) {
  const pitches = usePitches(quarter);
  const exporter = usePitchesExport();
  const edit = usePitchEdit(quarter);
  const outcomeSave = usePitchOutcome(quarter);
  const [outcome, setOutcome] = useState<PitchOutcomeTarget | null>(null);
  const [lead, setLead] = useState("all");
  const [show, setShow] = useState<Show>("all");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ date: string; held: boolean; amount: string; tbc: boolean; leads: string[] }>({ date: "", held: false, amount: "", tbc: false, leads: [] });
  const [error, setError] = useState<CellError | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [newPitch, setNewPitch] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const today = pitches.data?.today ?? new Date().toISOString().slice(0, 10);
  const all = useMemo(() => pitches.data?.rows ?? [], [pitches.data]);
  const leadOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of all) for (const l of r.leads) m.set(l.id, l.name);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [all]);
  const rows = useMemo(
    () =>
      all.filter((r) => {
        if (lead === "none" ? r.leads.length > 0 : lead !== "all" && !r.leads.some((l) => l.id === lead)) return false;
        if (show === "missed") return r.status.tone === "missed";
        if (show === "nodates") return r.status.tone === "none";
        if (show === "week") return r.steps.some((s) => s.due && !s.done && days(today, s.due) >= 0 && days(today, s.due) <= 6);
        return true;
      }),
    [all, lead, show, today],
  );
  const kpi = useMemo(() => {
    const revenue = rows.reduce((sum, r) => sum + (r.revenue ?? 0), 0);
    const tbc = rows.filter((r) => r.revenue === null && !r.revenueHidden).length;
    const missed = rows.filter((r) => r.status.tone === "missed");
    return {
      count: rows.length,
      revenue,
      tbc,
      onTime: rows.filter((r) => r.onTime === "on_time").length,
      missed: missed.length,
      emailed: missed.every((r) => r.status.missed.every((m) => m.emailed)),
      noDates: rows.filter((r) => r.status.tone === "none").length,
    };
  }, [rows]);

  function open(cell: string, row: PitchRow, key?: PitchStepKey) {
    const s = key ? row.steps.find((x) => x.key === key) : undefined;
    setError(null);
    setDraft({
      date: key ? (s?.due ?? "") : (row.deadline ?? ""),
      held: Boolean(s?.done),
      amount: row.revenue === null ? "" : String(row.revenue),
      tbc: row.revenue === null && row.revenueTbc,
      leads: row.leads.map((l) => l.id),
    });
    setEditing(cell);
  }

  function commit(cell: string, change: PitchEdit | null) {
    setEditing(null);
    if (!change) return;
    setSaving(cell);
    edit.mutate(change, {
      onError: (e) => setError({ cell, message: getErrorMessage(e), taskId: e instanceof PitchEditError ? e.taskId : null }),
      onSettled: () => setSaving(null),
    });
  }

  const cellError = (cell: string) =>
    error?.cell === cell ? (
      <p role="alert" className="mt-1 max-w-56 whitespace-normal text-[11px] leading-snug text-destructive">
        {error.message}{" "}
        {error.taskId && (
          <Link to={`/tasks?task=${error.taskId}`} className="font-medium underline underline-offset-2">
            Open the task
          </Link>
        )}
      </p>
    ) : null;

  const cellButton = (cell: string, tone: CellTone | "plain", text: ReactNode, editable: boolean, onOpen: () => void, label: string) => {
    const cls = cn("block w-full min-w-[6.5rem] whitespace-nowrap rounded-md px-2 py-1 text-left text-xs", TONE[tone]);
    if (!editable) return <span className={cls}>{text}</span>;
    return (
      <button type="button" className={cn(cls, "cursor-pointer hover:brightness-95 hover:ring-1 hover:ring-border")} onClick={onOpen} aria-label={`${label}. Edit`}>
        {saving === cell ? <LuLoaderCircle aria-hidden className="inline size-3 animate-spin" /> : text}
      </button>
    );
  };

  function stepCell(row: PitchRow, key: PitchStepKey, label: string) {
    const cell = `${row.id}:${key}`;
    const s = row.steps.find((x) => x.key === key);
    if (editing === cell) {
      return (
        <EditBox
          onCancel={() => setEditing(null)}
          onCommit={() => {
            const date = draft.date || null;
            // Held / not held go through the outcome menu; this editor only sets the date.
            commit(cell, date !== (s?.due ?? null) ? { kind: "step", row, step: key, date, held: Boolean(s?.done) } : null);
          }}
        >
          <input autoFocus type="date" aria-label={label} className={cn(inputCls, "w-32")} value={draft.date} onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))} />
        </EditBox>
      );
    }
    const hint = stepHint(row, key);
    // A step with its task: a menu of outcomes (Held / Not held / Rescheduled), plus the plain date edit.
    if (s?.taskId && s.canAct) {
      const cls = cn(
        "flex w-full min-w-[6.5rem] cursor-pointer items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-left text-xs hover:brightness-95 hover:ring-1 hover:ring-border focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        TONE[stepTone(row, key, today)],
      );
      const pick = (mode: PitchOutcomeMode) => setOutcome({ row, step: key, title: label, mode });
      return (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger className={cls} title={hint} aria-label={`${label} for ${row.title}${hint ? `. ${hint}` : ""}. Record the outcome`}>
              {saving === cell || (outcomeSave.isPending && outcomeSave.variables?.row.id === row.id && outcomeSave.variables.step === key) ? (
                <LuLoaderCircle aria-hidden className="inline size-3 animate-spin" />
              ) : (
                <span className="flex min-w-0 items-center">{stepText(row, key, today)}</span>
              )}
              {s.outcomeNote && <LuMessageSquareText aria-hidden className="size-3 shrink-0 opacity-70" />}
              <LuChevronDown aria-hidden className="ml-auto size-3 shrink-0 opacity-60" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-auto min-w-52 max-w-80">
              {hint && (
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="whitespace-pre-wrap text-xs font-normal text-muted-foreground">{hint}</DropdownMenuLabel>
                </DropdownMenuGroup>
              )}
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => pick("held")}>
                  <LuCircleCheck aria-hidden className="text-emerald-600 dark:text-emerald-400" />
                  {s.outcome === "held" ? "Held — edit notes…" : "Held…"}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => pick("not_held")}>
                  <LuCircleSlash aria-hidden className="text-muted-foreground" />
                  {s.outcome === "not_held" ? "Not held — edit reason…" : "Not held…"}
                </DropdownMenuItem>
                {!s.done && (
                  <DropdownMenuItem onClick={() => pick("rescheduled")}>
                    <LuCalendarClock aria-hidden />
                    Rescheduled…
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                {row.canEdit && !s.done && (
                  <DropdownMenuItem onClick={() => open(cell, row, key)}>
                    <LuPencil aria-hidden />
                    Correct the date
                  </DropdownMenuItem>
                )}
                {s.done && (
                  <DropdownMenuItem
                    onClick={() =>
                      outcomeSave.mutate(
                        { row, step: key, input: { outcome: "reopen" } },
                        { onError: (e) => setError({ cell, message: getErrorMessage(e), taskId: s.taskId }) },
                      )
                    }
                  >
                    <LuRotateCcw aria-hidden />
                    Reopen the step
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem render={<Link to={`/tasks?task=${s.taskId}`} />}>
                  <LuExternalLink aria-hidden />
                  Open the task
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          {cellError(cell)}
        </>
      );
    }
    const text = hint ? <span title={hint}>{stepText(row, key, today)}</span> : stepText(row, key, today);
    return (
      <>
        {cellButton(cell, stepTone(row, key, today), text, row.canEdit, () => open(cell, row, key), `${label} for ${row.title}${hint ? `. ${hint}` : ""}`)}
        {cellError(cell)}
      </>
    );
  }

  function revenueCell(row: PitchRow) {
    const cell = `${row.id}:revenue`;
    if (row.revenueHidden) return <span className="block px-2 text-xs text-muted-foreground">Hidden</span>;
    if (editing === cell) {
      return (
        <EditBox
          onCancel={() => setEditing(null)}
          onCommit={() => {
            const revenue = draft.tbc || draft.amount === "" ? null : Number(draft.amount);
            const changed = revenue !== row.revenue || draft.tbc !== (row.revenue === null && row.revenueTbc);
            commit(cell, changed ? { kind: "revenue", row, revenue, tbc: draft.tbc || revenue === null } : null);
          }}
        >
          <input autoFocus type="number" min={0} step={1000} placeholder="AED" aria-label="Potential revenue (AED)" className={cn(inputCls, "w-28")} value={draft.amount} disabled={draft.tbc} onChange={(e) => setDraft((d) => ({ ...d, amount: e.target.value }))} />
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <input type="checkbox" checked={draft.tbc} onChange={(e) => setDraft((d) => ({ ...d, tbc: e.target.checked }))} />
            TBC
          </label>
        </EditBox>
      );
    }
    return (
      <>
        {cellButton(cell, "plain", <span className="tabular-nums">{row.revenue === null ? "TBC" : aed(row.revenue)}</span>, row.canEdit, () => open(cell, row), `Potential revenue for ${row.title}`)}
        {cellError(cell)}
      </>
    );
  }

  function deadlineCell(row: PitchRow) {
    const cell = `${row.id}:deadline`;
    if (editing === cell) {
      return (
        <EditBox
          onCancel={() => setEditing(null)}
          onCommit={() => {
            const deadline = draft.date || null;
            commit(cell, deadline !== row.deadline ? { kind: "deadline", row, deadline } : null);
          }}
        >
          <input autoFocus type="date" aria-label="End date" className={cn(inputCls, "w-32")} value={draft.date} onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))} />
        </EditBox>
      );
    }
    return (
      <>
        {cellButton(cell, row.deadline ? "plain" : "na", row.deadline ? pitchDate(row.deadline) : "—", row.canEdit, () => open(cell, row), `End date for ${row.title}`)}
        {cellError(cell)}
      </>
    );
  }

  function leadCell(row: PitchRow) {
    const cell = `${row.id}:lead`;
    const names = new Map(row.leads.map((l) => [l.id, l.name]));
    if (editing === cell) {
      return (
        <PersonPicker
          label={`Lead for ${row.title}`}
          people={draft.leads}
          nameOf={(id) => names.get(id) ?? leadOptions.find(([lid]) => lid === id)?.[1] ?? "…"}
          options={[]}
          showBrands={false}
          className="block rounded-md bg-muted"
          onChange={(ids) => setDraft((d) => ({ ...d, leads: ids.slice(0, 3) }))}
          onClose={() => {
            const before = row.leads.map((l) => l.id);
            const changed = draft.leads.length !== before.length || draft.leads.some((id, i) => id !== before[i]);
            if (changed && draft.leads.length === 0) {
              setEditing(null);
              setError({ cell, message: "A pitch needs a lead.", taskId: null });
              return;
            }
            commit(cell, changed ? { kind: "leads", row, leads: draft.leads } : null);
          }}
        />
      );
    }
    const text = row.leads.length ? row.leads.map((l) => l.name.split(" ")[0]).join(" / ") : "No lead";
    return (
      <>
        {cellButton(cell, row.leads.length ? "plain" : "miss", text, row.canEdit, () => open(cell, row), `Lead for ${row.title}`)}
        {cellError(cell)}
      </>
    );
  }

  const groups = useMemo(() => {
    const out: Array<{ group: string | null; rows: PitchRow[] }> = [];
    for (const r of rows) {
      const last = out[out.length - 1];
      if (last && last.group === r.group) last.rows.push(r);
      else out.push({ group: r.group, rows: [r] });
    }
    return out;
  }, [rows]);

  const quarters = useMemo(() => {
    const base = thisQuarter();
    const list = Array.from({ length: 9 }, (_, i) => shiftQuarter(base, i - 4));
    return list.includes(quarter) ? list : [...list, quarter].sort();
  }, [quarter]);

  return (
    <div className="mx-auto w-full max-w-[96rem] space-y-3 p-4 md:p-6">
      <PageHeader
        title="Pitch & Growth Tracker"
        description="Pitches / proactive projects by month. Status comes from each pitch's tasks: the three are created automatically, others can be added."
      />

      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect aria-label="Quarter" value={quarter} onChange={(e) => onQuarterChange(e.target.value)}>
          {quarters.map((q) => (
            <NativeSelectOption key={q} value={q}>
              {quarterOption(q)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect aria-label="Lead" value={lead} onChange={(e) => setLead(e.target.value)}>
          <NativeSelectOption value="all">All leads</NativeSelectOption>
          {leadOptions.map(([id, name]) => (
            <NativeSelectOption key={id} value={id}>
              {name}
            </NativeSelectOption>
          ))}
          <NativeSelectOption value="none">No lead</NativeSelectOption>
        </NativeSelect>
        <NativeSelect aria-label="Show" value={show} onChange={(e) => setShow(e.target.value as Show)}>
          <NativeSelectOption value="all">All pitches</NativeSelectOption>
          <NativeSelectOption value="missed">Missed only</NativeSelectOption>
          <NativeSelectOption value="week">Due this week</NativeSelectOption>
          <NativeSelectOption value="nodates">No dates yet</NativeSelectOption>
        </NativeSelect>
        <span className="grow" />
        {canImport && (
          <Button type="button" variant="outline" onClick={() => setImportOpen(true)}>
            <LuFileUp aria-hidden /> Import pitch sheet
          </Button>
        )}
        <Button type="button" variant="outline" onClick={() => exporter.mutate(quarter)} disabled={exporter.isPending || all.length === 0}>
          {exporter.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuFileSpreadsheet aria-hidden />}
          Download Excel
        </Button>
        <Button type="button" onClick={() => setNewPitch(true)}>
          <LuPlus aria-hidden /> New pitch
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-5">
        {[
          { value: String(kpi.count), label: `Pitches in ${quarterLabel(quarter)}`, cls: "" },
          { value: aedShort(kpi.revenue), label: `Potential revenue${kpi.tbc ? ` (${kpi.tbc} TBC)` : ""}`, cls: "" },
          { value: String(kpi.onTime), label: "On time", cls: "text-emerald-700 dark:text-emerald-400" },
          { value: String(kpi.missed), label: kpi.missed ? `Missed a date${kpi.emailed ? " · email sent" : " · email pending"}` : "Missed a date", cls: "text-red-700 dark:text-red-400" },
          { value: String(kpi.noDates), label: "No dates yet", cls: "text-muted-foreground" },
        ].map((k) => (
          <div key={k.label} className="rounded-xl border bg-card px-3 py-2.5 text-card-foreground">
            <p className={cn("text-2xl font-bold tracking-tight tabular-nums", k.cls)}>{k.value}</p>
            <p className="text-xs text-muted-foreground">{k.label}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-3.5 text-xs text-muted-foreground">
        {(
          [
            ["ok", "Held / done"],
            ["na", "Not held · no date"],
            ["load", "Due within 2 days"],
            ["miss", "Missed (not held / not closed) · no lead"],
            ["plain", "Upcoming"],
          ] as const
        ).map(([tone, label]) => (
          <span key={tone} className="inline-flex items-center gap-1.5">
            <i aria-hidden className={cn("inline-block size-3 rounded-[3px]", TONE[tone], tone === "plain" && "border")} />
            {label}
          </span>
        ))}
      </div>

      {pitches.error ? (
        <QueryError title="Couldn't load the pitches" error={pitches.error} onRetry={() => void pitches.refetch()} retrying={pitches.isFetching} />
      ) : pitches.isPending ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={LuPresentation}
          title={all.length ? "No pitches match the filters" : `No pitches in ${quarterLabel(quarter)}`}
          description="A pitch shows here when its month or one of its dates falls in the quarter."
        />
      ) : (
        <div className={cn("overflow-x-auto rounded-xl border bg-card", pitches.isFetching && "opacity-80")}>
          <table className="w-full min-w-[78rem] border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                {["Client / brand · Project", "Potential revenue", ...STEP_COLUMNS.map((c) => c.label), "End date", "Lead", "Open tasks", "On time", "Status"].map((h, i) => (
                  <th
                    key={h}
                    scope="col"
                    className={cn("whitespace-nowrap border-b bg-card px-2 py-2 font-semibold", i > 0 && "border-l", i === 0 && "sticky left-0 z-20 min-w-64")}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.group ?? "none"}>
                  <tr className="bg-muted/60 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                    <td className="sticky left-0 z-10 border-b bg-muted px-2 py-1.5">
                      {groupLabel(g.group)} · {g.rows.length}
                    </td>
                    <td colSpan={9} className="border-b bg-muted/60" />
                  </tr>
                  {g.rows.map((row) => {
                    const org = row.brand?.organisation ?? "";
                    const sameAsOrg = !org || row.brand!.name.trim().toLowerCase() === org.trim().toLowerCase();
                    return (
                      <tr key={row.id} className="align-middle [&>td]:border-b [&>td+td]:border-l">
                        <td className="sticky left-0 z-10 min-w-64 bg-card px-2 py-1.5">
                          <div className="text-sm">
                            {!sameAsOrg && <span className="text-[11px] text-muted-foreground">{org} › </span>}
                            {row.brand ? (
                              <Link to={`/brands/${row.brand.id}`} className="font-semibold hover:underline">
                                {sameAsOrg ? row.brand.name : shortName(row.brand.name, org)}
                              </Link>
                            ) : (
                              <span className="font-semibold">{row.name.split("_")[0]}</span>
                            )}
                          </div>
                          <Link to={`/projects/${row.id}`} className="block max-w-72 truncate text-xs text-primary hover:underline" title={row.name}>
                            {row.name}
                          </Link>
                        </td>
                        <td className="px-1.5 py-1">{revenueCell(row)}</td>
                        {STEP_COLUMNS.map((c) => (
                          <td key={c.key} className="px-1.5 py-1">
                            {stepCell(row, c.key, c.label)}
                          </td>
                        ))}
                        <td className="px-1.5 py-1">{deadlineCell(row)}</td>
                        <td className="px-1.5 py-1">{leadCell(row)}</td>
                        <td className="px-2 py-1 text-center tabular-nums">{row.openTasks}</td>
                        <td className="px-2 py-1">
                          <span className={cn("inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold", row.onTime === "late" ? CELL_TONE.miss : row.onTime === "on_time" ? CELL_TONE.ok : CELL_TONE.na)}>
                            {row.onTime === "late" ? "Late" : row.onTime === "on_time" ? "On time" : "—"}
                          </span>
                        </td>
                        <td className="min-w-72 px-2 py-1.5 text-xs">
                          <p className={cn("flex items-start gap-1.5 font-semibold", STATUS_TEXT[row.status.tone])}>
                            <i aria-hidden className={cn("mt-1 size-2 shrink-0 rounded-full", DOT[row.status.tone])} />
                            <span>{row.status.text}</span>
                          </p>
                          {row.note && <p className="mt-0.5 pl-3.5 text-[11px] text-muted-foreground">{row.note}</p>}
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-muted font-semibold">
                <td className="sticky left-0 z-10 bg-muted px-2 py-2">
                  {kpi.count} pitch{kpi.count === 1 ? "" : "es"}
                </td>
                <td className="border-l px-2 py-2 tabular-nums">{aed(kpi.revenue)}</td>
                <td colSpan={8} className="border-l px-2 py-2 text-xs font-normal text-muted-foreground">
                  {kpi.tbc ? `${kpi.tbc} TBC not counted` : "Known revenue only"}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <ProjectFormDialog open={newPitch} onOpenChange={setNewPitch} defaultType="Pitch" pitch />
      {canImport && <PitchImportDialog open={importOpen} onOpenChange={setImportOpen} />}
      <PitchOutcomeDialog target={outcome} quarter={quarter} onClose={() => setOutcome(null)} />
    </div>
  );
}
