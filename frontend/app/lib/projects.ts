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

/** Project codes: 2-10 uppercase letters/digits. */
export const PROJECT_CODE_PATTERN = /^[A-Z0-9]{2,10}$/;

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
