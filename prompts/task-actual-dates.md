# Task Actual Start / Actual End (date + time)

## Goal

Every task gets **Actual start** and **Actual end** as full date-time values, alongside the planned Start date and Due date. They're **filled automatically** and **editable** by the people who manage the task. They appear in the task detail, the tasks table, Delivery Pulse and Excel import/export.

## Data

`Task.actualStartAt?: Date | null` and `Task.actualEndAt?: Date | null`, stored as UTC and shown in the app timezone using the configured date and time format.

Plus `Task.actualStartSource` and `actualEndSource`: `"auto" | "manual" | "import"`. Once someone sets a value manually, automatic updates never overwrite it.

## Automatic rules

- **Actual start**: set the **first** time any of these happens, if it's still empty:
  - the status moves to `in_progress`
  - a timer is started on the task
  - a manual time log is added for the task (using that log's start time)
  - the task is created already `in_progress`
- **Actual end**:
  - Set when the status becomes `completed`, using the same moment as `completedAt`.
  - If a task is reopened (moves out of completed), an **auto** Actual end is cleared; a manual one is kept.
  - When the task is completed again, it's set again.
- **Consistency**: if Actual end is set and Actual start is empty, Actual start is filled from the earliest time log; failing that, it stays empty and is shown as "—".

## Editing

- **Who**: the task's managers (creator, admin, project manager or department head under the existing rules) and **assignees**.
- **Validation**: Actual end ≥ Actual start, and neither may be in the future (2 minutes of clock skew allowed).
- **Clearing**: allowed, which returns the field to automatic.
- **History**: each change writes `actual_dates_updated` with from/to values.

## API

- Task detail and list items include `actualStartAt`, `actualEndAt` and their sources.
- `PATCH /api/tasks/:id` accepts both fields (null clears them).
- `GET /api/tasks` supports sorting by `actualStartAt` and `actualEndAt`. The CSV export gains the columns **Actual start**, **Actual end**, **Start variance (days)** and **Finish variance (days)**.

## Frontend

- **Task detail sheet**: an "Actual" block next to Planned, showing start and end with a date-time picker, an "auto" / "edited" badge, and a reset-to-automatic button.
  - **Variance chips**: "Started 2d late" (actual start vs planned start) and "Finished 1d early" (actual end vs due date), coloured good/warn.
- **Task form**: optional Actual start and end fields in edit mode only.
- **Tasks table**: two optional columns, **Actual start** and **Actual end** (hidden by default; turned on through a column-visibility menu that's remembered per user), with variance shown in muted text under the date. Both are sortable.

## Delivery Pulse

- **Results**: a new KPI tile **Mean days start → done**, using tasks completed in the period that have an actual start, with its change vs the previous period. Plus **Late starts %**: tasks whose actual start date is after their planned start date, out of those with both.
- **Analysis**: the weekly chart gets a second series, **start → done**, next to brief → done.
- **People and teams tables**: a "Mean start → done" column.

## Import / migration

- **Excel import**: the tasks template gains **Actual start** and **Actual end** columns (date or date-time; time optional). They're validated like the other dates and stored with source `import`.
- **Worksuite import** (`import:worksuite`):
  - Actual end = `completed_on` for completed tasks.
  - Actual start = the first history entry that moved the task to the Doing / In Process column. If there's none, the earliest time log start.
  - Rerunning **never overwrites a manual value**.
  - **Backfill command**: `bun run backfill:actual-dates`, which is idempotent, computes the values for existing tasks (imported or native), and prints counts.

## Done when

- Both type checks and the build pass.
- **API tests**: auto start on in_progress and on the timer; end on complete; reopen clears an auto end but keeps a manual one; manual edits are protected from auto updates; validation; permissions; sorting; the CSV columns.
- **Backfill** was run on a scratch copy and counts reported. It isn't run on the user's `ems` or Cosmos until approved; it's run as part of deployment.
- **Browser**: the detail edit, the table columns, and the Delivery Pulse tiles.
