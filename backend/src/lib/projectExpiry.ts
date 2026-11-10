import type { IProject } from "../models/Project.js";
import { settingsTimeZone } from "./companySettings.js";

/**
 * Monthly project expiry: a project closes at the end of its month. After that
 * no new task can be added to it (open tasks can still be worked and closed);
 * work that continues needs a project for the new month.
 *
 * The month is the project's naming month. Projects without one (imported from
 * Worksuite) use a month and year written in their name ("Ajmal | September 2026 |
 * Retainer", "C4 | Sep 2026", "Abbott | September 26"), else their deadline's
 * month; projects with none of these never close.
 */
type ExpiryFields = Pick<IProject, "naming" | "deadline"> & { name?: string; activeThrough?: string | null };

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const NAME_MONTH =
  /(?:^|[^a-z])(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[\s,.'’_|-]*((?:20)?\d{2})(?!\d)/i;

/** "YYYY-MM" from a month and year written in a project name, or null. */
export function monthFromName(name: string | undefined): string | null {
  if (!name) return null;
  const m = NAME_MONTH.exec(name);
  if (!m) return null;
  const month = MONTHS[m[1]!.slice(0, 3).toLowerCase()];
  const year = m[2]!.length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  if (!month || year < 2020 || year > 2040) return null;
  return `${year}-${String(month).padStart(2, "0")}`;
}

export const PROJECT_CLOSED_MESSAGE =
  "This project closed at the end of its month. Create a project for the new month to add tasks.";

/** "YYYY-MM" the project belongs to, or null when it has no month and no deadline. */
export function projectMonth(project: ExpiryFields): string | null {
  if (project.naming?.month) return project.naming.month;
  const fromName = monthFromName(project.name);
  if (fromName) return fromName;
  // Deadlines are date-only values stored at UTC midnight.
  if (project.deadline) return project.deadline.toISOString().slice(0, 7);
  return null;
}

/** Current "YYYY-MM" in the app timezone. */
export function currentAppMonth(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: settingsTimeZone(),
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  return `${year}-${month}`;
}

/** Today ("YYYY-MM-DD") in the app timezone. */
function currentAppDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: settingsTimeZone(), year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * Last day ("YYYY-MM-DD") the project takes new work, or null when it never closes:
 * the last day of its month — or its deadline when that is later (a monthly project
 * running for a whole contract term).
 */
export function projectClosesOn(project: ExpiryFields): string | null {
  // A project carried on (open tasks at month end) runs through its activeThrough month.
  const month = project.activeThrough ?? projectMonth(project);
  if (!month) return null;
  const [y, m] = month.split("-").map(Number);
  const monthEnd = new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
  const deadline = project.deadline ? project.deadline.toISOString().slice(0, 10) : null;
  return deadline && deadline > monthEnd ? deadline : monthEnd;
}

/** True once the project has closed: its month has ended and so has its deadline (app timezone). */
export function isProjectExpired(project: ExpiryFields, now: Date = new Date()): boolean {
  const closes = projectClosesOn(project);
  return closes !== null && closes < currentAppDay(now);
}

/** True when the project runs in `month`: from its own month through the last month it was carried into. */
export function projectRunsIn(project: ExpiryFields, month: string): boolean {
  const start = projectMonth(project);
  if (!start || start > month) return false;
  return (project.activeThrough ?? start) >= month;
}
