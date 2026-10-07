# Imports API contract (`/api/imports`)

Backend for `prompts/excel-import.md`. All endpoints need the auth cookie. Errors are always `{ "error": string }`.

## Permissions

- **Projects import**: admin, or a head who has a department. Heads can only use their own department; other departments give a row error.
- **Tasks import**: admin, head, or the manager of at least one non-archived project. A project manager can add rows only to projects they manage (or can otherwise add tasks to). Rows without a project fail for employees.
- Other callers get **403** on preview, validate and run.
- Jobs are visible to their creator and to admins. Anyone else gets **404**.
- Only the uploader can validate or run a job. The uploader or an admin can undo it.

## Types

```ts
type ImportType = "projects" | "tasks";
type JobStatus = "previewed" | "running" | "completed" | "failed" | "undone";
// validate: ready | warning | error;  run: created | updated | skipped | error
type RowStatus = "ready" | "warning" | "error" | "created" | "updated" | "skipped";

interface ImportField {            // from preview.fields
  key: string;                     // projects: name, code, summary, category, departments, manager, members, status,
                                   //   startDate, deadline, progressMode, hoursAllocated, budget, isPublic
                                   // tasks: title, description, project, milestone, assignees, priority, status,
                                   //   startDate, dueDate, estimate, category, labels, subtasks
  label: string;
  required: boolean | "create";    // "create" = needed for new records (project startDate)
  accepts: string;
  example: string | number;
}

interface ImportOptions {          // every field is optional
  onExisting?: "skip" | "update";  // projects, default "skip"
  defaultProject?: string | null;  // tasks: project _id for rows with no project value
  sendEmails?: boolean;            // default false → in-app notifications only
  skipUnknownPeople?: boolean;     // default false: unknown person = row error; true = warning
                                   //   (tasks still need ≥ 1 resolved assignee)
}

type Mapping = Record<string /* column index */, string /* field key */>; // e.g. { "0": "title", "3": "assignees" }

interface ImportRow {
  row: number;                     // spreadsheet row number (1-based, as shown in Excel)
  status: RowStatus;
  action: "create" | "update" | "skip" | null;
  messages: string[];              // errors, warnings, or notes (for example "Category X will be created")
  recordId: string | null;         // run results: project/task _id
  recordRef: string | null;        // "WEB" (project code), "WEB-12" or "#123" (task)
}

interface ImportJob {
  id: string; type: ImportType; status: JobStatus;
  fileName: string; fileSize: number;
  fileAvailable: boolean; fileExpiresAt: string | null;   // raw file kept ≤ 1 h
  sheets: string[]; sheet: string | null; headerRow: boolean;
  columns: { index: number; header: string }[];
  rowCount: number;
  mapping: Mapping; options: ImportOptions | {};
  resultsOf: "validate" | "run" | null;
  totals: { rows: number; ready: number; warnings: number; errors: number;
            created: number; updated: number; skipped: number };
  progress: { processed: number; total: number };
  createdCount: number;
  startedAt: string | null; finishedAt: string | null;
  undoUntil: string | null; canUndo: boolean;
  undoneAt: string | null;
  undoResult: { deleted: number; skipped: { id: string; ref: string | null; reason: string }[] } | null;
  error: string | null;
  hasErrorReport: boolean;
  createdBy: { id: string; name: string | null };
  createdAt: string; updatedAt: string;
  rows?: ImportRow[];              // only where noted below
}
```

**Totals:**
- After **validate**, `ready`, `warnings` and `errors` count rows, and `skipped` counts valid rows whose action is `skip`.
- After **run**, `created`, `updated`, `skipped` and `errors` are the outcomes. `warnings` counts imported rows that have messages, and `ready` = `created + updated`.

## Endpoints

### `GET /templates/:type` → `.xlsx` file

Returns `projects-import-template.xlsx` or `tasks-import-template.xlsx`. The workbook has a data sheet with the headers and one example row, plus an **Instructions** sheet. Unknown type → **404**.

### `POST /:type/preview`

This endpoint takes one of two request bodies:

- **New upload**: `multipart/form-data` with
  - `file` (`.xlsx` or `.csv`, at most 5 MB)
  - optional `sheet` (sheet name; the first sheet is used by default)
  - optional `headerRow` (`"true"` by default, or `"false"`)
- **Change sheet or header setting**: JSON `{ jobId, sheet?, headerRow? }`. This re-reads the stored file of a job that is still `previewed`. It resets the mapping and results.

**201** (upload) or **200** (re-read):

```ts
{
  jobId: string;
  job: ImportJob;                       // no rows
  fileName: string;
  format: "xlsx" | "csv";
  sheets: string[];                     // [] for CSV
  sheet: string | null;
  headerRow: boolean;
  rowCount: number;                     // non-empty data rows
  columns: { index: number; header: string; samples: string[] }[]; // samples = first 3 values
  sampleRows: { row: number; cells: string[] }[];                  // first 20 rows, dates as YYYY-MM-DD
  suggestedMapping: Mapping;            // header names, synonyms and Worksuite headers
  fields: ImportField[];
  limits: { maxBytes: 5242880; maxRows: 2000; inlineRows: 200 };
}
```

**Errors:**
- **400**: bad workbook or zip, encrypted file, missing file/jobId, or bad `headerRow`
- **403**: no permission
- **404**: unknown type or job
- **409**: the job already ran
- **410**: the stored file expired
- **413**: the file is over 5 MB, or the workbook unpacks to more than 50 MB (zip-bomb guard)
- **415**: the file is not `.xlsx` or `.csv`
- **422**: no data rows (`"No data rows found"`), more than 2,000 rows, or more than 50 columns

Header names are de-duplicated (`"Name (2)"`). Blank headers become `"Column C"`.

### `POST /:jobId/validate`

Body: `{ mapping: Mapping, options?: ImportOptions }`

**200**: `{ job: ImportJob & { rows: ImportRow[] } }`. It validates **every** row and writes nothing except the job record (it stores the mapping, options and results).

**Errors:**
- **400**: bad mapping (unknown column or field, or a field mapped twice), required fields not mapped (`title` and `assignees` for tasks; `name` for projects), or bad options
- **403**
- **409**: the job is not `previewed`
- **410**: the file expired (re-upload)

### `POST /:jobId/run`

Body: `{ mapping?: Mapping, options?: ImportOptions }`. When a field is omitted, the values from the last validate are used. Every row is re-validated first.

- **≤ 200 rows**: **200** `{ job: ImportJob & { rows } }`, with `status: "completed"`.
- **More than 200 rows**: **202** `{ job }`, with `status: "running"`. Poll `GET /:jobId` (about every 1 s) until the status is not `running`.
- **409**: the job is already running or has finished. A concurrent second call also gets 409.
- **400 / 403 / 410**: same as validate.

When it runs:
- Rows with errors are skipped, and each row is independent.
- Projects go through `createProjectCore` / `updateProjectCore` (and `applyProjectStatus` when updating with a mapped status). With **Update**, only the mapped, non-empty cells change. Members are not changed on update.
- Tasks go through `createTaskCore`, so they get the same permissions, `WEB-n` short codes and numbers in row order, history (`created` with `{ importJob }`), notifications and progress recalculation.
- Missing categories and labels are created only for admins. For other roles they become warnings.
- With `sendEmails: false`, only in-app notifications are created.

### `GET /:jobId`

**200** `{ job }`. `job.rows` is included unless the status is `running`. A `running` job whose heartbeat is older than 2 minutes (for example after a server restart) is switched to `failed`. Records it already created can still be undone.

### `GET /:jobId/errors.xlsx` → `.xlsx` file

The sheet "Errors" has these columns: `Row`, the original headers, `Status`, `Reason`. Text that starts with `= + - @` is prefixed with `'`. The report uses the latest results (validate or run). **404** if there are no failing rows.

### `POST /:jobId/undo`

Allowed within 24 h of the run, for the uploader or an admin.

- It deletes the created records that are **unedited**, meaning:
  - **Tasks**: no history other than created/reminders, and no comments, notes, files or time.
  - **Projects**: no tasks, and no activity other than "created". It also needs no time logs, files, notes or milestones.
- Updated projects and categories/labels created on the fly are kept.
- **200** `{ job }` with `status: "undone"` and `undoResult`.
- **202** `{ job }` with `undoResult: null` when more than 200 records are being deleted in the background. Poll `GET /:jobId` until `undoResult` is set.
- Undo is idempotent: repeating the call returns the job.

**Errors:**
- **409**: the job is not finished, or it created nothing
- **410**: the 24 h window has passed

### `GET /`

Query: `?type=projects|tasks&limit=20(≤100)&offset=0&mine=true`

**200** `{ imports: ImportJob[] (no rows), total, limit, offset }`. The list is newest first. Admins see every import (`mine=true` limits it to their own). Everyone else sees only their own.

## Value formats

- **Dates**:
  - Accepted formats: Excel date cells, Excel serial numbers, `YYYY-MM-DD`, `DD-MM-YYYY` (or `MM-DD-YYYY` when that is the company date format; `/` and `.` also work), `15 Jan 2026`, `Jan 15, 2026`, and ISO date-times.
  - ISO date-times are converted to the app-timezone date. All dates are stored date-only.
- **People**: an email (exact, case-insensitive) or an exact full name. A name shared by two or more users is a row error. Lists are split on `,` `;` or line breaks.
- **Task status**: to do / in progress / in review / completed / rejected. Worksuite names also work: Incomplete → To do, Doing → In progress, plus common synonyms. Unknown values give a warning and fall back to To do.
- **Priority**: low / medium / high / urgent. Unknown values give a warning and fall back to medium.
- **Estimate**: `2h 30m`, `2.5` (hours), `150m`, `2:30`.
- **Subtasks**: separated by `;`.
- **Project progress mode**: manual / task completion / total time / deadline.
- **Public**: yes / no / true / false / 1 / 0.
- **Project code**: 2–10 letters/digits, upper-cased. When it is empty, a code is generated from the name (the row gets a note). A code that appears twice in the file is an error on the second occurrence.
- **Formula cells**: their cached results are imported, and formulas are never evaluated. Text that starts with `=` is imported as text.

## Activity log

New actions `import_completed` and `import_undone` (`targetType: "import"`, details include the counts). Add them to the frontend `ActivityAction` type.
