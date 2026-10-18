import mongoose, { type PipelineStage } from "mongoose";
import { Brand } from "../../models/Brand.js";
import { Department } from "../../models/Department.js";
import { archivedProjectIds, Project } from "../../models/Project.js";
import { Task } from "../../models/Task.js";
import { User } from "../../models/User.js";
import { appTimeZone, zonedParts } from "../appTime.js";
import { deliveryCached } from "./cache.js";
import { dayFromKey, keyFromDay } from "./days.js";
import type { DeliverySettingsSnapshot } from "./settings.js";

const { ObjectId } = mongoose.Types;

// ---------------------------------------------------------------------------
// Delivery "facts": one aggregation over tasks ($match on the indexed window /
// assignee / project prefilters, $project of the date-only keys in
// APP_TIMEZONE and the rework flag), then the joins — brand through the
// project, team through the doers' departments — against the cached reference
// maps (a per-task $lookup cost ~400 ms on 5,000 tasks; the maps cost ~0).
// Doers = assignees minus traffic managers. Every endpoint reduces these rows;
// one load is shared (single-flight, cached 60 s) by all the endpoints the page
// calls for a filter set.
// ---------------------------------------------------------------------------

/** Team key of departments outside the configured dashboard teams (and doers without a department). */
export const OTHER_TEAM = "other";
export const NO_BRAND = "none";

export interface DeliveryFilters {
  /** Department id or "other". */
  team: string | null;
  /** Brand id or "none". */
  brand: string | null;
  /** User id (matched against the doers). */
  person: string | null;
}

export interface DeliveryScope {
  kind: "all" | "department";
  /** Head's department (null = head without a department → empty data). */
  department: string | null;
}

export interface TaskFact {
  id: string;
  code: string;
  title: string;
  status: string;
  /** Assignees minus traffic managers. */
  doers: string[];
  /** Task creator (assignedBy). */
  briefer: string | null;
  project: string | null;
  /** Brand id, null = "No brand". */
  brand: string | null;
  /** Dashboard team keys of the doers (department id or "other"), unique. */
  teams: string[];
  createdAt: Date;
  /** Day numbers (days since 1970-01-01) of the app-timezone calendar dates. */
  createdDay: number;
  /** completedAt day for completed tasks with a completedAt (the "Completed" metric). */
  completedDay: number | null;
  /** Day the task stopped being open (completedAt, else updatedAt for legacy completed tasks); null while open. */
  closedDay: number | null;
  dueDay: number | null;
  /** Planned start (date-only). */
  startDay: number | null;
  /** Actual start / end in app-timezone days (null when unset). */
  actualStartDay: number | null;
  actualEndDay: number | null;
  rework: boolean;
}

export interface FactsResult {
  facts: TaskFact[];
  /** Earliest createdDay in the scope (for period "all"); null when empty. */
  minCreatedDay: number | null;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Rework moved inside tasks on 12 Oct 2026: rework items added since then mark the task as reworked. */
const REWORK_ITEMS_SINCE = Date.UTC(2026, 9, 12);
function hasReworkItems(ids: unknown[] | undefined): boolean {
  return (ids ?? []).some((id) => {
    const ts = (id as { getTimestamp?: () => Date })?.getTimestamp?.();
    return ts ? ts.getTime() >= REWORK_ITEMS_SINCE : false;
  });
}

/** Whole-word, case-insensitive pattern for the rework keywords (null when there are none). */
export function reworkPattern(keywords: string[]): string | null {
  const words = keywords.map((k) => k.trim()).filter(Boolean).map(escapeRegex);
  return words.length ? `\\b(?:${words.join("|")})\\b` : null;
}

const oid = (id: string) => new ObjectId(id);

interface RawFact {
  _id: mongoose.Types.ObjectId;
  title: string;
  status: string;
  shortCode?: string | null;
  number?: number | null;
  assignedBy?: mongoose.Types.ObjectId | null;
  project?: mongoose.Types.ObjectId | null;
  assignees?: mongoose.Types.ObjectId[];
  createdAt: Date;
  createdKey: string;
  completedKey: string | null;
  updatedKey: string | null;
  dueKey: string | null;
  startDate?: Date | null;
  actualStartAt?: Date | null;
  actualEndAt?: Date | null;
  rework: boolean;
  subtaskIds?: unknown[];
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** App-timezone offset (ms) at the start of UTC hour `hour`. */
function offsetAtHour(hour: number): number {
  const probe = new Date(hour * HOUR_MS);
  const p = zonedParts(probe);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - probe.getTime();
}

/**
 * App-timezone day number of an instant, without a $dateToString per row. The
 * zone offset is memoised per UTC day (two Intl calls); on the rare day whose
 * offset changes (DST) it is resolved per hour, where offsets change.
 */
function makeAppDay(): (date: Date | null | undefined) => number | null {
  const byDay = new Map<number, number | null>();
  const byHour = new Map<number, number>();
  return (date) => {
    if (!date) return null;
    const t = date.getTime();
    const utcDay = Math.floor(t / DAY_MS);
    let offset = byDay.get(utcDay);
    if (offset === undefined) {
      const first = offsetAtHour(utcDay * 24);
      offset = first === offsetAtHour(utcDay * 24 + 24) ? first : null;
      byDay.set(utcDay, offset);
    }
    if (offset === null) {
      const hour = Math.floor(t / HOUR_MS);
      offset = byHour.get(hour) ?? offsetAtHour(hour);
      byHour.set(hour, offset);
    }
    return Math.floor((t + offset) / DAY_MS);
  };
}

/**
 * Loads the facts for a scope + filters. `windowStartDay` limits the scan to
 * tasks that matter for any window starting that day: still open, or created /
 * completed since then (null = every task).
 */
export function loadFacts(
  settings: DeliverySettingsSnapshot,
  ref: RefData,
  scope: DeliveryScope,
  filters: DeliveryFilters,
  windowStartDay: number | null
): Promise<FactsResult> {
  const key = `facts:${JSON.stringify([scope, filters, windowStartDay, settings.updatedAt, appTimeZone()])}`;
  return deliveryCached(key, () => queryFacts(settings, ref, scope, filters, windowStartDay));
}

/** Users whose department is `department`. */
function usersOf(ref: RefData, department: string): mongoose.Types.ObjectId[] {
  return [...ref.users].filter(([, u]) => u.department === department).map(([id]) => oid(id));
}

async function queryFacts(
  settings: DeliverySettingsSnapshot,
  ref: RefData,
  scope: DeliveryScope,
  filters: DeliveryFilters,
  windowStartDay: number | null
): Promise<FactsResult> {
  if (scope.kind === "department" && !scope.department) return { facts: [], minCreatedDay: null };
  const tz = appTimeZone();
  const trafficManagers = new Set(settings.trafficManagers);
  const dashboardTeams = settings.dashboardTeams ? new Set(settings.dashboardTeams) : null;

  // --- $match: everything an index can narrow (exact checks happen on the doers below) ---
  const match: Record<string, unknown>[] = [];
  if (windowStartDay !== null) {
    // A day earlier than the window in UTC covers every timezone offset; the day keys decide exactly.
    const since = new Date((windowStartDay - 1) * 86_400_000);
    match.push({ $or: [{ status: { $ne: "completed" } }, { completedAt: { $gte: since } }, { createdAt: { $gte: since } }] });
  }
  // Archived projects are read-only: their unfinished tasks aren't open or
  // overdue work (same as the dashboard and task lists); completed ones stay in history.
  const archived = await archivedProjectIds();
  if (archived.length) match.push({ $or: [{ status: "completed" }, { project: { $nin: archived } }] });
  if (filters.person) match.push({ assignees: oid(filters.person) });
  if (scope.kind === "department") match.push({ assignees: { $in: usersOf(ref, scope.department!) } });
  if (filters.team && filters.team !== OTHER_TEAM) match.push({ assignees: { $in: usersOf(ref, filters.team) } });
  if (filters.brand) {
    const projects = [...ref.projects].filter(([, p]) => (filters.brand === NO_BRAND ? !p.brand || !ref.brands.has(p.brand) : p.brand === filters.brand));
    if (filters.brand === NO_BRAND) {
      const branded = [...ref.projects].filter(([, p]) => p.brand && ref.brands.has(p.brand)).map(([id]) => oid(id));
      if (branded.length) match.push({ project: { $nin: branded } });
    } else {
      match.push({ project: { $in: projects.map(([id]) => oid(id)) } });
    }
  }

  const pattern = reworkPattern(settings.reworkKeywords);
  const reworkConditions: unknown[] = [{ $in: ["$category", settings.reworkCategories.map(oid)] }];
  if (pattern) reworkConditions.push({ $regexMatch: { input: "$title", regex: pattern, options: "i" } });

  const pipeline: PipelineStage[] = [
    ...(match.length ? [{ $match: match.length === 1 ? match[0]! : { $and: match } }] : []),
    {
      $project: {
        title: 1,
        status: 1,
        shortCode: 1,
        number: 1,
        assignedBy: 1,
        project: 1,
        assignees: 1,
        createdAt: 1,
        createdKey: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: tz } },
        completedKey: {
          $cond: [
            { $and: [{ $eq: ["$status", "completed"] }, { $ne: [{ $ifNull: ["$completedAt", null] }, null] }] },
            { $dateToString: { format: "%Y-%m-%d", date: "$completedAt", timezone: tz } },
            null,
          ],
        },
        updatedKey: {
          $cond: [
            { $eq: ["$status", "completed"] },
            { $dateToString: { format: "%Y-%m-%d", date: { $ifNull: ["$updatedAt", "$createdAt"] }, timezone: tz } },
            null,
          ],
        },
        // Due dates are date-only (UTC midnight).
        dueKey: {
          $cond: [
            { $ne: [{ $ifNull: ["$dueDate", null] }, null] },
            { $dateToString: { format: "%Y-%m-%d", date: "$dueDate", timezone: "UTC" } },
            null,
          ],
        },
        // Raw instants: day numbers are derived in JS (see makeAppDay).
        startDate: 1,
        actualStartAt: 1,
        actualEndAt: 1,
        // Rework items (subtasks) — those added since rework moved inside tasks count as rework.
        subtaskIds: "$subtasks._id",
        // Rules-era tasks carry an explicit iteration marker; older ones use the keyword/category rule.
        rework: {
          $cond: [
            { $ne: [{ $ifNull: ["$iteration", null] }, null] },
            { $eq: ["$iteration", "rework"] },
            { $or: reworkConditions },
          ],
        },
      },
    },
  ];

  const rows = await Task.aggregate<RawFact>(pipeline).allowDiskUse(true);

  // --- joins (brand through the project, team through the doers' departments) and exact filters ---
  let minCreatedDay: number | null = null;
  const facts: TaskFact[] = [];
  const appDay = makeAppDay();
  for (const r of rows) {
    const doers = [...new Set((r.assignees ?? []).map(String))].filter((id) => !trafficManagers.has(id));
    const departments = doers.map((d) => ref.users.get(d)?.department ?? null);
    if (scope.kind === "department" && !departments.includes(scope.department)) continue;
    const teams = [
      ...new Set(departments.map((d) => (d && (dashboardTeams === null || dashboardTeams.has(d)) ? d : OTHER_TEAM))),
    ];
    if (teams.length === 0) teams.push(OTHER_TEAM);
    if (filters.team && !teams.includes(filters.team)) continue;
    if (filters.person && !doers.includes(filters.person)) continue;
    const project = r.project ? String(r.project) : null;
    const brand = project ? (ref.projects.get(project)?.brand ?? null) : null;

    const createdDay = dayFromKey(r.createdKey);
    if (minCreatedDay === null || createdDay < minCreatedDay) minCreatedDay = createdDay;
    const completedDay = r.completedKey ? dayFromKey(r.completedKey) : null;
    facts.push({
      id: String(r._id),
      code: r.shortCode || (r.number ? `#${r.number}` : ""),
      title: r.title,
      status: r.status,
      doers,
      briefer: r.assignedBy ? String(r.assignedBy) : null,
      project,
      brand: brand && ref.brands.has(brand) ? brand : null,
      teams,
      createdAt: r.createdAt,
      createdDay,
      completedDay,
      closedDay: r.status === "completed" ? (completedDay ?? (r.updatedKey ? dayFromKey(r.updatedKey) : createdDay)) : null,
      dueDay: r.dueKey ? dayFromKey(r.dueKey) : null,
      // Planned start is date-only (UTC midnight).
      startDay: r.startDate ? Math.floor(r.startDate.getTime() / DAY_MS) : null,
      actualStartDay: appDay(r.actualStartAt),
      actualEndDay: appDay(r.actualEndAt),
      rework: Boolean(r.rework) || hasReworkItems(r.subtaskIds),
    });
  }
  return { facts, minCreatedDay };
}

// -- Reference data (names / colours), cached with the responses --------------

export interface RefData {
  users: Map<string, { name: string; department: string | null; role: string; designation: string }>;
  brands: Map<string, { name: string; shortName: string; color: string; active: boolean }>;
  departments: Map<string, string>;
  projects: Map<string, { code: string; name: string; brand: string | null }>;
}

export function loadRefData(): Promise<RefData> {
  return deliveryCached("ref", async () => {
    const [users, brands, departments, projects] = await Promise.all([
      User.find().select("name department role designation").lean(),
      Brand.find().select("name shortName color active").lean(),
      Department.find().select("name").lean(),
      Project.find().select("code name brand").lean(),
    ]);
    return {
      users: new Map(
        users.map((u) => [String(u._id), { name: u.name, department: u.department ? String(u.department) : null, role: u.role, designation: u.designation ?? "" }])
      ),
      brands: new Map(
        brands.map((b) => [String(b._id), { name: b.name, shortName: b.shortName ?? "", color: b.color, active: b.active }])
      ),
      departments: new Map(departments.map((d) => [String(d._id), d.name])),
      projects: new Map(
        projects.map((p) => [String(p._id), { code: p.code, name: p.name, brand: p.brand ? String(p.brand) : null }])
      ),
    };
  });
}

export { keyFromDay };
