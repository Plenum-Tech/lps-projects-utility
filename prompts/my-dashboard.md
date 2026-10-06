# Personal "My Dashboard" + HR Dates + Employee Documents

## Goal

Every user gets a personal dashboard like Worksuite's `/account/dashboard` (the user's screenshots). To support its cards, three things are added:
1. **HR profile fields** on users: designation, employee ID, date of birth, joining date, probation end date, notice period and internship end date.
2. An **Employee Documents** module: documents with expiry dates, reminders and email notifications.
3. Daily reminder jobs for upcoming HR dates and expiring documents.

The existing organisation analytics (`GET /api/dashboard/analytics`, admin and head) stay. Admins and heads switch between **My dashboard** and **Organisation** with a toggle at the top of `/dashboard`. Employees only see My dashboard.

Out of scope, by the user's choice: an appreciations module, a holidays module, and birthday-wish emails.

## Data model

### User, extended (admin-editable in Manage Users; visible to the user on their Profile)

```ts
designation?: string (max 100)        // e.g. "Technical Lead - AI & ERP"
employeeId?: string (max 30)          // unique (sparse); auto "EMP-0001" sequence if left blank on create
dateOfBirth?: Date | null             // date-only
joiningDate?: Date | null
probationEndDate?: Date | null
internshipEndDate?: Date | null
noticePeriodStart?: Date | null
noticePeriodEnd?: Date | null         // >= start
lastHrReminderKeys?: string[]         // idempotency for daily reminders (bounded, keep last 20)
```

- **Privacy**: other users only ever see a colleague's birthday as **day and month**, never the year.
- **Who sees which dates**: probation, notice and internship dates are visible only to the person themselves, their department head and admins.
- **Migration** (`bun run migrate:hr`, idempotent): assigns `employeeId` to existing users in `createdAt` order and creates the counter.

### EmployeeDocument (new)

```ts
user: ObjectId                         // whose document
type: "passport" | "visa" | "work_permit" | "national_id" | "driving_license" | "contract" | "certificate" | "insurance" | "other"
name: string (max 120)                 // e.g. "UAE Residence Visa"
issueDate?: Date | null
expiryDate?: Date | null               // optional — some documents never expire
notes?: string (max 1000)
file?: { filename, mimeType, size, gridFsId } | null    // reuse lib/gridfs.ts; pdf/images/office; 10 MB
uploadedBy: ObjectId
reminderKeys: string[]                 // e.g. "30d", "7d", "0d", "expired"
```

- **No document numbers are stored**, to avoid keeping sensitive identifiers. Only the name, type, dates and the file.
- **Access**:
  - The user can view their own documents and add their own.
  - Admins can see and manage everyone's.
  - Heads can view documents of their department, but not edit them.
  - Only admins and the uploader can delete. File downloads are permission-checked on each request.

### Notification types

- `document_expiring`: the document's owner and admins.
- `hr_date_upcoming`: probation, notice or internship ending. Goes to admins, the department head and the employee.

Both are gated by a new email preference `emailPreferences.hrReminders` (default true).

## Backend

| Method | Path | Notes |
|---|---|---|
| GET | `/api/dashboard/me` | **One aggregated call** for the personal dashboard (shape below). |
| GET | `/api/dashboard/me/calendar?from&to` | Items for My Calendar: my tasks (due, or start→due), my leaves (approved and pending), deadlines of projects I'm a member of, my subtasks due. Max 500. |
| GET | `/api/dashboard/me/timelogs?weekStart=` | Per-day `{ date, minutes, breakMinutes }` for Mon–Sun, plus `{ totalMinutes }`. |
| PATCH | `/api/users/:id` | Accepts the new HR fields (admin). |
| GET / PATCH | `/api/users/me` | Returns the HR fields. Users can't edit them; read-only for self. |
| GET / POST | `/api/documents` | `?user=` (admin or head scope; defaults to me), `?expiring=30`, plus pagination. POST is multipart. |
| PATCH / DELETE | `/api/documents/:id` | |
| GET | `/api/documents/:id/file` | Streams the file. |

**`GET /api/dashboard/me` shape**:

```ts
{
  profile: { name, email, role, designation, employeeId, department: {name}|null, avatarInitials },
  counts: {
    openTasks,            // assigned to me, not completed
    pendingTasks,         // todo + in_progress + in_review assigned to me
    overdueTasks,         // assigned to me, due < today, not completed
    projects,             // projects I'm a member/manager of, not archived
    projectsInProgress,   // of those, status not completed
    projectsOverdue,      // of those, deadline < today and not completed
  },
  myTasks: [{ _id, code, title, labels, status, dueDate, priority, project }],  // 10 most urgent: overdue first, then by due date
  onLeaveToday: [{ user: {name, designation}, until }],       // approved leave covering today; leave type hidden
  birthdays: [{ user: {name, designation}, day, month, inDays }],           // next 30 days, all active users
  joiningsAndAnniversaries: [{ user, kind: "joining"|"anniversary", years }], // today
  probation: [...], notice: [...], internship: [...],          // ending in next 30 days — scoped: self / department (head) / all (admin)
  documentExpiries: [{ _id, name, type, user, expiryDate, inDays }],  // next 60 days + expired — scoped like above
  weekTimelogs: { weekStart, days: [{date, minutes, breakMinutes}], totalMinutes }
}
```

Every list is capped at 10, with a "View all" link where a page exists. All date-only comparisons use `APP_TIMEZONE`.

**Daily job `hrReminders`** (Inngest cron at 08:00, plus `bun run jobs:hr` and the dev in-process interval):
- **Documents** expiring in 30 days, 7 days, today, or already expired → `document_expiring`. Each threshold fires once.
- **Probation, notice or internship** ending in 7 days and today → `hr_date_upcoming`, once per key.
- Idempotency keys are stored on the documents and users.

**Email templates**:
- `documentExpiringTemplate`: the name, type, owner, expiry date and "in N days" / "expired N days ago", with a button to the Documents page.
- `hrDateTemplate`: who, which date and when.

## Frontend

### `/dashboard`

For admins and heads, a segmented toggle at the top: **My dashboard | Organisation**. The choice is remembered in localStorage, and the Organisation view is the existing page, unchanged. My dashboard is the default for employees and the first option for others.

My dashboard layout, a responsive 12-column grid. On desktop the left column is about 5/12 and the right about 7/12, matching the screenshot; everything stacks on mobile.

**Top row**
- **"Welcome {name}"** with a **live clock** at the right ("12:17 pm", weekday below), ticking every minute.

**Left column**
- **Profile card**: avatar initials, name, designation, "Employee ID: EMP-0004" and department. Below a divider, **Open tasks** and **Projects** counts, which link through.
- **Birthdays**: list with avatar, name, designation, a "🎂 25 Nov" chip, and "today" / "in 3 days" / "1 month after", following Worksuite's wording.
- **On leave today**.
- **Today's joinings & work anniversaries**: "Joined today" or "3 years today 🎉".
- **Probation ending**, **Notice period**, **Internship ending**: each shows name, date and "in N days". These cards are shown only when the viewer is allowed to see them.
- Each card has its designed empty state, with an icon and "No record found".

**Right column**
- **Tasks card**: **Pending** (primary colour) and **Overdue** (destructive colour) as large numbers, each linking to the task list filtered that way.
- **Projects card**: **In progress** and **Overdue** in the same style.
- **Week time logs**: the header shows a badge like "6h 20m this week". Mo–Su day pills, with today highlighted and selectable. A bar shows the selected day's worked minutes against breaks, with "Duration: 2h 10m" on the left and "Break: 15m" on the right. Prev/next week arrows.
- **Document expiries**:
  - A count badge in the header.
  - Rows show the document name, owner (for admins and heads), and the expiry date with an urgency colour: past is destructive, ≤7 days amber, otherwise muted.
  - Empty state: "No upcoming document expiries".
- **My tasks**: a compact table with Task#, the title and labels, a status dot, and the due date (red when overdue). The body scrolls inside the card, about 6 rows high. Clicking a row opens the task sheet.
- **My calendar**:
  - Prev / next / **today**, a range title, and **month · week · day · list** views.
  - It reuses `components/globals/calendar-month.tsx` from the tables work and adds day and list modes.
  - Items are colour-coded by kind: task, subtask, leave, project deadline.
  - Empty state: "No events to display".

### Profile page

A read-only **Employment** card showing designation, employee ID, department, joining date, date of birth, and probation, notice and internship dates where they are set.

### Manage Users → user dialog

An **Employment** section with all the HR fields, using date pickers. Employee ID shows a placeholder "Auto (EMP-00xx)".

### Documents

- **`/documents`**: employees see "My documents"; admins and heads get a user filter.
- **Table columns**: name, type, owner, issue date, expiry (with the urgency colour), file (download), actions.
- **Upload dialog**: type, name, issue and expiry dates, notes, file.
- **Navigation**: "Documents" appears in the **My workspace** sidebar group for everyone, and admins also get it under Administration.

### Other changes

- **Email preferences card**: an "HR reminders" switch.
- **Notification bell**: icons for the two new notification types.

## Edge cases

- **Birthdays on 29 February** fall on 28 February in non-leap years.
- **Anniversaries** count only full years, so the joining day itself shows "Joined today" with no anniversary.
- **Inactive or deleted users** are excluded from every card.
- **A department head who has no department** sees only their own dates.
- **Documents without an expiry** never appear in the expiry card.
- **Deleting a user** deletes their documents, including the GridFS files.
- **The dashboard request** must be fast: at most about 10 indexed queries, run in parallel with `Promise.all`.

## Dependencies and order

Build this after the Worksuite tables work. It reuses `calendar-month.tsx`, the avatar stack and the table styles from that work.

## Affected files

**backend**
- models: `User.ts`, `EmployeeDocument.ts` (new), `Notification.ts`
- controllers: `dashboard.ts`, `users.ts`, `documents.ts` (new)
- routes: `dashboard.ts`, `documents.ts` (new); mounted in `server.ts`
- lib: `hrJobs.ts` (new), `email.ts`, `notifications.ts`
- inngest: `functions/hrJobs.ts`
- scripts: `migrateHr.ts`, `runJobs.ts`

**frontend**
- routes: `routes/dashboard.tsx` (toggle), `routes/documents.tsx` (new), `routes.ts`
- components:
  - `components/dashboard/my-dashboard/*`: welcome-clock, profile-card, stat cards, week-timelogs, people-list card, document-expiries, my-tasks-table, my-calendar
  - `components/documents/*`
  - user dialog Employment section, profile Employment card, email-preferences card, notification bell, sidebar
- hooks: `use-my-dashboard.ts`, `use-documents.ts`
- `types.ts`

## Done when

- Both typechecks pass, and `migrate:hr` is idempotent.
- An employee sees My dashboard:
  - counts that match their task and project lists
  - the week time logs match `/timelogs`
  - the calendar shows their tasks, leaves and project deadlines in all four views
  - only their own HR dates and documents
- An admin toggles to Organisation and back, and sees everyone's upcoming probation, notice and internship dates and document expiries.
- **Birthdays**: a birthday set 3 days ahead shows "in 3 days", with no birth year visible to others.
- **Document reminders**: a document expiring in 7 days triggers a `document_expiring` email once (`bun run jobs:hr` twice sends one).
- **Mobile**: at 375px all cards stack with no horizontal scroll.
