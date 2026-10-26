// ---------------------------------------------------------------------------
// Board / chat data blocks: a tool result → one display-ready dataset (KPIs,
// columns, rows, chart series, what a row drills into). The numbers are the
// tool's own; the model only picks tool + params + view, never the figures.
// ---------------------------------------------------------------------------

export type Cell = string | number | boolean | null;
export type DrillKind = "brand" | "person" | "team" | "task" | "lead";

export interface DatasetColumn {
  key: string;
  label: string;
  numeric?: boolean;
  unit?: string;
}

export interface Dataset {
  /** Period / month / quarter label of the data. */
  subtitle: string;
  kpis: Array<{ label: string; value: Cell; hint?: string }>;
  /** The list shown (some tools have several, e.g. pitchPipeline byLead / byMonth / pitches). */
  list: string;
  lists: string[];
  columns: DatasetColumn[];
  rows: Array<Record<string, Cell>>;
  /** Rows in the list before `only` / the row cap. */
  total: number;
  labelKey: string;
  /** Default chart series (numeric column keys) and whether they stack. */
  series: string[];
  stacked: boolean;
  /** Ordered data (weeks): a line reads best. */
  ordered: boolean;
  /** What clicking a row opens: its kind and the column holding the name (or task id). */
  drill: { kind: DrillKind; key: string } | null;
  /** Filters this tool takes (filter chips). */
  filters: Array<"period" | "month" | "quarter" | "brand" | "team" | "person">;
  /** Filters the tool actually applied (names), shown as removable chips. */
  applied: Record<string, string>;
  /** Server ranking of the rows ("reworkPct desc"), when the tool ranks. */
  sortedBy?: { key: string; dir: "asc" | "desc" };
  note?: string;
}

type R = Record<string, unknown>;
const rec = (v: unknown): R => (v && typeof v === "object" ? (v as R) : {});
const list = (v: unknown): R[] => (Array.isArray(v) ? (v as R[]) : []);
const cell = (v: unknown): Cell =>
  v === null || v === undefined ? null : typeof v === "number" || typeof v === "string" || typeof v === "boolean" ? v : Array.isArray(v) ? v.join(", ") : JSON.stringify(v);

const col = (key: string, label: string, numeric = false, unit?: string): DatasetColumn => ({ key, label, ...(numeric ? { numeric } : {}), ...(unit ? { unit } : {}) });
const rowsOf = (items: R[], columns: DatasetColumn[], extra: string[] = []) =>
  items.map((it) => Object.fromEntries([...columns.map((c) => c.key), ...extra].map((k) => [k, cell(it[k])])));
const periodLabel = (r: R) => String(rec(r.period).label ?? r.label ?? r.quarter ?? "");

const GROUP_DRILL: Record<string, DrillKind | undefined> = { brand: "brand", person: "person", team: "team" };
const PERIOD_FILTERS: Dataset["filters"] = ["period", "brand", "team", "person"];

interface Shape {
  subtitle: string;
  kpis: Dataset["kpis"];
  lists: Record<string, () => Omit<Dataset, "subtitle" | "kpis" | "list" | "lists" | "total" | "filters" | "applied" | "sortedBy" | "note"> & { items: number }>;
  filters: Dataset["filters"];
  note?: string;
}

function shape(tool: string, r: R, params: R): Shape {
  switch (tool) {
    case "tasksSummary": {
      const t = rec(r.totals);
      const by = String(r.groupBy ?? "none");
      const cols = [col("name", by === "none" ? "Group" : by[0]!.toUpperCase() + by.slice(1)), col("created", "Created", true), col("completed", "Completed", true), col("completedOnTime", "On time", true), col("completedLate", "Late", true), col("onTimePct", "On time %", true, "%"), col("open", "Open", true), col("overdue", "Overdue", true)];
      return {
        subtitle: periodLabel(r),
        kpis: [
          { label: "Created", value: cell(t.created) },
          { label: "Completed", value: cell(t.completed) },
          { label: "On time", value: cell(t.onTimePct), hint: `% of ${t.completedWithDueDate ?? 0} with a due date` },
          { label: "Overdue now", value: cell(t.overdue), hint: `of ${t.open ?? 0} open` },
        ],
        lists: {
          groups: () => ({ columns: cols, rows: rowsOf(list(r.groups), cols, ["lowVolume"]), items: Number(r.groupCount ?? 0), labelKey: "name", series: ["completedOnTime", "completedLate"], stacked: true, ordered: false, drill: GROUP_DRILL[by] ? { kind: GROUP_DRILL[by]!, key: "name" } : null }),
        },
        filters: PERIOD_FILTERS,
      };
    }
    case "lateTasks": {
      const cols = [col("code", "Task"), col("title", "Title"), col("brand", "Brand"), col("doers", "Doers"), col("due", "Due"), col("actualEnd", "Actual end"), col("daysLate", "Days late", true), col("kind", "Kind"), col("outcomeNote", "Outcome note")];
      return {
        subtitle: periodLabel(r),
        kpis: [
          { label: "Closed late", value: cell(r.closedLate) },
          { label: "Overdue now", value: cell(r.overdue) },
        ],
        lists: {
          tasks: () => ({ columns: cols, rows: rowsOf(list(r.tasks), cols, ["id"]), items: Number(r.total ?? 0), labelKey: "code", series: ["daysLate"], stacked: false, ordered: false, drill: { kind: "task", key: "id" } }),
        },
        filters: PERIOD_FILTERS,
      };
    }
    case "scopeUsage": {
      const bcols = [col("brand", "Brand"), col("projects", "Projects", true), col("totalScope", "Scope", true), col("totalUsed", "Used", true), col("overUnits", "Over", true), col("overScopeTasksPending", "Over-scope pending", true), col("overScopeTasksApproved", "Over-scope approved", true)];
      const pcols = [col("brand", "Brand"), col("code", "Project"), col("name", "Name"), col("units", "Units (used / scope)")];
      const projects = list(r.projects).map((p) => ({
        ...p,
        units: list(p.units).map((u) => `${u.unit} ${u.used}/${u.total}${Number(u.over) > 0 ? ` (+${u.over})` : ""}`).join(", "),
      }));
      return {
        subtitle: String(r.label ?? ""),
        kpis: [
          { label: "Projects", value: cell(r.projectCount) },
          { label: "Brands over scope", value: list(r.brands).filter((b) => Number(b.overUnits) > 0).length },
          { label: "Projects without scope", value: cell(r.projectsWithoutScope) },
        ],
        lists: {
          brands: () => ({ columns: bcols, rows: rowsOf(list(r.brands), bcols), items: list(r.brands).length, labelKey: "brand", series: ["totalScope", "totalUsed", "overUnits"], stacked: false, ordered: false, drill: { kind: "brand", key: "brand" } }),
          projects: () => ({ columns: pcols, rows: rowsOf(projects, pcols), items: projects.length, labelKey: "code", series: [], stacked: false, ordered: false, drill: { kind: "brand", key: "brand" } }),
        },
        filters: ["month", "brand"],
        note: "Used = task quantities of new work (rework excluded) per scope unit; over = beyond the approved total.",
      };
    }
    case "timeLogged": {
      const by = String(r.groupBy ?? "person");
      const cols = [col("name", by === "week" ? "Week" : by[0]!.toUpperCase() + by.slice(1)), col("hours", "Hours", true, "h"), col("people", "People", true)];
      return {
        subtitle: periodLabel(r),
        kpis: [{ label: "Hours logged", value: cell(r.totalHours) }],
        lists: {
          groups: () => ({ columns: cols, rows: rowsOf(list(r.groups), cols, ["lowVolume"]), items: Number(r.groupCount ?? 0), labelKey: "name", series: ["hours"], stacked: false, ordered: by === "week", drill: GROUP_DRILL[by] ? { kind: GROUP_DRILL[by]!, key: "name" } : null }),
        },
        filters: PERIOD_FILTERS,
      };
    }
    case "manpowerLoad": {
      const pcols = [col("name", "Person"), col("team", "Team"), col("activeLines", "Active lines", true), col("pitchLines", "Pitch lines", true), col("brands", "Brands", true), col("overloaded", "Overloaded")];
      const lcols = [col("line", "Plan line"), col("brand", "Brand"), col("emptyRoles", "Empty roles"), col("placeholders", "Placeholders"), col("missingLead", "Missing lead")];
      return {
        subtitle: String(r.label ?? ""),
        kpis: r.plan === null
          ? [{ label: "Plan", value: "No approved plan", hint: `Months with a plan: ${list(r.monthsWithAPlan).join(", ")}` }]
          : [
              { label: "Overloaded", value: cell(r.overloadedCount), hint: `more than ${r.maxActiveLinesPerPerson} active lines` },
              { label: "People on plan", value: cell(r.peopleOnPlan) },
              { label: "Lines missing a lead", value: cell(r.linesMissingLead) },
              { label: "Lines with empty roles", value: cell(r.linesWithEmptyRoles) },
            ],
        lists: {
          people: () => ({ columns: pcols, rows: rowsOf(list(r.people), pcols), items: Number(r.peopleOnPlan ?? 0), labelKey: "name", series: ["activeLines", "pitchLines"], stacked: true, ordered: false, drill: { kind: "person", key: "name" } }),
          lines: () => ({ columns: lcols, rows: rowsOf(list(r.linesNeedingStaff), lcols), items: list(r.linesNeedingStaff).length, labelKey: "line", series: [], stacked: false, ordered: false, drill: null }),
        },
        filters: ["month", "person"],
      };
    }
    case "pitchPipeline": {
      const t = rec(r.totals);
      const leadCols = [col("lead", "Lead"), col("pitches", "Pitches", true), col("revenue", "Revenue (AED)", true), col("tbc", "Revenue TBC", true), col("missed", "Missed", true)];
      const byLead = list(r.byLead).map((l) => ({ ...l, missed: rec(l.byStatusTone).missed ?? 0 }));
      const monthCols = [col("month", "Month"), col("pitches", "Pitches", true), col("revenue", "Revenue (AED)", true), col("tbc", "Revenue TBC", true)];
      const pitchCols = [col("client", "Client"), col("title", "Pitch"), col("leads", "Leads"), col("revenueAed", "Revenue (AED)", true), col("status", "Status")];
      return {
        subtitle: String(r.quarter ?? ""),
        kpis: [
          { label: "Pitches", value: cell(t.pitches) },
          { label: "Revenue potential (AED)", value: cell(t.revenuePotentialAed) },
          { label: "Missed", value: cell(rec(t.byStatusTone).missed ?? 0) },
          { label: "Revenue TBC", value: cell(t.revenueTbc) },
        ],
        lists: {
          byLead: () => ({ columns: leadCols, rows: rowsOf(byLead, leadCols), items: byLead.length, labelKey: "lead", series: ["pitches"], stacked: false, ordered: false, drill: { kind: "lead", key: "lead" } }),
          byMonth: () => ({ columns: monthCols, rows: rowsOf(list(r.byMonth), monthCols), items: list(r.byMonth).length, labelKey: "month", series: ["revenue"], stacked: false, ordered: true, drill: null }),
          pitches: () => ({ columns: pitchCols, rows: rowsOf(list(r.pitches), pitchCols), items: Number(t.pitches ?? 0), labelKey: "client", series: [], stacked: false, ordered: false, drill: null }),
        },
        filters: ["quarter", "person"],
      };
    }
    case "reworkStats": {
      const t = rec(r.totals);
      const by = String(r.groupBy ?? "none");
      const cols = [col("name", by === "none" ? "Group" : by[0]!.toUpperCase() + by.slice(1)), col("created", "Created", true), col("rework", "Rework", true), col("reworkPct", "Rework %", true, "%"), col("internal", "Internal", true), col("external", "External", true), col("notSet", "Not set", true)];
      return {
        subtitle: periodLabel(r),
        kpis: [
          { label: "Tasks created", value: cell(t.created) },
          { label: "Rework", value: cell(t.rework), hint: `${t.reworkPct ?? "—"}% of created` },
          { label: "Internal", value: cell(t.internal) },
          { label: "External", value: cell(t.external) },
        ],
        lists: {
          groups: () => ({ columns: cols, rows: rowsOf(list(r.groups), cols, ["lowVolume"]), items: Number(r.groupCount ?? 0), labelKey: "name", series: ["internal", "external", "notSet"], stacked: true, ordered: false, drill: GROUP_DRILL[by] ? { kind: GROUP_DRILL[by]!, key: "name" } : null }),
        },
        filters: PERIOD_FILTERS,
      };
    }
    case "pearityStats": {
      const t = rec(r.totals);
      const by = String(r.groupBy ?? "brand");
      const cols = [col("name", by === "person" ? "Person" : "Brand"), col("closed", "Closed", true), col("on", "On Pearity", true), col("off", "Off Pearity", true), col("notRecorded", "Not recorded", true), col("onPct", "On % (recorded)", true, "%")];
      const wcols = [col("week", "Week of"), col("on", "On", true), col("off", "Off", true), col("notRecorded", "Not recorded", true)];
      return {
        subtitle: periodLabel(r),
        kpis: [
          { label: "Closed tasks", value: cell(t.closed) },
          { label: "On Pearity", value: cell(t.on), hint: `${t.onPctOfClosed ?? "—"}% of closed` },
          { label: "Off Pearity", value: cell(t.off), hint: `${t.offPctOfClosed ?? "—"}% of closed` },
          { label: "Not recorded", value: cell(t.notRecorded) },
        ],
        lists: {
          groups: () => ({ columns: cols, rows: rowsOf(list(r.groups), cols, ["lowVolume"]), items: Number(r.groupCount ?? 0), labelKey: "name", series: ["on", "off"], stacked: true, ordered: false, drill: { kind: by === "person" ? "person" : "brand", key: "name" } }),
          trend: () => ({ columns: wcols, rows: rowsOf(list(r.weeklyTrend), wcols), items: list(r.weeklyTrend).length, labelKey: "week", series: ["on", "off"], stacked: false, ordered: true, drill: null }),
        },
        filters: PERIOD_FILTERS,
      };
    }
    case "approvalsWaiting": {
      const cols = [col("kind", "Kind"), col("title", "What"), col("requestedBy", "Requested by"), col("brand", "Brand"), col("ageDays", "Age (days)", true)];
      return {
        subtitle: "Now",
        kpis: [
          { label: "Waiting", value: cell(r.total) },
          { label: "Oldest (days)", value: cell(r.oldestAgeDays) },
        ],
        lists: {
          items: () => ({ columns: cols, rows: rowsOf(list(r.items), cols), items: Number(r.total ?? 0), labelKey: "title", series: ["ageDays"], stacked: false, ordered: false, drill: null }),
        },
        filters: [],
      };
    }
    default:
      void params;
      return { subtitle: "", kpis: [], lists: {}, filters: [] };
  }
}

/** Display dataset of a tool result. `only` keeps the rows whose label matches one of the names (compare). */
export function datasetOf(tool: string, result: unknown, opts: { list?: string; only?: string[]; params?: R } = {}): Dataset {
  const r = rec(result);
  const s = shape(tool, r, opts.params ?? {});
  const names = Object.keys(s.lists);
  const chosen = opts.list && names.includes(opts.list) ? opts.list : (names[0] ?? "");
  const built = s.lists[chosen]?.() ?? { columns: [], rows: [], items: 0, labelKey: "", series: [], stacked: false, ordered: false, drill: null };
  const { items, ...rest } = built;
  let rows = rest.rows;
  if (opts.only?.length) {
    // Each name: its exact row when there is one, else the rows containing it.
    const label = (row: Record<string, Cell>) => String(row[rest.labelKey] ?? "").toLowerCase();
    const keep = new Set<Record<string, Cell>>();
    for (const name of opts.only.map((n) => n.toLowerCase().trim())) {
      const exact = rows.filter((row) => label(row) === name);
      (exact.length ? exact : rows.filter((row) => label(row).includes(name))).forEach((row) => keep.add(row));
    }
    rows = rows.filter((row) => keep.has(row));
  }
  return {
    ...rest,
    rows,
    subtitle: s.subtitle,
    kpis: s.kpis,
    list: chosen,
    lists: names,
    total: items,
    filters: s.filters,
    applied: Object.fromEntries(Object.entries(rec(r.filters)).map(([k, v]) => [k, String(v)])),
    ...(typeof r.sortedBy === "string" ? { sortedBy: { key: r.sortedBy.split(" ")[0]!, dir: r.sortedBy.endsWith("asc") ? ("asc" as const) : ("desc" as const) } } : {}),
    ...(s.note || r.note ? { note: String(s.note ?? r.note) } : {}),
    ...(r.error ? { note: String(r.error) } : {}),
  };
}

/** Lists each tool offers (for the model's prompt and validation). */
export const TOOL_LISTS: Record<string, string[]> = {
  tasksSummary: ["groups"],
  lateTasks: ["tasks"],
  scopeUsage: ["brands", "projects"],
  timeLogged: ["groups"],
  manpowerLoad: ["people", "lines"],
  pitchPipeline: ["byLead", "byMonth", "pitches"],
  reworkStats: ["groups"],
  pearityStats: ["groups", "trend"],
  approvalsWaiting: ["items"],
};
