import mongoose from "mongoose";
import { Brand, type IBrand } from "../models/Brand.js";
import { latestPlan, type IManpowerRow } from "../models/ManpowerPlan.js";
import { Project } from "../models/Project.js";
import type { IUser } from "../models/User.js";
import { logActivity } from "./activityLog.js";
import { linkProjectsToRows } from "./manpower/match.js";
import { reusableLine } from "./manpowerDedupe.js";
import { renamedLineName } from "./manpowerLineNames.js";
import { composeProjectName } from "./projectNaming.js";
import { projectMonth } from "./projectExpiry.js";
import { scheduleProjectTag } from "./tagAssign.js";

// ---------------------------------------------------------------------------
// Brand split ("different scope = different brand"): projects of one brand move
// to a new brand (Ajmal → Ajmal GCC). The move runs at once for leadership, or
// when leadership approves the new brand (Brand.pendingSetup, kind "split").
// ---------------------------------------------------------------------------

/** Setup stored on a pending brand made by a split. */
export interface BrandSplitSetup {
  kind: "split";
  /** Brand the projects come from. */
  from: string;
  projectIds: string[];
}

export function isSplitSetup(setup: unknown): setup is BrandSplitSetup {
  return Boolean(setup && typeof setup === "object" && (setup as { kind?: unknown }).kind === "split");
}

export interface SplitResult {
  moved: number;
  plans: Array<{ month: string; version: number; pendingApproval?: string }>;
  notes: string[];
}

/**
 * Moves `projectIds` (open projects of brand `from`) to `brand`: project brand and
 * naming brand, structured names recomposed (codes kept; legacy names only get the
 * brand), and their manpower plan lines follow (new plan version per month) when
 * the line holds only moved projects. Moved projects are pinned to their line.
 */
export async function runBrandSplit(brand: IBrand, setup: BrandSplitSetup, actor: IUser, ip?: string): Promise<SplitResult> {
  const fromId = new mongoose.Types.ObjectId(setup.from);
  const toId = brand._id as mongoose.Types.ObjectId;
  const from = await Brand.findById(fromId).select("name").lean();
  const ids = setup.projectIds.filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id));
  const projects = await Project.find({
    _id: { $in: ids },
    archivedAt: null,
    $or: [{ brand: fromId }, { "naming.brand": fromId }],
  })
    .select("name brand naming deadline manpowerRow")
    .lean();
  const result: SplitResult = { moved: 0, plans: [], notes: [] };
  if (projects.length === 0) {
    result.notes.push("No projects were moved (none of them is an open project of the brand any more).");
    return result;
  }
  const movedIds = new Set(projects.map((p) => String(p._id)));

  // Plan lines of the moved projects, per month (before the move, with the old brand).
  const months = new Set(projects.map((p) => projectMonth({ name: p.name, naming: p.naming as never, deadline: p.deadline ?? null })).filter((m): m is string => Boolean(m)));
  const pinned = new Map<string, string>();
  const planWrites: Array<{ month: string; before: IManpowerRow[]; latestVersion: number; rows: IManpowerRow[]; max: number }> = [];
  if (months.size) {
    const [all, brands] = await Promise.all([
      Project.find({ archivedAt: null }).select("name brand naming deadline manpowerRow").lean(),
      Brand.find({}).select("name").lean(),
    ]);
    const brandNames = new Map(brands.map((b) => [String(b._id), b.name]));
    for (const month of months) {
      const plan = await latestPlan(month);
      if (!plan) continue;
      const rows = plan.toObject().rows as IManpowerRow[];
      const links = linkProjectsToRows(
        month,
        rows.map((r) => ({ key: r.key, brand: r.brand ? String(r.brand) : null, type: r.type, name: r.name })),
        all.map((p) => ({
          _id: String(p._id),
          name: p.name,
          brand: p.brand ? String(p.brand) : p.naming?.brand ? String(p.naming.brand) : null,
          naming: p.naming ? { type: p.naming.type, month: p.naming.month, title: p.naming.title } : null,
          deadline: p.deadline ?? null,
          manpowerRow: p.manpowerRow ?? null,
        })),
        brandNames
      );
      const byRow = new Map<string, string[]>();
      for (const [projectId, key] of links) byRow.set(key, [...(byRow.get(key) ?? []), projectId]);
      const moveRows = new Set<string>();
      for (const [projectId, key] of links) {
        if (!movedIds.has(projectId)) continue;
        pinned.set(projectId, key);
        const row = rows.find((r) => r.key === key);
        const linked = byRow.get(key) ?? [];
        if (row && String(row.brand ?? "") === String(fromId) && linked.every((id) => movedIds.has(id))) moveRows.add(key);
        else if (row) result.notes.push(`${row.name} (${month}) is shared with projects that stay on ${from?.name ?? "the old brand"}: the line was kept, the moved projects stay linked to it.`);
      }
      if (moveRows.size === 0) continue;
      // The moved lines take the new brand's name ("Ajmal - Campaign" → "Ajmal GCC - Campaign").
      // No duplicate lines: where the new brand already has that line (same name, or its only
      // line), the moved projects are pinned to it and the old line stays where it is.
      let nextRows = rows;
      let changed = false;
      for (const key of moveRows) {
        const row = nextRows.find((r) => r.key === key)!;
        const name = renamedLineName(row.name, from?.name ?? "", brand.name);
        const existing = reusableLine(nextRows, toId, name);
        if (existing) {
          for (const [projectId, pin] of pinned) if (pin === key && links.get(projectId) === key) pinned.set(projectId, existing.key);
          result.notes.push(`${brand.name} already has the line ${existing.name} in ${month}: the moved projects were linked to it.`);
          continue;
        }
        nextRows = nextRows.map((r) => (r.key === key ? { ...r, brand: toId, name } : r));
        changed = true;
      }
      if (!changed) continue;
      planWrites.push({ month, before: rows, latestVersion: plan.version, rows: nextRows, max: plan.maxProjectsPerPerson });
    }
  }

  for (const p of projects) {
    const set: Record<string, unknown> = { brand: toId };
    if (p.naming) {
      set["naming.brand"] = toId;
      set.name = composeProjectName(brand.name, p.naming.type, p.naming.month, p.naming.title);
    }
    const key = pinned.get(String(p._id));
    if (key) set.manpowerRow = key;
    await Project.updateOne({ _id: p._id }, { $set: set });
    scheduleProjectTag(p._id as mongoose.Types.ObjectId, true);
    result.moved++;
  }

  // The plan lines follow (the shared save path: approved for leadership, pending otherwise).
  const { writePlanVersion } = await import("../controllers/manpower.js");
  for (const w of planWrites) {
    try {
      const saved = await writePlanVersion({
        month: w.month,
        before: w.before,
        latestVersion: w.latestVersion,
        rows: w.rows,
        note: `Brand split: lines moved from ${from?.name ?? "brand"} to ${brand.name}`,
        maxProjectsPerPerson: w.max,
        source: "edit",
        actor,
        ip,
      });
      result.plans.push({ month: w.month, ...saved });
    } catch (err) {
      console.error("[brand-split] plan update failed", w.month, err);
      result.notes.push(`The ${w.month} manpower plan couldn't be updated — move the line on the Manpower page.`);
    }
  }

  result.notes = [...new Set(result.notes)];
  logActivity({
    action: "settings_updated",
    actor,
    targetType: "brand",
    targetId: toId,
    targetName: brand.name,
    details: { brand: "split", from: from?.name ?? setup.from, projects: result.moved, plans: result.plans.map((p) => `${p.month} v${p.version}`) },
    ip,
  });
  return result;
}
