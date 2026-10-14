import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { APPROVED_PLAN, ManpowerPlan, type IManpowerCell, type IManpowerRow } from "../models/ManpowerPlan.js";
import { Brand } from "../models/Brand.js";
import type { IProject } from "../models/Project.js";
import type { IUser } from "../models/User.js";
import { Project } from "../models/Project.js";
import { logActivity } from "./activityLog.js";
import { linkProjectsToRows } from "./manpower/match.js";
import { MANPOWER_ROLE_KEYS } from "./manpowerRoles.js";
import { projectMonth } from "./projectExpiry.js";

// ---------------------------------------------------------------------------
// The manpower plan and project teams are linked both ways:
//  - project → plan (here): a project's team is copied onto its plan line in
//    the latest approved plan of its month, saved as a new plan version (a
//    project without a line gets one);
//  - plan → projects (controllers/manpower.ts syncPlanToProjects): an approved
//    plan change updates the teams of the projects linked to the changed lines.
// ---------------------------------------------------------------------------

type TeamEntry = { role: string; users: Array<mongoose.Types.ObjectId | string> };

const ids = (users: Array<mongoose.Types.ObjectId | string>) => users.map(String).sort().join(",");

/** The plan line's cells with the team's people (plan roles only); placeholders / notes are kept. */
export function cellsFromTeam(current: IManpowerCell[], team: TeamEntry[]): IManpowerCell[] {
  const byRole = new Map(team.filter((t) => MANPOWER_ROLE_KEYS.includes(t.role)).map((t) => [t.role, t.users]));
  const out: IManpowerCell[] = [];
  const seen = new Set<string>();
  for (const cell of current) {
    seen.add(cell.role);
    const users = byRole.get(cell.role) ?? [];
    out.push({ ...cell, users: users.map((u) => new mongoose.Types.ObjectId(String(u))), notNeeded: users.length ? false : cell.notNeeded });
  }
  for (const [role, users] of byRole) {
    if (seen.has(role) || users.length === 0) continue;
    out.push({ role, users: users.map((u) => new mongoose.Types.ObjectId(String(u))), placeholders: [], notNeeded: false, note: "" });
  }
  return out;
}

/** People per role of a plan line (for comparing). */
export function rowPeopleKey(cells: IManpowerCell[]): string {
  return cells
    .filter((c) => (c.users ?? []).length)
    .map((c) => `${c.role}:${ids(c.users)}`)
    .sort()
    .join("|");
}

/**
 * Project → plan: copies `project`'s team onto its line of the month's plan
 * (new version). No plan for the month = nothing to do.
 */
export async function syncProjectTeamToPlan(project: IProject, actor: IUser): Promise<void> {
  try {
    const month = project.naming?.month ?? projectMonth({ name: project.name, naming: project.naming ?? undefined, deadline: project.deadline ?? null } as never);
    if (!month) return;
    const [plan, highest] = await Promise.all([
      ManpowerPlan.findOne({ month, ...APPROVED_PLAN }).sort({ version: -1 }).lean(),
      ManpowerPlan.findOne({ month }).sort({ version: -1 }).select("version").lean(),
    ]);
    if (!plan) return;
    const rows = plan.rows as IManpowerRow[];
    const brand = project.naming?.brand ?? project.brand ?? null;

    let key = project.manpowerRow && rows.some((r) => r.key === project.manpowerRow) ? project.manpowerRow : null;
    if (!key) {
      const brands = await Brand.find({}).select("name").lean();
      const links = linkProjectsToRows(
        month,
        rows.map((r) => ({ key: r.key, brand: r.brand ? String(r.brand) : null, type: r.type, name: r.name })),
        [{
          _id: String(project._id),
          name: project.name,
          brand: brand ? String(brand) : null,
          naming: project.naming ? { type: project.naming.type, month: project.naming.month, title: project.naming.title } : null,
          deadline: project.deadline ?? null,
        }],
        new Map(brands.map((b) => [String(b._id), b.name]))
      );
      key = links.get(String(project._id)) ?? null;
    }

    const team = (project.team ?? []) as TeamEntry[];
    let created = false;
    let nextRows: IManpowerRow[];
    if (key) {
      const row = rows.find((r) => r.key === key)!;
      const cells = cellsFromTeam(row.cells, team);
      if (rowPeopleKey(cells) === rowPeopleKey(row.cells)) return;
      nextRows = rows.map((r) => (r.key === key ? { ...r, cells } : r));
    } else {
      if (!team.some((t) => t.users.length && MANPOWER_ROLE_KEYS.includes(t.role))) return;
      key = randomUUID();
      created = true;
      nextRows = [
        ...rows,
        {
          key,
          section: "active",
          brand: brand as mongoose.Types.ObjectId | null,
          type: project.naming?.type ?? null,
          name: (project.naming?.title ?? project.name).slice(0, 80),
          cells: cellsFromTeam([], team),
        },
      ];
    }

    const saved = await ManpowerPlan.create({
      month,
      version: (highest?.version ?? plan.version) + 1,
      rows: nextRows,
      note: `Team of ${project.name} updated on the project`,
      maxProjectsPerPerson: plan.maxProjectsPerPerson,
      source: "edit",
      status: "approved",
      createdBy: actor._id,
    });
    if (created) await Project.updateOne({ _id: project._id }, { $set: { manpowerRow: key } });
    logActivity({
      action: "settings_updated",
      actor,
      targetType: "manpower_plan",
      targetId: saved._id as mongoose.Types.ObjectId,
      targetName: `Manpower plan ${month} v${saved.version}`,
      details: { month, version: saved.version, fromProject: String(project._id), line: created ? "added" : "updated" },
    });
  } catch (err) {
    console.error("[manpower] project → plan sync failed", String(project._id), err);
  }
}
