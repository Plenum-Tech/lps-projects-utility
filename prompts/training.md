# HR → Training

## Goal

Add a **Training** page under the HR menu. Admin / HR upload a slide deck, for example `Utility_21 sep.pptx` (15 slides), and choose who must take it. Each employee reads the deck slide by slide in the app. Once they have seen **every** slide, they can press **Mark training as completed**. That records the completion, and admins see who has finished and who hasn't.

## Decisions (approved)

- **Terms-style reading**: all slides are shown one under another, like a website's terms page. Each slide is marked read once it has been on screen. At the end there is a tick box, *"I have read and understood this training"*, and a **Complete training** button. Both are disabled until every slide has been read.
- **Upload .pptx directly**: the server converts it with LibreOffice (added to the container image) to one PNG image per slide. PDF uploads are accepted too.
- `Utility_21 sep` is assigned to **all employees**.

## Slides: how a deck is shown (original proposal, replaced by the decisions above)

Browsers cannot display a .pptx directly, so the deck is shown as a **PDF, one slide per page**.

- **Upload**: the form takes a PDF (PowerPoint → *File → Save as → PDF*). It can optionally also take the original .pptx, kept as a download.
- **This deck**: I convert `Utility_21 sep.pptx` to PDF with PowerPoint on this machine and upload it for you as the first training.
- **Storage**: files go in the database (GridFS, the same as employee documents), so they survive deploys. Limit 50 MB.
- **Not included**: automatic .pptx → PDF conversion on the server. It needs LibreOffice in the container image (about 400 MB more, slower builds). It can be added later if you'd rather upload .pptx files directly.

## Pages

| Who | Page | What they see |
|---|---|---|
| Everyone | **HR → Training** (`/training`) | Cards for "My trainings", each with a status: Not started, In progress (6/15 slides), or Completed on <date>. A badge on the menu item shows how many are pending. |
| Everyone | **Training viewer** (`/training/:id`) | The slide viewer: one slide at a time, filling the page. It has Previous / Next buttons, arrow keys, a "Slide 6 of 15" counter, a progress bar, and slide thumbnails. A slide counts as **read** after it has been shown for 3 seconds. **Mark training as completed** is enabled only when all slides are read; until then it says "Read all slides to complete (9 left)". When the person reopens it, the viewer resumes at the last slide. |
| Admin / HR | **Manage** tab on `/training` | Create, edit and archive trainings: title, description, the file, a due date (optional), and **assigned to** (everyone, departments or people). |
| Admin / HR | **Progress** view per training | One row per assignee: name, department, slides read (x/15), status, started date, completed date. It has filters (status, department), an Excel export and **Send reminder** (in-app). |

## Rules

- Assignment is by **everyone / departments / people**. New employees who join an assigned department automatically see the training.
- Progress is saved **on the server**, so it works across devices. The server only accepts slide numbers that exist, and refuses "complete" until every slide has been recorded.
- If the file is replaced with a new version, admins choose whether everyone **must re-read** it (progress reset) or completions are **kept**.
- Notifications are in-app only: a new training is assigned, or a reminder is sent. Email follows the existing switch, which is off on Azure for now.
- Every action goes in the Activity Log (created, assigned, completed).

## Backend

- **Models**:
  - `Training`: title, description, `file` (GridFS id, pages), optional `sourceFile` (.pptx), dueDate, `assignTo` {all, departments[], users[]}, version, archived, createdBy.
  - `TrainingProgress`: training, user, version, `viewedPages[]`, lastPage, startedAt, completedAt. Unique on (training, user).
- **Routes** under `/api/trainings`:
  - `GET /mine`
  - `GET /:id`
  - `GET /:id/file` (stream)
  - `POST /:id/progress {page}`
  - `POST /:id/complete`
  - Admin / HR: `POST /` (multipart), `PATCH /:id`, `DELETE /:id` (archive), `GET /:id/progress`, `POST /:id/remind`
- The page count is read from the PDF on upload (pdf-lib), so the server knows how many slides there are.

## Frontend

- `pdfjs-dist` renders each slide onto a canvas, scaled to fit the page, and works on phones.
- Theme tokens, react-icons/lu and the existing page layouts are used throughout.

## Done when

- Both type checks and the build pass.
- **API tests** (scratch database) cover:
  - who can see which training
  - progress only accepts valid pages
  - complete is refused until all slides are read
  - progress reset on a new version
  - the HR-only routes
- **Browser** check (local test copy): upload the deck, read it as an employee, see "complete" become available on the last slide, and check that the admin progress shows the completion. Also check it at 375 px.
- Deployed, with `Utility_21 sep` uploaded as the first training. Assignment needs your answer below.
