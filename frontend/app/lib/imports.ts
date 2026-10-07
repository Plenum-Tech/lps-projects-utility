import type {
  ImportColumn,
  ImportField,
  ImportJob,
  ImportJobStatus,
  ImportMapping,
  ImportRow,
  ImportRowStatus,
  ImportType,
} from "@/types";

export const IMPORT_ACCEPT =
  ".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const IMPORT_EXTENSIONS = ["xlsx", "csv"] as const;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 2_000;
/** Runs with more rows than this go to the background (202). */
export const INLINE_IMPORT_ROWS = 200;

export const IMPORT_NOUN: Record<ImportType, { one: string; many: string }> = {
  projects: { one: "project", many: "projects" },
  tasks: { one: "task", many: "tasks" },
};

export function plural(count: number, type: ImportType): string {
  return `${count.toLocaleString()} ${count === 1 ? IMPORT_NOUN[type].one : IMPORT_NOUN[type].many}`;
}

/** Status chip look per row status — theme tokens only. */
export const ROW_STATUS_META: Record<
  ImportRowStatus,
  { label: string; className: string; dot: string }
> = {
  ready: { label: "Ready", className: "bg-primary/10 text-primary border-primary/25", dot: "bg-primary" },
  created: { label: "Created", className: "bg-primary/10 text-primary border-primary/25", dot: "bg-primary" },
  updated: { label: "Updated", className: "bg-chart-2/15 text-foreground border-chart-2/30", dot: "bg-chart-2" },
  warning: { label: "Warning", className: "bg-chart-4/15 text-foreground border-chart-4/35", dot: "bg-chart-4" },
  skipped: { label: "Skipped", className: "bg-muted text-muted-foreground border-border", dot: "bg-muted-foreground" },
  error: {
    label: "Error",
    className: "bg-destructive/10 text-destructive border-destructive/25",
    dot: "bg-destructive",
  },
};

export const JOB_STATUS_META: Record<
  ImportJobStatus,
  { label: string; badge: "default" | "secondary" | "destructive" | "outline" }
> = {
  previewed: { label: "Not run", badge: "outline" },
  running: { label: "Running", badge: "secondary" },
  completed: { label: "Completed", badge: "default" },
  failed: { label: "Failed", badge: "destructive" },
  undone: { label: "Undone", badge: "outline" },
};

/** Row filter buckets used by the preview and result grids. */
export type RowFilter = "all" | "ok" | "warning" | "error" | "skipped";

/** A row "has a warning" when it went through but carries messages. */
export function rowBucket(row: ImportRow): Exclude<RowFilter, "all"> {
  if (row.status === "error") return "error";
  if (row.status === "warning") return "warning";
  if (row.status === "skipped" || row.action === "skip") return "skipped";
  if ((row.status === "created" || row.status === "updated") && row.messages.length > 0) return "warning";
  return "ok";
}

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Link to an imported record, or null when there is nothing to open. */
export function recordHref(type: ImportType, row: Pick<ImportRow, "recordId">): string | null {
  if (!row.recordId) return null;
  return type === "projects" ? `/projects/${row.recordId}` : `/tasks?task=${row.recordId}`;
}

export function progressPercent(job: Pick<ImportJob, "progress">): number {
  const { processed, total } = job.progress;
  if (!total) return 0;
  return Math.min(100, Math.round((processed / total) * 100));
}

export function requiredFields(fields: ImportField[]): ImportField[] {
  return fields.filter((field) => field.required === true);
}

// ---------------------------------------------------------------------------
// Remembered mappings (localStorage, per user + import type)
// ---------------------------------------------------------------------------

function mappingKey(userId: string, type: ImportType) {
  return `lps.import-mapping.${userId}.${type}`;
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Saves the mapping as header → field so it survives column re-ordering. */
export function rememberMapping(
  userId: string,
  type: ImportType,
  columns: ImportColumn[],
  mapping: ImportMapping
) {
  if (!userId) return;
  const byHeader: Record<string, string> = {};
  for (const column of columns) {
    const field = mapping[String(column.index)];
    if (field) byHeader[normalizeHeader(column.header)] = field;
  }
  try {
    window.localStorage.setItem(mappingKey(userId, type), JSON.stringify(byHeader));
  } catch {
    // Storage blocked or full — remembering is a convenience only.
  }
}

function readRemembered(userId: string, type: ImportType): Record<string, string> | null {
  if (!userId) return null;
  try {
    const raw = window.localStorage.getItem(mappingKey(userId, type));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, string>;
  } catch {
    return null;
  }
}

/**
 * Starting mapping for a fresh preview: the server suggestion, overridden by
 * what this user picked last time for the same header. Each field is used once.
 */
export function initialMapping(
  userId: string,
  type: ImportType,
  columns: ImportColumn[],
  fields: ImportField[],
  suggested: ImportMapping
): { mapping: ImportMapping; remembered: number } {
  const validFields = new Set(fields.map((field) => field.key));
  const remembered = readRemembered(userId, type) ?? {};
  const mapping: ImportMapping = {};
  let fromMemory = 0;

  // Remembered picks win over the suggestion.
  const used = new Set<string>();
  for (const column of columns) {
    const field = remembered[normalizeHeader(column.header)];
    if (field && validFields.has(field) && !used.has(field)) {
      mapping[String(column.index)] = field;
      used.add(field);
      fromMemory += 1;
    }
  }
  for (const column of columns) {
    const key = String(column.index);
    if (mapping[key]) continue;
    const field = suggested[key];
    if (field && validFields.has(field) && !used.has(field)) {
      mapping[key] = field;
      used.add(field);
    }
  }
  return { mapping, remembered: fromMemory };
}

/** Required fields (true) that no column maps to. */
export function missingRequired(fields: ImportField[], mapping: ImportMapping): ImportField[] {
  const mapped = new Set(Object.values(mapping));
  return requiredFields(fields).filter((field) => !mapped.has(field.key));
}

/** Field keys that more than one column maps to. */
export function duplicateTargets(mapping: ImportMapping): Set<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const field of Object.values(mapping)) {
    if (!field) continue;
    if (seen.has(field)) dupes.add(field);
    seen.add(field);
  }
  return dupes;
}

// ---------------------------------------------------------------------------
// Background jobs (sessionStorage) — so a toolbar can keep watching a run
// after the dialog closes, and pick it up again after a page change.
// ---------------------------------------------------------------------------

function backgroundKey(type: ImportType) {
  return `lps.import-running.${type}`;
}

export function readBackgroundJob(type: ImportType): string | null {
  try {
    return window.sessionStorage.getItem(backgroundKey(type));
  } catch {
    return null;
  }
}

export function writeBackgroundJob(type: ImportType, jobId: string | null) {
  try {
    if (jobId) window.sessionStorage.setItem(backgroundKey(type), jobId);
    else window.sessionStorage.removeItem(backgroundKey(type));
  } catch {
    // Ignore — the run still finishes on the server.
  }
}
