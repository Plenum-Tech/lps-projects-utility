# Worksuite → Projects Utility Data Migration (LPS Brands)

## Goal

Import the **LPS Brands** company (Worksuite `company_id = 18`) from the MySQL dump `projectsutility_new.sql` into Projects Utility's MongoDB. That covers users, departments, projects, tasks and everything attached to them. File attachments are also extracted from the server backup. The migration is a **repeatable, idempotent script**: it runs first against the local `ems` database for review, and later unchanged against Atlas / production.

Users are migrated **without passwords**. Each person sets a new password through a one-time **set-password link**, because the old password hashes came from the compromised server.

## Sources

- **SQL dump**: `C:\Users\balap\Downloads\projectsutility_new.sql` (MariaDB 10.11, 140 MB). It is parsed by a streaming SQL-values parser. No MySQL server is needed.
- **Backup**: `C:\Users\balap\Documents\projectutility\backup-4.17.2026_08-39-48_projectsutility.tar.gz`. Only the referenced files under `homedir/public_html/public/user-uploads/{task-files,project-files,sub-task-files}/…` are streamed out.
  - The backup is **never fully extracted**.
  - Nothing outside those three folders is read. This matters because the archive contains malware and secrets.
  - Files are validated against the allowed types and size limit before storing.
- **Sensitive tables are never read**: `smtp_settings`, `payment_gateway_credentials`, `stripe_setting`, `sessions`, `password_resets`, `user_auths`, `social_auth_settings`, `slack_settings`, `pusher_settings`, `quick_books_settings`. Password columns are never selected.

## Scope (company 18 only; soft-deleted rows skipped)

| Worksuite | → Projects Utility | Rows (approx.) |
|---|---|---|
| `teams` | `Department` (matched by name, case-insensitive; created if missing) | 21 |
| `designations` | `User.designation` (name) | 106 |
| `users` + `employee_details` + `role_user` | `User`: name, email (lowercased), role (`admin`→admin, `employee`→employee; **clients and superadmins skipped**), department, designation, employeeId, joiningDate, dateOfBirth, probation/notice/internship dates, hourlyRate | 59 |
| `project_category` | `ProjectCategory` | 20 |
| `project_status_settings` | `ProjectStatus`: in progress→In progress, not started→Not started, on hold→On hold, canceled→Cancelled, finished→Finished | 5 |
| `projects` | `Project`: name, code (`project_short_code`, made unique; generated if empty), summary (HTML→text), category, departments (`project_departments`), manager (`project_admin`), status, startDate, deadline, progress (`completion_percent`), progressMode (`calculate_task_progress`), budget, hoursAllocated, isPublic, createdBy, createdAt | ~490 |
| `project_members` | `Project.members[]` with hourlyRate | ~3,800 |
| `project_milestones` | `Milestone` (complete/incomplete, start/end) | 41 |
| `project_notes` | `ProjectNote` (public→members, private→private + sharedWith) | 11 |
| `project_files` | `ProjectFile` + GridFS (external links become a project note) | 14 |
| `task_category` | `TaskCategory` | ~50 |
| `task_label_list` / `task_labels` | `TaskLabel` + `Task.labels` | 25 / 97 |
| `tasks` | `Task` (details below) | ~10,560 |
| `task_users` | `Task.assignees` (missing project members are added to the project) | ~16,000 |
| `sub_tasks` / `sub_task_files` | `Task.subtasks[]` (title, description, dates, done, assignee) + subtask files | 300 / 1 |
| `task_comments` | `TaskComment` (HTML→text; mention spans become plain `@Name`) | 1,905 |
| `task_notes` | `TaskNote` (visibility: task) | 113 |
| `task_files` | `TaskFile` + GridFS; Google/Dropbox/external links become a comment "Linked file: name — url" | 610 |
| `task_history` | `TaskHistory`, with actions mapped (create→created, status→status_changed, file→file_added, subTask*→subtask_*; anything else → updated, with the original key kept) | ~28,900 |
| `project_time_logs` + `_breaks` | `TimeLog` (status approved/pending/rejected, breaks, memo, rate, earnings); **running timers (no end time) are skipped and reported** | 2,204 / 1,399 |
| `pinned` | `User.pinnedTasks` / `pinnedProjects` | 25 |

**Not migrated**: clients, attendance, leaves (none exist), notifications, activity logs, chat, invoices and finance, tickets, Slack/push settings, custom fields, recurring schedules (see Tasks).

### Task field mapping

- **Basics**:
  - `heading` → title (trimmed to 200; the full original goes in the description if longer).
  - `description` HTML → text. The `Task.description` limit is **raised to 20,000** so long briefs aren't cut.
- **Status**, from the **board column**, which is what users saw in Worksuite:

  | Board column | Status |
  |---|---|
  | Incomplete | `todo` |
  | To Do | `todo` |
  | In Process / Doing | `in_progress` |
  | Waiting Approval | `in_review` |
  | Completed | `completed` |

  `completedAt` comes from `completed_on`, falling back to `updated_at`.
- **Codes**: `shortCode` is kept from `task_short_code` when unique within the project (the project's `taskCounter` is set to the max). `number` is assigned sequentially by `createdAt`.
- **Other fields**:
  - priority: low/medium/high
  - start and due dates
  - estimate = hours × 60 + minutes
  - project, milestone, category
  - `assignedBy` from `created_by`, falling back to `added_by`
  - `createdAt` and `updatedAt` are preserved
- **Recurring tasks**: the `recurringParent` links are kept, but `recurrence` is imported **disabled**, so nothing is generated straight after import. The report lists the formerly recurring tasks so an admin can re-enable them.
- **Dropped**: `is_private`, `billable`, `dependent_task_id`, `event_id`, `hash`. Private tasks are reported.

### Dates

Worksuite stores DATETIME values in **UTC** (Laravel default), so they're converted as UTC. Date-only columns (due, start, deadline, birth, joining) are stored as date-only. The company timezone was Asia/Dubai, so the report suggests setting **App Settings → Timezone** to Asia/Dubai.

## Users and sign-in

- **New users**: created with **no usable password** and `passwordSetupRequired: true`. Signing in with such an account gives "Your account needs a password — use the link from your administrator." Emails that already exist in Projects Utility are **matched and updated**, not duplicated, and existing passwords are kept.
- **Set-password links** (new feature, reusing the invitation token design):
  - Tokens are SHA-256 hashed, valid for 7 days, single use.
  - `POST /api/users/:id/password-link` (admin) returns `{ setupUrl }` and emails it when SMTP is configured.
  - `POST /api/users/password-links` (admin, bulk) takes `{ userIds }` and returns the results.
  - Public `GET` / `POST /api/password-setup/:token` (rate-limited). Setting the password signs the user in.
- **UI**:
  - **Manage Users** gets a "Needs password" badge and filter, plus the actions **Send set-password link**, **Copy link** and a bulk **Send links to all**.
  - New public page **`/set-password/:token`**, in the style of the login page.
- **Roles**: Worksuite has no department heads, so everyone migrates as employee or admin. Admins promote heads afterwards in Manage Users.

## Script

`backend/src/scripts/importWorksuite.ts`, run as `bun run import:worksuite -- --sql <path> --backup <path> --company 18 [--dry-run] [--skip-files] --confirm`.

- **Idempotent**: every created document stores `legacy: { source: "worksuite", id }`. On rerun it upserts by legacy id instead of creating duplicates. The relevant models get a sparse index on `legacy.id`.
- **Safe to run**:
  - Refuses to run without `--confirm`, and prints the target DB name and host first.
  - `--dry-run` parses and validates everything and writes only the report.
  - It sends **no emails or notifications** and writes no activity-log spam; it records one `import_completed` activity.
- **Order**: departments → users → categories/statuses/labels → projects (+ members, milestones, notes) → tasks (+ assignees, subtasks, labels) → comments, notes, history → files → time logs → pins → counters (task numbers, project task counters) → progress recalculation.
- **Batching**: `insertMany` / `bulkWrite` in batches of 500. The target is about 2 minutes for the whole dataset, not counting files.
- **Report**: `import-report-<timestamp>.json` with counts per entity (created / updated / skipped) and lists of skipped rows with reasons (deleted, client, missing reference, running timer, missing file, oversized file, private task). No passwords or other secrets are written to it.

## Process

1. Start Docker Desktop and `ems-mongo`, then take a **mongodump backup** of the local `ems` database.
2. Run a dry run and review the report.
3. Run the real import against the local `ems` database.
4. Verify:
   - The counts match the dump.
   - Spot-check 10 random tasks against the SQL: title, assignees, status, dates, comments, files.
   - Delivery Pulse shows sensible historical numbers.
5. Generate the set-password links.
6. Later, when Atlas is set up, run the same command against Atlas / production.

## Done when

- Both type checks pass, and the backend bundle builds (the script is included in the image's `dist/scripts`).
- The dry run and the real run complete. Counts match the dump within the documented skips, and a rerun produces 0 new documents.
- Spot checks pass, and the attachments download correctly.
- A migrated user can't sign in until they use a set-password link; after that they can, and they see their own tasks and projects.
- The `ems` DB backup exists, and restoring it is documented.
