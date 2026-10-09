# Delivery Pulse: Brands › projects › people

## Goal

On Delivery Pulse (People section), show the real structure of the work: each **brand → its projects → the tasks and the people assigned**, following the period, team, brand and person filters. The existing *Team map coverage* block stays (it compares work against the configured team maps); this new block needs no team map.

## What it shows

- One row per brand (sorted by tasks), with counts: tasks · open · overdue · done, plus chips of the people assigned (×count each).
- Expand a brand → its projects (code + name) with the same counts and people chips.
- Expand a project → its tasks: code, title, due date (red when overdue), status, assignees. Each task links to the task; "+N more — open in Tasks" when a project has more than 25 tasks in the period.
- "Active in the period" = created in the period, or completed in it, or still open.

## Backend

`GET /api/analytics/delivery/brand-structure?period&team&brand&person` (same scope rules as the other Delivery Pulse endpoints; cached 60 s like them).

## Done when

- Type checks pass; API totals equal the Delivery Pulse task counts for the same filters on a data copy; the panel renders and expands in the browser; deployed.
