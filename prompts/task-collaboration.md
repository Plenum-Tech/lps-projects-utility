# Task Collaboration, Task Notifications & SMTP Email

## Goal

Bring EMS tasks up to the "core + collaboration" feature set of the Worksuite (Laravel) install found in the projectsutility backup, re-implemented in our MERN stack (no code is copied). The work has three parts:

1. **Tasks**: multiple assignees, subtasks, comments with @mentions, file attachments, labels and categories, a per-task history, a kanban board with drag and drop, start and due dates, the existing approval flow (with its bugs fixed), due-date reminders and recurring tasks.
2. **Notifications**: a full set of task notification types, in-app (SSE) and by email. Each user can turn email off per category.
3. **Email transport**: replace Resend with **Nodemailer over SMTP (Microsoft 365)**. Credentials are read from `backend/.env` only.

Out of scope, because Worksuite has them but EMS has no matching concepts: projects, milestones, clients, Slack, push, timers and time logs, Gantt, public task links, custom fields, comment emoji reactions.

## Reference: Worksuite → EMS mapping

| Worksuite | EMS |
|---|---|
| `tasks` + `task_users` (many-to-many) | `Task.assignees: ObjectId[]` |
| `sub_tasks` (+ `sub_task_files`) | Embedded `Task.subtasks[]` (no files on subtasks) |
| `task_comments` (+ `mention_user_id`) | `TaskComment` collection, `mentions[]` |
| `task_notes` | Dropped; comments cover it |
| `task_files` | `TaskFile` metadata + **GridFS** bucket `taskFiles` |
| `task_history` | `TaskHistory` collection |
| `task_label_list` / `task_labels` | `TaskLabel` collection + `Task.labels[]` |
| `task_category` | `TaskCategory` collection + `Task.category` |
| `taskboard_columns` (custom) | Fixed columns = existing statuses; `Task.position` for order |
| `companies.before_days/after_days/on_deadline` | `TaskSettings` singleton |
| `repeat*`, `recurring_task_id` | `Task.recurrence` + `Task.recurringParent` |
| `email_notification_settings` (global slugs) | Per-user `User.emailPreferences` |
| `smtp_settings` (DB) | Env vars (`SMTP_*`); no secrets stored in the DB |

## Data model changes

### Task (`backend/src/models/Task.ts`), modified

```ts
assignees: ObjectId[]            // ref User, required, min 1, max 20 (replaces assignedTo)
assignedBy: ObjectId             // unchanged (creator)
department?: ObjectId | null     // from the first assignee (unchanged semantics)
category?: ObjectId | null       // ref TaskCategory
labels: ObjectId[]               // ref TaskLabel, max 10
startDate?: Date | null          // NEW
dueDate?: Date | null
position: number                 // NEW, order within a kanban column (float, default Date.now())
subtasks: [{
  _id, title (max 200), done: boolean, assignee?: ObjectId | null,
  dueDate?: Date | null, completedAt?: Date | null, createdBy: ObjectId
}]                               // max 50
recurrence?: { every: number (1-365), unit: "day"|"week"|"month", cycles: number (-1 = forever), generated: number, nextRunAt: Date } | null
recurringParent?: ObjectId | null
lastReminderSentOn?: string | null   // "YYYY-MM-DD:kind" (kind = before/on/after); prevents duplicate reminder emails
// existing: title, description, status, priority, submission*/review*, completedAt
```

New indexes:
- `{ assignees: 1, status: 1, position: 1 }`, for "my board"
- `{ "recurrence.nextRunAt": 1 }`
- Existing `{ status: 1, dueDate: 1 }`, now used by the reminders job

**Migration**: `backend/src/scripts/migrateTaskAssignees.ts` (`bun run migrate:tasks`). It is idempotent:
- Sets `assignees = [assignedTo]` where `assignedTo` exists, then unsets `assignedTo`.
- Sets `position` where it is missing.

### New collections

- **TaskComment**: `task` (ref, indexed), `author`, `body` (plain text, max 5000), `mentions: ObjectId[]`, `editedAt`, plus timestamps. Index `{ task: 1, createdAt: 1 }`.
- **TaskFile**: `task`, `uploadedBy`, `filename`, `mimeType`, `size`, `gridFsId`. Limits: 10 MB per file, 20 files per task. Allowed types: images, pdf, office docs, txt, csv, zip.
- **TaskHistory**: `task`, `actor`, `action` (`created | updated | status_changed | assignees_changed | subtask_added | subtask_completed | subtask_reopened | subtask_removed | comment_added | file_added | file_removed | submitted | reviewed | reminder_sent`), `details` (Mixed), `createdAt`. Index `{ task: 1, createdAt: -1 }`.
- **TaskLabel**: `name` (unique, max 40), `color` (one of the theme token names, e.g. `chart-1`…`chart-5`, `primary`, `destructive`), `description`.
- **TaskCategory**: `name` (unique, max 60).
- **TaskSettings** (singleton): `reminderBeforeDays` (0-30, default 1; 0 = off), `reminderOnDeadline` (bool, default true), `reminderAfterDays` (0-30, default 1; 0 = off).

### User (`backend/src/models/User.ts`), modified

```ts
emailPreferences: {
  taskAssigned: boolean,      // default true
  taskUpdates: boolean,       // status changes, edits, approvals; default true
  taskComments: boolean,      // comments and @mentions; default true
  taskReminders: boolean,     // due, overdue and recurring; default true
}
```

In-app notifications are always created; these flags only control email.

### Notification types (`backend/src/models/Notification.ts`)

Add the following types:
- `task_updated`
- `task_status_changed`
- `task_comment`
- `task_mention`
- `subtask_assigned`
- `subtask_completed`
- `task_reminder`
- `task_overdue`

Deleting a task also deletes all of that task's notifications (Worksuite does the same).

### Activity actions

Add `task_updated`, `task_deleted` (fixes the current mislabel, where a delete is logged as `task_status_updated`) and `task_settings_updated`.

## Permissions (EMS roles: admin, head, employee)

| Action | admin | head | employee |
|---|---|---|---|
| View task | all | tasks they created, plus tasks in their department | tasks they are assigned to or created |
| Create / assign | anyone | members of their own department only | no (unchanged) |
| Edit fields, labels, dates, recurrence | any | tasks they created | no |
| Move on board / change status | any | tasks they created | tasks assigned to them; transitions below |
| Add / toggle / remove subtasks | any | tasks they created | toggle `done` on tasks assigned to them |
| Comment, @mention, upload files | can view → yes | can view → yes | can view → yes |
| Delete own comment or file | yes | yes | yes, own only |
| Delete task | any | tasks they created | no |
| Labels, categories, reminder settings | yes | no | no |

**Status transitions for assignees** (fixes a bug where an assignee could go todo→completed and skip review):
- `todo → in_progress`
- `in_progress → todo | in_review`
- `in_review → in_progress`
- `rejected → in_progress`

Only the creator or an admin can set `completed` or `rejected`: through `/review`, or by dragging a card on the board while it is `in_review`.

**Bug fixes**:
- The status-update handler now captures `previousStatus` *before* mutating, so the activity log and SSE carry the correct "from".
- Heads get a task-management view. Today the admin task page calls an admin-only endpoint, so heads have no UI.

## Backend endpoints (`/api/tasks`, all routes require `requireAuth`)

| Method | Path | Notes |
|---|---|---|
| GET | `/` | **Scoped by role** (replaces the admin-only list). Filters: `status, assignee, department, label, category, priority, due (overdue/today/week), search`, plus pagination. `view=board` returns all non-archived tasks grouped by status, ordered by `position` (max 200 per column). |
| GET | `/mine`, `/created` | Kept for compatibility |
| POST | `/` | Create with `assignees[]`, labels, category, dates, subtasks[], recurrence |
| GET | `/:id` | Detail; populated, includes subtasks |
| PATCH | `/:id` | Edit (creator/admin); diffs assignees and notifies newly added ones |
| PATCH | `/:id/status` | Same transitions as above |
| PATCH | `/:id/move` | Board drag: `{ status, position }`. Validates the transition for the caller's role. |
| POST | `/:id/submit`, `/:id/review` | Unchanged behaviour |
| DELETE | `/:id` | Also deletes comments, files (GridFS), history and notifications |
| POST | `/:id/remind` | Manual reminder to assignees (creator/admin); rate-limited to once per hour per task |
| POST | `/:id/subtasks` | `{ title, assignee?, dueDate? }` |
| PATCH | `/:id/subtasks/:subId` | Title, assignee, dueDate, done |
| DELETE | `/:id/subtasks/:subId` | |
| GET / POST | `/:id/comments` | POST `{ body }`. The server parses `@[Name](userId)` tokens into `mentions`; only users who can view the task count. |
| PATCH / DELETE | `/:id/comments/:commentId` | Author only (admin can delete) |
| GET / POST | `/:id/files` | Multipart upload via **multer** (memory storage), streamed into GridFS |
| GET | `/:id/files/:fileId` | Streams the download (`Content-Disposition: attachment`) |
| DELETE | `/:id/files/:fileId` | Uploader, creator or admin |
| GET | `/:id/history` | Newest first |

Other routes:
- `/api/task-labels` and `/api/task-categories`: GET for any authenticated user; POST, PATCH and DELETE for admin. Deleting a label or category pulls it from tasks.
- `/api/task-settings`: GET and PATCH, admin only.
- `/api/users/me/email-preferences`: GET and PATCH.
- `/api/admin/email/test`: POST `{ to? }`, admin only. Verifies the SMTP connection, then sends a test email (defaults to the admin's own address).

Every mutating endpoint writes a `TaskHistory` row, pushes the `task-updated` SSE event to every assignee, the creator and admins viewing the task, and calls `logActivity` where an action exists.

## Notification matrix

| Type | Trigger | Recipients (never the actor) | Email pref |
|---|---|---|---|
| `task_assigned` | Created, or assignee added on edit | New assignees | taskAssigned |
| `task_updated` | Title, description, dates or priority edited | Assignees | taskUpdates |
| `task_status_changed` | Status change, including a board move | Creator + assignees | taskUpdates |
| `task_completed` (existing) | Submitted for review | Creator | taskUpdates |
| `task_approved` / `task_rejected` (existing) | Reviewed | Assignees | taskUpdates |
| `task_comment` | Comment added | Creator + assignees, minus anyone mentioned | taskComments |
| `task_mention` | @mention in a comment | Mentioned users | taskComments |
| `subtask_assigned` | Subtask assignee set or changed | Subtask assignee | taskAssigned |
| `subtask_completed` | Subtask marked done | Creator + assignees | taskUpdates |
| `task_reminder` | Due in N days, due today, or manual remind | Assignees | taskReminders |
| `task_overdue` | N days past due, not completed | Assignees + creator | taskReminders |

- Each email names the user ("Hi {firstName}"), shows the task title, due date and priority, and has a button linking to `${APP_URL}/tasks?task=<id>`, which opens the detail sheet.
- **All user-supplied text is HTML-escaped**, fixing the current XSS-in-email gap.
- Notification `link` values point to `/tasks?task=<id>` for everyone, instead of the admin-only page.

## Scheduled jobs (Inngest cron, plus a local fallback)

`backend/src/inngest/functions/taskReminders.ts` runs on cron `0 8 * * *` in `TZ=Asia/Kolkata` and calls `runTaskReminders(now)` from `backend/src/lib/taskJobs.ts`. That function compares on **date-only** values in the app timezone (Worksuite's reminders broke because of a DATETIME vs. date comparison):
- `dueDate == today + beforeDays` → `task_reminder` ("due in N days")
- `dueDate == today` and `onDeadline` → `task_reminder` ("due today")
- `dueDate == today - afterDays` → `task_overdue`

It skips tasks in `completed` status, and skips any task whose `lastReminderSentOn` already equals today's key.

`backend/src/inngest/functions/recurringTasks.ts` runs on cron `30 0 * * *` and calls `runRecurringTasks(now)`:
- For tasks with `recurrence.nextRunAt <= now` and cycles not exhausted, it clones the task: status `todo`, subtasks reset to not done, `startDate = today`, and the due date keeps the original start→due span.
- It sets `recurringParent`, notifies with `task_assigned`, and advances `nextRunAt` and `generated`.

**Local dev** (no Inngest dev server): `bun run jobs:reminders` and `bun run jobs:recurring` run the same functions once. When `NODE_ENV !== "production"`, the server also runs both hourly in-process via `setInterval`; the idempotency keys prevent duplicates.

## Email transport (`backend/src/lib/email.ts`): Nodemailer over Microsoft 365 SMTP

Remove `resend` and add `nodemailer` + `@types/nodemailer`.

New env vars, added to `.env.example` with placeholders. Real values go in `.env` only:

```
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_SECURE=false            # STARTTLS on 587
SMTP_USER=you@yourdomain.com
SMTP_PASS=                   # mailbox password, or app password if MFA is on
FROM_NAME=EMS
FROM_EMAIL=you@yourdomain.com   # must equal SMTP_USER unless "Send As" is granted
EMAIL_REDIRECT_TO=           # optional, dev only: deliver ALL mail here (subject prefixed "[to: original@x]")
```

- One pooled transporter (`pool: true, maxConnections: 3`), created lazily. If `SMTP_HOST`, `SMTP_USER` or `SMTP_PASS` is missing, sending is skipped with one warning, and the server still boots.
- `sendEmail({to, subject, html, text?})` sends to the **real** recipient; `EMAIL_REDIRECT_TO` overrides it when set. This replaces the hard-coded address added for local testing.
- `sendBatchEmails` sends every item, with concurrency 3. It no longer sends only the first item.
- `verifyEmailTransport()` is used by the test endpoint and logged once at startup: `✅ SMTP ready (smtp.office365.com)` or a clear warning.
- Delete `RESEND_API_KEY` from config and docs.

## Frontend

Pages stay thin; the logic lives in `components/tasks/*`.
- **`/tasks`**, for every role:
  - Toolbar: List | Board toggle (remembered in localStorage), filters (status, priority, label, category, assignee for head/admin, due), search, and a "New task" button for head/admin.
  - Tabs: "Assigned to me", plus for head/admin "Created by me" and "All" (department-scoped for heads).
  - The existing `routes/admin/tasks.tsx` redirects to `/tasks` and is removed from the admin sidebar group. The Tasks nav item shows for all roles.
- **Board** (`task-board.tsx`): five columns (To do, In progress, In review, Completed, Rejected) with a count per column. Drag and drop uses **@dnd-kit/core + @dnd-kit/sortable**. Updates are optimistic and roll back on error with a toast. Moves that aren't allowed show a disabled drop target.
- **Task card**: title, priority dot, label chips, subtask progress (3/5), avatars for the assignees, a due-date chip (red when overdue), and comment and file counts.
- **Task detail** (`task-detail-sheet.tsx`, shadcn `Sheet`, opened via `?task=<id>`):
  - Header: status, priority, dates, assignees, labels, category.
  - Tabs: Subtasks (checklist, with an inline add), Comments (textarea with `@` mention autocomplete via `Command`), Files (drag-and-drop upload zone, list with download and delete), History (timeline).
  - Head/admin get an edit form and a "Send reminder" action.
- **Create/Edit dialog**: multi-select assignees (department-scoped for heads), labels, category, start and due dates, priority, an initial subtasks list, and a recurrence control ("Repeat every [N] [day/week/month] for [N | forever] cycles").
- **`/admin/task-settings`**: CRUD for labels (name and theme colour) and categories, reminder settings, and an "SMTP status + send test email" card.
- **Profile → Notifications card**: four switches for the email preferences.
- **Notification bell**: icons for the new types. Clicking a task notification opens `/tasks?task=<id>`.
- Every list, board column and tab has designed empty, loading and error states. Colours come only from theme tokens, icons from react-icons, and the layout works on mobile (the board scrolls horizontally, the sheet is full screen).

## New packages

- backend: `nodemailer`, `@types/nodemailer` (dev), `multer`, `@types/multer` (dev); remove `resend`
- frontend: `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`

## Edge cases

- Removing an assignee who has subtasks assigned: unassign those subtasks.
- Assignee deactivated or deleted: skip them in notifications and reminders.
- A head reassigning outside their department gets 403. The department is recalculated from the first assignee.
- Comment mentions of users who can't view the task are ignored silently.
- File upload over the limit or of a disallowed type gets 413 or 415 with a clear message. GridFS chunks are removed when a file or task is deleted.
- A recurring parent that is deleted stops generating copies. Copies keep `recurringParent` for traceability.
- Board `position` uses fractional indexing (the midpoint of the neighbours). Positions are re-normalised server-side when the gap is below 1e-6.
- An SMTP failure never fails the API request (fire-and-forget, logged).
- Microsoft 365: if login fails with `535 5.7.139`, SMTP AUTH is disabled for the mailbox or MFA requires an app password. The test endpoint surfaces this hint.

## Security note (from the backup analysis)

The source backup contains 34 copies of an obfuscated PHP backdoor (`wp-cron.php` / `wp-blog-header.php` dropped across `bin/`, `etc/`, `mail/`, `ssl/`, `php/`, `perl5/` and others). None of that code is used here. The SMTP credentials must be for the Microsoft 365 mailbox, not for any mailbox on the compromised cPanel host.

## Affected files

**backend**
- models: `Task.ts`, `User.ts`, `Notification.ts`, `ActivityLog.ts`, plus new `TaskComment.ts`, `TaskFile.ts`, `TaskHistory.ts`, `TaskLabel.ts`, `TaskCategory.ts`, `TaskSettings.ts`
- controllers: `tasks.ts` (split into `tasks.ts`, `taskSubtasks.ts`, `taskComments.ts`, `taskFiles.ts`), `taskMeta.ts` (labels, categories, settings), `users.ts` (email preferences), `emailAdmin.ts`
- routes: `tasks.ts`, `taskMeta.ts`, `users.ts`, `admin.ts`
- lib: `email.ts` (rewrite), `notifications.ts` (new types, preference check, names, escaping), `taskJobs.ts`, `taskAccess.ts` (shared permission checks), `gridfs.ts`
- inngest: `functions/taskReminders.ts`, `functions/recurringTasks.ts`, `index.ts`
- scripts: `scripts/migrateTaskAssignees.ts`, `scripts/runJobs.ts`
- other: `server.ts`, `package.json`, `.env.example`

**frontend**
- routes: `routes.ts`, `routes/tasks.tsx`, `routes/admin/tasks.tsx` (redirect), `routes/admin/task-settings.tsx`, `routes/profile.tsx`
- `components/tasks/*` (board, card, list, filters, detail sheet, subtasks, comments, mention input, files, history, create/edit dialog, recurrence field, label chip)
- other components: `components/notifications/notification-bell.tsx`, `components/layout/app-sidebar.tsx`
- hooks: `use-tasks.ts`, `use-task-meta.ts`, `use-email-preferences.ts`
- `types.ts`

## Done when

- `bun run typecheck` passes in both `backend/` and `frontend/`.
- `bun run migrate:tasks` converts existing tasks, and running it again is a no-op.
- With `EMAIL_REDIRECT_TO` set and the M365 creds in `.env`:
  - The admin "send test email" arrives.
  - Creating a task with two assignees sends two `task_assigned` emails and two in-app notifications in real time.
  - Commenting with an @mention sends a `task_mention` to the mentioned user and a `task_comment` to the others.
- Dragging a card on the board persists its order and status across a reload. An assignee cannot drag to Completed.
- `bun run jobs:reminders` sends due/overdue reminders once; a second run the same day sends nothing.
- `bun run jobs:recurring` generates the next occurrence of a due recurring task.
- A head can create, assign, review and remind within their department from `/tasks`.
- Turning off "Task comments" email in Profile stops comment emails but keeps the in-app notifications.
