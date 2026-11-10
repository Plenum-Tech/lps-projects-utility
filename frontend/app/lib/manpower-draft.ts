import type { TableRow } from "@/components/manpower/plan-table";

/**
 * Manpower plan drafts live on the editor's computer (localStorage), one per person and
 * month: only they see it, and nothing reaches the plan until they send it (or, for
 * leadership, publish it). Every edit is written at once, so a refresh, a closed tab or
 * an expired session doesn't lose the work.
 */
export interface StoredPlanDraft {
  rows: TableRow[];
  /** The version the edits started from (null: a month without a plan). */
  baseVersion: number | null;
  source: "edit" | "copy";
  note: string;
  maxProjects: string;
  /** ISO time of the last edit. */
  savedAt: string;
}

const key = (userId: string, month: string) => `lps:manpower-draft:${userId}:${month}`;

export function readPlanDraft(userId: string, month: string): StoredPlanDraft | null {
  try {
    const raw = window.localStorage.getItem(key(userId, month));
    if (!raw) return null;
    const draft = JSON.parse(raw) as StoredPlanDraft;
    return Array.isArray(draft?.rows) ? draft : null;
  } catch {
    return null;
  }
}

/** False when the browser won't store it (private window, storage full). */
export function writePlanDraft(userId: string, month: string, draft: StoredPlanDraft): boolean {
  try {
    window.localStorage.setItem(key(userId, month), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearPlanDraft(userId: string, month: string): void {
  try {
    window.localStorage.removeItem(key(userId, month));
  } catch {
    // Nothing stored.
  }
}
