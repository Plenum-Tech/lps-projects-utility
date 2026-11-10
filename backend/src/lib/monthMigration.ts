import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { Brand, type IBrand } from "../models/Brand.js";
import { latestPlan, type IManpowerRow } from "../models/ManpowerPlan.js";
import { Project, type IProject } from "../models/Project.js";
import type { IUser } from "../models/User.js";
import { logActivity } from "./activityLog.js";
import { brandLocksScope, pickBrandScope } from "./brandFlow.js";
import { MANPOWER_LIMITS } from "./manpowerRoles.js";
import { composeProjectName } from "./projectNaming.js";
import { carryProject, openTaskCounts, throughMonth } from "./projectCarry.js";

// ---------------------------------------------------------------------------
// Month migration (Brands → "Migrate to next month"): a brand creator (Nazeer) or
// leadership picks brands and moves them from one month to the next in one go,
// with no approval:
//  1. the picked brands' lines in the `from` month's approved manpower plan are
//     copied into the `to` month as a new APPROVED version (lines a brand already
//     has in `to` are kept as they are);
//  2. each picked brand's `from` projects (not pitches, not archived) get their
//     `to` project: same brand / type / title, only the month changed (also in the title). The new
//     project keeps the old one's scope rows (within the brand's scope, when the brand
//     has one), takes the brand's current details (platforms, notes, files — the old
//     project's where the brand has none), its team from the `to` plan (else the
//     brand's leads), and is approved at once.
// Re-running is safe: a line or a project that already exists in `to` is skipped.
// ---------------------------------------------------------------------------

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m!, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function isMonth(value: unknown): value is string {
  return typeof value === "string" && MONTH.test(value);
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "MomStore | October | SFV" → "MomStore | November | SFV": the old month's name / short name in a title becomes the new one's. */
export function retitle(title: string, from: string, to: string): string {
  const [fromLong, toLong] = [from, to].map((m) => MONTH_NAMES[Number(m.slice(5, 7)) - 1]!);
  const swap = (word: string, next: string) => (word === word.toUpperCase() ? next.toUpperCase() : word === word.toLowerCase() ? next.toLowerCase() : next);
  return title
    .replace(new RegExp(`\\b${fromLong}\\b`, "gi"), (w) => swap(w, toLong!))
    .replace(new RegExp(`\\b${fromLong!.slice(0, 3)}\\b`, "gi"), (w) => swap(w, toLong!.slice(0, 3)));
}

/** Projects running in the `from` month (their own month, or carried into it) of the brands that roll over: structured, not pitches, not archived. */
async function sourceProjects(from: string, brandIds?: mongoose.Types.ObjectId[]): Promise<IProject[]> {
  return Project.find({
    $or: [{ "naming.month": from }, { "naming.month": { $lt: from }, activeThrough: { $gte: from } }],
    "naming.type": { $not: /^pitch$/i },
    archivedAt: null,
    ...(brandIds ? { "naming.brand": { $in: brandIds } } : { "naming.brand": { $ne: null } }),
  }).sort({ createdAt: 1 });
}

/** One project per brand / type / title (the first created). */
function uniqueSources(projects: IProject[]): IProject[] {
  const seen = new Set<string>();
  return projects.filter((p) => {
    const key = `${String(p.naming!.brand)}|${p.naming!.type.toLowerCase()}|${p.naming!.title.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function existsInMonth(brand: mongoose.Types.ObjectId, type: string, title: string, month: string): Promise<boolean> {
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Boolean(
    await Project.exists({
      "naming.brand": brand,
      "naming.month": month,
      "naming.type": new RegExp(`^${esc(type)}$`, "i"),
      "naming.title": new RegExp(`^${esc(title)}$`, "i"),
    })
  );
}

export interface MigrationCandidate {
  brand: { _id: string; name: string; organisation: string };
  /** `from` projects: those with open tasks carry on into `to` (same project and name); `exists` = already runs in `to`. */
  projects: Array<{ _id: string; name: string; type: string; title: string; newName: string; exists: boolean; openTasks: number }>;
  /** Lines of the brand in the `from` plan / already in the `to` plan. */
  planLines: number;
  inTargetPlan: boolean;
  hasScope: boolean;
  hasLead: boolean;
}

/** GET preview: the brands that have `from` projects or `from` plan lines, with what a migration would do. */
export async function migrationCandidates(from: string, to: string): Promise<{ from: string; to: string; fromPlanVersion: number | null; brands: MigrationCandidate[] }> {
  const [projects, fromPlan, toPlan] = await Promise.all([sourceProjects(from), latestPlan(from), latestPlan(to)]);
  const fromRows = (fromPlan?.rows ?? []) as IManpowerRow[];
  const toBrands = new Set(((toPlan?.rows ?? []) as IManpowerRow[]).map((r) => (r.brand ? String(r.brand) : "")).filter(Boolean));
  const ids = new Set<string>([
    ...projects.map((p) => String(p.naming!.brand)),
    ...fromRows.map((r) => (r.brand ? String(r.brand) : "")).filter(Boolean),
  ]);
  const brands = await Brand.find({
    _id: { $in: [...ids] },
    active: true,
    $or: [{ status: { $exists: false } }, { status: "approved" }],
  }).sort({ nameKey: 1 });
  const byBrand = new Map<string, IProject[]>();
  for (const p of uniqueSources(projects)) {
    const key = String(p.naming!.brand);
    byBrand.set(key, [...(byBrand.get(key) ?? []), p]);
  }
  const open = await openTaskCounts(projects.map((p) => p._id as mongoose.Types.ObjectId));
  const out: MigrationCandidate[] = [];
  for (const brand of brands) {
    const id = String(brand._id);
    const list = byBrand.get(id) ?? [];
    out.push({
      brand: { _id: id, name: brand.name, organisation: brand.organisation ?? "" },
      projects: await Promise.all(
        list.map(async (p) => ({
          _id: String(p._id),
          name: p.name,
          type: p.naming!.type,
          title: p.naming!.title,
          // Projects carry on with their name unchanged.
          newName: p.name,
          exists: (throughMonth(p) ?? "") >= to,
          openTasks: open.get(String(p._id)) ?? 0,
        }))
      ),
      planLines: fromRows.filter((r) => r.brand && String(r.brand) === id).length,
      inTargetPlan: toBrands.has(id),
      hasScope: brandLocksScope(brand),
      hasLead: (brand.leads ?? []).length > 0,
    });
  }
  return { from, to, fromPlanVersion: fromPlan?.version ?? null, brands: out };
}

export interface MigrationResult {
  from: string;
  to: string;
  plan: { version: number; lines: number } | { skipped: string };
  created: Array<{ brand: string; projectId: string; name: string }>;
  skipped: Array<{ brand: string; reason: string }>;
}

/** Step 1: the picked brands' `from` plan lines → a new approved `to` version (brands already in `to` keep theirs). */
async function copyPlanLines(from: string, to: string, brands: IBrand[], actor: IUser, ip?: string): Promise<MigrationResult["plan"]> {
  const fromPlan = await latestPlan(from);
  if (!fromPlan) return { skipped: `${from} has no approved manpower plan to copy from` };
  const toPlan = await latestPlan(to);
  const toRows = (toPlan?.toObject().rows ?? []) as IManpowerRow[];
  const inTo = new Set(toRows.map((r) => (r.brand ? String(r.brand) : "")).filter(Boolean));
  const picked = new Set(brands.map((b) => String(b._id)).filter((id) => !inTo.has(id)));
  const keys = new Set(toRows.map((r) => r.key));
  const added = (fromPlan.toObject().rows as IManpowerRow[])
    .filter((r) => r.brand && picked.has(String(r.brand)))
    .map((r) => {
      const key = keys.has(r.key) ? randomUUID() : r.key;
      keys.add(key);
      return { ...r, key };
    });
  if (added.length === 0) return { skipped: `The picked brands have no new lines for the ${to} plan` };
  const { writePlanVersion } = await import("../controllers/manpower.js");
  const names = brands.filter((b) => picked.has(String(b._id))).map((b) => b.name);
  const note = `Month migration from ${from}: ${names.join(", ")}`.slice(0, MANPOWER_LIMITS.versionNoteMax);
  const saved = await writePlanVersion({
    month: to,
    before: toRows,
    latestVersion: toPlan?.version ?? null,
    rows: [...toRows, ...added],
    note,
    maxProjectsPerPerson: toPlan?.maxProjectsPerPerson ?? fromPlan.maxProjectsPerPerson,
    source: "copy",
    actor,
    ip,
    autoApprove: true,
  });
  return { version: saved.version, lines: added.length };
}

/**
 * The new project's scope rows: the old project's rows. A brand with a scope fixes its
 * projects' rows, so the old pick is kept only while it still fits the brand's scope
 * (else the project takes all of it — `undefined`).
 */
function scopeFor(brand: IBrand, src: IProject): unknown[] | undefined {
  const rows = (src.scopeItems ?? []).map((r) => ({
    unit: r.unit,
    quantity: r.quantity,
    languages: r.languages,
    sizes: r.sizes,
    ...(r.languageList?.length ? { languageList: [...r.languageList] } : {}),
  }));
  if (rows.length === 0) return undefined;
  if (brandLocksScope(brand) && "error" in pickBrandScope(brand, rows)) return undefined;
  return rows;
}

/** Off since projects carry on (Nov 2026): migration moves the plan lines and carries projects with open tasks. */
const COPY_PROJECTS = false as boolean;

/** POST run: plan lines first (the new projects take their team from them), then the projects. */
export async function runMonthMigration(params: { from: string; to: string; brandIds: string[]; actor: IUser; ip?: string }): Promise<MigrationResult> {
  const { from, to, actor, ip } = params;
  const ids = [...new Set(params.brandIds)].filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id));
  const brands = await Brand.find({ _id: { $in: ids } }).sort({ nameKey: 1 });
  const result: MigrationResult = { from, to, plan: { skipped: "No brands picked" }, created: [], skipped: [] };
  if (brands.length === 0) return result;

  result.plan = await copyPlanLines(from, to, brands, actor, ip);
  // Projects aren't copied (Nov 2026): a project with open tasks carries on into `to` — same
  // project and name, its closed and open tasks together. Finished projects stay in `from`.
  if (!COPY_PROJECTS) {
    const sources = await sourceProjects(from, ids);
    const open = await openTaskCounts(sources.map((p) => p._id as mongoose.Types.ObjectId));
    const brandName = new Map(brands.map((b) => [String(b._id), b.name]));
    for (const p of sources) {
      const brand = brandName.get(String(p.naming!.brand)) ?? "";
      if (!open.get(String(p._id))) {
        result.skipped.push({ brand, reason: `${p.name}: no open tasks — stays in ${from}` });
        continue;
      }
      if (await carryProject(p, to, actor, "month_migration")) result.created.push({ brand, projectId: String(p._id), name: p.name });
    }
    logActivity({
      action: "settings_updated",
      actor,
      targetType: "manpower_plan",
      targetName: `Month migration ${from} → ${to}`,
      details: { from, to, brands: brands.map((b) => b.name), plan: result.plan, carried: result.created.map((c) => c.name), skipped: result.skipped },
      ip,
    });
    return result;
  }

  const { createProjectCore } = await import("../controllers/projects.js");
  const byBrand = new Map<string, IProject[]>();
  for (const p of uniqueSources(await sourceProjects(from, ids))) {
    const key = String(p.naming!.brand);
    byBrand.set(key, [...(byBrand.get(key) ?? []), p]);
  }
  for (const brand of brands) {
    const sources = byBrand.get(String(brand._id)) ?? [];
    if (sources.length === 0) {
      result.skipped.push({ brand: brand.name, reason: `No ${from} project to roll over` });
      continue;
    }
    for (const src of sources) {
      const n = src.naming!;
      const title = retitle(n.title, from, to);
      const name = composeProjectName(brand.name, n.type, to, title);
      if (await existsInMonth(brand._id as mongoose.Types.ObjectId, n.type, title, to)) {
        result.skipped.push({ brand: brand.name, reason: `${name} already exists` });
        continue;
      }
      const scopeItems = scopeFor(brand, src);
      const create = (withScope: boolean) =>
        createProjectCore(
          actor,
          {
            naming: { brand: String(brand._id), type: n.type, month: to, title },
            ...(withScope && scopeItems ? { scopeItems } : {}),
            ...(src.summary ? { summary: src.summary } : {}),
            // Last month's manager keeps managing (else the person migrating would).
            ...(src.manager ? { manager: String(src.manager) } : {}),
            departments: (src.departments ?? []).map(String),
            ...(src.category ? { category: String(src.category) } : {}),
            progressMode: src.progressMode,
            ...(src.hoursAllocated != null ? { hoursAllocated: src.hoursAllocated } : {}),
            ...(src.budget != null ? { budget: src.budget } : {}),
            isPublic: src.isPublic,
            manualTimeLogs: src.manualTimeLogs,
            requireTaskApproval: src.requireTaskApproval,
          },
          ip,
          {
            // A brand creator runs this for leadership: no readiness gate, no approval.
            skipBrandReadiness: true,
            allowBrandWithoutScope: true,
            skipPlanSync: true,
            autoApproveReason: `Month migration from ${from} (no approval needed)`,
            activityExtra: { via: "month_migration", from: String(src._id) },
          }
        );
      let created = await create(true);
      // An old scope row the unit list no longer knows: the project takes the brand's scope instead.
      if ("error" in created && scopeItems && /scope/i.test(created.error)) created = await create(false);
      if ("error" in created) {
        result.skipped.push({ brand: brand.name, reason: `${name}: ${created.error}` });
        continue;
      }
      // Where it came from (shown as "Migrated"), and the old project's scope text /
      // platforms / notes where the brand has none of its own.
      const carry: Record<string, unknown> = { migratedFrom: src._id };
      if (!brand.scopeText && src.scopeText) carry.scopeText = src.scopeText;
      if (!brand.platforms?.length && src.platforms?.length) carry.platforms = [...src.platforms];
      if (!brand.scopeNotes?.length && src.scopeNotes?.length) carry.scopeNotes = [...src.scopeNotes];
      if (Object.keys(carry).length) await Project.updateOne({ _id: created.project._id }, { $set: carry });
      result.created.push({ brand: brand.name, projectId: String(created.project._id), name: created.project.name });
    }
  }

  logActivity({
    action: "settings_updated",
    actor,
    targetType: "manpower_plan",
    targetName: `Month migration ${from} → ${to}`,
    details: {
      from,
      to,
      brands: brands.map((b) => b.name),
      plan: result.plan,
      created: result.created.map((c) => c.name),
      skipped: result.skipped,
    },
    ip,
  });
  return result;
}

