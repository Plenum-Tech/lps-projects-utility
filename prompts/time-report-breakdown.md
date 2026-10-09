# Time log report: Employee › Project › Task breakdown + Excel export

## Goal

On **Reports → Time Log Report**, add a **Breakdown** view that shows hours spent per **employee → project → task**, with a graph, and an **Export Excel** button that produces a formatted workbook of the same report (not just the raw CSV).

## Breakdown view (new "Group by" option)

- A fifth group option, **Breakdown**, next to Employee / Project / Task / Day. The existing filters (date range, project, department, employee, status) apply unchanged.
- **Table**: a nested table, Employee (bold row, total hours) → their projects (hours) → the tasks under each project (task code + title, hours, earnings, entries). Employees and projects expand/collapse; "Expand all / Collapse all" at the top. Rows are sorted by hours, biggest first. A footer shows the grand total.
- **Graph**: a horizontal stacked bar per employee, one colour segment per project (legend of the top 8 projects, the rest as "Other"), so you can see both who logged the most and on what. Hovering a segment shows employee, project and hours.
- The three stat cards (Total time, Earnings, Time logs) stay as they are.

## Export Excel (.xlsx), available in every group mode

A button **Export Excel** beside **Export CSV**. It downloads `time-report-<from>-<to>.xlsx` built on the server with the current filters:

| Sheet | Contents |
|---|---|
| **Summary** | Period, filters applied, generated on/by, Total hours, Earnings, Time logs, Employees. |
| **Breakdown** | Employee, Project (code + name), Task (code + title), Hours, Earnings, Entries. Grouped with Excel outline levels (collapsible), subtotal rows per employee and per project, grand total. The **Hours** column has Excel data bars, so the sheet shows the graph in-cell. |
| **By employee** | Employee, Email, Hours, Earnings, Entries, % of total — with data bars. |
| **By project** | Project code, Project, Hours, Earnings, Entries, % — with data bars. |
| **By task** | Task code, Task, Project, Hours, Entries — with data bars. |
| **Time logs** | One row per time log (the same columns as today's CSV). |

Formatting: bold headers, frozen header row, auto-filter, column widths, hours as `0.00`, earnings as currency, totals in bold. Capped at 10,000 logs like the CSV.

**Limitation to know:** the library we use (exceljs) cannot create native Excel charts. The graph in the workbook is the in-cell data bars (which look like a bar chart and update if you edit the numbers). If you want a real Excel chart object, that needs a different tool later.

## Backend

- `GET /api/reports/time/breakdown?…` — same filters as `/summary`; returns `employees[] → projects[] → tasks[]` with minutes, hours, earnings, count at each level, plus totals.
- `GET /api/reports/time/export.xlsx?…` — streams the workbook (exceljs). Same visibility rules as the report (admins: everyone; heads: their department).

## Done when

- Both type checks and the build pass.
- API tests on a scratch DB: breakdown totals equal the summary totals for the same filters; the xlsx opens, has the six sheets and matching totals; heads only see their department.
- Browser check: Breakdown view renders with expand/collapse and the stacked chart; Export Excel downloads; works at 375 px.
- Deployed.
