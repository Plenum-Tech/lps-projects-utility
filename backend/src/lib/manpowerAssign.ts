import { Brand } from "../models/Brand.js";
import { APPROVED_PLAN, ManpowerPlan, latestPlan } from "../models/ManpowerPlan.js";
import type { IProject } from "../models/Project.js";
import type { IUser } from "../models/User.js";
import { isGuestUser } from "./guests.js";
import { linkProjectsToRows } from "./manpower/match.js";
import { currentAppMonth } from "./projectExpiry.js";

// ---------------------------------------------------------------------------
// Tasks go only to people on the manpower plan (Nov 2026): a task on a brand's project can be
// assigned to someone who is on the project's plan line, on another line of the brand, or on a
// line of the same organisation (sister brands), in the plan in use today — the month's latest
// approved version. Anyone else has to be added to the manpower plan first (a plan change needs
// leadership approval), then the task can be assigned.
// No exceptions for staff. Held back until leadership says go: on only when the server has
// ASSIGN_ON_PLAN_ONLY=true (nothing in the app turns it on or off). Not checked: tasks without a project or brand, and
// outside guests (clients / freelancers, who are never on a manpower plan).
// ---------------------------------------------------------------------------

type Invalid = { status: number; error: string };

const monthLabel = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });

/** The people who may be given tasks on the project, and the plan they come from; null = the rule doesn't apply. */
export async function planTeamOf(project: Pick<IProject, "_id" | "name" | "brand" | "naming" | "deadline" | "manpowerRow" | "activeThrough">): Promise<{
  users: Set<string>;
  plan: string;
  brand: string;
  inPlan: boolean;
} | null> {
  // Not switched on yet: the rule waits for leadership's go-ahead (server setting ASSIGN_ON_PLAN_ONLY=true).
  if (process.env.ASSIGN_ON_PLAN_ONLY !== "true") return null;
  if (!project.brand) return null;
  const month = currentAppMonth();
  const plan = (await latestPlan(month)) ?? (await ManpowerPlan.findOne({ month: { $lt: month }, ...APPROVED_PLAN }).sort({ month: -1, version: -1 }));
  if (!plan) return null;

  const brandId = String(project.brand);
  const brands = await Brand.find({}).select("name organisation").lean<Array<{ _id: unknown; name: string; organisation?: string }>>();
  const orgOf = new Map(brands.map((b) => [String(b._id), (b.organisation || b.name || "").trim().toLowerCase()]));
  const brandNames = new Map(brands.map((b) => [String(b._id), b.name]));
  const rows = plan.rows.map((r) => ({
    key: r.key,
    brand: r.brand ? String(r.brand) : null,
    type: r.type ?? null,
    name: r.name,
    users: r.cells.flatMap((c) => c.users.map(String)),
  }));

  const users = new Set<string>();
  // The project's own line.
  const link = linkProjectsToRows(
    plan.month,
    rows.map((r) => ({ key: r.key, brand: r.brand, type: r.type, name: r.name })),
    [
      {
        _id: String(project._id),
        name: project.name,
        brand: brandId,
        naming: project.naming ? { type: project.naming.type, month: project.naming.month, title: project.naming.title } : null,
        deadline: project.deadline ?? null,
        manpowerRow: project.manpowerRow ?? null,
        activeThrough: project.activeThrough ?? null,
      },
    ],
    brandNames
  ).get(String(project._id));
  for (const r of rows) if (r.key === link) for (const u of r.users) users.add(u);
  // The brand's lines, and the lines of its organisation (sister brands).
  const org = orgOf.get(brandId);
  let inPlan = false;
  for (const r of rows) {
    if (!r.brand) continue;
    if (r.brand === brandId) inPlan = true;
    if (r.brand === brandId || (org && orgOf.get(r.brand) === org)) for (const u of r.users) users.add(u);
  }
  return { users, plan: `${monthLabel(plan.month)} v${plan.version}`, brand: brandNames.get(brandId) ?? "this brand", inPlan };
}

/** Refuses assignees who aren't on the manpower plan for the project's brand. Null = fine. */
export async function offPlanAssignees(project: IProject | null | undefined, assignees: IUser[]): Promise<Invalid | null> {
  if (!project || assignees.length === 0) return null;
  const team = await planTeamOf(project);
  if (!team) return null;
  const off = assignees.filter((u) => !isGuestUser(u) && !team.users.has(String(u._id)));
  if (off.length === 0) return null;
  const names = off.map((u) => u.name).join(", ");
  return {
    status: 409,
    error: team.inPlan
      ? `${names} ${off.length === 1 ? "isn't" : "aren't"} on the manpower plan for ${team.brand} (${team.plan}). Add them to the manpower plan first — the change needs leadership approval — then assign the task.`
      : `${team.brand} has no line in the manpower plan (${team.plan}), so nobody can be given its tasks yet. Add the brand and its team to the manpower plan first — the change needs leadership approval.`,
  };
}
