# Full Subtask Form (Worksuite-style) + Subtask Emails

## Goal

Replace the inline "Add a subtask…" row in the task detail sheet with a full subtask form like Worksuite's. The fields are:
- **Title** (required)
- **Start date** and **Due date**
- **Assigned to**: a searchable person picker, marked "It's you" for the current user
- **Description**
- **Upload file**: attachments on the subtask

The same form is used to add and to edit. Every subtask event sends in-app and **email** notifications through the existing Microsoft 365 SMTP setup, gated by the user's email preferences.

## Data model

### Subtask (embedded in `Task.subtasks[]`), extended

```ts
title: string (max 200)            // existing
description?: string (max 2000)    // NEW
startDate?: Date | null            // NEW
dueDate?: Date | null              // existing
assignee?: ObjectId | null         // existing; rule relaxed (see Permissions)
done, completedAt, createdBy       // existing
updatedBy?: ObjectId | null        // NEW
```

Validation: `startDate <= dueDate` when both are set. A subtask due date after the parent task's due date is allowed, but the UI shows a warning (the same pattern as milestones).

### TaskFile, extended

Add `subtask?: ObjectId | null`. Subtask attachments reuse the same GridFS storage, size and type limits, and download/delete endpoints. The per-task file limit of 20 counts subtask files too. Deleting a subtask deletes its files.

### Notification types

- `subtask_created`: **new**
- `subtask_assigned`, `subtask_completed`: existing; both now always send email (subject to user preferences)

## Permissions (changed)

- **Assignee rule:** a subtask may be assigned to:
  - any task assignee
  - the task creator
  - project members, if the task is in a project
  - for heads and admins, anyone they can assign tasks to

  This replaces the old rule that a subtask assignee had to be a task assignee, and matches Worksuite.
- **Visibility:** a **subtask assignee can view the parent task** (detail, comments, files) and can tick their own subtask done, even if they aren't a task assignee. They don't get the task on their board or in "Assigned to me". Their subtasks show in a new **"My subtasks"** strip at the top of `/tasks`, listing each open subtask with its parent task and due date and linking to the parent task.
- **Who can add or edit subtasks:** the task manager (creator, admin, project manager, or the head of that department) **and task assignees**. Worksuite lets assignees add subtasks; today ours only allows managers.
  - Assignees may edit or delete only subtasks they created.
  - Anyone involved may toggle done on a subtask assigned to them or unassigned.

## Backend

| Method | Path | Change |
|---|---|---|
| POST | `/api/tasks/:id/subtasks` | Body adds `description`, `startDate`, plus the relaxed `assignee` rule. Assignees can now add subtasks. Returns `{ task, permissions }` as today. |
| PATCH | `/api/tasks/:id/subtasks/:subId` | Same new fields, and sets `updatedBy`. |
| POST | `/api/tasks/:id/subtasks/:subId/files` | **New**. Multipart upload attached to the subtask, with the same limits as task files. |
| GET | `/api/tasks/:id/files` | Each file now includes `subtask` (an id or null). An optional `?subtask=` filter. |
| GET | `/api/tasks/subtasks/mine` | **New**. Open subtasks assigned to me on tasks where I'm not a task assignee, with the parent `{ _id, title, shortCode, project }`. |

**Notifications** (in-app and email; recipients never include the actor):

| Type | When | To | Email pref |
|---|---|---|---|
| `subtask_created` | Subtask added | Task assignees + creator | taskUpdates |
| `subtask_assigned` | Assignee set or changed, on add or edit | The subtask assignee | taskAssigned |
| `subtask_completed` | Marked done | Creator + task assignees + subtask creator | taskUpdates |

When a subtask is created *with* an assignee, that person gets only `subtask_assigned`, not both notifications.

**Email template** `subtaskTemplate`, styled like the task emails:
- The subtask title, the parent task (with its short code), start and due dates, and the assignee.
- The description, escaped.
- How many attachments it has.
- A button linking to `/tasks?task=<id>&subtask=<subId>`.

**History**: `subtask_added`, `subtask_updated` (new), `subtask_completed`, `subtask_reopened`, `subtask_removed`, and `file_added` now carries `{ subtask }` when relevant.

## Frontend

**Task detail sheet → Subtasks tab**
- The list shows rows: checkbox, title, assignee avatar ("You" badge), date range chip (red when overdue), paperclip count, and a ⋯ menu with Edit and Delete.
- Clicking a row expands it inline to show the description and attachments, with download and delete actions.
- An **"+ Add subtask"** button opens the **Subtask form** in a dialog. The form uses `components/tasks/subtask-form.tsx`, and is the same for add and edit.
  - **Title**: required, max 200.
  - **Start date** and **Due date**: date pickers, validated, with a warning if the due date is after the task's.
  - **Assigned to**: a searchable single-select starting with "Unassigned". Each option shows avatar, name and email, and the current user gets an **"It's you"** badge. Options follow the assignee rule above.
  - **Description**: textarea, max 2000.
  - **Upload file**: a "📎 Upload file" link that opens a file picker; drag and drop works too. Selected files are listed and can be removed before saving, and are uploaded after the subtask is created. Same type and size limits as task files.
  - Footer: **Cancel** and **Submit** (Save when editing).
- `?subtask=<id>` in the URL opens the sheet with that subtask expanded, which is where email links land.

**Elsewhere**
- **Files tab:** files are grouped into "Task files" and "Subtask: {title}".
- **Create-task dialog:** the initial subtasks list stays title-only for quick entry. Full fields are set from the sheet.
- **`/tasks`:** a "My subtasks" strip, shown only when the user has some.
- **Notification bell:** an icon for `subtask_created`. Subtask notifications link to `?task=…&subtask=…`.

## Task Notes (approved addition; Worksuite `task_notes`)

A **Notes** tab in the task detail sheet, next to Comments. Comments are the conversation; notes are longer-lived reference text such as specs, credentials locations, or decisions.

**Model `TaskNote`** (new collection):
- Fields: `task` (indexed), `author`, `title` (optional, max 150), `body` (max 10000, plain text with line breaks), `visibility` (`"task"`, meaning everyone who can view the task, or `"private"`, meaning only the author and admins), `mentions: ObjectId[]`, `pinned: boolean`, `editedAt`, plus timestamps.
- Index: `{ task: 1, pinned: -1, createdAt: -1 }`.

**Endpoints** under `/api/tasks/:id/notes`:
- `GET` lists notes the caller may see, pinned first.
- `POST` takes `{ title?, body, visibility }`.
- `PATCH /:noteId`: the author can edit; the author or task manager can pin.
- `DELETE /:noteId`: the author, the task manager or an admin.
- Mentions use the same `@[Name](userId)` tokens as comments. Only users who can view the task count, and private notes ignore mentions.

**Notifications** (in-app and email, gated by the `taskComments` preference):
- `task_note`: a task-visible note was added. Goes to task assignees and the creator, except the author and anyone mentioned.
- `task_note_mention`: someone was @mentioned in a note.

**History**: `note_added`, `note_updated`, `note_removed`.

**UI**:
- Note cards show the title, body (with show more/less), author and time, an "edited" marker, a 📌 pinned badge, and a 🔒 Private badge.
- The editor reuses the mention textarea, plus a title field and a "Private (only me)" switch.
- Designed empty state: "Keep specs, decisions and handy links here."
- **Deleting a task** also deletes its notes.

Affected files add: `models/TaskNote.ts`, `controllers/taskNotes.ts`, routes, `notifications.ts`, `email.ts` (note template), `components/tasks/task-notes.tsx`, `task-detail-sheet.tsx` (tab), `hooks/use-tasks.ts`, `types.ts`, `notification-bell.tsx`.

**Done when** add: notes CRUD works; private notes are invisible to other users (API returns 404 or omits them); mentions notify by email; pinned notes sort first.

## Edge cases

- Removing a person from the task's assignees doesn't unassign their subtasks any more, since subtask assignees now stand alone. Removing them from the **project** still unassigns their subtasks in that project.
- If a subtask assignee is deactivated or deleted, the subtask shows "Unassigned" and they get no notifications.
- A file upload failing after the subtask is created leaves the subtask saved. The form shows which files failed, with a retry.
- Deleting a subtask removes its GridFS files.

## Affected files

**backend**
- models: `Task.ts`, `TaskFile.ts`, `Notification.ts`
- `controllers/taskSubtasks.ts`, `controllers/taskFiles.ts`, `controllers/tasks.ts` (`subtasks/mine`)
- `routes/tasks.ts`
- lib: `taskAccess.ts` (subtask-assignee view rights), `notifications.ts`, `email.ts`

**frontend**
- `types.ts`, `hooks/use-tasks.ts`
- `components/tasks/`: `task-subtasks.tsx`, `subtask-form.tsx` (new), `task-files.tsx`, `task-detail-sheet.tsx`, `task-workspace.tsx` ("My subtasks" strip)
- `notification-bell.tsx`

## Done when

- Both typechecks pass.
- An assignee adds a subtask with title, dates, another person, a description and 2 files:
  - The subtask assignee gets a `subtask_assigned` email with an attachment count and a working link that opens the subtask.
  - The task creator gets `subtask_created`.
- The subtask assignee, who isn't a task assignee, sees it under "My subtasks", can open the parent task, and can tick it done. That sends `subtask_completed` emails.
- Editing the subtask changes its fields and history, and reassigning notifies only the new assignee.
- Deleting the subtask removes its files.
