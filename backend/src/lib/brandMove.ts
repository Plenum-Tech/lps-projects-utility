import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { Brand, type IBrand } from "../models/Brand.js";
import { ManpowerPlan, latestPlan, type IManpowerCell, type IManpowerRow } from "../models/ManpowerPlan.js";
import { Project, type IProject } from "../models/Project.js";
import type { IUser } from "../models/User.js";
import { logActivity } from "./activityLog.js";
import { exactNameRegex } from "./pagination.js";
import { brandLocksScope } from "./brandFlow.js";
import { canCreateBrand } from "./brandAccess.js";
import { isLeadershipActor, notifyException, requestChange, type ExceptionEntry } from "./changeRequests.js";
import { linkProjectsToRows } from "./manpower/match.js";
import { cellsFromTeam } from "./manpowerSync.js";
import { renamedLineName } from "./manpowerLineNames.js";
import { canManageProject, recordProjectActivity } from "./projectAccess.js";
import { currentAppMonth, projectMonth } from "./projectExpiry.js";
import { composeProjectName, NAMING_SEPARATOR, parseStructuredName, tidy } from "./projectNaming.js";
import { scheduleProjectTag } from "./tagAssign.js";

// ---------------------------------------------------------------------------
// Moving projects between existing brands (brand page → "Move to another brand…",
// or the project form's brand field), and what follows a brand rename.
//
// A move: the project's brand and naming brand change, a structured name gets the
// new brand (the code stays), its manpower plan line follows (relinked to the
// target brand's line of the month, the old line moved when only moved projects
// use it, else a new line), and the target brand's scope / files / platforms /
// notes replace the project's when the target has a scope (updateProjectCore's
// brand-change path). Leadership moves at once (approvers are told); brand
// creators and the projects' managers send a "project_move" change request.
// ---------------------------------------------------------------------------

/** The brand part of a free-form name that follows `Brand_Type_MonYYYY_Title`, replaced; else null. */
function replaceBrandPart(name: string, oldBrand: string, newBrand: string): string | null {
  const parsed = parseStructuredName(name);
  if (!parsed || parsed.brand.toLowerCase() !== tidy(oldBrand).toLowerCase()) return null;
  const rest = name.slice(name.indexOf(NAMING_SEPARATOR));
  return `${tidy(newBrand)}${rest}`;
}

/** A project's name once its brand is `newBrand` (structured names only; others unchanged). */
export function nameWithBrand(project: Pick<IProject, "name" | "naming">, oldBrand: string, newBrand: string): string {
  if (project.naming) return composeProjectName(newBrand, project.naming.type, project.naming.month, project.naming.title);
  return replaceBrandPart(project.name, oldBrand, newBrand) ?? project.name;
}

// --------------------------------------------------------------------- move

export type LineAction = "relink" | "move" | "new" | "none";

export interface MoveItem {
  projectId: string;
  code: string;
  oldName: string;
  newName: string;
  /** Structured names: the title used (the project's own, or numbered when the new name is taken). */
  title: string | null;
  type: string | null;
  month: string | null;
  /** The target brand's scope replaces the project's ("replace"), or the project keeps its own ("keep"). */
  scope: "replace" | "keep";
  line: { action: LineAction; key: string | null; name: string | null; from: string | null };
}

export interface MovePlan {
  from: { _id: string; name: string };
  to: { _id: string; name: string; hasScope: boolean };
  items: MoveItem[];
  /** Per month: the plan rows to write (only months whose lines change). */
  writes: Array<{ month: string; before: IManpowerRow[]; rows: IManpowerRow[]; latestVersion: number; max: number }>;
  notes: string[];
}

type LeanProject = Pick<IProject, "name" | "code" | "brand" | "naming" | "deadline" | "manpowerRow" | "team"> & { _id: mongoose.Types.ObjectId };

/** Open projects of `fromId` among `ids`, or an error when some aren't. */
export async function moveCandidates(fromId: mongoose.Types.ObjectId, ids: string[]): Promise<LeanProject[] | { error: string }> {
  const unique = [...new Set(ids.map(String))];
  if (unique.length === 0) return { error: "Tick the projects to move" };
  if (unique.length > 100) return { error: "Move at most 100 projects at a time" };
  if (unique.some((id) => !mongoose.isValidObjectId(id))) return { error: "projectIds must be project IDs" };
  const projects = await Project.find({
    _id: { $in: unique },
    archivedAt: null,
    $or: [{ brand: fromId }, { "naming.brand": fromId }],
  })
    .select("name code brand naming deadline manpowerRow activeThrough team")
    .lean<LeanProject[]>();
  if (projects.length !== unique.length) return { error: "Some of those projects aren't open projects of this brand" };
  return projects;
}

const linkRow = (r: IManpowerRow) => ({ key: r.key, brand: r.brand ? String(r.brand) : null, type: r.type, name: r.name });

/**
 * What a move does (no writes): each project's new name, scope and plan line, and
 * the plan rows to write per month. Recomputed when the move is applied.
 */
export async function planBrandMove(from: IBrand, target: IBrand, projects: LeanProject[]): Promise<MovePlan> {
  const fromId = String(from._id);
  const toId = String(target._id);
  const hasScope = brandLocksScope(target);
  const plan: MovePlan = {
    from: { _id: fromId, name: from.name },
    to: { _id: toId, name: target.name, hasScope },
    items: [],
    writes: [],
    notes: [],
  };
  const movedIds = new Set(projects.map((p) => String(p._id)));
  const monthOf = (p: LeanProject) => projectMonth({ name: p.name, naming: p.naming as never, deadline: p.deadline ?? null } as never);
  const byMonth = new Map<string, LeanProject[]>();
  for (const p of projects) {
    const m = monthOf(p);
    if (m) byMonth.set(m, [...(byMonth.get(m) ?? []), p]);
  }
  const lineOf = new Map<string, MoveItem["line"]>();
  if (byMonth.size) {
    const [all, brands] = await Promise.all([
      Project.find({ archivedAt: null }).select("name brand naming deadline manpowerRow activeThrough").lean(),
      Brand.find({}).select("name").lean(),
    ]);
    const brandNames = new Map(brands.map((b) => [String(b._id), b.name]));
    for (const [month, list] of byMonth) {
      const live = await latestPlan(month);
      if (!live) {
        for (const p of list) lineOf.set(String(p._id), { action: "none", key: null, name: null, from: null });
        continue;
      }
      const rows = live.toObject().rows as IManpowerRow[];
      const next = rows.map((r) => ({ ...r, cells: r.cells.map((c) => ({ ...c })) }));
      // Links as they are now (before the move).
      const links = linkProjectsToRows(
        month,
        rows.map(linkRow),
        all.map((p) => ({
          _id: String(p._id),
          name: p.name,
          brand: p.brand ? String(p.brand) : p.naming?.brand ? String(p.naming.brand) : null,
          naming: p.naming ? { type: p.naming.type, month: p.naming.month, title: p.naming.title } : null,
          deadline: p.deadline ?? null,
          manpowerRow: p.manpowerRow ?? null,
          activeThrough: (p as { activeThrough?: string | null }).activeThrough ?? null,
        })),
        brandNames
      );
      const linkedTo = new Map<string, string[]>();
      for (const [pid, key] of links) linkedTo.set(key, [...(linkedTo.get(key) ?? []), pid]);
      let changed = false;
      for (const p of list) {
        const pid = String(p._id);
        const newName = nameWithBrand(p, from.name, target.name);
        const targetRows = next.filter((r) => String(r.brand ?? "") === toId);
        const oldKey = links.get(pid) ?? null;
        const oldRow = oldKey ? next.find((r) => r.key === oldKey) : undefined;
        // 1. The target brand's line of the month (the automatic match, else its only / first line).
        if (targetRows.length) {
          const sim = linkProjectsToRows(
            month,
            targetRows.map(linkRow),
            [{ _id: pid, name: newName, brand: toId, naming: p.naming ? { type: p.naming.type, month: p.naming.month, title: p.naming.title } : null, deadline: p.deadline ?? null }],
            new Map([[toId, target.name]])
          );
          const key = sim.get(pid) ?? targetRows[0]!.key;
          lineOf.set(pid, { action: "relink", key, name: next.find((r) => r.key === key)!.name, from: oldRow?.name ?? null });
          continue;
        }
        // 2. The project's own line moves with it when only moved projects use it.
        if (oldRow && String(oldRow.brand ?? "") === fromId && (linkedTo.get(oldRow.key) ?? []).every((id) => movedIds.has(id))) {
          const fromName = oldRow.name;
          oldRow.brand = new mongoose.Types.ObjectId(toId);
          oldRow.name = renamedLineName(oldRow.name, from.name, target.name);
          changed = true;
          lineOf.set(pid, { action: "move", key: oldRow.key, name: oldRow.name, from: fromName });
          continue;
        }
        // 3. A new line for the target brand (the project's team, else its old line's people).
        const team = (p.team ?? []) as Array<{ role: string; users: mongoose.Types.ObjectId[] }>;
        let cells: IManpowerCell[] = cellsFromTeam([], team);
        if (!cells.some((c) => c.users.length) && oldRow) cells = oldRow.cells.map((c) => ({ ...c, users: [...c.users], placeholders: [...c.placeholders] }));
        const row: IManpowerRow = {
          key: randomUUID(),
          section: oldRow?.section ?? (p.naming?.type?.toLowerCase() === "pitch" ? "pitch" : "active"),
          brand: new mongoose.Types.ObjectId(toId),
          type: null,
          name: target.name.slice(0, 80),
          cells,
        };
        next.push(row);
        changed = true;
        lineOf.set(pid, { action: "new", key: row.key, name: row.name, from: oldRow?.name ?? null });
        if (oldRow && (linkedTo.get(oldRow.key) ?? []).some((id) => !movedIds.has(id))) {
          plan.notes.push(`${oldRow.name} (${month}) stays on ${from.name}: other projects still use it.`);
        }
      }
      if (changed) plan.writes.push({ month, before: rows, rows: next, latestVersion: live.version, max: live.maxProjectsPerPerson });
    }
  }
  // Open projects' names are unique: a new name another open project already has gets a number
  // ("…_Launch 2") instead of failing the move.
  const taken = new Map(
    (await Project.find({ archivedAt: null, _id: { $nin: [...movedIds].map((id) => new mongoose.Types.ObjectId(id)) } }).select("name code").lean()).map((o) => [
      o.name.toLowerCase(),
      o.code,
    ])
  );
  for (const p of projects) {
    const pid = String(p._id);
    let title = p.naming?.title ?? null;
    let newName = nameWithBrand(p, from.name, target.name);
    const usedBy = taken.get(newName.toLowerCase());
    if (usedBy) {
      for (let n = 2; taken.has(newName.toLowerCase()); n++) {
        if (p.naming) {
          title = `${p.naming.title} ${n}`;
          newName = composeProjectName(target.name, p.naming.type, p.naming.month, title);
        } else {
          newName = `${nameWithBrand(p, from.name, target.name)} (${n})`;
        }
      }
      plan.notes.push(`${p.code}: "${nameWithBrand(p, from.name, target.name)}" is already used by ${usedBy} — renamed "${newName}".`);
    }
    taken.set(newName.toLowerCase(), p.code);
    plan.items.push({
      projectId: pid,
      code: p.code,
      oldName: p.name,
      newName,
      title,
      type: p.naming?.type ?? null,
      month: monthOf(p),
      scope: hasScope ? "replace" : "keep",
      line: lineOf.get(pid) ?? { action: "none", key: null, name: null, from: null },
    });
  }
  plan.items.sort((a, b) => a.oldName.localeCompare(b.oldName));
  plan.notes = [...new Set(plan.notes)];
  return plan;
}

/** Who may move these projects: "apply" (leadership), "request" (brand creators, the projects' managers) or null. */
export async function moveAccess(user: IUser, projects: Array<Pick<IProject, "manager" | "createdBy">>): Promise<"apply" | "request" | null> {
  if (await isLeadershipActor(user)) return "apply";
  if (canCreateBrand(user)) return "request";
  if (projects.length && projects.every((p) => canManageProject(user, p as never))) return "request";
  return null;
}

/** Target brand checks: approved, active, not the source, no "_" in its name. */
export function targetError(from: IBrand, target: IBrand | null): string | null {
  if (!target) return "Target brand not found";
  if (String(target._id) === String(from._id)) return "Pick a different brand";
  if (target.status && target.status !== "approved") return "That brand isn't approved yet";
  if (!target.active) return "That brand is inactive";
  if (target.name.includes(NAMING_SEPARATOR)) return `The brand name "${target.name}" contains "_" — rename it first`;
  return null;
}

const SCOPE_TEXT = (plan: MovePlan) => (plan.to.hasScope ? `Replaced by ${plan.to.name}'s scope` : `Kept (${plan.to.name} has no scope)`);
const LINE_TEXT = (line: MoveItem["line"]) =>
  line.action === "relink"
    ? `${line.name}`
    : line.action === "move"
      ? `${line.from} moves with it${line.name !== line.from ? ` (as ${line.name})` : ""}`
      : line.action === "new"
        ? `New line ${line.name}`
        : "No plan for its month";

/** Sends the move to leadership (one change request per move). */
export async function requestBrandMove(plan: MovePlan, actor: IUser, ip?: string) {
  const changes = plan.items.flatMap((i) => [
    { label: `${i.code} · project`, before: `${i.oldName} (${plan.from.name})`, after: `${i.newName} (${plan.to.name})` },
    { label: `${i.code} · plan line`, before: i.line.from ?? "—", after: LINE_TEXT(i.line) },
  ]);
  changes.push({ label: "Scope", before: "Project's own scope", after: SCOPE_TEXT(plan) });
  return requestChange({
    kind: "project_move",
    actor,
    title: `Move ${plan.items.length} project${plan.items.length === 1 ? "" : "s"} from ${plan.from.name} to ${plan.to.name}`,
    changes,
    payload: { from: plan.from._id, to: plan.to._id, projectIds: plan.items.map((i) => i.projectId) },
    brand: new mongoose.Types.ObjectId(plan.from._id),
    project: plan.items.length === 1 ? new mongoose.Types.ObjectId(plan.items[0]!.projectId) : null,
    ip,
  });
}

export interface MoveResult {
  moved: number;
  items: MoveItem[];
  plans: Array<{ month: string; version: number; pendingApproval?: string }>;
  notes: string[];
  errors: string[];
}

/**
 * Applies a move (leadership, or leadership approving a request): projects first (pinned to
 * their new line), then the plan versions (leadership's saves are approved at once).
 * `notify`: tell the approvers (a direct move by leadership).
 */
export async function applyBrandMove(
  fromId: mongoose.Types.ObjectId | string,
  targetId: mongoose.Types.ObjectId | string,
  projectIds: string[],
  actor: IUser,
  ip: string | undefined,
  options: { notify?: boolean } = {}
): Promise<MoveResult | { error: string; status?: number }> {
  const [from, target] = await Promise.all([Brand.findById(fromId), Brand.findById(targetId)]);
  if (!from) return { error: "The brand no longer exists", status: 404 };
  const bad = targetError(from, target);
  if (bad) return { error: bad, status: 400 };
  const candidates = await moveCandidates(from._id as mongoose.Types.ObjectId, projectIds);
  if ("error" in candidates) return { error: candidates.error, status: 400 };
  const plan = await planBrandMove(from, target!, candidates);
  const result: MoveResult = { moved: 0, items: plan.items, plans: [], notes: [...plan.notes], errors: [] };
  const { updateProjectCore } = await import("../controllers/projects.js");
  const exceptions: ExceptionEntry[] = [];
  for (const item of plan.items) {
    const project = await Project.findById(item.projectId);
    if (!project) continue;
    const body: Record<string, unknown> = { manpowerRow: item.line.key };
    if (project.naming) {
      body.naming = { brand: String(target!._id), type: project.naming.type, month: project.naming.month, title: item.title ?? project.naming.title };
    } else {
      body.brand = String(target!._id);
      if (item.newName !== project.name) body.name = item.newName;
    }
    const scopeBefore = project.scopeItems?.length ?? 0;
    const updated = await updateProjectCore(actor, project, body as never, ip, {
      skipApproval: true,
      skipPermission: true,
      activityExtra: { movedFrom: from.name, movedTo: target!.name },
    });
    if ("error" in updated) {
      result.errors.push(`${item.code}: ${updated.error}`);
      continue;
    }
    result.moved++;
    recordProjectActivity(project._id as mongoose.Types.ObjectId, actor, "brand_moved", {
      from: from.name,
      to: target!.name,
      oldName: item.oldName,
      newName: project.name,
      line: item.line.name,
      scope: item.scope,
    });
    scheduleProjectTag(project._id as mongoose.Types.ObjectId, true);
    exceptions.push({
      project: { _id: project._id, name: project.name, code: project.code },
      details: [
        ["Brand", `${from.name} → ${target!.name}`],
        ...(item.oldName !== project.name ? [["Name", `${item.oldName} → ${project.name}`] as [string, string]] : []),
        ["Scope", item.scope === "replace" ? `${scopeBefore} row(s) replaced by ${target!.name}'s scope` : "Kept"],
        ["Plan line", LINE_TEXT(item.line)],
      ],
    });
  }
  // Only months whose moved projects actually moved.
  if (result.moved) {
    const { writePlanVersion } = await import("../controllers/manpower.js");
    for (const w of plan.writes) {
      try {
        const saved = await writePlanVersion({
          month: w.month,
          before: w.before,
          latestVersion: w.latestVersion,
          rows: w.rows,
          note: `Projects moved from ${from.name} to ${target!.name}`,
          maxProjectsPerPerson: w.max,
          source: "edit",
          actor,
          ip,
        });
        result.plans.push({ month: w.month, ...saved });
      } catch (err) {
        console.error("[brand-move] plan update failed", w.month, err);
        result.notes.push(`The ${w.month} manpower plan couldn't be updated — move the line on the Manpower page.`);
      }
    }
  }
  logActivity({
    action: "settings_updated",
    actor,
    targetType: "brand",
    targetId: target!._id as mongoose.Types.ObjectId,
    targetName: target!.name,
    details: { brand: "projects_moved", from: from.name, projects: result.moved, plans: result.plans.map((p) => `${p.month} v${p.version}`) },
    ip,
  });
  if (options.notify && exceptions.length) void notifyException("brand_change", actor, exceptions);
  return result;
}

// ------------------------------------------------------------------- rename

export interface RenameFollowResult {
  projects: number;
  skipped: string[];
  plans: Array<{ month: string; version?: number; inPlace?: boolean }>;
  entries: ExceptionEntry[];
}

/**
 * After a brand rename (`oldName` → brand.name): structured project names get the new brand
 * part (codes kept; free-form names untouched, when `renameProjects`), and every plan line
 * linked to the brand takes its new name ("Old - Campaign" → "New - Campaign", any other name
 * → "New"; lib/manpowerLineNames.ts). Current and future months: a new plan version (the
 * shared save path: approved for leadership), or — when the month has a pending version
 * (someone's change waiting for approval) — the names are fixed in place in the live and
 * pending versions so that request isn't superseded. Past months: the names are fixed in
 * place in their latest approved version only (older versions keep their history).
 */
export async function followBrandRename(brand: IBrand, oldName: string, renameProjects: boolean, actor: IUser, ip?: string): Promise<RenameFollowResult> {
  const out: RenameFollowResult = { projects: 0, skipped: [], plans: [], entries: [] };
  const id = brand._id as mongoose.Types.ObjectId;
  if (tidy(oldName) === tidy(brand.name)) return out;
  if (renameProjects) {
    const projects = await Project.find({ $or: [{ brand: id }, { "naming.brand": id }] }).select("name code naming archivedAt");
    for (const p of projects) {
      const next = nameWithBrand(p, oldName, brand.name);
      if (next === p.name) continue;
      // Open projects' names are unique (case-insensitive).
      if (!p.archivedAt) {
        const clash = await Project.exists({ _id: { $ne: p._id }, archivedAt: null, name: exactNameRegex(next) });
        if (clash) {
          out.skipped.push(`${p.code}: "${next}" is already used`);
          continue;
        }
      }
      const before = p.name;
      await Project.updateOne({ _id: p._id }, { $set: { name: next } });
      out.projects++;
      recordProjectActivity(p._id as mongoose.Types.ObjectId, actor, "updated", { fields: ["name"], brandRenamed: { from: oldName, to: brand.name }, oldName: before, newName: next });
      scheduleProjectTag(p._id as mongoose.Types.ObjectId, true);
      out.entries.push({ project: { _id: p._id, name: next, code: p.code }, details: [["Name", `${before} → ${next}`]] });
    }
  }
  // Every plan line linked to the brand takes the new name.
  const months = (await ManpowerPlan.distinct("month", { "rows.brand": id })) as string[];
  const current = currentAppMonth();
  const { writePlanVersion } = await import("../controllers/manpower.js");
  const rename = (r: IManpowerRow) => {
    if (String(r.brand ?? "") !== String(id)) return null;
    const next = renamedLineName(r.name, oldName, brand.name);
    return next !== r.name ? next : null;
  };
  for (const month of months.sort()) {
    const live = await latestPlan(month);
    if (!live) continue;
    const rows = live.toObject().rows as IManpowerRow[];
    if (!rows.some((r) => rename(r))) continue;
    const pending = month >= current ? await ManpowerPlan.findOne({ month, status: "pending", version: { $gt: live.version } }) : null;
    if (month < current || pending) {
      for (const doc of pending ? [live, pending] : [live]) {
        let touched = false;
        for (const r of doc.rows) {
          const name = rename(r as IManpowerRow);
          if (name) {
            r.name = name;
            touched = true;
          }
        }
        if (touched) {
          doc.markModified("rows");
          await doc.save();
        }
      }
      out.plans.push({ month, inPlace: true });
      continue;
    }
    try {
      const saved = await writePlanVersion({
        month,
        before: rows,
        latestVersion: live.version,
        rows: rows.map((r) => ({ ...r, name: rename(r) ?? r.name })),
        note: `Brand renamed: ${oldName} → ${brand.name}`,
        maxProjectsPerPerson: live.maxProjectsPerPerson,
        source: "edit",
        actor,
        ip,
      });
      out.plans.push({ month, version: saved.version });
    } catch (err) {
      console.error("[brand-rename] plan update failed", month, err);
    }
  }
  return out;
}
