import {
  formatDate as formatSettingsDate,
  formatDateOnly as formatSettingsDateOnly,
  formatDateTime as formatSettingsDateTime,
} from "@/lib/format";
import type {
  LabelColor,
  Role,
  Task,
  TaskPriority,
  TaskStatus,
} from "@/types";

/* ------------------------------------------------------------------ */
/* Status / priority metadata                                          */
/* ------------------------------------------------------------------ */

export const TASK_STATUSES: TaskStatus[] = [
  "todo",
  "in_progress",
  "in_review",
  "completed",
  "rejected",
];

export const STATUS_META: Record<
  TaskStatus,
  {
    label: string;
    /** Theme-token classes for the small status dot / column accent. */
    dot: string;
    badge: "default" | "secondary" | "destructive" | "outline";
  }
> = {
  todo: { label: "To do", dot: "bg-muted-foreground", badge: "outline" },
  in_progress: { label: "In progress", dot: "bg-chart-2", badge: "secondary" },
  in_review: { label: "In review", dot: "bg-chart-4", badge: "default" },
  completed: { label: "Completed", dot: "bg-primary", badge: "secondary" },
  rejected: { label: "Rejected", dot: "bg-destructive", badge: "destructive" },
};

/** Calendar chip / inline-status tints per task status (theme tokens only). */
export const STATUS_CHIP: Record<TaskStatus, string> = {
  todo: "bg-muted border-border",
  in_progress: "bg-chart-2/15 border-chart-2/30",
  in_review: "bg-chart-4/15 border-chart-4/30",
  completed: "bg-primary/15 border-primary/30",
  rejected: "bg-destructive/10 border-destructive/30",
};

export const PRIORITIES: TaskPriority[] = ["low", "medium", "high", "urgent"];

export const PRIORITY_META: Record<TaskPriority, { label: string; dot: string; text: string }> = {
  low: { label: "Low", dot: "bg-muted-foreground/60", text: "text-muted-foreground" },
  medium: { label: "Medium", dot: "bg-chart-2", text: "text-foreground" },
  high: { label: "High", dot: "bg-chart-4", text: "text-foreground" },
  urgent: { label: "Urgent", dot: "bg-destructive", text: "text-destructive" },
};

/* ------------------------------------------------------------------ */
/* Label colours — theme tokens only (static class names for Tailwind) */
/* ------------------------------------------------------------------ */

export const LABEL_COLORS: LabelColor[] = [
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "primary",
  "secondary",
  "accent",
  "muted",
  "destructive",
];

export const LABEL_COLOR_META: Record<LabelColor, { name: string; dot: string; chip: string }> = {
  "chart-1": { name: "Teal", dot: "bg-chart-1", chip: "bg-chart-1/15 border-chart-1/30" },
  "chart-2": { name: "Sky", dot: "bg-chart-2", chip: "bg-chart-2/15 border-chart-2/30" },
  "chart-3": { name: "Indigo", dot: "bg-chart-3", chip: "bg-chart-3/15 border-chart-3/30" },
  "chart-4": { name: "Amber", dot: "bg-chart-4", chip: "bg-chart-4/15 border-chart-4/30" },
  "chart-5": { name: "Coral", dot: "bg-chart-5", chip: "bg-chart-5/15 border-chart-5/30" },
  primary: { name: "Primary", dot: "bg-primary", chip: "bg-primary/15 border-primary/30" },
  secondary: {
    name: "Secondary",
    dot: "bg-secondary-foreground/50",
    chip: "bg-secondary border-border",
  },
  accent: { name: "Accent", dot: "bg-accent-foreground/60", chip: "bg-accent border-border" },
  muted: { name: "Muted", dot: "bg-muted-foreground", chip: "bg-muted border-border" },
  destructive: {
    name: "Red",
    dot: "bg-destructive",
    chip: "bg-destructive/10 border-destructive/30",
  },
};

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

/** "YYYY-MM-DD" for an API date-only value (UTC midnight ISO) — empty when null. */
export function toDateInput(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "";
}

/** Today's local calendar date as "YYYY-MM-DD". */
export function todayKey(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Formats a date-only API value (read by its date part so the day never
 * shifts). With a year it follows the configured date format (Settings → App);
 * without one it stays a compact "Oct 6".
 */
export function formatDateOnly(iso: string | null | undefined, withYear = false): string {
  if (!iso) return "—";
  if (withYear) return formatSettingsDateOnly(iso);
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Configured date format (default DD-MM-YYYY) for a date-only API value; fallback when empty. */
export function formatDMY(iso: string | null | undefined, fallback = "--"): string {
  return formatSettingsDateOnly(iso, fallback);
}

/** Configured date format for a timestamp, in the viewer's timezone (e.g. completedAt). */
export function formatTimestampDMY(iso: string | null | undefined, fallback = "--"): string {
  return formatSettingsDate(iso, fallback);
}

/** Formats a full timestamp in the viewer's timezone (configured date + clock). */
export function formatDateTime(iso: string): string {
  return formatSettingsDateTime(iso);
}

export function isOverdue(task: Pick<Task, "dueDate" | "status">): boolean {
  return Boolean(
    task.dueDate && task.status !== "completed" && toDateInput(task.dueDate) < todayKey()
  );
}

export function isDueToday(task: Pick<Task, "dueDate" | "status">): boolean {
  return Boolean(
    task.dueDate && task.status !== "completed" && toDateInput(task.dueDate) === todayKey()
  );
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** Display code: "PEAR-12", "#42" for standalone tasks, "" before the migration. */
export function taskCode(task: Pick<Task, "shortCode" | "number">): string {
  if (task.shortCode) return task.shortCode;
  return task.number ? `#${task.number}` : "";
}

/** Effort: 150 → "2h 30m", 65 → "1h 05m", 45 → "45m", 0 → "0s". */
export function formatEffort(minutes: number | null | undefined): string {
  const total = Math.max(0, Math.round(minutes ?? 0));
  if (total === 0) return "0s";
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${String(rest).padStart(2, "0")}m`;
}

export const MAX_ESTIMATE_MINUTES = 100_000;

/**
 * Hours + minutes inputs → minutes. Both empty → null (no estimate);
 * "invalid" for negatives, non-integers or values over the limit.
 */
export function parseEstimate(hours: string, minutes: string): number | null | "invalid" {
  if (hours.trim() === "" && minutes.trim() === "") return null;
  const h = hours.trim() === "" ? 0 : Number(hours);
  const m = minutes.trim() === "" ? 0 : Number(minutes);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0 || m > 59) return "invalid";
  const total = h * 60 + m;
  return total > MAX_ESTIMATE_MINUTES ? "invalid" : total;
}

/** Minutes → `{ hours, minutes }` strings for the estimate inputs. */
export function splitEstimate(total: number | null | undefined): { hours: string; minutes: string } {
  if (total === null || total === undefined) return { hours: "", minutes: "" };
  return { hours: String(Math.floor(total / 60)), minutes: String(total % 60) };
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function describeRecurrence(recurrence: {
  every: number;
  unit: "day" | "week" | "month";
  cycles: number;
}): string {
  const unit = recurrence.every === 1 ? recurrence.unit : `${recurrence.unit}s`;
  const every = recurrence.every === 1 ? `Every ${unit}` : `Every ${recurrence.every} ${unit}`;
  return recurrence.cycles === -1
    ? `${every}, forever`
    : `${every}, ${recurrence.cycles} time${recurrence.cycles === 1 ? "" : "s"}`;
}

/* ------------------------------------------------------------------ */
/* Board move rules (mirrors the backend; the server still validates)  */
/* ------------------------------------------------------------------ */

const ASSIGNEE_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: ["in_progress"],
  in_progress: ["todo", "in_review"],
  in_review: ["in_progress"],
  rejected: ["in_progress"],
  completed: [],
};

/**
 * Columns the current user may drop `task` into (the task's own column is
 * included when they may reorder it). Empty = the card is not draggable.
 */
export function allowedDropStatuses(
  task: Pick<Task, "status" | "assignedBy" | "assignees" | "project">,
  user: { _id: string; role: Role }
): TaskStatus[] {
  // Tasks of archived projects are read-only.
  if (task.project?.archivedAt) return [];
  // Projects without task approval (mirrors the server): To do / In progress /
  // Completed only, and Completed can be chosen from any status.
  const skipReview = task.project?.requireTaskApproval === false;
  const isCreator = task.assignedBy?._id === user._id;
  if (user.role === "admin" || isCreator) {
    if (skipReview) return ["todo", "in_progress", "completed"];
    return TASK_STATUSES.filter(
      (status) =>
        status === task.status ||
        (status !== "completed" && status !== "rejected") ||
        task.status === "in_review"
    );
  }
  const isAssignee = task.assignees.some((assignee) => assignee._id === user._id);
  if (!isAssignee) return [];
  if (skipReview) {
    return task.status === "completed" ? ["completed"] : ["todo", "in_progress", "completed"];
  }
  return [task.status, ...ASSIGNEE_TRANSITIONS[task.status]];
}

/**
 * Fractional board position for inserting between neighbours (see the API
 * contract): midpoint, or ±1024 at the ends; undefined for an empty column.
 */
export function positionBetween(prev?: number, next?: number): number | undefined {
  if (prev !== undefined && next !== undefined) return (prev + next) / 2;
  if (next !== undefined) return next - 1024;
  if (prev !== undefined) return prev + 1024;
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Mentions                                                            */
/* ------------------------------------------------------------------ */

/** Matches `@[Display Name](24-hex userId)` tokens in a comment body. */
export const MENTION_TOKEN = /@\[([^\]\n]+)\]\(([a-f0-9]{24})\)/g;

/** Splits a comment body into text and mention segments for rendering. */
export function parseMentions(
  body: string
): Array<{ type: "text"; value: string } | { type: "mention"; name: string; id: string }> {
  const parts: Array<
    { type: "text"; value: string } | { type: "mention"; name: string; id: string }
  > = [];
  let lastIndex = 0;
  for (const match of body.matchAll(MENTION_TOKEN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push({ type: "text", value: body.slice(lastIndex, index) });
    parts.push({ type: "mention", name: match[1], id: match[2] });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < body.length) parts.push({ type: "text", value: body.slice(lastIndex) });
  return parts;
}

/** A project's scope unit with its deliverables in use (GET /projects/:id/scope-usage). */
export interface ScopeUnitUsage {
  unit: string;
  total: number;
  /** Deliverables (1 … total) that have tasks. */
  used: number;
  deliverables: Array<{ n: number; tasks: number; names: string[] }>;
}

export interface DeliverableOption {
  key: string;
  unit: string;
  n: number;
  /** "Video 3 of 15", or "Video 16 (extra)" beyond the scope. */
  label: string;
  /** Beyond the approved total. */
  extra: boolean;
  tasks: number;
  names: string[];
}

/**
 * The scope as deliverables for the task form: "15 Video" → Video 1 of 15 … Video 15 of 15,
 * plus extra ones already in use beyond the total and one new extra (needs an admin's approval).
 */
export function deliverableOptions(units: ScopeUnitUsage[], pickedUpTo?: Map<string, number>): DeliverableOption[] {
  const out: DeliverableOption[] = [];
  for (const u of units) {
    const inUse = new Map(u.deliverables.map((d) => [d.n, d]));
    // One more extra than the highest in use or picked (lower-cased unit → highest picked number).
    const highest = Math.max(u.total, pickedUpTo?.get(u.unit.toLowerCase()) ?? 0, ...u.deliverables.map((d) => d.n));
    for (let n = 1; n <= highest + 1; n++) {
      const extra = n > u.total;
      const use = inUse.get(n);
      out.push({
        key: `${u.unit}|${n}`,
        unit: u.unit,
        n,
        label: extra ? `${u.unit} ${n} (extra — needs approval)` : `${u.unit} ${n} of ${u.total}`,
        extra,
        tasks: use?.tasks ?? 0,
        names: use?.names ?? [],
      });
    }
  }
  return out;
}

/** "Video 1–3, 7 + Static 2": deliverables by type, runs of numbers shortened (the same as the server's title). */
export function deliverablesLabel(items: Array<{ unit: string; n: number }>): string {
  const groups = new Map<string, { unit: string; numbers: number[] }>();
  for (const d of items) {
    const key = d.unit.trim().toLowerCase();
    const group = groups.get(key) ?? { unit: d.unit.trim(), numbers: [] };
    group.numbers.push(d.n);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const numbers = [...new Set(group.numbers)].sort((a, b) => a - b);
      const runs: string[] = [];
      for (let i = 0; i < numbers.length; ) {
        let j = i;
        while (j + 1 < numbers.length && numbers[j + 1] === numbers[j]! + 1) j++;
        runs.push(j === i ? String(numbers[i]) : j === i + 1 ? `${numbers[i]}, ${numbers[j]}` : `${numbers[i]}–${numbers[j]}`);
        i = j + 1;
      }
      return `${group.unit} ${runs.join(", ")}`;
    })
    .join(" + ");
}

/** "Others" is a catch-all type: it takes a count like any type, but is never counted or checked against the scope. */
export const isUncountedUnit = (unit: string | null | undefined): boolean => /^others?$/i.test((unit ?? "").trim());

/** "5 Static + 2 Video + 3 Others": how many of each type (the same as the server's title). */
export function countsLabel(items: Array<{ unit: string; n: number }>): string {
  const groups = new Map<string, { unit: string; count: number }>();
  for (const d of items) {
    const key = d.unit.trim().toLowerCase();
    const group = groups.get(key) ?? { unit: d.unit.trim(), count: 0 };
    group.count++;
    groups.set(key, group);
  }
  return [...groups.values()].map((g) => `${g.count} ${g.unit}`).join(" + ");
}

/** A line of the task form: a type and how many of it the task covers. */
export interface DeliverableRow {
  unit: string;
  count: string;
}

/** The task's deliverables as form lines: one per type with its count (an empty line for a new task). */
export function deliverableRows(parts: Parameters<typeof taskDeliverables>[0]): DeliverableRow[] {
  const groups = new Map<string, { unit: string; count: number }>();
  for (const d of taskDeliverables(parts)) {
    const key = d.unit.trim().toLowerCase();
    const group = groups.get(key) ?? { unit: d.unit.trim(), count: 0 };
    group.count++;
    groups.set(key, group);
  }
  const rows = [...groups.values()].map((g) => ({ unit: g.unit, count: String(g.count) }));
  return rows.length ? rows : [{ unit: "", count: "1" }];
}

/** The deliverables of the form lines: numbers 1 … count of each type. */
export function rowDeliverables(rows: DeliverableRow[]): Array<{ unit: string; n: number }> {
  return rows.flatMap((row) => {
    const unit = row.unit.trim();
    if (!unit) return [];
    const count = Number(row.count);
    return Number.isInteger(count) && count >= 1 && count <= 9999 ? Array.from({ length: count }, (_, i) => ({ unit, n: i + 1 })) : [];
  });
}

/** The deliverables a task covers: its list, or the single one of its name. */
export function taskDeliverables(parts: { unit: string; quantity: number; items?: Array<{ unit: string; n: number; done?: boolean }> | null } | null | undefined) {
  if (!parts) return [];
  return parts.items && parts.items.length > 0 ? parts.items : [{ unit: parts.unit, n: parts.quantity }];
}

/** "1-3, 7" → [1, 2, 3, 7]; null when it isn't a list of whole numbers (1 or more). */
export function parseNumberList(text: string): number[] | null {
  const out = new Set<number>();
  for (const part of text.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(part);
    if (!m) return null;
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (from < 1 || to < from || to - from > 500) return null;
    for (let n = from; n <= to; n++) out.add(n);
  }
  return out.size ? [...out].sort((a, b) => a - b) : null;
}

/** [1, 2, 3, 7] → "1-3, 7" (what parseNumberList reads). */
export function numberListText(numbers: number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    runs.push(j === i ? String(sorted[i]) : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return runs.join(", ");
}

/** "ENOC › Zoom": the brand with its organisation (just the brand when there's none, or it's the same name). */
export function brandWithOrg(brand: { name: string; organisation?: string | null } | null | undefined): string {
  if (!brand) return "";
  const org = brand.organisation?.trim();
  return org && org.toLowerCase() !== brand.name.trim().toLowerCase() ? `${org} › ${brand.name}` : brand.name;
}
