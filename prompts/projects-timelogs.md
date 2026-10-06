# Projects, Milestones & Time Logs

## Goal

Add the Worksuite project and time-tracking module, re-implemented for EMS. It builds on `prompts/task-collaboration.md`, which must be in place first. Tasks can belong to a project and a milestone. Employees track time with a live timer or by manual entry. Time is approved by the department head or an admin, and weekly timesheets are supported. No Worksuite code is copied.

Out of scope, because EMS has no matching concepts: clients, invoices, payments, expenses, estimates, currency conversion, Gantt, burndown chart, discussions, ratings, Miro, project templates, Excel import/export, and public project links.

## Worksuite → EMS mapping

| Worksuite | EMS |
|---|---|
| `projects` (soft delete = archive) | `Project`, with `archivedAt` |
| `project_short_code` + `task_short_code` `{CODE}-{n}` | `Project.code` + `Project.taskCounter`; `Task.shortCode` (counter only, never re-coded from ids) |
| `project_members` (+ hourly_rate) | Embedded `Project.members[] { user, hourlyRate, addedAt }` |
| `project_admin` | `Project.manager` (a user who manages this project) |
| `project_category` | `ProjectCategory` |
| `project_status_settings` (custom, coloured, default) | `ProjectStatus` collection, seeded with 6 statuses |
| `calculate_task_progress` manual / task_completion / project_total_time / project_deadline | `Project.progressMode`, same four modes |
| `project_milestones` | `Milestone` |
| `project_files` | `ProjectFile`, reusing GridFS (`lib/gridfs.ts`) |
| `project_notes` (public/private + per-user access) | `ProjectNote` with `visibility: "members" \| "private"` + `sharedWith[]` (no password feature) |
| `project_activity` | `ProjectActivity` |
| `pinned` | `User.pinnedProjects[]` |
| `project_settings` reminders | Inside the `ProjectSettings` singleton |
| `project_time_logs` + `_breaks` | `TimeLog` with embedded `breaks[]` |
| `weekly_timesheets` + entries | `WeeklyTimesheet` with embedded `entries[]` |
| `log_time_for` settings | Inside the `ProjectSettings` singleton |
| Reporting manager approves | The **department head** of the employee, or any admin |

## Data model

### Project (`backend/src/models/Project.ts`)

```ts
name: string (max 150), code: string (2-10 uppercase alnum, unique), summary?: string (max 5000)
category?: ObjectId | null            // ProjectCategory
departments: ObjectId[]               // Department, 0..n
manager?: ObjectId | null             // User: project manager (Worksuite project_admin)
members: [{ user: ObjectId, hourlyRate: number (0..100000, default 0), addedAt: Date }]
status: ObjectId                      // ProjectStatus
startDate: Date, deadline?: Date | null   // null = no deadline
progressMode: "manual" | "task_completion" | "total_time" | "deadline"
progress: number (0..100)             // stored; recalculated per mode
hoursAllocated?: number | null        // enforced in total_time mode
budget?: number | null                // display only, single app currency (no conversion)
isPublic: boolean                     // public = all employees can view
manualTimeLogs: boolean (default true)  // allow manual time entries
requireTaskApproval: boolean (default true)  // false = tasks skip in_review (Worksuite need_approval_by_admin)
taskCounter: number (default 0)
createdBy: ObjectId, archivedAt?: Date | null
lastDeadlineReminderOn?: string | null
```

Indexes:
- `{ code: 1 }` unique
- `{ "members.user": 1, archivedAt: 1 }`
- `{ departments: 1 }`
- `{ deadline: 1, archivedAt: 1 }`

### New collections

**ProjectStatus**
- Fields: `name`, `color` (theme token), `isDefault` (exactly one), `isCompleted` (counts as finished), `order`, `active`.
- Seeded: Not started, In progress (default), On hold, Under review, Cancelled, Finished (`isCompleted`).
- Moving to an `isCompleted` status sets progress to 100.

**ProjectCategory**
- Fields: `name` (unique).

**Milestone**
- Fields: `project`, `title`, `summary`, `startDate`, `endDate`, `status` (`incomplete | complete`), `completedAt`.
- Gets a task count and progress when listed.

**ProjectNote**
- Fields: `project`, `author`, `title`, `body` (max 10000), `visibility`, `sharedWith[]`, timestamps.

**ProjectFile**
- Fields: `project`, `uploadedBy`, `filename`, `mimeType`, `size`, `gridFsId`.
- Same limits as task files: 10 MB per file, 50 files per project.

**ProjectActivity**
- Fields: `project`, `actor`, `action`, `details`, `createdAt`.
- Actions: created, updated, status_changed, member_added, member_removed, manager_changed, milestone_*, file_*, note_*, archived, restored, duplicated.

**TimeLog**

```ts
user: ObjectId, project?: ObjectId | null, task?: ObjectId | null   // at least one (per settings.logTimeFor)
startTime: Date, endTime?: Date | null            // null = timer running
breaks: [{ startTime: Date, endTime?: Date | null, reason?: string }]
durationMinutes: number                           // (end - start) - breaks; integer, rounded (not truncated)
breakMinutes: number
memo: string (max 500)
source: "timer" | "manual" | "timesheet"
hourlyRate: number, earnings: number              // snapshot: rate × durationMinutes / 60
status: "pending" | "approved" | "rejected"
reviewedBy?: ObjectId, reviewedAt?: Date, rejectReason?: string
weeklyTimesheet?: ObjectId | null
addedBy: ObjectId, editedBy?: ObjectId | null
```

- Indexes: `{ user: 1, startTime: -1 }`, `{ project: 1, startTime: -1 }`, `{ task: 1 }`, `{ status: 1 }`, and a partial unique index on `{ user: 1 }` where `endTime: null`, which enforces one running timer per user.
- If `task` is set, `project` is taken from the task.
- The hourly rate comes from the user's membership row on the project. Otherwise it falls back to `User.hourlyRate`, a new field (default 0).

**WeeklyTimesheet**
- Fields: `user`, `weekStart` (Monday, date-only), `status` (`draft | submitted | approved | rejected`), `entries: [{ task, date, minutes }]`, `submittedAt`, `reviewedBy`, `reviewedAt`, `rejectReason`.
- Unique index on `{ user, weekStart }`.

**ProjectSettings** (singleton):

```ts
logTimeFor: "project" | "task"         // what a time log must reference
approvalRequired: boolean (default true)
autoStopTimerAt?: "HH:mm" | null       // e.g. "19:00", stops running timers daily in APP_TIMEZONE
trackerReminderAt?: "HH:mm" | null     // remind employees with no log today (skips weekends + approved leave)
deadlineReminderDays: number (0 = off, default 3)
deadlineReminderTo: ("manager" | "members" | "admins")[]
dailyTimeLogReport: boolean            // daily summary email to admins & heads
```

### Changes to existing models

- **Task:** add `project?: ObjectId | null`, `milestone?: ObjectId | null` and `shortCode?: string`, with index `{ project: 1, status: 1, position: 1 }`.
  - `shortCode` is assigned on create with an atomic `$inc` on `Project.taskCounter`, giving for example `WEB-12`.
  - Assignees on a project task must be project members. Adding a non-member assignee auto-adds them as a member, but only if the actor can manage the project; otherwise the request gets 400.
  - The task's due date may not be after the milestone's `endDate` (a warning, not an error).
  - If `project.requireTaskApproval` is false, submitting a task completes it directly with no review.
- **User:** add `hourlyRate` (admin-editable) and `pinnedProjects[]`. Add `emailPreferences.projectUpdates` and `emailPreferences.timeLogs`, both default true.
- **Notification types:**
  - `project_member_added`, `project_status_changed`, `project_deadline`
  - `project_note`, `project_file`
  - `timelog_pending`, `timelog_approved`, `timelog_rejected`
  - `timesheet_submitted`, `timesheet_approved`, `timesheet_rejected`
  - `time_tracker_reminder`, `timer_auto_stopped`
- **ActivityLog actions:** `project_created`, `project_updated`, `project_archived`, `project_deleted`, `timelog_reviewed`, `timesheet_reviewed`, `project_settings_updated`.

## Permissions

| Action | admin | head | project manager | member | other employee |
|---|---|---|---|---|---|
| List / view project | all | projects in their department(s) + member/manager | yes | yes | only if public |
| Create project | ✓ | ✓ (their department) | — | — | — |
| Edit, status, members, milestones, archive | ✓ | projects they created or manage | ✓ | — | — |
| Delete permanently (archived only) | ✓ | — | — | — | — |
| Create tasks in project | ✓ | ✓ | ✓ | — | — |
| Upload files, add notes | ✓ | ✓ | ✓ | ✓ | — |
| View hourly rates, earnings, budget | ✓ | ✓ (their department) | ✓ | own only | — |
| Log time on a project or task | ✓ | ✓ | ✓ | member or assignee only | — |
| Edit / delete a time log | ✓ | department | project | own, while pending | — |
| Approve / reject time and timesheets | ✓ | their department's employees | their project's logs | — | — |
| Project settings, statuses, categories | ✓ | — | — | — | — |

These rules fix the Worksuite gaps found in the analysis:
- Every approve and reject call checks permission.
- Timesheet status changes check ownership.
- No raw SQL is used for short codes.
- Admins do receive status-change notifications.

## Backend endpoints

**`/api/projects`**
- `GET /`: filters are status, category, department, manager, member, search, `archived=true`, `pinned=true` and `deadline=overdue`; supports pagination. Each item includes progress, task counts by status, and logged minutes.
- `POST /`: create. `POST /:id/duplicate` copies members, milestones (as incomplete) and optionally tasks with subtasks; the copied tasks get new short codes and go back to `todo`.
- `GET /:id` returns `{ project, permissions, stats }`.
  - stats: task counts by status, overdue tasks, minutes logged vs `hoursAllocated`, earnings (permission-gated), milestone progress.
- `PATCH /:id`. `PATCH /:id/status` takes `{ status }`.
- `POST /:id/archive`, `POST /:id/restore` and `DELETE /:id` (admin only, archived projects only).
  - Archiving hides the project's tasks from boards and lists.
  - Deleting removes the project's tasks, logs, files, notes and activity.
- `POST /:id/members` takes `{ userIds[], hourlyRate? }`. `PATCH /:id/members/:userId` takes `{ hourlyRate }`. `DELETE /:id/members/:userId` refuses to remove a user who still has open tasks unless `?force=true`, which unassigns them.
- `PUT /:id/pin` and `DELETE /:id/pin`.
- Milestones: `GET`/`POST /:id/milestones`, `PATCH`/`DELETE /:id/milestones/:mid`, `PATCH /:id/milestones/:mid/status`.
- Notes and files: `GET`/`POST /:id/notes`, `PATCH`/`DELETE /:id/notes/:nid`; `GET`/`POST /:id/files`, `GET`/`DELETE /:id/files/:fid`.
- `GET /:id/activity`.
- `GET /:id/tasks` reuses the task list and board logic with `project=<id>`. `GET /api/tasks` also accepts `project` and `milestone` filters.

**`/api/project-meta`**
- Any user: `GET statuses` and `GET categories`.
- Admin only: CRUD on statuses (with set-default) and categories, plus `GET`/`PATCH settings`.

**`/api/timelogs`**
- `GET /`: filters are user, project, task, status, from, to and `scope=mine|team|all`; supports pagination. Returns totals of minutes and earnings, with earnings permission-gated.
- `GET /active` returns my running timer, or null.
- `POST /timer/start` takes `{ project?, task?, memo }`. It returns 409 if a timer is already running or the project's hour limit is exhausted.
- `POST /timer/pause`, `POST /timer/resume` and `POST /timer/stop`. A manager or admin can stop someone else's timer with `/:id/stop`.
- `POST /` (manual entry) takes `{ project?, task?, startTime, endTime, memo, user? }`. Managers may log for others.
  - The entry must be at least 1 minute and must not overlap the user's existing logs.
  - It may not be in the future, and it must respect `manualTimeLogs` and the hour limit.
- `PATCH /:id` and `DELETE /:id`. `POST /:id/approve`. `POST /:id/reject` takes `{ reason }` (required).
- `POST /bulk-approve` takes `{ ids[] }`.

**`/api/timesheets`**
- `GET /week?weekStart=` returns my timesheet plus the tasks I can log against that week, excluding tasks in completed projects. A draft is created lazily.
- `PUT /:id/entries` saves the draft, replacing all entries. `POST /:id/submit` creates TimeLogs with `source: "timesheet"` and status `pending`.
- `GET /pending` is for approvers. `POST /:id/approve` marks the generated logs approved. `POST /:id/reject` takes `{ reason }`, deletes the generated logs and returns the timesheet to `rejected`, after which it can be edited and resubmitted.

**`/api/reports/time`** (head and admin; heads see only their department)
- `GET summary?from&to&groupBy=user|project|task|day` returns rows with minutes, earnings and log count, for charts and tables.
- `GET export?…` returns CSV.

All mutations write ProjectActivity rows and activity logs, push SSE events, and recalculate project progress where relevant.
- **Progress recalculation:** on task status changes, time log changes and status changes, and nightly for `deadline` mode.
- **New SSE events:** `project-updated`, `timer-updated` (to the owning user), `timelog-updated`.

## Notifications (in-app + email; email gated by preference)

| Type | Trigger | Recipients |
|---|---|---|
| `project_member_added` | Member added (including at creation) | The new member |
| `project_status_changed` | Status changed | Manager, members and admins (not the actor) |
| `project_deadline` | Deadline is N days away (job) | Per `deadlineReminderTo` |
| `project_note` | Note added that members can see, or that is shared with them | Members / `sharedWith` |
| `project_file` | File uploaded | Manager + members |
| `timelog_pending` | Log created while approval is required (by self or on someone's behalf) | Approvers (department head + project manager), or the employee if someone else logged it for them |
| `timelog_approved` / `timelog_rejected` | Reviewed | The employee (the rejection includes the reason) |
| `timesheet_submitted` | Submitted | Department head (admins if there is no head) |
| `timesheet_approved` / `timesheet_rejected` | Reviewed | The employee |
| `time_tracker_reminder` | No log today at `trackerReminderAt` | The employee |
| `timer_auto_stopped` | Auto-stop job | The employee |

The daily time-log report is an email-only summary for admins and heads.

## Scheduled jobs (Inngest cron + local `bun run jobs:*` + dev in-process interval)

All jobs use date-only comparisons in `APP_TIMEZONE`, with idempotency keys stored on each document.

| Job | When | Does |
|---|---|---|
| `projectDeadlineReminders` | 08:00 | Deadline = today + N days, sends `project_deadline` |
| `projectProgressDeadlineMode` | 00:15 | Recalculates `deadline`-mode progress |
| `autoStopTimers` | every 15 min | Stops timers still running past `autoStopTimerAt`; the end time is the configured time, not now |
| `timeTrackerReminder` | every 15 min | Fires once per day per user after `trackerReminderAt`; skips weekends, users on approved leave, and users with a log today |
| `dailyTimeLogReport` | 19:30 | Summary email per department |

## Frontend

**Navigation (requested by the user; mirrors Worksuite's sidebar)**
- A collapsible **Work** group for all roles:
  - **Projects** → `/projects`
  - **Tasks** → `/tasks`; the standalone Tasks nav item moves into this group.
  - **Timesheet** → `/timesheet`, which has a "Time logs" tab for `/timelogs`.
- A collapsible **Reports** group for head and admin; heads see only their department:
  - **Task Report** → `/reports/tasks`. Charts of task counts by status, per employee, per project and per priority, plus completion rate and on-time vs late. Overdue list. Filters: date range, project, employee, department. CSV export. Backend: `GET /api/reports/tasks/summary` and `/export`.
  - **Time Log Report** → `/reports/time`, described below.
  - **Weekly Timesheet** → `/reports/timesheets`. A table with one row per employee per week: total hours, status (draft, submitted, approved or rejected), submitted and reviewed dates, reviewer. Filters: week range, employee, department, status. Approve and reject actions inline. CSV export. Backend: `GET /api/reports/timesheets` and `/export`.
- The existing EMS admin "Reports" page stays where it is under Administration, renamed "HR Reports" to avoid two items called Reports.
- **Project settings** stays under Administration, for admin only.
- Group open/closed state is remembered in localStorage.

**Pages**
- `/projects`:
  - Grid or table toggle, plus filters and search, with Active / Archived / Pinned tabs.
  - Project cards show code, name, status pill, progress ring, member avatars, deadline (red when overdue) and open-task count.
  - A "New project" dialog for head and admin.
- `/projects/:id` has tabs:
  - **Overview:** stats cards, hours logged vs allocated, a task status chart, milestone progress, and budget and earnings for those allowed to see them.
  - **Tasks:** List / Board, reusing `components/tasks/*` with a project filter; the create dialog defaults to this project.
  - **Milestones**, **Members** (with hourly rate if permitted), **Files**, **Notes**, **Time logs** and **Activity**.
  - Header actions: edit, change status, pin, duplicate, archive/restore.
- **Global timer widget** in the app header:
  - Start dialog: choose project and task, enter a memo.
  - While running: elapsed time, pause/resume, stop. The state syncs across tabs through SSE `timer-updated`.
- `/timelogs`:
  - Tabs: Mine, Team (head/admin) and Pending approval (approvers).
  - Table with a date range, project and task filters, totals, a manual-entry dialog, approve/reject (with a reason dialog), and bulk approve.
- `/timesheet`: weekly grid with tasks as rows and days Mon–Sun as columns, plus row and day totals. Week navigation, Save draft, Submit. A read-only view with the rejection reason banner.
- `/admin/project-settings`: statuses (with colour, default and completed flags, drag to reorder), categories, and time-log settings.
- `/reports/time` (Time Log Report, head/admin): group-by switcher, date range, bar chart (shared chart components, theme tokens) and table, CSV export.

**Elsewhere**
- **Task UI:** project and milestone pickers in the task form, `shortCode` shown on cards and in the detail sheet, and a **Time** tab in the task detail sheet (logs plus a "Start timer on this task" button).
- **Profile:** two more email-preference switches. **Admin user edit:** the hourly rate field.
- **New packages:** none expected. The charts use the existing `components/ui/chart.tsx` (recharts).

## Migration

`bun run migrate:projects` is idempotent. It does three things:
- Seeds the six statuses and the settings singleton if they are missing.
- Sets `hourlyRate: 0` and `pinnedProjects: []` on users.
- Leaves existing tasks without a project.

## Edge cases

- **Overlapping logs:** checked against approved and pending logs, and against the running timer's start.
- **Breaks:** time spent on breaks is excluded from duration. Pausing twice is a no-op. Stopping a paused timer closes the open break first.
- **Day boundary:** a timer running past midnight is saved as one log; reports split by `startTime` date.
- **Members leaving:** a member removed from a project keeps their historical logs. Their running timer on that project is stopped.
- **Archiving:**
  - Archiving a project stops all running timers on it.
  - Tasks of an archived project are read-only.
  - The timer and timesheet pickers exclude archived and completed projects.
- **Hour limit:** in `total_time` mode, `hoursAllocated` blocks new logs and timers once the limit is reached, and the auto-stop job stops timers at the limit.
- **Changing a short code:** existing task codes are not rewritten; only new tasks use the new code. This avoids Worksuite's re-coding bug.
- **Deleting statuses and categories:**
  - The default status cannot be deleted, and neither can a status that projects use; the latter needs a reassign target.
  - Deleting a category clears it from projects.
- **Timezones:** all times are stored in UTC, and the UI shows local time. Date-only logic uses `APP_TIMEZONE`.

## Affected files

**backend**
- models: `Project.ts`, `ProjectStatus.ts`, `ProjectCategory.ts`, `Milestone.ts`, `ProjectNote.ts`, `ProjectFile.ts`, `ProjectActivity.ts`, `TimeLog.ts`, `WeeklyTimesheet.ts`, `ProjectSettings.ts`, plus edits to `Task.ts`, `User.ts`, `Notification.ts` and `ActivityLog.ts`
- controllers: `projects.ts`, `projectMilestones.ts`, `projectNotes.ts`, `projectFiles.ts`, `projectMeta.ts`, `timelogs.ts`, `timesheets.ts`, `timeReports.ts`, plus edits to `tasks.ts`
- routes: the matching route files, mounted in `server.ts`
- lib: `projectAccess.ts`, `projectProgress.ts`, `timeJobs.ts`, plus edits to `taskAccess.ts`, `notifications.ts` and `email.ts` templates
- inngest: `functions/projectJobs.ts` and `functions/timeJobs.ts`
- scripts: `migrateProjects.ts`, and `runJobs.ts` extended
- other: `package.json` scripts

**frontend**
- routes: `projects.tsx`, `projects.$id.tsx`, `timelogs.tsx`, `timesheet.tsx`, `reports.time.tsx`, `admin/project-settings.tsx`, `routes.ts`
- components: `components/projects/*`, `components/timelogs/*`, `components/timer/*`, plus edits to `components/tasks/*`, the sidebar, the header and the notification bell
- hooks: `use-projects.ts`, `use-timelogs.ts`, `use-timesheets.ts`
- `types.ts`, `profile.tsx`, admin users

## Done when

- `bun run typecheck` passes in both apps, and `bun run migrate:projects` is idempotent.
- **Projects and tasks:**
  - A head creates project `WEB` with two members. Both receive a `project_member_added` notification in-app and by email.
  - Tasks created in the project get `WEB-1` and `WEB-2`.
  - The project board shows only WEB tasks.
- **Timer:**
  - A member starts a timer on `WEB-1`, pauses for 5 minutes and stops. The log excludes the break.
  - A second start while one is running returns 409.
  - The header widget survives a reload.
- **Manual entry:** an entry overlapping an existing log is rejected.
- **Approval:**
  - With approval required, the head sees the log under Pending.
  - Approving notifies the employee.
  - Rejecting requires a reason.
- **Weekly timesheet:** saving a draft keeps it; submitting creates pending logs; rejecting deletes them and shows the reason.
- **Project overview:**
  - Hours logged match the sum of approved and pending logs.
  - Progress follows the chosen mode.
  - Moving the project to Finished sets progress to 100.
- **Time report:** grouped by user and by project; the CSV export opens in Excel.
- **Navigation:** the sidebar shows a **Work** group (Projects, Tasks, Timesheet) for everyone, and a **Reports** group (Task Report, Time Log Report, Weekly Timesheet) for head and admin.
- **Task Report:** totals match the task list for the same filters.
- **Weekly Timesheet report:** lists every submitted week, and approving from the report updates the employee's timesheet.
- **Jobs:**
  - `bun run jobs:time` auto-stops a stale timer at the configured time.
  - Tracker and deadline reminders fire once per day.
