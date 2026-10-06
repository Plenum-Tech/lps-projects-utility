# Meeting Transcripts → Tasks

## Goal

Turn Microsoft Teams meeting transcripts into tracked tasks:
1. **Bring the transcript in.** Upload it (`.vtt` or `.docx` exported from Teams, or `.txt`) or paste the text, and attach it to a project if you like.
2. **Find the action items.** EMS highlights likely action items with **smart hints**, which are rule-based and keep everything on the server. Optionally, **Extract with AI** proposes action items, owners and due dates. It appears only when AI is configured.
3. **Create the tasks.** Review the suggested items and create tasks in bulk. Each task links back to the exact moment in the meeting.

Out of scope, by the user's choice: auto-import from Teams (Microsoft Graph and an Azure app). The data model keeps a `source` field so it can be added later.

## Data model

### Meeting (`backend/src/models/Meeting.ts`), new

```ts
title: string (max 200)
meetingDate: Date
project?: ObjectId | null                 // optional; drives visibility + task defaults
source: "upload" | "paste"                // future: "teams"
file?: { filename, mimeType, size, gridFsId } | null   // original upload (GridFS bucket "meetingFiles")
segments: [{                              // parsed transcript, max 5000
  idx: number, start?: number | null,     // seconds from start
  end?: number | null,
  speaker?: string | null, text: string (max 5000)
}]
speakers: [{ name: string, user?: ObjectId | null }]   // speaker → EMS user mapping (editable)
notes?: string (max 20000)                // free-form meeting notes / summary
actionItems: [{
  _id, segmentIdxs: number[], quote: string,
  title: string (max 200), assignee?: ObjectId | null, assigneeName?: string | null,
  dueDate?: Date | null, priority: TaskPriority,
  origin: "hint" | "ai" | "manual",
  status: "suggested" | "task_created" | "dismissed",
  task?: ObjectId | null
}]                                         // max 300
aiExtractedAt?: Date | null
createdBy: ObjectId
```

Indexes: `{ project: 1, meetingDate: -1 }`, `{ createdBy: 1, meetingDate: -1 }`, `{ "speakers.user": 1 }`.

### Task, extended

- `sourceMeeting?: { meeting: ObjectId, segmentIdx: number | null } | null`
- The task detail sheet shows **"From meeting: {title} · 12:31"**, which links to `/meetings/:id?seg=<idx>`.

### History and activity

- Task history: `created_from_meeting`.
- Activity actions: `meeting_created`, `meeting_deleted`, `meeting_tasks_created`.

## Parsing (`backend/src/lib/transcripts/*`)

- **VTT** (Teams): handles `WEBVTT`, cue timings, `<v Speaker Name>text</v>`, multi-line cues and NOTE blocks. Consecutive cues from the same speaker less than 2 seconds apart are merged.
- **DOCX** (Teams "Download as .docx"): text is extracted with `mammoth`. Each "Speaker Name   0:01:23" header line followed by text lines becomes a segment.
- **TXT / paste**: supports `[00:01:02] Name: text`, `Name (00:01:02): text`, `Name: text`, and plain lines (no speaker).
- **Limits**: 5 MB file size, 300k characters, 5000 segments. Control characters are stripped. All text is stored as plain text and rendered escaped.
- **Speaker matching**: speakers are auto-matched to EMS users by full name, case-insensitively, then by a unique first name. The match is limited to users the uploader can assign: project members when there's a project, otherwise the assignable-users rule. Anything the match doesn't settle is left for the user to resolve in the mapping step.

## Smart hints (`lib/transcripts/hints.ts`)

These are rule-based. **No data leaves the server.**

- **Triggers**:
  - `action item`, `todo`, `follow up`
  - `I'll` / `I will`, `we'll` / `we will`, `let me`
  - `can you` / `could you`, `please`, `needs to` / `need to`
  - `assign(ed) to`, `@Name`
  - date phrases
- Each segment gets a score. Segments above the threshold are flagged and produce `origin: "hint"` suggestions when the meeting is created. Suggestions can be regenerated.
- **Owner**:
  - "I'll / I will / let me" → the speaker.
  - "can you / could you / Name, please / Name will / @Name" → the mentioned attendee.
  - Otherwise none.
- **Due date**: `chrono-node` is used relative to `meetingDate`. It handles today, tomorrow, weekday names, next week, EOD/EOW, and explicit dates. Past or ambiguous results are dropped.
- **Title**: the sentence is cleaned of filler words ("um", "so", "I think"), the leading "I'll" / "can you" is removed, it is capitalised, and it is truncated to 120 characters.

## AI extraction (optional)

- **Enabled only when** `MEETING_AI_EXTRACTION=true` and `GEMINI_API_KEY` is set. This reuses the project's existing Gemini integration pattern (`generateInsight.ts` / `generateReview.ts`) and documents both values in `.env.example`.
- `GET /api/meetings/config` returns `{ aiEnabled }`. The button is hidden when it's off.
- `POST /api/meetings/:id/extract-ai`:
  - Runs **synchronously**, with no Inngest, so it works locally.
  - Long transcripts are chunked to about 12k characters each.
  - The model must return strict JSON: `[{ segmentIdxs, title, owner, dueDate, priority }]`. Malformed items are dropped.
  - Results are added as `origin: "ai"` suggestions, de-duplicated against existing suggestions by segment overlap.
  - **It never creates tasks by itself.**
  - Timeout is 60 seconds. On failure it returns 502 with a clear message, and the meeting is unchanged.
- The UI shows a one-time notice that the transcript text is sent to Google Gemini.

## Permissions

- **Create a meeting**:
  - Admins and heads can create meetings.
  - Any user can create a meeting for a project they're a member or manager of.
  - Employees can create meetings with no project; those are visible only to the creator and admins.
- **View**:
  - creator and admins
  - project members or manager, if the meeting has a project
  - users mapped as speakers
  - the head of the creator's department
- **Edit** (notes, speaker mapping, suggestions) and **delete**: the creator, admins, and the project manager.
- **Create tasks from items**: this goes through the **same `createTask` code path** as everywhere else. The usual permissions apply (project rules, head department scope), as do short codes and numbers, `task_assigned` emails, history and SSE. Items that aren't allowed come back as `skipped` with a reason.

## Backend endpoints (`/api/meetings`)

| Method | Path | Notes |
|---|---|---|
| GET | `/config` | `{ aiEnabled }` |
| GET | `/` | Filters `project`, `from`, `to`, `search` (title or notes); pagination. Items carry counts: segments, suggestions, tasks created. |
| POST | `/preview` | Multipart file **or** `{ text }`. Returns `{ segments (first 50), segmentCount, speakers: [{ name, matchedUser }] }` without saving, for the upload dialog. |
| POST | `/` | Multipart file or `text`, plus `title`, `meetingDate`, `project?`, `speakers?` (mapping). Parses, stores, generates hint suggestions, and returns the meeting. |
| GET | `/:id` | Full meeting: segments, speakers, suggestions with populated assignees and tasks. |
| PATCH | `/:id` | `title`, `meetingDate`, `project`, `notes`, `speakers` (re-maps suggestion owners whose `assigneeName` matches). |
| DELETE | `/:id` | Also deletes the GridFS file. Tasks are **kept**, and their `sourceMeeting` is unset. |
| GET | `/:id/file` | Downloads the original transcript. |
| POST | `/:id/hints` | Regenerates hint suggestions. Removes un-actioned hint suggestions only. |
| POST | `/:id/extract-ai` | See AI extraction above. |
| POST | `/:id/items` | Adds a manual item from the selected segments. |
| PATCH / DELETE | `/:id/items/:itemId` | Edit or dismiss / restore. |
| POST | `/:id/tasks` | `{ items: [{ itemId?, segmentIdxs, title, description?, assignees[], dueDate?, priority, project?, milestone?, labels? }] }` (max 50). Creates tasks and returns `{ created: [{ itemId, task }], skipped: [{ itemId, reason }] }`. |

**Task description** for each created task:
- the quote as a blockquote,
- "From meeting **{title}** on {date} at {mm:ss}",
- a link to `${APP_URL}/meetings/:id?seg=…`.

## Frontend

### Navigation

- A **Meetings** item in the **Work** group (Projects · Tasks · Meetings · Timesheet).
- A **Meetings** tab on the project detail page.

### `/meetings`

- The same Worksuite-style table pattern as Projects and Tasks.
- **Columns**: title, date, project, speakers (avatars), action items ("5 suggested · 3 tasks"), created by, ⋮ (Open / Edit / Download transcript / Delete).
- **Filters**: date range, project, search.
- **+ New meeting** opens the upload dialog.

### Upload dialog (two steps)

1. **Source**:
   - The title is auto-filled from the file name.
   - Date and optional project.
   - **Upload** (drag and drop `.vtt` / `.docx` / `.txt`) **or Paste** tabs.
   - **Preview** shows the segment count, the first few lines, and any parse warnings.
2. **Speakers**: each detected speaker → an EMS user picker (auto-matched where possible, with an "Not in EMS" option). Then **Create meeting**.

### `/meetings/:id`, a two-pane workspace

The panes stack on mobile, with Transcript and Action items as tabs.

**Header**: title, date, project link, speakers, Edit, Download, and **Extract with AI** (only when enabled, with a sparkle icon and a privacy note).

**Left, Transcript**:
- Search box with match count and next/previous.
- Segments show a timestamp chip, the speaker name with a consistent theme-token colour per speaker, and the text.
- **Hint segments** have a subtle highlight and an icon. Segments that already became a task show a link chip to it.
- Checkboxes for multi-select. Selecting text shows a floating **"+ Action item"** button.
- `?seg=` scrolls to and flashes that segment.

**Right, Action items**:
- Groups: **Suggested** (hint and AI, with origin badges), **Created** (linked tasks with status), **Dismissed** (collapsed).
- Each suggestion is an **editable row**: title, assignee picker (defaulting to the matched owner, otherwise empty), due date, priority, and a ✓ include checkbox.
- **Create N tasks** opens a confirm sheet with defaults (project and milestone from the meeting, labels). The results toast reads, for example, "4 created, 1 skipped (reason)".
- Dismiss and restore.

**Notes** tab: a free-form meeting notes editor.

### Elsewhere

- **Task detail sheet**: the "From meeting" link (above).
- **Notification bell**: no new types. Created tasks use the existing `task_assigned` notification.

## New packages

- backend: `mammoth` (DOCX text extraction), `chrono-node` (natural-language dates).

## Edge cases

- **Unparseable files**: a 400 error with a hint ("Export the transcript from Teams as .vtt or .docx").
- **Empty transcript**: 400.
- **Speakers who aren't EMS users**: their name is kept, and the assignee is left empty.
- **Duplicate actions**: creating tasks twice for the same item is blocked (`status: task_created`).
- **Deleting a project**: removes the project from its meetings. Meetings are kept, but private to the creator and admins.
- **Very long transcripts**: the left pane is virtualised (rendered in windows) so it stays smooth with 5000 segments.
- **Timezones**: `meetingDate` is date-only in `APP_TIMEZONE`, and due-date parsing is relative to it.

## Affected files

**backend**
- models: `Meeting.ts`, plus `Task.ts`, `ActivityLog.ts`, `TaskHistory.ts`
- `lib/transcripts/{vtt,docx,text,hints,ai,match}.ts`, `lib/gridfs.ts` (bucket)
- `controllers/meetings.ts`, `routes/meetings.ts`, `server.ts`
- `controllers/tasks.ts`: export a reusable create-task function if one isn't already shared
- `.env.example`, `package.json`

**frontend**
- routes: `routes/meetings.tsx`, `routes/meetings.$id.tsx`, `routes.ts`
- `components/meetings/*`: table, upload dialog, speaker mapping, transcript pane, action items pane, create-tasks sheet, notes
- `hooks/use-meetings.ts`, `types.ts`, sidebar, project detail tab, task detail sheet link

## Done when

- Both typechecks and the frontend build pass.
- A real Teams **.vtt** and **.docx** sample, plus a pasted transcript, parse with the right speakers and timestamps.
- Hints flag "I'll send the deck by Friday" (owner = speaker, due = that Friday) and "Priya, can you update the API docs tomorrow?" (owner = Priya, due = the next day).
- Selecting 3 suggestions → **Create 3 tasks** produces 3 tasks with short codes, assignee emails, and a "From meeting" link that jumps to the right line.
- With AI off, there is no AI button and the API returns 400. With AI on but the key wrong, the API returns 502 with a clear message.
- Permissions: a non-member can't see a project meeting, and task creation respects the task rules.
- At 375px the layout stacks, with no horizontal scroll.
