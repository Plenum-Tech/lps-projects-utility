# Worksuite-style Project & Task Tables (+ estimates, calendar, pins, approvals, recurring)

## Goal

Rebuild `/projects` and `/tasks` so they look and work like the user's Worksuite screens (screenshots of `/account/projects` and `/account/tasks`): dense data tables with inline actions. The design keeps EMS's theme tokens and stays consistent with the rest of the app. It does not copy Worksuite's styling.

The approved extras are estimated time with hours logged, a calendar view, pinned items, a waiting-for-approval view, and a recurring-tasks list. Out of scope: project templates, import, the client column, and custom fields such as "Project_Tag".

## Shared table pattern (`components/globals/data-table/*`)

These pieces are reusable by both pages and by future pages:
- **Toolbar row**: primary action button, secondary buttons, and on the right a **view toggle group** of icon buttons with tooltips.
- **Filters bar**:
  - inline **Duration** (a date range), **Status** select, page-specific quick filters and **search**
  - a **Filters** button that opens a side sheet with the advanced filters, with a count badge for active filters
  - **Clear all**
  - Filters are stored in the URL query string, so they can be shared and survive a reload.
- **Table**:
  - a header checkbox selects the page; an indeterminate state shows a partial selection
  - sortable headers show ↑↓ and set `?sort=field&dir=asc|desc`
  - sticky header, with horizontal scroll inside the card
  - designed loading (skeleton rows), empty and error states
- **Bulk bar**: appears when rows are selected, showing "N selected", the actions, and Clear.
- **Pagination footer**: "Show [10 | 25 | 50 | 100] entries", "Showing x to y of z entries", and Previous / page numbers (with ellipsis) / Next. The page size is remembered in localStorage.
- **Inline status dropdown**: a coloured dot with a label. It shows only allowed statuses, updates optimistically, and rolls back on error.
- **Avatar stack**: up to 4 avatars, then +N, with a tooltip listing names.
- **Dates** show as `DD-MM-YYYY`. A deadline or due date in the past on an unfinished item shows in destructive colour.
- **Row ⋮ menu** using `DropdownMenu`.
- **Mobile**: rows become stacked cards with the same actions.

## Projects page (`/projects`)

**Toolbar**:
- **+ Add project** (head/admin).
- **Export**: CSV of the current filters, or of the selected rows.
- View toggles: **List** (default) · **Archive** · **Calendar** · **Pinned**.

**Filters bar**:
- Inline: **Duration** (projects whose start→deadline overlaps the range), **Status**, **Progress** (0–20, 21–40, 41–60, 61–80, 81–100, multi-select), search (name, code or summary).
- Side sheet: category, department, manager, member.

**Columns**:

| Column | Content |
|---|---|
| ☐ | Row selection |
| Code | e.g. `PEAR` |
| Project name | Name (a link to the detail page), with the category in small muted text below |
| Members | Avatar stack |
| Start date | Date |
| Deadline | Date; "No deadline" when none; red when overdue |
| Status | **Progress bar with the %** in its fill: red below 50, amber 50–79, green 80 and above. Below it, the **inline status dropdown** with the project status colours. |
| Action | ⋮ menu: View · Edit · Pin/Unpin · Duplicate · Archive/Restore · Delete (admin, archived only) |

Sortable by code, name, start date, deadline, progress and status.

**Bulk actions**: Change status · Archive · Restore (in the Archive view) · Delete (admin, Archive view) · Export selected.

**Calendar view**: projects as bars from start date to deadline in a month grid, coloured by status. Click a bar to open the project.

## Tasks page (`/tasks`)

**Toolbar**:
- **+ Add task**.
- **My tasks**: a toggle that switches the scope between "assigned to me" and "all I can see". It replaces the current scope tabs.
- **Recurring tasks** opens `/tasks/recurring`.
- **Export**: CSV.
- View toggles: **List** (default) · **Board** (the existing kanban) · **Calendar** · **Pinned** · **Waiting approval** (with a count badge; shown to reviewers only).

**Filters bar**:
- Inline: **Duration** (due-date range), **Status**, **Project**, search (title, code or description).
- Side sheet: priority, label, category, assignee (head/admin), milestone, department (admin), "overdue only".

**Columns**:

| Column | Content |
|---|---|
| ☐ | Row selection |
| Code | `shortCode` (e.g. `PEAR-12`), or `#<number>` for tasks without a project. Underneath, a **▶ timer button** that starts a timer on this task, shows **■** when your timer is running on it, and is disabled when time can't be logged. |
| Task | Title (opens the detail sheet), **priority badge**, the project name (muted, linked), and label chips |
| Completed on | Date, or "--" |
| Start date | Date |
| Due date | Date; red when overdue |
| Estimated time | e.g. `2h 30m`, or "--" |
| Hours logged | Total of pending and approved logs, e.g. `1h 05m` (`0s` when there are none, like Worksuite) |
| Assigned to | Avatar stack |
| Status | Inline status dropdown, showing only the transitions allowed for the caller |
| Action | ⋮ menu: View · Edit · Duplicate · Pin/Unpin · Send reminder · Delete |

Sortable by code, title, start date, due date, estimate, hours logged and status.

**Bulk actions**: Change status (applied per task, each with its own permission check; the result toast says "8 updated, 2 skipped") · Assign to (head/admin) · Delete (managers) · Export selected.

**Calendar view**: a month grid (with a week toggle) showing tasks on their due date, or spanning start→due when both are set. Chips are coloured by status, with a "+N more" popover. Click a chip to open the detail sheet. Filters still apply.

**Pinned view**: the same table, limited to tasks you pinned.

**Waiting approval view**: tasks `in_review` that the caller can review, with inline **Approve / Reject** buttons in the row. Reject opens a reason dialog.

**Recurring tasks** (`/tasks/recurring`): a table with these columns:
- task
- schedule, e.g. "Every 2 weeks"
- cycles (generated / total, or ∞)
- next run
- assignees
- copies (a link to the list filtered by `recurringParent`)
- actions: Edit schedule · Stop repeating (sets `recurrence` to null and keeps existing copies) · Delete

## Data model changes

- **Task**:
  - `estimateMinutes?: number | null` (0–100000). The form gets "Estimated time" as hours plus minutes inputs, in both the create/edit dialog and the detail sheet.
  - `number: number`: a global sequence assigned atomically from a `counters` collection; unique index.
  - Index `{ dueDate: 1, status: 1 }` for the calendar.
- **User**: `pinnedTasks: ObjectId[]`. `pinnedProjects` already exists.
- **Migration**: `bun run migrate:tables` backfills `number` in `createdAt` order and creates the counter. It is idempotent.

## Backend changes

**Tasks**
- `GET /api/tasks` gains:
  - `sort` and `dir`
  - `from` and `to` (due range)
  - `pinned=true`
  - `scope=approvals`
  - `recurring=true`
  - `recurringParent=`
  - `overdue=true`
  - `project` (`none` means no project)
- Each item also returns `number`, `estimateMinutes`, `loggedMinutes` (aggregated, not N+1), `pinned` and `completedAt`.
- `GET /api/tasks/calendar?from&to` returns a lean list for the calendar, capped at 500.
- `GET /api/tasks/export` returns CSV with the same filters, or `ids=`. Fields are escaped, there is a UTF-8 BOM so Excel opens it correctly, and rows are capped at 5000.
- `POST /api/tasks/bulk` takes `{ ids (max 200), action: "status" | "assign" | "delete", status?, assignees? }` and returns `{ updated, skipped: [{ id, reason }] }`. Every item goes through the same permission and transition checks as the single-item endpoints, and the usual notifications and history are written.
- `POST /api/tasks/:id/duplicate` copies:
  - title (with " (copy)" added)
  - description, assignees, labels, category, priority
  - project and milestone, dates and estimate
  - subtasks, reset to not done

  It does not copy comments, files, notes or history. The copy gets a new number or short code, and `task_assigned` notifications are sent.
- `PUT` and `DELETE /api/tasks/:id/pin`.
- `GET /api/tasks/approvals/count` feeds the badge.

**Projects**
- `GET /api/projects` gains `sort` and `dir`, `from`/`to` (overlap), `progress=0-20,21-40,…`, and `pinned=true`.
- `GET /api/projects/export` returns CSV.
- `POST /api/projects/bulk` takes `{ ids, action: "status" | "archive" | "restore" | "delete", status? }` and returns `{ updated, skipped }`, with per-item permission checks. Delete is admin-only and only for archived projects.

## Frontend structure

Pages stay thin:
- `routes/projects.tsx`, `routes/tasks.tsx`, `routes/tasks.recurring.tsx` (new, registered in `routes.ts`)
- `components/globals/data-table/*`: toolbar, filters-bar, filters-sheet, table, bulk-bar, pagination, inline-status, avatar-stack
- `components/globals/calendar-month.tsx`: a lightweight month/week grid with no new dependency, built with `date-fns`
- `components/projects/projects-table.tsx`, `projects-calendar.tsx`
- `components/tasks/tasks-table.tsx`, `tasks-calendar.tsx`, `task-timer-button.tsx`, `approval-actions.tsx`, `recurring-tasks-table.tsx`
- The task form and detail sheet get the estimate field.
- Hooks: extend `use-tasks.ts` and `use-projects.ts` (bulk, export, pin, duplicate, calendar, approvals count).

The existing List/Board toggle and filters on `/tasks` are replaced by this toolbar and filters bar. The board itself is reused unchanged.

## Edge cases

- **Bulk actions** with mixed permissions: allowed items are applied, the rest are skipped with reasons, and the toast summarises.
- **Inline status change** that isn't allowed: the dropdown doesn't offer it. If the server still refuses, the change rolls back with a toast.
- **Timer ▶**: starting while another timer runs gets 409, shown as "Stop your running timer on X first", with a Stop & start button.
- **Large exports** are capped at 5000 rows with a note in the toast. Huge result sets are paginated server-side, and the table never loads everything.
- **Calendar**: a month with more than 4 chips on a day collapses to "+N more".
- **Overdue colouring**: a task counts as overdue when its due date is before today in `APP_TIMEZONE`, compared as dates only, and its status isn't completed.

## Done when

- Both type checks pass and `bun run migrate:tables` is idempotent.
- **`/projects`**:
  - matches the column layout above
  - inline status change works
  - the progress bar colours follow the thresholds
  - Duration, Status, Progress and search filters work and survive a reload via the URL
  - bulk archive works
  - Export downloads a CSV that opens correctly in Excel
  - Archive, Calendar and Pinned views work
- **`/tasks`**:
  - shows code with ▶, task cell, dates, estimate vs hours logged, avatars, inline status and ⋮
  - **My tasks** toggles the scope
  - the Board, Calendar, Pinned and Waiting approval views work (approve inline)
  - Recurring tasks lists the schedules and Stop repeating works
  - bulk status change reports skipped items
  - Duplicate creates a copy with a new code
- Page size and "Showing x to y of z" are correct, and sorting works on every sortable column.
- On mobile, both tables become stacked cards with no horizontal page scroll.
