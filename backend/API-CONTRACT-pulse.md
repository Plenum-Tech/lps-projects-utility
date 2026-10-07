# Delivery Pulse — API contract (backend → frontend)

Spec: `prompts/delivery-pulse.md`. All endpoints are JSON under `/api`, cookie-authenticated like the rest of the API.
Dates are `"YYYY-MM-DD"` app-timezone calendar dates unless noted. Percentages are numbers `0–100` with one decimal; `null` means "no data" (render "—").

---

## 1. Brands — `/api/brands`

| Method | Path | Role | Body | Response |
|---|---|---|---|---|
| GET | `/api/brands[?active=true]` | any signed-in user | — | `{ brands: Brand[], total }` (sorted by name, case-insensitive) |
| POST | `/api/brands` | admin | `{ name, shortName?, color?, active? }` | `201 { brand: Brand }` |
| PATCH | `/api/brands/:id` | admin | any of `name, shortName, color, active` | `{ brand: Brand, changed: string[] }` |
| DELETE | `/api/brands/:id` | admin | — | `{ success: true }` · **409** `{ error, projectCount }` when projects use it (deactivate instead) |

```ts
type BrandColor = "chart-1"|"chart-2"|"chart-3"|"chart-4"|"chart-5"|"primary"|"secondary"|"accent"|"muted"|"destructive";
interface Brand {
  _id: string; name: string;          // unique case-insensitively, ≤ 80
  shortName: string;                  // "" when unset, ≤ 20
  color: BrandColor;                  // default "chart-1"
  active: boolean;
  projectCount: number;
  createdAt: string; updatedAt: string;
}
```
Errors: `400 { error, field }` (validation), `409 { error, field: "name" }` (duplicate name), `404` unknown id.
Deleting a brand also removes it from the delivery settings (same-day allowlist, team map).

## 2. Project brand

- `Project.brand: string | null`. In project responses (`GET /api/projects`, `/api/projects/:id`) it is **populated**: `brand: { _id, name, shortName, color, active } | null`.
- `POST /api/projects` / `PATCH /api/projects/:id` accept `brand: "<brandId>" | null | ""`. An **inactive** brand can't be newly assigned (`400 "This brand is inactive"`); keeping the current one is fine. Unknown id → `404 "Brand not found"`.
- `GET /api/projects?brand=<brandId>` or `?brand=none` (projects without a brand). Also works on `/api/projects/export` (CSV has a new **Brand** column after Category).
- **Excel/CSV import (projects)**: new optional field `brand` (label "Brand"; header synonyms: brand, brand name, client, client name, project brand). Matched by name case-insensitively; missing brands are created for admins (row note `Brand "X" will be created`), heads get a warning and the value is skipped. Inactive brands are skipped with a warning. The template/Instructions sheet picks the column up automatically.

## 3. Delivery settings — `/api/settings/delivery` (admin only; head/employee → 403)

`GET` creates the singleton with defaults on first use. `PATCH` is partial (at least one known key), returns the same shape plus `changed: string[]`; `400 { error, field }` on validation errors. Saving clears the analytics cache immediately.

```ts
interface DeliverySettingsResponse {
  settings: {
    trafficManagers: string[];          // user ids (≤ 50)
    dashboardTeams: string[] | null;    // department ids; null (or []) = every department is a team
    reworkKeywords: string[];           // lower-cased, whole-word title match (≤ 50, each ≤ 40 chars)
    reworkCategories: string[];         // task category ids (default: the category named "Amends" if it exists)
    briefingWeekday: number;            // 0 = Sunday … 6 = Saturday (default 1 = Monday)
    minLeadDays: number;                // 0–60 (default 2)
    sameDayBrands: string[];            // brand ids
    finalAssetDomains: string[];        // e.g. "frame.io" (subdomains match; protocol/path stripped on save)
    briefMinLength: number;             // 0–2000 (default 80)
    minCompletedToRank: number;         // 0–1000 (default 5)
    staleDays: number;                  // 1–3650 (default 30)
    brandTeamMap: Array<{ brand: string; users: string[] }>;  // one entry per brand; empty users = "no map"
    teamMapStartDate: string;           // "YYYY-MM-DD" (default: the day the settings were created)
    updatedAt: string | null;
  };
  defaults: { reworkKeywords; reworkCategoryNames; briefingWeekday; minLeadDays; finalAssetDomains; briefMinLength; minCompletedToRank; staleDays };
  changed?: string[];                   // PATCH only
}
```
PATCH body = any subset of the `settings` keys above except `updatedAt` (send `dashboardTeams: null` for "all departments"). Names for ids come from `/api/users`, `/api/departments`, `/api/brands`, `/api/task-categories`.

## 4. Analytics — `/api/analytics/delivery/*`

Roles: **admin** (everything), **head** (only tasks where any *doer* is in their department; `team` filter still applies). Employees → **403**.

### Common query parameters
| Param | Values | Default |
|---|---|---|
| `period` | `7d` · `30d` · `90d` · `12m` (365 days) · `all` | `30d` |
| `team` | department id, or `other` | — |
| `brand` | brand id, or `none` (No brand) | — |
| `person` | user id (matches tasks where the user is a **doer**) | — |
| `format` | `csv` (only on `/delayed`, `/teams`, `/brands`, `/people`) | JSON |

Invalid values → `400 { error }`. CSV responses are downloads (`Content-Disposition: attachment; filename="delivery-<table>-YYYY-MM-DD.csv"`, UTF-8 BOM, headers `X-Export-Rows/Total/Truncated`).

### Common `meta` (every JSON response)
```ts
interface Meta {
  period: "7d"|"30d"|"90d"|"12m"|"all";
  days: number;                          // window length
  today: string;
  range: { start: string; end: string }; // current window (end = today)
  previous: { start: string; end: string } | null;   // null for "all"
  asOf: string;                          // ISO instant the data was computed ("data as of {time}"); cached ≤ 60 s
  timezone: string;                      // APP_TIMEZONE in effect
  filters: { team: string|null; brand: string|null; person: string|null };
  scope: { kind: "all"|"department"; departmentId: string|null; departmentName: string|null;
           noDepartment: boolean };      // true → head without a department: show the explanatory empty state
}
```

### Shared shapes
```ts
interface Stats {            // one row of metrics for a slice of tasks
  created: number;           // tasks created in the window
  completed: number;         // status=completed and completedAt in the window
  completedWithDue: number;  // on-time denominator
  completedNoDue: number;    // shown in the On-time KPI tooltip
  onTimePct: number | null;
  meanDays: number | null;   // mean calendar days createdAt → completedAt
  rework: number;            // rework tasks created in the window
  reworkPct: number | null;  // rework ÷ created  (= "rework share" in Teams/People)
  open: number;              // open now (todo/in_progress/in_review/rejected)
  overdue: number;           // open now and dueDate < today
}
interface Delta {
  current: number | null; previous: number | null;
  change: number | null;               // current − previous (percentage points for %)
  direction: "up"|"down"|"flat"|null;
  good: boolean | null;                // colour the pill: true = good, false = bad, null = neutral / n/a
  betterWhen: "higher"|"lower"|"neutral";
  noPreviousData: boolean;             // → "no data in previous period"
}
interface UserRef  { id: string|null; name: string; former: boolean }      // deleted user → "Former user"
interface BrandRef { id: string; name: string; shortName: string; color: string; active: boolean; noBrand: boolean }
                   // id "none", name "No brand", color "muted" for tasks without a brand
interface TaskRow {
  id: string; code: string;            // "PEAR-12" or "#12"
  title: string; status: "todo"|"in_progress"|"in_review"|"completed"|"rejected";
  brand: BrandRef;
  project: { id: string; code: string; name: string } | null;
  doers: UserRef[];                    // assignees minus traffic managers
  briefer: UserRef;                    // task creator (assignedBy)
  createdDate: string; dueDate: string | null;
  daysLate: number | null;             // today − due, only when open and past due
}
```

### `GET /summary`
```ts
{ meta, kpis: Stats, previous: Stats | null, deltas: {
    created: Delta;     // tasks created (neutral)
    completed: Delta;   // higher is good
    onTimePct: Delta;   // higher is good (tasks completed in each period)
    meanDays: Delta;    // lower is good
    reworkPct: Delta;   // lower is good (tasks created in each period)
    open: Delta;        // now vs the start of the period (neutral)
    overdue: Delta;     // now vs the start of the period; lower is good
} }
```
`previous` is the same-length window before; its `open`/`overdue` are the state at the end of that window (= start of the current one). For `all`, `previous` is `null` and every delta has `noPreviousData: true`.

### `GET /weekly`
```ts
{ meta, capped: boolean, maxWeeks: 104, weeks: Array<{
  weekStart: string; weekEnd: string;   // Monday … Sunday (weekEnd = today for the current week)
  created: number; completed: number; onTimePct: number|null; meanDays: number|null;
  open: number; overdue: number;        // reconstructed at weekEnd
  overduePct: number|null;              // overdue ÷ open at weekEnd
  rework: number; reworkPct: number|null;
}> }
```
Weeks cover the period (the first week may start before `range.start`); `capped: true` when `all` was cut to the latest 104 weeks.

### `GET /teams`  (CSV: `?format=csv`)
```ts
{ meta, rows: Array<Stats & { team: { id: string /* department id or "other" */; name: string }; volume: number /* = completed */ }> }
```
One row per configured dashboard team (zeros included) plus "Other" when it has data. A task with doers in several teams counts once in each. Sorted by completed desc.

### `GET /brands`  (CSV)
```ts
{ meta, rows: Array<Stats & { brand: BrandRef; previous: Stats | null;
  deltas: { created; completed; onTimePct; meanDays; reworkPct; overdue: Delta } | null /* null for "all" */ }> }
```
Rows = brands with activity in either period (incl. "No brand"); the same rows drive **Brand movement** via `previous`/`deltas`.

### `GET /delayed?stale=0|1`  (CSV)
```ts
{ meta, staleDays: number, includeStale: boolean, total: number, hiddenStale: number, truncated: boolean,
  rows: Array<TaskRow & { stale: boolean; rejected: boolean }> }
```
Open tasks past due **plus** rejected tasks. Default hides `stale` rows (`daysLate > staleDays`); `hiddenStale` = how many were hidden. Sorted by days late desc (rejected without a past due date last). JSON capped at 1000 rows (`truncated`); CSV has all rows (≤ 5000).

### `GET /briefs`
```ts
{ meta,
  rules: Array<{ id: 1..7; key: "attached"|"written"|"weekday"|"leadTime"|"noSameDay"|"teamMap"|"finalAsset"; label: string }>,
  settings: { briefingWeekday: number; minLeadDays: number; briefMinLength: number },  // for rule labels
  totals: { briefs: number; avgScore: number|null; rules: RuleRate[] },
  byBriefer: Array<{ briefer: UserRef; briefs: number; avgScore: number|null; rules: RuleRate[];
                     rework: number; reworkPct: number|null /* "Rework on their briefs" */ }>,
  weakestWindowDays: 30,
  weakest: Array<TaskRow & { score: number /* 0–100 */; passed: number; applicable: number;
                             results: Array<"pass"|"fail"|"na">;  /* index 0 = rule 1 */
                             failed: number[] /* rule ids → chips */ }> }
type RuleRate = { id: number; passed: number; applicable: number; pct: number|null };
```
Briefs = tasks created in the period (within filters). `weakest` = 20 lowest scores among tasks created in the last 30 days (filters apply, period doesn't), ties → newest first. Rules: 1 file ≤ 24 h after creation or URL in description · 2 description minus links (whitespace collapsed) ≥ min length · 3 created on the briefing weekday · 4 due − created ≥ min lead days (n/a without due) · 5 due ≠ created date or brand on allowlist (n/a without due) · 6 every doer on the brand's team map (n/a without a map) · 7 completed only: any file, or an allowed-domain link in the description / comments / non-private notes.

### `GET /people`  (CSV)
```ts
{ meta, minCompletedToRank: number, rows: Array<PersonStats & { person: Person }> }
type PersonStats = Stats & { brandCount: number; ranked: boolean /* completed ≥ minCompletedToRank; else "not ranked", greyed */ };
interface Person extends UserRef {
  department: { id: string; name: string } | null;
  team: { id: string; name: string };      // dashboard team of their department, or "other"
  isTrafficManager: boolean;
}
```
Doers only (traffic managers never appear). Ranked people first, then by completed desc. `brandCount` = distinct brands across their tasks created/completed in the period or open now.

### `GET /people/:id`  (drawer)
```ts
{ meta, person: Person, minCompletedToRank: number, stats: PersonStats,
  brands: Array<Stats & { brand: BrandRef }>,           // brand breakdown (period)
  weekly: { capped: boolean; weeks: WeekRow[] },          // same row shape as /weekly
  openWork: TaskRow[] }                                   // their open tasks, by due date (no due last)
```
`400` bad id, `404` unknown user with no tasks. Respects the head scope and the other filters (`person` is forced to `:id`).

### `GET /team-map`
```ts
{ meta, startDate: string, mappedBrands: number,
  offMap: Array<{ brand: BrandRef; total: number; people: Array<{ person: UserRef; count: number }> }>,
  mappedUnused: Array<{ brand: BrandRef; people: UserRef[] }>,
  unmappedBrands: Array<{ brand: BrandRef; tasks: number /* tasks since startDate */ }> }
```
Since `teamMapStartDate` (ignores `period`; other filters/scope apply). Off-map = completed tasks on a mapped brand by doers not on its map. Mapped-but-unused = map people with no tasks (created or completed since the start) on that brand. Unmapped = active brands without a map.

## 5. Notes
Tasks in archived projects are counted (delivery history doesn't disappear on archive). Tasks whose doers are all traffic managers belong to team "Other".

## 6. Caching & freshness
Responses are cached 60 s per (endpoint, filters, scope). Task / project / brand / user / task file / comment / note writes clear the cache (debounced ≈ 0.5 s, max 3 s); settings saves clear it at once. Show `meta.asOf` as "data as of {time}".
