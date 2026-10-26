import mongoose from "mongoose";
import { z } from "zod/v4";
import { latestPlan } from "../../models/ManpowerPlan.js";
import { Task } from "../../models/Task.js";
import type { RefData, TaskFact } from "../delivery/facts.js";
import { currentMonth, matchName, ToolInputError, closestNames } from "./common.js";

// ---------------------------------------------------------------------------
// "Team" filters for the Insights tools. A team is a department ("Production")
// or — when no department matches — a PERSON's team ("Hamza team", "Hamza's
// team"): the person is matched by name (sound-alike / typo tolerant), and the
// team is one of the definitions below (default: tasks they own or assigned).
// The tool result says which definition was used and lists the others, so the
// page can offer them as chips. Never a bare "not found": the error carries
// the closest people / teams as suggestions.
// ---------------------------------------------------------------------------

export const TEAM_SCOPES = ["owned_or_assigned", "own", "assigned", "department", "projects"] as const;
export type TeamScope = (typeof TEAM_SCOPES)[number];

export const teamScopeParam = z
  .enum(TEAM_SCOPES)
  .optional()
  .describe(
    "When `team` names a person (\"Hamza team\"): owned_or_assigned (default — tasks they own or assigned to others), own (only their tasks), assigned (tasks they assigned), department (their department), projects (people on their manpower plan lines this month)."
  );

const ASSIGNED_LOOKBACK_DAYS = 60;

export interface TeamFilter {
  kind: "department" | "person";
  departmentId: string | null;
  personId: string | null;
  scope: TeamScope | null;
  /** Shown as the filter ("Hamza Sheikh's team"). */
  label: string;
  /** Which definition was used, in words. */
  definition: string;
  /** People counted as the team (hours, activity, day view). */
  userIds: Set<string>;
  /** Tasks that belong to the team. */
  matchFact: (f: TaskFact) => boolean;
  /** For a person's team: the definitions the user can switch to. */
  scopes: Array<{ value: TeamScope; label: string }> | null;
}

/** The people `personId` assigned tasks to recently (created by them, someone else doing it). */
async function assignees(personId: string): Promise<Set<string>> {
  const since = new Date(Date.now() - ASSIGNED_LOOKBACK_DAYS * 86_400_000);
  const ids = await Task.distinct("assignees", { assignedBy: new mongoose.Types.ObjectId(personId), createdAt: { $gte: since } });
  return new Set(ids.map(String).filter((id) => id !== personId));
}

/** People on the same manpower plan lines as `personId` this month (incl. them). */
async function planMates(personId: string): Promise<Set<string>> {
  const plan = await latestPlan(currentMonth());
  const mates = new Set<string>([personId]);
  for (const row of plan?.rows ?? []) {
    const people = row.cells.flatMap((c) => c.users.map(String));
    if (people.includes(personId)) people.forEach((id) => mates.add(id));
  }
  return mates;
}

const usersOfDepartment = (ref: RefData, departmentId: string) => new Set([...ref.users].filter(([, u]) => u.department === departmentId).map(([id]) => id));

/** Resolves a `team` filter: a department, else a person's team (see TEAM_SCOPES). */
export async function resolveTeam(ref: RefData, query: string, scope?: TeamScope): Promise<TeamFilter> {
  const name = query.replace(/(?:'s|’s|s')?\s+team$/i, "").trim() || query.trim();
  const departments = [...ref.departments].map(([id, n]) => ({ id, names: [n], label: n }));
  const people = [...ref.users].map(([id, u]) => ({ id, names: [u.name], label: u.name }));
  const tryMatch = <T>(fn: () => T): T | null => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof ToolInputError) return null;
      throw err;
    }
  };
  // A department by its name first (no sound-alikes: "Hamza" must not become a department).
  const department = tryMatch(() => matchName("team", name, departments, false));
  if (department) {
    const users = usersOfDepartment(ref, department.id);
    return {
      kind: "department",
      departmentId: department.id,
      personId: null,
      scope: null,
      label: department.label,
      definition: `the ${department.label} department`,
      userIds: users,
      matchFact: (f) => f.doers.some((d) => users.has(d)),
      scopes: null,
    };
  }
  let person: { id: string; label: string } | null = null;
  try {
    person = matchName("person", name, people);
  } catch (err) {
    if (!(err instanceof ToolInputError)) throw err;
    if (err.suggestions.length && /several/.test(err.message)) throw err;
    // Nothing close: offer the teams themselves, so the answer is never a dead end.
    const close = [...closestNames(name, people, 4), ...closestNames(name, departments, 3)];
    const suggestions = close.length ? close : departments.map((d) => d.label).sort().slice(0, 8);
    throw new ToolInputError(`No team or person matches "${query}". ${close.length ? "Closest" : "Teams"}: ${suggestions.join(", ")}.`, suggestions);
  }
  const first = person.label.split(" ")[0]!;
  const departmentId = ref.users.get(person.id)?.department ?? null;
  const departmentName = departmentId ? (ref.departments.get(departmentId) ?? "their department") : "no department";
  const s: TeamScope = scope ?? "owned_or_assigned";
  const pid = person.id;
  let users: Set<string>;
  let match: (f: TaskFact) => boolean;
  let definition: string;
  switch (s) {
    case "own":
      users = new Set([pid]);
      match = (f) => f.doers.includes(pid);
      definition = `only ${first}'s own tasks (assigned to ${first})`;
      break;
    case "assigned":
      users = await assignees(pid);
      match = (f) => f.briefer === pid && !(f.doers.length === 1 && f.doers[0] === pid);
      definition = `tasks ${first} created / assigned to others`;
      break;
    case "department":
      users = departmentId ? usersOfDepartment(ref, departmentId) : new Set([pid]);
      match = (f) => f.doers.some((d) => users.has(d));
      definition = `${first}'s department (${departmentName})`;
      break;
    case "projects":
      users = await planMates(pid);
      match = (f) => f.doers.some((d) => users.has(d));
      definition = `people on ${first}'s manpower plan lines this month`;
      break;
    default:
      users = new Set([pid, ...(await assignees(pid))]);
      match = (f) => f.doers.includes(pid) || f.briefer === pid;
      definition = `tasks ${first} owns or assigned to others (and the people doing them)`;
  }
  return {
    kind: "person",
    departmentId,
    personId: pid,
    scope: s,
    label: `${person.label}'s team`,
    definition,
    userIds: users,
    matchFact: match,
    scopes: [
      { value: "owned_or_assigned", label: `Tasks ${first} owns or assigned` },
      { value: "own", label: `Only ${first}'s own tasks` },
      { value: "assigned", label: `Tasks ${first} assigned` },
      { value: "department", label: `${first}'s department (${departmentName})` },
      { value: "projects", label: `People on ${first}'s projects` },
    ],
  };
}

/** What a tool result says about the team filter used. */
export const teamInfo = (t: TeamFilter | null) =>
  t ? { team: { name: t.label, definition: t.definition, ...(t.kind === "person" ? { scope: t.scope, scopes: t.scopes, people: t.userIds.size } : {}) } } : {};
