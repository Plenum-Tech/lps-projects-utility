import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { APPROVED_PLAN, ManpowerPlan, type IManpowerCell, type IManpowerRow } from "../models/ManpowerPlan.js";
import { Brand } from "../models/Brand.js";
import type { IProject } from "../models/Project.js";
import type { IUser } from "../models/User.js";
import { Project } from "../models/Project.js";
import { logActivity } from "./activityLog.js";
import { isLeadershipActor } from "./changeRequests.js";
import { linkProjectsToRows } from "./manpower/match.js";
import { cellsWithTeam, reusableLine } from "./manpowerDedupe.js";
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

/**
 * The team of a (new) project from its brand's line in the month's plan: the line
 * picked on the project, else the automatic match (lib/manpower/match.ts — the
 * same as GET /api/manpower/suggest). Plan roles with people only. The latest
 * approved version is used; `includePending` also takes a newer pending version
 * (the monthly retainer job builds projects on the plan copy it just wrote).
 */
export async function planTeamForProject(
  input: { brand: mongoose.Types.ObjectId | string; month: string; type?: string | null; title?: string | null; name: string; manpowerRow?: string | null },
  options: { includePending?: boolean } = {}
): Promise<{ team: Array<{ role: string; users: mongoose.Types.ObjectId[] }>; rowKey: string | null; version: number | null }> {
  const none = { team: [], rowKey: null, version: null };
  const filter: Record<string, unknown> = options.includePending ? { month: input.month, status: { $nin: ["rejected", "superseded"] } } : { month: input.month, ...APPROVED_PLAN };
  const plan = await ManpowerPlan.findOne(filter as never).sort({ version: -1 }).lean();
  if (!plan) return none;
  const rows = plan.rows as IManpowerRow[];
  let key = input.manpowerRow && rows.some((r) => r.key === input.manpowerRow) ? input.manpowerRow : null;
  if (!key) {
    const brandId = String(input.brand);
    const brand = await Brand.findById(brandId).select("name").lean();
    const links = linkProjectsToRows(
      input.month,
      rows.map((r) => ({ key: r.key, brand: r.brand ? String(r.brand) : null, type: r.type, name: r.name })),
      [{
        _id: "candidate",
        name: input.name,
        brand: brandId,
        naming: { type: input.type ?? "", month: input.month, title: input.title ?? "" },
        deadline: null,
      }],
      new Map([[brandId, brand?.name ?? ""]])
    );
    key = links.get("candidate") ?? null;
  }
  const row = key ? rows.find((r) => r.key === key) : undefined;
  if (!row) return none;
  const team = row.cells
    .filter((c) => (c.users ?? []).length && MANPOWER_ROLE_KEYS.includes(c.role))
    .map((c) => ({ role: c.role, users: c.users.map((u) => new mongoose.Types.ObjectId(String(u))) }));
  return { team, rowKey: row.key, version: plan.version };
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
    // A carried project's team belongs to the latest month it runs in (activeThrough).
    const month = project.activeThrough ?? project.naming?.month ?? projectMonth({ name: project.name, naming: project.naming ?? undefined, deadline: project.deadline ?? null } as never);
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
          activeThrough: project.activeThrough ?? null,
        }],
        new Map(brands.map((b) => [String(b._id), b.name]))
      );
      key = links.get(String(project._id)) ?? null;
    }

    const team = (project.team ?? []) as TeamEntry[];
    let created = false;
    let pinTo: string | null = null;
    let nextRows: IManpowerRow[];
    if (key) {
      const row = rows.find((r) => r.key === key)!;
      const cells = cellsFromTeam(row.cells, team);
      if (rowPeopleKey(cells) === rowPeopleKey(row.cells)) return;
      nextRows = rows.map((r) => (r.key === key ? { ...r, cells } : r));
    } else {
      if (!team.some((t) => t.users.length && MANPOWER_ROLE_KEYS.includes(t.role))) return;
      // A brand's line carries the brand's name (lib/manpowerLineNames.ts).
      const name = (brand ? ((await Brand.findById(brand).select("name").lean())?.name ?? project.naming?.title ?? project.name) : (project.naming?.title ?? project.name)).slice(0, 80);
      // No duplicate lines: the brand's line with the same name (or its only line) is reused —
      // the project's people are added to it (nobody on it is taken off) and the project is pinned to it.
      const existing = reusableLine(rows, brand, name);
      if (existing) {
        const cells = cellsWithTeam(existing.cells, team);
        pinTo = existing.key;
        if (rowPeopleKey(cells) === rowPeopleKey(existing.cells)) {
          await Project.updateOne({ _id: project._id }, { $set: { manpowerRow: existing.key } });
          return;
        }
        key = existing.key;
        nextRows = rows.map((r) => (r.key === existing.key ? { ...r, cells } : r));
      } else {
        key = randomUUID();
        created = true;
        nextRows = [
          ...rows,
          { key, section: "active", brand: brand as mongoose.Types.ObjectId | null, type: project.naming?.type ?? null, name, cells: cellsFromTeam([], team) },
        ];
      }
    }
    if (created) pinTo = key;

    // Only leadership's changes go live on the plan; anyone else's become a pending
    // version for leadership to approve (the shared save path, with its email).
    if (!(await isLeadershipActor(actor))) {
      const { writePlanVersion } = await import("../controllers/manpower.js");
      await writePlanVersion({
        month,
        before: rows,
        latestVersion: plan.version,
        rows: nextRows,
        note: `Team of ${project.name} updated on the project`,
        maxProjectsPerPerson: plan.maxProjectsPerPerson,
        source: "edit",
        actor,
      });
      // A new line is pinned now (a key the plan doesn't have yet is ignored until approved).
      if (pinTo) await Project.updateOne({ _id: project._id }, { $set: { manpowerRow: pinTo } });
      return;
    }
    // A brand's same-named lines become one (the line just edited is kept); pinned projects follow it.
    const { dropDuplicateLinesOnSave } = await import("./manpowerDedupe.js");
    const deduped = await dropDuplicateLinesOnSave(month, rows, nextRows);
    nextRows = deduped.rows;
    if (pinTo && deduped.repin.has(pinTo)) pinTo = deduped.repin.get(pinTo)!;
    const { markPlanNoticeBase } = await import("./manpowerNotice.js");
    await markPlanNoticeBase(month);
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
    if (pinTo) await Project.updateOne({ _id: project._id }, { $set: { manpowerRow: pinTo } });
    for (const [from, to] of deduped.repin) await Project.updateMany({ manpowerRow: from }, { $set: { manpowerRow: to } });
    // A version waiting for approval is carried onto this approved one (its changes aren't lost).
    const { rebasePendingPlan } = await import("../controllers/manpower.js");
    await rebasePendingPlan(month, { version: saved.version, rows: nextRows }, actor, undefined, rows);
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
