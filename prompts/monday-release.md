# Monday release: mandatory structure for brands, projects, tasks and briefs

Seven changes from the 10 Oct 2026 list. "Next week" items are listed at the end and are **not** in this release.

## 1. Brands

- Only admins create brands — already the case (`POST /brands` is admin-only). The project form's "Add brand" shortcut is hidden for non-admins; they pick from the list.
- Brand is required on every project — already enforced by the model; the form now blocks saving without it (clear message instead of a server error).

## 2. Project creation

- **Brand, type, month and name are all required.** The form refuses to save without any of them; the API returns a clear 400.
- The project name is composed automatically: `Brand_Type_MonYYYY_Name`. The custom "Name" part is free text (up to 80 chars) and required; a fully free-text name is not accepted (the API rejects names that don't match the composed form).
- Project code keeps generating automatically.
- **Start date and end date are removed from the form.** The month stands in: `startDate` becomes the 1st of the month and `deadline` the last day, set automatically, so existing deadline reminders, Delivery Pulse and reports keep working. Existing projects keep their dates.
- Scope and team allocation: not in this release.

## 3. Task creation

- **A task must belong to a project** (which gives it a brand). "No project" is removed from the task form and the API rejects tasks without one. Existing tasks without a project are untouched; a one-off list of them is produced so they can be moved (Delivery Pulse's "No brand" bucket empties as they are).
- **Brief is mandatory:** a description **or** at least one attachment picked in the form. The form shows "Add a description or attach the brief" until one is present.
- **Time entry is mandatory:** the estimated time (hours/minutes) must be > 0. *(Assumption — "time entry" read as the estimate at creation; actual time logging is covered in section 4.)*
- **Iteration marker is compulsory:** a new required field on the task, **Iteration: New work / Rework**, shown as a badge on the task. Delivery Pulse's rework measures use this field first and fall back to the existing keyword/category rule for older tasks.
- **Controlled task name:** the title is built as `<Scope unit> <Quantity> – <Short name>`. For this release, scope unit is a free short text (e.g. "Video", "Post"), quantity a number ≥ 1, short name free text ≤ 80 chars. Brand and month are inherited from the project and shown next to the title (not typed). The three parts are stored separately so next week's scope list can constrain the unit without changing stored data.
- Milestones unchanged.

## 4. Task completion

- The completion dialog (Mark as complete / Submit for review) gets a **Final file** box at the top: upload a file **or** paste a link. Required.
- Completion is refused unless **(final file or link) or an outcome note** is present — the outcome note is the existing submission note, now with that wording.
- Completion is refused when **no time is logged** on the task ("Log your time before completing"). Applies to the complete/submit action and to drag-to-Completed on the board; admins' review-approve step is unchanged.

## 5. Delivery Pulse

- **Custom date range** added to the period selector (from/to dates), everywhere the period applies.
- **Brief score R1–R7 removed.** Brief coverage becomes one measure: the task has a description or an attachment. The brief panels, the "Briefs" CSV and the person drawer show coverage % instead of the rule score.
- **AI brief check:** each task brief (description) is read by an OpenAI model and flagged *OK / Weak / Flagged* with a one-line reason (gibberish, off-context, off-brand, too thin). Runs in the background on create/update, cached per task, so the dashboard stays fast. A **Brief quality** table per person (OK / weak / flagged counts, %). Needs an `OPENAI_API_KEY` secret on Azure; without it the check shows "not configured" and everything else works.
- The brand view stays. The "No brand" bucket disappears as item 3 takes effect.
- Figures are re-verified against the data copy before release (totals, per-person counts, brand table), except the off-map section.

## 6. Time log report

- Unchanged.

## 7. Mandatory training

- Trainings marked **mandatory** (new checkbox when creating a training) pop up at sign-in for everyone assigned who hasn't completed them: a dialog listing the training(s), "Start now" / "Later". **Later** is allowed for three days from the person's first sign-in after assignment; after that the dialog can't be dismissed until the training is completed.
- On completion, an email goes to HR automatically — *question below for the address*.
- The current "Utility_21 sep" deck stays until the new version arrives; replacing it is the existing "replace deck" action.

## Questions (answers can come after approval; defaults in brackets)

1. HR address for training-completion emails? [default: every user with the admin role]
2. Section 3 "time entry is mandatory": the **estimate** at creation [default], or also require a time log before completing (that's section 4 — included anyway)?
3. OpenAI: do you have an API key, or shall I create the key under Plenum's OpenAI account? The check runs on task descriptions only (no attachments), ~US$1–2/month at current volumes.
4. Existing tasks without a project (1,757 imported ones whose Worksuite project was deleted): leave as-is [default] or move them under one archive project per brand?

## Not in this release (next week)

Task rules linked to scope and team; assignee list limited to the project team; scope unit limited to the project scope.

## Done when

- Type checks and build pass; API tests on a data copy for every new rule (400s with clear messages); browser checks of the project form, task form, completion dialog, Delivery Pulse (custom range, brief coverage, AI table), training pop-up; deployed, with `OPENAI_API_KEY` set when provided.
