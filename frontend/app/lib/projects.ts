import { LABEL_COLOR_META, todayKey, toDateInput } from "@/lib/tasks";
import type { ColorToken, ProgressMode, Project, ProjectActivityAction, Role } from "@/types";

export const PROGRESS_MODES: ProgressMode[] = [
  "task_completion",
  "total_time",
  "deadline",
  "manual",
];

export const PROGRESS_MODE_META: Record<ProgressMode, { label: string; description: string }> = {
  task_completion: {
    label: "Task completion",
    description: "Share of the project's tasks that are completed.",
  },
  total_time: {
    label: "Time logged",
    description: "Hours logged against the allocated hours (the limit is enforced).",
  },
  deadline: {
    label: "Deadline",
    description: "Days elapsed between the start date and the deadline.",
  },
  manual: { label: "Manual", description: "Set the percentage yourself." },
};

/** Colour classes for a status colour token (theme tokens only). */
export function statusColor(color: ColorToken) {
  return LABEL_COLOR_META[color] ?? LABEL_COLOR_META.primary;
}

/** Project codes: 2-12 uppercase letters/digits. */
export const PROJECT_CODE_PATTERN = /^[A-Z0-9]{2,12}$/;

/** Suggests a code from a project name ("Website redesign" → "WR"). */
export function suggestCode(name: string): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0].slice(0, 4);
  return words
    .map((word) => word[0])
    .join("")
    .slice(0, 6);
}

// ---------------------------------------------------------------------------
// Structured names: `Brand_Type_MonYYYY_Name` (mirrors backend lib/projectNaming.ts)
// ---------------------------------------------------------------------------

export const NAMING_SEPARATOR = "_";
export const NAMING_TITLE_MAX = 80;
export const DEFAULT_PROJECT_TYPES = ["Campaign", "Program", "Project", "Pitch"];

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-10" → "Oct2026" ("" when not a month). */
export function formatNamingMonth(month: string): string {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  return match ? `${MONTH_ABBR[Number(match[2]) - 1]}${match[1]}` : "";
}

/** "2026-10" → "October 2026" (filter chips / labels). */
export function namingMonthLabel(month: string): string {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  return match ? `${MONTH_LONG[Number(match[2]) - 1]} ${match[1]}` : month;
}

/** Whitespace collapsed and trimmed. */
export function tidyNamePart(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A name part as a pattern where spaces, "_" and "-" between its words are alike ("ZAJEL 2026" ~ "ZAJEL_2026"). */
function partPattern(text: string): string {
  return text
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s_-]*");
}

/** Matches a leading "Brand_Type_MonYYYY" (any of space / "_" / "-" between parts and words). */
function composedPrefix(brand: string, type: string, month: string): RegExp | null {
  const parts = [brand, type, formatNamingMonth(month).replace(/(\d{4})$/, " $1")].map(partPattern);
  if (parts.some((p) => !p)) return null;
  return new RegExp(`^${parts.join("[\\s_-]+")}(?:[\\s_-]+|$)`, "i");
}

/**
 * The name part only: a whole composed name typed into the name field
 * ("Wasl_Campaign_Oct2026_Launch", or "ZAJEL_2026_Pitch_Oct2026_Launch" for the brand
 * "ZAJEL 2026") loses its "Brand_Type_MonYYYY_" start. "_" inside the name itself is
 * fine (same rule as the server). A name that is only that start is kept.
 */
export function stripComposedPrefix(title: string, brand: string, type: string, month: string): string {
  const prefix = composedPrefix(brand, type, month);
  let out = tidyNamePart(title);
  for (let m = prefix?.exec(out); m && m[0].length < out.length; m = prefix!.exec(out)) out = tidyNamePart(out.slice(m[0].length));
  return out;
}

/** True when `title` is nothing but "Brand_Type_MonYYYY" (e.g. a file named after the project). */
export function isComposedPrefixOnly(title: string, brand: string, type: string, month: string): boolean {
  const out = tidyNamePart(title);
  const m = composedPrefix(brand, type, month)?.exec(out);
  return Boolean(m && m[0].length === out.length);
}

/** The composed project name, with "…" placeholders for missing parts (live preview). */
export function composeProjectName(parts: { brand: string; type: string; month: string; title: string }): string {
  return [
    tidyNamePart(parts.brand) || "Brand",
    tidyNamePart(parts.type) || "Type",
    formatNamingMonth(parts.month) || "MonYYYY",
    tidyNamePart(parts.title) || "Name",
  ].join(NAMING_SEPARATOR);
}

/** Short code suggestion from brand (short name preferred) + type: "Wasl" + "Campaign" → "WASLC". */
export function suggestNamingCode(brand: string, type: string): string {
  const head = brand.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  const initial = type.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 1);
  const code = `${head}${initial}`;
  if (!head) return "";
  return code.length >= 2 ? code : `${code}PR`.slice(0, 2);
}

/**
 * Preview of the server-generated project code: brand (4) + type (3) + MMYY,
 * e.g. WASLCMP1026. The server adds a number if it's taken; codes never change.
 */
/** Type part of codes and tags (mirrors backend lib/tags.ts typeTag). */
const TYPE_CODES: Record<string, string> = {
  campaign: "CMP",
  program: "PRG",
  programme: "PRG",
  project: "PRJ",
  retainer: "RET",
  pitch: "PIT",
};
function typeCode(type: string): string {
  const t = type.trim().toLowerCase();
  if (TYPE_CODES[t]) return TYPE_CODES[t];
  const words = type.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words.map((w) => w[0]).join("") : (words[0] ?? "")).slice(0, 3);
}

export function previewProjectCode(brand: string, type: string, month: string): string {
  const alnum = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const head = alnum(brand).slice(0, 4);
  if (!head || !type || !/^\d{4}-\d{2}$/.test(month)) return "";
  const [year, mm] = month.split("-");
  return `${head}${typeCode(type)}${mm}${year.slice(2)}`.slice(0, 11);
}

/** true = legacy free-text name (no structured parts). */
export function isLegacyProjectName(project: Pick<Project, "naming">): boolean {
  return !project.naming;
}

export function isProjectOverdue(project: Pick<Project, "deadline" | "isOverdue">): boolean {
  if (typeof project.isOverdue === "boolean") return project.isOverdue;
  return Boolean(project.deadline && toDateInput(project.deadline) < todayKey());
}

export const PROJECT_ACTIVITY_LABELS: Record<ProjectActivityAction, string> = {
  created: "created the project",
  updated: "updated the project",
  status_changed: "changed the status",
  member_added: "added members",
  member_removed: "removed a member",
  member_rate_changed: "changed a member's hourly rate",
  manager_changed: "changed the project manager",
  milestone_created: "created a milestone",
  milestone_updated: "updated a milestone",
  milestone_completed: "completed a milestone",
  milestone_reopened: "reopened a milestone",
  milestone_deleted: "deleted a milestone",
  file_added: "uploaded files",
  file_removed: "removed a file",
  note_added: "added a note",
  note_updated: "updated a note",
  note_deleted: "deleted a note",
  archived: "archived the project",
  restored: "restored the project",
  duplicated: "duplicated the project",
  brand_moved: "moved the project to another brand",
};

/**
 * Progress bar tone: red below 50, amber 50–79, green 80 and above. `fill` is a
 * tint (the % label sits on it in the foreground colour); `edge` is the solid
 * leading edge.
 */
export function progressTone(value: number): { fill: string; edge: string; label: string } {
  if (value >= 80) return { fill: "bg-primary/25", edge: "bg-primary", label: "On track" };
  if (value >= 50) return { fill: "bg-chart-4/30", edge: "bg-chart-4", label: "Progressing" };
  return { fill: "bg-destructive/20", edge: "bg-destructive", label: "Behind" };
}

/** Progress filter buckets (multi-select, `?progress=0-20,21-40`). */
export const PROGRESS_BUCKETS = ["0-20", "21-40", "41-60", "61-80", "81-100"] as const;

/**
 * Mirrors the backend `canManageProject` (edit, status, archive): admin, the
 * manager, or the head who created it. The server still re-checks.
 */
export function canManageProjectClient(
  project: Pick<Project, "manager" | "createdBy">,
  user: { _id: string; role: Role }
): boolean {
  if (user.role === "admin") return true;
  if (project.manager?._id === user._id) return true;
  return user.role === "head" && project.createdBy?._id === user._id;
}
