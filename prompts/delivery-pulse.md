# LPS Delivery Pulse (delivery-analytics dashboard)

## Goal

Build **Reports → Delivery Pulse**: a management dashboard that measures creative and production delivery from the Projects Utility task board. It follows the structure of the reference design ("LPS Delivery Pulse", used as a **design reference only**; no code is copied) and is built in our design system.

The four sections are **1 · Results**, **2 · Analysis**, **3 · Actions** and **4 · People**, all driven by global filters. It needs two supporting pieces: a new **Brand** entity, and a **Settings → Delivery** section for the traffic manager, brand team maps and the rule thresholds.

**Access**: admins (everything) and department heads (data limited to tasks where any doer is in their department).

## New concepts

### Brand (client), new entity

- **Model `Brand`**: `name` (unique, ≤80), `shortName?`, `color` (theme chart token), `active`, `createdAt`.
- **`Project.brand?: ObjectId`**: each project belongs to a brand. A task's brand is **its project's brand**. Tasks without a project, or whose project has no brand, show as **"No brand"**.
- **Settings → Brands** (admin): create, rename, colour, deactivate, and see a project count per brand.
- **Project form**: a Brand picker (with "+ Manage brands"). **Projects table**: a Brand column and filter. **Excel import**: a "Brand" column is matched by name and created if missing (admin only).

### Roles in delivery

- **Doer**: a task assignee who **isn't** a traffic manager.
- **Traffic manager(s)**: chosen in Settings → Delivery. They're co-assigned for allocation and are excluded from people stats and from "doer" checks.
- **Briefer**: the task's creator (`assignedBy`), usually a program manager.
- **Team**: the doer's **department**. Settings chooses which departments appear as dashboard teams (e.g. Creative, Production, Community, Program); every other department is grouped as **"Other"**. A task with doers in several teams counts **once for each of those teams**.

### Settings → Delivery (admin)

| Setting | Default |
|---|---|
| Traffic manager users | none |
| Dashboard teams (departments) | all departments |
| Rework keywords (title, whole word, case-insensitive) | amend, amends, revision, revisions, feedback, change, changes |
| Rework task categories | "Amends" |
| Briefing weekday | Monday |
| Minimum lead time (days) | 2 |
| Brands allowed same-day delivery | none (e.g. Ajmal, Wasl, Emarat) |
| Final-asset link domains | frame.io, onedrive.live.com, 1drv.ms, sharepoint.com |
| Written-brief minimum length (characters, excluding links) | 80 |
| Minimum completed tasks to rank a person | 5 |
| Stale threshold (days past due) | 30 |
| **Brand team map**: brand → allowed doers | empty |
| Team-map tracking start date | today (e.g. 1 Jun 2026) |

These are stored in a `DeliverySettings` singleton, cached and invalidated on save.

## Metric definitions

All dates are compared **date-only in `APP_TIMEZONE`**. "Period" is the selected window ending today. The **previous period** is the window of the same length immediately before it.

| Metric | Definition |
|---|---|
| **Completed** | Tasks with `status = completed` and `completedAt` in the period |
| **On time %** | Of completed-in-period tasks **with a due date**: `completedAt date ≤ dueDate` |
| **Mean days brief → done** | Average of `completedAt − createdAt` in calendar days, over completed-in-period tasks |
| **Open now** | Status is to do, in progress, in review or rejected |
| **Overdue now** | Open now, and `dueDate < today` |
| **Rework** | The title matches a rework keyword **or** the category is a rework category |
| **Rework %** | Rework tasks ÷ tasks **created** in the period |
| **Overdue % (week)** | At each week's end: tasks open at that moment (`createdAt ≤ weekEnd` and not completed by `weekEnd`) **and** late (`dueDate < weekEnd`), ÷ tasks open at that moment |
| **Deltas** | Current vs previous period. Tasks and rework compare tasks *created* in each period; on time compares tasks *completed* in each period; overdue compares the count now with the count at the start of the period. Each pill is coloured by whether the change is **good** or **bad** for that metric (e.g. overdue going down is good). |

## Brief score (Actions → Brief coverage)

Each task is scored against **7 rules**. A rule marked n/a is left out of that task's score, and the score is passed ÷ applicable.

| # | Rule | Passes when |
|---|---|---|
| 1 | Brief attached (deck, doc or link) | A file was attached to the task within 24 h of creation, or the description contains a URL |
| 2 | Written brief | The description, minus links, has at least the minimum length |
| 3 | Briefed on a Monday | `createdAt` falls on the briefing weekday |
| 4 | ≥ N days lead time | `dueDate − createdAt ≥` the minimum lead days. n/a if there's no due date. |
| 5 | No same-day delivery | `dueDate ≠` the creation date, **or** the brand is on the same-day allowlist. n/a if there's no due date. |
| 6 | Doer on the brand team map | Every doer is in that brand's map. n/a if the brand has no map. |
| 7 | Final asset attached | **Completed tasks only**: a file, or a comment, note or description link on an allowed domain. n/a while the task is open. |

- **By briefer**: per briefer, the number of briefs in the period, the average score, the pass rate for each rule (as small bars), and the share of their briefs that turned into rework ("Rework on their briefs").
- **Weakest recent briefs**: the 20 lowest-scoring tasks from the last 30 days within the filters, each with its failed rules as chips. Rows link to the task.

## Page layout (`/reports/delivery`)

- **Sticky header**: "Delivery Pulse", the subtitle "Creative & production delivery from the task board · data as of {time}", and the filters: Period segmented control (7d · 30d · 90d · 12m · All), Team select, Brand select, Person select. Filters are stored in the URL query.
- **Sticky section nav**: 1 · Results, 2 · Analysis, 3 · Actions, 4 · People, as anchor links with active-section highlighting.

**1 · Results**: KPI tiles, each with its value, delta pill and a one-line explanation. The values are coloured with good/warn/critical tokens.

**2 · Analysis**
- *Throughput and speed*: two charts side by side, **Completed per week** (bars) and **Mean days brief → done** (line), each with a "Table view" toggle.
- *Teams*: a sortable table: team, completed, on time %, mean days, rework share, overdue now, open, and a volume bar.
- *Brands*: a sortable table: brand (colour dot), created, completed, on time %, mean days, rework %, overdue now. Then **Brand movement**, which is the same table showing deltas vs the previous period.

**3 · Actions**
- *Delayed and open work*: a table of open tasks past due plus **rejected** (sent back) tasks. Columns: code, task, brand, doers, briefer, due, days late, status. It has an **Include stale (> 30 days)** toggle (off by default) and a note that very stale items are probably abandoned. Rows open the task sheet, and the table exports to CSV.
- *Brief coverage by program manager*: two tabs, **By briefer** and **Weakest recent briefs**.

**4 · People**
- *Individuals*: a table of doers only (traffic managers excluded) with completed, on time %, mean days, rework share, overdue now, open now and brand count. People under the minimum completed count are shown as "not ranked" and greyed out. Clicking a row opens a **drawer** with their brand breakdown, a weekly trend mini-chart, and their open work list.
- *Week by week*: three charts: **Completed per week**, **Overdue % by week**, **Rework % by week**.
- *Team map coverage* (since the tracking start date):
  - **Off-map**: completed tasks done by people who aren't on that brand's map, by brand and person, with counts.
  - **Mapped but unused**: people on a brand's map with no tasks for that brand.
  - **Unmapped brands**: brands that have no map at all.

**Design**: theme tokens only. Chart series use the existing chart tokens, and the KPI tiles use the good/warn/critical tokens; brand blue and lime accents can be added as tokens. Charts use the existing `components/ui/chart.tsx` (recharts). Light and dark both work. The layout is responsive (grids collapse to one column below 1000px), and every table scrolls inside its card. Every chart has a table equivalent for accessibility.

## Backend

**`/api/analytics/delivery/*`** (admin and head; heads are scoped to tasks where any doer is in their department):
- Query parameters: `period=7d|30d|90d|12m|all`, `team`, `brand`, `person`.
- Endpoints:
  - `GET /summary`: KPIs and deltas
  - `GET /weekly`: completed, mean cycle days, overdue %, rework % per week
  - `GET /teams`
  - `GET /brands`: including movement
  - `GET /delayed?stale=0|1`
  - `GET /briefs`: by briefer, and weakest
  - `GET /people` and `GET /people/:id`: drawer data
  - `GET /team-map`
- Everything is built with **MongoDB aggregation pipelines**. Brand is joined through the project, team through the doers' departments. Results are cached for 60 seconds per filter combination and scope, and the cache is cleared on task writes in a debounced way.
- **Indexes**: `{ completedAt: 1 }`, `{ createdAt: 1 }`, `{ project: 1, createdAt: 1 }`, plus `Project.brand`.
- **Performance target**: every endpoint under 500 ms at p95 on the load dataset (5,000 tasks); checked with a quick k6 run.

**Brand and settings endpoints**:
- `/api/brands`: GET for everyone; POST, PATCH and DELETE for admins. A brand that projects use can't be deleted; it can only be deactivated.
- `/api/settings/delivery`: GET and PATCH, admin only.

## Navigation

- **Reports group**: adds **Delivery Pulse**, shown first.
- **Settings**: adds the **Delivery** and **Brands** sections (admin only).

## Edge cases

- **Empty periods**: KPIs show "—", with the delta "no data in previous period".
- **No due date**: excluded from on-time % and from rules 4–5. The count of tasks without a due date is shown in the KPI tooltip.
- **Deleted users or projects**: still counted, shown as "Former user" or "No brand".
- **Head with no department**: sees an empty state explaining why.
- **Very large "All" periods**: weekly series is capped at 104 weeks, and the UI notes this.

## Done when

- Both type checks and the build pass, and the scratch API tests verify each metric against hand-calculated fixtures: on-time %, mean days, rework %, overdue % by week, deltas, brief rules 1–7, and the exclusion of traffic managers.
- A brand can be created and assigned to projects, and the dashboard filters by brand, team, person and period, with filters surviving a reload.
- Heads see only their department's data. Employees get 403 from the API and don't see the menu item.
- All endpoints respond in under 500 ms at p95 on the load dataset.
- The layout works in light and dark mode, and at 375px it has no page-level horizontal scroll.
