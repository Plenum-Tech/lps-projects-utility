import type { ImportType } from "../../models/ImportJob.js";

// ---------------------------------------------------------------------------
// Import target fields, their header synonyms (incl. Worksuite export headers)
// and the automatic column → field mapping.
// ---------------------------------------------------------------------------

export interface ImportField {
  key: string;
  label: string;
  /** true = always required; "create" = required when creating (projects). */
  required: boolean | "create";
  /** Shown in the mapping UI and the template's Instructions sheet. */
  accepts: string;
  example: string | number;
  synonyms: string[];
}

export const PROJECT_FIELDS: ImportField[] = [
  { key: "name", label: "Project name", required: true, accepts: "Text, up to 150 characters", example: "Website redesign", synonyms: ["project name", "project", "name", "project title", "title"] },
  { key: "code", label: "Project code", required: false, accepts: "2-10 letters/digits, unique (generated from the name when empty)", example: "WEB", synonyms: ["project code", "code", "short code", "project short code", "shortcode", "key", "project key"] },
  { key: "summary", label: "Summary", required: false, accepts: "Text, up to 5000 characters", example: "Refresh the marketing site", synonyms: ["summary", "project summary", "description", "project description", "details", "notes"] },
  { key: "category", label: "Category", required: false, accepts: "Project category name (created if missing — admins only)", example: "Marketing", synonyms: ["category", "project category"] },
  { key: "brand", label: "Brand", required: false, accepts: "Brand (client) name (created if missing — admins only)", example: "Ajmal", synonyms: ["brand", "brand name", "client", "client name", "project brand"] },
  { key: "departments", label: "Departments", required: false, accepts: "Comma-separated department names", example: "Engineering", synonyms: ["departments", "department", "dept", "team department"] },
  { key: "manager", label: "Project manager", required: false, accepts: "Email (preferred) or exact full name", example: "jane@example.com", synonyms: ["project manager", "manager", "project admin", "pm", "owner", "project owner"] },
  { key: "members", label: "Members", required: false, accepts: "Comma/semicolon list of emails or exact names", example: "jane@example.com; john@example.com", synonyms: ["members", "project members", "team", "team members", "member"] },
  { key: "status", label: "Status", required: false, accepts: "Project status name (default status when empty)", example: "In progress", synonyms: ["status", "project status"] },
  { key: "startDate", label: "Start date", required: "create", accepts: "Excel date, DD-MM-YYYY, YYYY-MM-DD or the configured date format", example: "2026-01-15", synonyms: ["start date", "start", "started on", "start on", "startdate"] },
  { key: "deadline", label: "Deadline", required: false, accepts: "Date, on or after the start date", example: "2026-03-31", synonyms: ["deadline", "due date", "end date", "due", "finish date", "due on"] },
  { key: "progressMode", label: "Progress mode", required: false, accepts: "manual / task completion / total time / deadline", example: "task completion", synonyms: ["progress mode", "calculate progress", "calculate progress through", "progress calculation", "progress based on"] },
  { key: "hoursAllocated", label: "Hours allocated", required: false, accepts: "Number", example: 120, synonyms: ["hours allocated", "allocated hours", "project hours", "estimated hours", "hours"] },
  { key: "budget", label: "Budget", required: false, accepts: "Number", example: 5000, synonyms: ["budget", "project budget", "cost"] },
  { key: "isPublic", label: "Public", required: false, accepts: "yes / no / true / false / 1 / 0", example: "no", synonyms: ["public", "is public", "public project", "visibility"] },
];

export const TASK_FIELDS: ImportField[] = [
  { key: "title", label: "Title", required: true, accepts: "Text, up to 200 characters", example: "Design the home page", synonyms: ["title", "task", "task name", "task title", "heading", "subject", "name"] },
  { key: "description", label: "Description", required: false, accepts: "Text, up to 5000 characters", example: "Hero, features and pricing sections", synonyms: ["description", "task description", "details", "notes"] },
  { key: "project", label: "Project", required: false, accepts: "Project code (preferred) or exact project name", example: "WEB", synonyms: ["project", "project code", "project name", "project short code", "projectname"] },
  { key: "milestone", label: "Milestone", required: false, accepts: "Milestone title in that project", example: "Phase 1", synonyms: ["milestone", "milestone title", "milestones"] },
  { key: "assignees", label: "Assignees", required: true, accepts: "Comma/semicolon list of emails or exact names", example: "jane@example.com", synonyms: ["assignees", "assignee", "assigned to", "assign to", "assigned", "responsible", "users", "employee", "employees", "members"] },
  { key: "priority", label: "Priority", required: false, accepts: "low / medium / high / urgent (default medium)", example: "high", synonyms: ["priority"] },
  { key: "status", label: "Status", required: false, accepts: "to do / in progress / in review / completed / rejected (Worksuite: Incomplete, Doing…)", example: "to do", synonyms: ["status", "task status", "board column", "column", "stage"] },
  { key: "startDate", label: "Start date", required: false, accepts: "Date", example: "2026-01-15", synonyms: ["start date", "start", "start on", "startdate"] },
  { key: "dueDate", label: "Due date", required: false, accepts: "Date, on or after the start date", example: "2026-01-31", synonyms: ["due date", "deadline", "due", "due on", "end date", "duedate"] },
  { key: "actualStart", label: "Actual start", required: false, accepts: "Date or date-time (time optional, company timezone); not in the future", example: "2026-01-16 09:30", synonyms: ["actual start", "actual start date", "actual start time", "started at", "started on", "work started"] },
  { key: "actualEnd", label: "Actual end", required: false, accepts: "Date or date-time, on or after the actual start; not in the future", example: "2026-01-30 17:00", synonyms: ["actual end", "actual end date", "actual end time", "finished at", "finished on", "completed on", "completed at", "completion date"] },
  { key: "estimate", label: "Estimate", required: false, accepts: "2h 30m, 2.5 (hours) or 150m", example: "2h 30m", synonyms: ["estimate", "estimated time", "estimation", "estimate hours", "estimated hours", "time estimate", "estimate time"] },
  { key: "category", label: "Category", required: false, accepts: "Task category name (created if missing — admins only)", example: "Design", synonyms: ["category", "task category"] },
  { key: "labels", label: "Labels", required: false, accepts: "Comma-separated label names (created if missing — admins only)", example: "frontend, ux", synonyms: ["labels", "label", "tags", "tag", "task labels"] },
  { key: "subtasks", label: "Subtasks", required: false, accepts: "Semicolon-separated subtask titles", example: "Wireframe; Mockup; Review", synonyms: ["subtasks", "sub tasks", "subtask", "sub task", "checklist"] },
];

export function fieldsFor(type: ImportType): ImportField[] {
  return type === "projects" ? PROJECT_FIELDS : TASK_FIELDS;
}

/** "Assigned To" → "assignedto". */
export function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Column index (as a string) → field key, each field used at most once. */
export function suggestMapping(type: ImportType, headers: string[]): Record<string, string> {
  const fields = fieldsFor(type);
  const used = new Set<string>();
  const mapping: Record<string, string> = {};
  const pass = (match: (f: ImportField, h: string) => boolean) => {
    headers.forEach((header, index) => {
      if (mapping[String(index)]) return;
      const h = normalizeHeader(header);
      if (!h) return;
      const field = fields.find((f) => !used.has(f.key) && match(f, h));
      if (field) {
        mapping[String(index)] = field.key;
        used.add(field.key);
      }
    });
  };
  // Exact label / key first, then synonyms in priority order.
  pass((f, h) => normalizeHeader(f.label) === h || normalizeHeader(f.key) === h);
  pass((f, h) => f.synonyms.some((s) => normalizeHeader(s) === h));
  return mapping;
}
