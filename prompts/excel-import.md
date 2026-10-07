# Import Projects & Tasks from Excel / CSV

## Goal

Add Worksuite-style **Import** buttons on the Projects and Tasks pages. A user uploads an `.xlsx` or `.csv` file, maps its columns to fields, previews every row with validation results, and imports the valid rows into the right collections. Imported records go through the **same create code paths** as the UI, so permissions, task numbers and short codes, history, notifications and progress recalculation behave the same way.

## Flow (both imports)

1. **Upload**: drag and drop an `.xlsx` or `.csv` file (max 5 MB, max 2,000 rows). The user picks a sheet if the workbook has several, and says whether the first row is a header row. A **Download template** link gives a ready-made `.xlsx` with the expected headers, one example row, and an "Instructions" sheet.
2. **Map columns**: each detected column gets a target-field dropdown, auto-matched by header name, synonyms (e.g. "Assigned To" → assignees, "Deadline" → deadline/due date) and Worksuite export headers. Unmapped columns are ignored, and required fields must be mapped. Mappings are remembered per user, per import type, in localStorage.
3. **Preview**: the server validates **every row** and returns a status per row: ✅ ready, ⚠️ warning (imported with defaults, e.g. "unknown label 'X' skipped"), or ❌ error (skipped, with the reason). It also shows totals ("142 ready · 6 warnings · 3 errors"), filters, and a **Download error report** (`.xlsx` of failing rows plus a reason column).
4. **Options**:
   - **Projects**: "If a project code already exists: Skip / Update". Update changes only the mapped fields.
   - **Tasks**: "Default project" for rows with no project column; "Send assignment emails" (default **off** for bulk imports, to avoid flooding inboxes; in-app notifications are still created).
5. **Import**:
   - **Up to 200 rows**: processed in the request.
   - **Larger files**: processed as a background job with a progress bar (polled), so the request never times out.
   - **Result**: a summary ("135 created, 7 updated, 6 skipped"), links to the new records, and the error report.
   - **Undo**: an **Undo import** button for 24 hours. It deletes the records created by that import, provided they haven't been edited since.

## Field mapping

### Projects

| Field | Required | Accepts / matching |
|---|---|---|
| Project name | ✅ | text ≤150 |
| Project code | ✅ for create (auto-generated from name if empty) | 2–10 letters/digits, uppercase; unique |
| Summary | | text |
| Category | | name → project category (created if missing, **admin only**; otherwise warning) |
| Departments | | comma-separated names → departments |
| Project manager | | email (preferred) or exact name → user |
| Members | | comma/semicolon list of emails or names |
| Status | | name → project status (default status if empty or unknown, with a warning) |
| Start date | ✅ | Excel date, `DD-MM-YYYY`, `YYYY-MM-DD`, or the configured date format |
| Deadline | | same; must be ≥ start |
| Progress mode | | manual / task completion / total time / deadline |
| Hours allocated, Budget | | numbers |
| Public | | yes/no/true/false/1/0 |

### Tasks

| Field | Required | Accepts / matching |
|---|---|---|
| Title | ✅ | text ≤200 |
| Description | | text ≤2000 |
| Project | | project **code** (preferred) or name; must be one the importer can add tasks to |
| Milestone | | milestone title within that project |
| Assignees | ✅ | comma/semicolon emails or names; must follow the task assignment rules (project members, head's department) |
| Priority | | low / medium / high / urgent (default medium) |
| Status | | to do / in progress / in review / completed / rejected (Worksuite names like "Doing" and "Incomplete" are mapped) |
| Start date, Due date | | dates; due ≥ start |
| Estimate | | `2h 30m`, `2.5`, `150m` |
| Category | | task category name (created if missing, admin only) |
| Labels | | comma list → labels (created if missing, admin only) |
| Subtasks | | `;`-separated titles in one cell → subtasks (title only) |

**Name matching**: emails match exactly (case-insensitive). Names match exactly first; an ambiguous name (two users with the same name) is an **error** for that row, never a guess.

## Backend

- **Packages**: `exceljs` (maintained; reads `.xlsx` and writes the templates and error reports); `.csv` is parsed with a small RFC-4180 parser or `csv-parse`. **Not** the old `xlsx@0.18` npm package, which has known vulnerabilities.
- **Parsing safety**:
  - 5 MB upload limit, 2,000-row cap, 50-column cap, 5,000 characters per cell.
  - Only the first sheet, or the chosen one, is read.
  - Formulas use their cached values; formulas are never evaluated.
  - Leading `= + - @` characters are kept as text on import, and are escaped again in exports.
  - A decompression-size guard for zip bombs: reject if the unpacked size is over 50 MB.
- **Model `ImportJob`**:
  - `type` (`projects` | `tasks`), `createdBy`, `status` (`previewed` | `running` | `completed` | `failed` | `undone`)
  - `fileName`, `mapping`, `options`, `totals`, `rowsResult`: `[{ row, status, message, recordId }]`, capped
  - `createdIds`, `progress`, `startedAt`, `finishedAt`, `undoUntil`
  - The raw file is held for at most 1 hour (GridFS), then deleted.

**Endpoints**, under `/api/imports`:

| Method | Path | Notes |
|---|---|---|
| GET | `/templates/:type` | Downloads the template `.xlsx`. |
| POST | `/:type/preview` | Multipart file plus optional `sheet` and `headerRow`. Returns `{ jobId, sheets, columns, sampleRows (first 20), suggestedMapping }`. |
| POST | `/:jobId/validate` | Takes `{ mapping, options }`. Returns per-row results and totals, without writing anything. |
| POST | `/:jobId/run` | Imports. Runs inline (≤200 rows) or in the background. |
| GET | `/:jobId` | Status and progress. |
| GET | `/:jobId/errors.xlsx` | The error report. |
| POST | `/:jobId/undo` | Undoes the import. |
| GET | `/` | My recent imports (admins see all). |

**Permissions**:
- **Projects import**: admin and head. Heads are limited to their own department, the same as creating a project.
- **Tasks import**: admin, head, and project managers (into their own projects).
- Every row is checked with the same permission functions as single creates.

**Activity log**: `import_completed` and `import_undone`, with counts.

## Frontend

- **Projects toolbar**: an **Import** button next to Export, opening the import dialog.
- **Tasks toolbar**: the same. When opened from a project's Tasks tab, the default project is pre-filled.
- **`components/imports/*`**: a stepper dialog (Upload → Map → Preview → Import → Result) with a column-mapping table, a virtualised preview grid with status chips and row filters, a progress bar, and the result summary with an Undo button.
- **Settings → Imports history**: an admin-only list of past imports, with download error report and undo.
- **States**: designed empty, loading and error states throughout. On mobile the dialog is full-screen, and the preview grid scrolls inside its card.

## Edge cases

- **Duplicate task titles** are allowed. Duplicate project codes within the file are an error on the second occurrence.
- **Empty rows** are ignored. Header-only files show "No data rows found".
- **Dates**: Excel serial dates and text dates are both handled. Dates are interpreted in `APP_TIMEZONE`, date-only.
- **Missing people**: assignees or managers not found produce a row error. With "Skip unknown people" ticked, the row is imported if at least one assignee resolves, with a warning.
- **Partial failures**: a row that errors mid-import doesn't stop the rest. Each row is independent, and the results show exactly what happened.
- **Concurrent runs**: a job can't run twice (409), and Undo is idempotent.

## Done when

- Both type checks and the build pass.
- A Worksuite-style projects export (`.xlsx`) and a tasks `.csv` import with auto-mapped columns.
- **Preview** shows correct ✅ / ⚠️ / ❌ results, including for unknown people, a bad date, a duplicate code, and a project the importer isn't allowed to use.
- **Importing 1,500 tasks** runs in the background with progress. Codes like `WEB-1…` are sequential, history is written, and emails are sent only when the option is on.
- **Undo** removes the imported records. The error report opens in Excel.
- **Permissions**: an employee can't import projects, and a project manager can import tasks only into their own projects.
