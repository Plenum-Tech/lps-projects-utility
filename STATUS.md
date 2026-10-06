# LPS – Projects Utility — build status: ✅ ready to test

The code lives in this folder (call it **WT**):
`C:\EMS\AI-Powered-Real-time-Employee-Management-System\.claude\worktrees\ems-backend-setup-e5fd54`

Your normal checkout `C:\EMS\AI-Powered-Real-time-Employee-Management-System` has **not** been changed. Nothing is committed yet.

| Step | Result |
|---|---|
| Phase 1 backend: tasks, subtasks, comments, files, board, reminders, recurring tasks, Microsoft 365 SMTP | ✅ typecheck passes; 36/36 API checks |
| Phase 1 frontend: `/tasks` board and list, detail panel, task settings, profile email switches | ✅ typecheck and build pass |
| Phase 2 backend: projects, milestones, timer and time logs, weekly timesheets, reports | ✅ typecheck passes; 176/176 + 24/24 API checks |
| Phase 2 frontend: Work and Reports menus, project page, timer, timesheet, 3 reports | ✅ typecheck and build pass; clicked through in a browser on a scratch database |
| User invitations: Invite people, Invitations tab, `/invite/<link>` join page, user filters | ✅ typecheck and build pass; 41/41 API checks; clicked through in a browser |
| UI tweaks: "+ Manage …" links in the project and task forms, settings moved up the sidebar, wide tables no longer stretch the page | ✅ |
| Proxy setting: rate limits use the real client IP only behind a proxy (Vercel automatically, or `TRUST_PROXY`) | ✅ |
| Live updates: one connection per browser, shared across tabs (fixes the "timeout of 15000ms" errors) | ✅ verified with 5 tabs, including failover |
| Subtask form (Worksuite-style) + subtask emails + task Notes tab | ✅ 71/71 API checks; browser-checked |
| Worksuite-style Projects & Tasks tables: estimate vs hours logged, calendar, pinned, waiting approval, recurring list, bulk actions, CSV export | ✅ 419/419 API checks; browser-checked |
| My dashboard + HR fields + Employee Documents + HR/document reminder emails | ✅ 87/88 API checks (the one failure was a mistake in the test); browser-checked as admin and as employee |
| Rate-limit fixes (found during the browser test) | ✅ API limit raised 100 → 1000 per 15 min; the notification stream is exempt; the strict limit now covers login only (it used to lock you out after about 10 page refreshes) |

## Morning test: Windows `cmd`, step by step

**1. Stop** the backend and frontend you started yesterday from the normal folder (press Ctrl+C in those windows). Leave Docker / `ems-mongo` running.

**2. Copy your env files into WT:**
```
copy /Y C:\EMS\AI-Powered-Real-time-Employee-Management-System\backend\.env C:\EMS\AI-Powered-Real-time-Employee-Management-System\.claude\worktrees\ems-backend-setup-e5fd54\backend\.env
copy /Y C:\EMS\AI-Powered-Real-time-Employee-Management-System\frontend\.env C:\EMS\AI-Powered-Real-time-Employee-Management-System\.claude\worktrees\ems-backend-setup-e5fd54\frontend\.env
```

**3. Edit `WT\backend\.env`.** Remove `RESEND_API_KEY` and add:
```
APP_URL=http://localhost:5173
APP_TIMEZONE=Asia/Kolkata
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=admin@hoistra.ai
SMTP_PASS=<your mailbox password; change it first, since it was shared in chat>
FROM_NAME=LPS – Projects Utility
FROM_EMAIL=admin@hoistra.ai
EMAIL_REDIRECT_TO=bala.r@plenum-tech.com
```
`EMAIL_REDIRECT_TO` sends **all** emails to you while testing. Leave it empty to email the real people.

**4. Backend** (window 1):
```
cd C:\EMS\AI-Powered-Real-time-Employee-Management-System\.claude\worktrees\ems-backend-setup-e5fd54\backend
bun install
bun run migrate:tasks
bun run migrate:projects
bun run migrate:tables
bun run migrate:hr
bun run dev
```
Expect `✅ MongoDB connected: ems`, `✅ SMTP ready (smtp.office365.com)`, and `✅ Express server running on http://localhost:5000`.

**5. Frontend** (window 2):
```
cd C:\EMS\AI-Powered-Real-time-Employee-Management-System\.claude\worktrees\ems-backend-setup-e5fd54\frontend
bun install
bun run dev
```
Open http://localhost:5173 and log in as `admin@ems.local` (password = `ADMIN_PASSWORD` in `.env`).

## What to try

1. **Admin → Task Settings**: check the SMTP status card, then **Send test email**. It should arrive at bala.r@plenum-tech.com.
   - If it fails with `535 5.7.139`, turn on Authenticated SMTP for the mailbox in Microsoft 365 admin, or use an app password if MFA is on.
2. **Admin → Users**: create a department head and two employees in the same department. Give them hourly rates.
3. **Work → Projects**: create a project (code e.g. `WEB`) and add the employees as members.
4. In the project's **Tasks** tab:
   - Create tasks; they get codes `WEB-1`, `WEB-2`.
   - Open one: add subtasks, comment with `@name`, upload a file.
   - Drag the card on the board.
5. **Timer** (top bar): start on a task → pause → resume → stop. Then check **Work → Timesheet → Time logs**.
6. **Timesheet**: as an employee, fill in the week, save, and submit. As the head, approve or reject it in **Reports → Weekly Timesheet**.
7. **Reports**: Task Report, Time Log Report, CSV export.
8. **Profile**: turn off an email switch and confirm those emails stop (in-app notifications still arrive).
9. Reminder jobs on demand (in the backend folder): `bun run jobs:reminders`, `bun run jobs:time`, `bun run jobs:projects`.

## Known limits / open items

- The "log time for someone else" picker shows for heads and admins only, not for an employee who manages a project.
- Task pickers in the timer and timesheet load at most 100 tasks.
- The board may offer a drop column that the server then refuses for a project manager who didn't create the task. The server stays correct; you just get an error toast.
- In the embedded test browser, dialogs sometimes lingered after closing. That is probably a test-browser artifact, so please check it in Chrome.
- The SSE and in-memory jobs are single-server. On Vercel, the scheduled jobs need Inngest (the functions are included).

## When you're happy

Tell Claude "commit and merge". It will commit this work on branch `claude/ems-backend-setup-e5fd54` so you can merge it into `main`.
