# Settings Area + HR Module Navigation

## Goal

1. **A Settings area like Worksuite's.** A single `/settings` page with a searchable left menu of sections, showing only sections that apply to EMS. Settings that are scattered today (Task Settings, Project Settings, leave policies, SMTP test, email preferences, profile) move into it, and new **Company**, **Business Address** and **App** settings are added.
2. **Sidebar reorganised into modules**, following Worksuite's Dashboard · HR · Work · Reports · Settings. Everything HR-related, **Announcements included**, lives under one collapsible **HR** group.

## 1. Sidebar (new information architecture)

| Group | Items | Visible to |
|---|---|---|
| **Dashboard** | Dashboard | all |
| **HR** (collapsible) | Employees (= Manage Users, admin), Departments (admin), **Leaves** (employee: my requests; head/admin: manage, as tabs), **Attendance**, **Documents**, **Performance Reviews**, **Feedback**, **Announcements**, Invitations (admin; opens Employees → Invitations tab) | items filtered by role |
| **Work** (collapsible) | Projects, Tasks, Meetings, Timesheet | all |
| **Reports** (collapsible) | Task Report, Time Log Report, Weekly Timesheet, **HR Reports** (moved from Administration; admin only), **Activity Log** (admin) | head and admin |
| **Settings** | a single link to `/settings` | all (sections filtered by role) |

Notes:
- The "My workspace" and "Administration" groups are **removed**. Their items move into the groups above.
- **"My Profile"** moves to Settings → Profile Settings. The user card at the bottom of the sidebar also links there.
- **Leaves page**: each role gets one entry. Employees see "My leave requests". Heads and admins see tabs: **My requests | Team requests | Leave policies** (admin only).
- **Performance Reviews and Feedback**: one entry each that opens the right view for the role. The current `/admin/...` and personal routes stay and redirect, so old links and email buttons keep working.
- **Header**: the sidebar shows the **company name and logo** from Company Settings (falling back to "EMS").
- **Order of items**:
  - HR: Employees, Departments, Leaves, Attendance, Documents, Performance Reviews, Feedback, Announcements
  - Work: Projects, Tasks, Meetings, Timesheet
- **AI Insights** stays hidden behind its feature switch. When enabled, it appears under Reports.

## 2. Settings area (`/settings`, `/settings/:section`)

**Layout**:
- A left panel (≈280px): a **Search** box that filters sections by name and keywords, then the section list with the active item highlighted.
- A content card on the right with a title, the form, and a footer **Save** button. Save is disabled until something changes, and you're warned about unsaved changes when leaving.
- On mobile, the section list becomes a select at the top.

| Section | Who | Contents |
|---|---|---|
| **Company Settings** | admin | Company name*, Company email*, Company phone, Website, **Logo** upload (png, jpg or svg, ≤1 MB, shown in sidebar and emails) |
| **Business Address** | admin | Address lines, city, state, postal code, country; shown in email footers |
| **App Settings** | admin | **Timezone** (searchable IANA list; replaces the `APP_TIMEZONE` env, which stays as fallback), **Date format** (DD-MM-YYYY · MM-DD-YYYY · YYYY-MM-DD), **Time format** (12h / 24h), **Week starts on** (Mon/Sun; used by timesheets, calendars and week time logs), **Currency** (code + symbol; for project budgets), **App URL** (used in email links; env fallback) |
| **Profile Settings** | everyone | The current profile page content: name, password change, Employment card (read-only) |
| **Notification Settings** | everyone | **My email notifications** (the existing preference switches). Admin also gets the **Email (SMTP) status + Send test email** card (moved from Task Settings) and a read-only summary of which events send email. |
| **Task Settings** | admin | Labels, categories, reminder timing (moved from `/admin/task-settings`) |
| **Project Settings** | admin | Project statuses, categories, deadline reminders (moved from `/admin/project-settings`) |
| **Time Log Settings** | admin | log-time-for, approval required, auto-stop time, tracker reminder, daily report (split out of Project Settings) |
| **Leave Settings** | admin | Leave policies / types (moved from the admin Leaves page) |
| **Meeting Settings** | admin | AI extraction status (read-only: shows whether `MEETING_AI_EXTRACTION` and a key are configured) |
| **Security** | everyone | Change password (moved out of Profile), and "Sign out of other sessions" if supported, otherwise omitted |

- The old routes `/admin/task-settings`, `/admin/project-settings` and `/profile` **redirect** to their new sections.
- The "+ Manage …" links in the task and project forms point to the new section URLs.
- Non-admins see only Profile, Notification and Security. Opening an admin section shows the existing "Admins only" state.

## Data model

**CompanySettings** (singleton, `backend/src/models/CompanySettings.ts`):

```ts
name: string (max 120, default "EMS"), email: string, phone?: string, website?: string (http/https URL),
logo?: { gridFsId, mimeType, size } | null,
address: { line1?, line2?, city?, state?, postalCode?, country? },
timezone: string (IANA, validated with Intl; default env APP_TIMEZONE || "Asia/Kolkata"),
dateFormat: "DD-MM-YYYY" | "MM-DD-YYYY" | "YYYY-MM-DD",
timeFormat: "12h" | "24h",
weekStart: "monday" | "sunday",
currency: { code: string (ISO 4217, 3 letters), symbol: string (max 4) },
appUrl?: string
```

## Backend

| Method | Path | Notes |
|---|---|---|
| GET | `/api/settings/public` | **Unauthenticated**, cached 5 minutes: `{ name, logoUrl, dateFormat, timeFormat, weekStart, timezone, currency }`. Used by the login page and the sidebar. |
| GET / PATCH | `/api/settings/company` | admin; full document. |
| PUT / DELETE | `/api/settings/company/logo` | admin; multipart upload, GridFS. |
| GET | `/api/settings/company/logo` | Public, serves the logo with cache headers. |

- **Timezone and appUrl** come from settings, with env fallback. They're read via a small cached getter in `lib/appTime.ts` and `lib/email.ts`, refreshed on PATCH. Every place that uses `APP_TIMEZONE` or `APP_URL` today goes through the getter.
- **Emails** use the company name, logo and address in the template header and footer, and `FROM_NAME` defaults to the company name when unset.
- **Activity log** gets a `settings_updated` action.

## Frontend

- **`components/settings/*`**: the layout (search and nav), a section registry (id, title, keywords, roles, component), and one component per section, reusing the existing cards (labels, categories, statuses, SMTP card, email preferences, profile forms).
- **`lib/format.ts`**: date and time formatting reads the public settings (date format, 12h/24h, week start), which also drive calendars and the timesheet week. The `DD-MM-YYYY` default keeps today's behaviour.
- **Sidebar** rewritten per section 1, using the same collapsible-group component and localStorage state.
- **Login page**: company name and logo.

## Edge cases

- **Changing the timezone**: affects date-only logic from that moment on. Stored timestamps are unaffected, since they're UTC. The UI warns about this.
- **Invalid timezone or currency**: rejected with 400.
- **Logo**: only png, jpg and svg are accepted. SVG files are sanitised on upload (scripts, event handlers and external references removed); if that's not reliable, SVG is refused. Images are served with `Content-Security-Policy: default-src 'none'` and `X-Content-Type-Options: nosniff`.
- **Missing settings document**: created lazily with defaults; existing installs behave exactly as before until someone edits settings.
- **Deep links** (`/settings/task`, old `/admin/...` URLs, email links) must all keep working.

## Done when

- Both type checks and the frontend build pass.
- The sidebar shows Dashboard · HR · Work · Reports · Settings, filtered by role, with Announcements under HR, and no Administration or My workspace groups.
- **`/settings`**: section search works, every section saves, and old URLs redirect.
- **Company settings**: changing the name and logo updates the sidebar, the login page and the test email.
- **App settings**:
  - Changing the date format to `YYYY-MM-DD` changes dates in tables, the dashboard and the calendar.
  - Changing week start to Sunday changes the timesheet and calendar weeks.
- **Non-admins** see only Profile, Notification and Security.
- **Mobile (375px)**: the settings nav becomes a select, with no horizontal scroll.
