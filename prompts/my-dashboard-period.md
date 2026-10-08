# My Dashboard: Period Filter

## Goal

Add a period selector to **My dashboard** only. The Organisation view and Delivery Pulse already have their own filters. The choices are **7 days · 30 days · 90 days · 120 days · 1 year · All time**. The task and project numbers, the My tasks table and the calendar follow the chosen period. The default is **30 days**, and the choice is remembered in the URL (`?period=30d`) and in localStorage.

The period is "the last N days ending today", computed date-only in the app timezone.

## What each card means for a period

| Card | Today (unchanged when "All time") | With a period |
|---|---|---|
| **Profile → Open tasks** | Open tasks assigned to me | Open tasks assigned to me **that were created or due in the period** |
| **Profile → Projects** | Projects I'm a member or manager of | Those projects that were **active in the period** (start → deadline overlaps the period, or a task of mine was updated in it) |
| **Tasks → Pending** | Open (to do, in progress, in review) | Open **and** (created or due in the period) |
| **Tasks → Overdue** | Open and due before today | Open and due before today, **with the due date inside the period** |
| **Tasks → Completed** *(new tile)* | — | Completed by me **in the period**, with the on-time share (e.g. "42 · 88% on time") |
| **Projects → In progress** | Not finished | Not finished **and** active in the period |
| **Projects → Overdue** | Deadline passed, not finished | Deadline **inside the period**, passed, not finished |
| **Projects → Completed** *(new tile)* | — | Moved to a completed status in the period |
| **My tasks table** | Most urgent 10 | Same, limited to the period; the "View all" link opens Tasks with matching filters |
| **My calendar** | Range navigation | Opens on the period's range; it can still be navigated |
| **Week time logs** | Week navigation | Unchanged (it's week-based). A small "N h logged in period" figure is added to the header. |
| **Birthdays, anniversaries, probation, notice, internship, documents** | Upcoming | **Unchanged**: these are forward-looking reminders, not history |

- **Labels**: each tile's caption shows the period (e.g. "Pending · last 30 days").
- **Comparison**: the Completed tiles show the change vs the previous equal period, using the same delta pill style as Delivery Pulse.

## Backend

- `GET /api/dashboard/me?period=7d|30d|90d|120d|365d|all` (default `30d` when omitted, so old clients keep working).
  - The counts in `counts` and the `myTasks` list are filtered as above.
  - The response adds `completedTasks: { count, onTimePct, previous }` and `completedProjects: { count, previous }`.
  - It echoes `period: { key, from, to }`.
- `GET /api/dashboard/me/calendar` is unchanged (the client passes the period range).
- Must stay fast: the same indexed queries, run in parallel, under 300 ms.

## Frontend

- A **segmented control** at the top right of My dashboard, next to the clock. On mobile it becomes a select.
- All affected cards show a subtle loading state while refetching. Captions show the period.
- **Links carry the filter**: the Pending / Overdue / Completed numbers link to `/tasks` with the matching filters (mine, status, due range or completed range).

## Done when

- Both type checks and the build pass.
- **API tests** confirm the counts for each period against hand-built fixtures (created, due and completed dates spread across the ranges). "All time" equals the current behaviour.
- **Browser**: switching the period updates the numbers and captions, survives a reload, links open correctly filtered task lists, and it works at 375px.
