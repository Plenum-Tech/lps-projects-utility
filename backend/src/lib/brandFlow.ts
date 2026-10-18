import mongoose from "mongoose";
import type { IBrand, IBrandScopeItem } from "../models/Brand.js";
import { Brand } from "../models/Brand.js";
import { Project } from "../models/Project.js";
import { ProjectFile } from "../models/ProjectFile.js";
import type { IProject } from "../models/Project.js";
import type { IUser } from "../models/User.js";
import { copyGridFsFile } from "./gridfs.js";

// ---------------------------------------------------------------------------
// Brand flow (Brands → New brand): a brand carries the scope read from its
// files. Its projects get that scope locked and its files attached; the setup
// picked in the flow (project, lead tasks, team → manpower plan line) runs at
// once for leadership, or when leadership approves the brand.
// ---------------------------------------------------------------------------

/** Setup stored on a pending brand and run on approval. */
export interface BrandSetup {
  projectType: string;
  month: string;
  title: string;
  leads: string[];
  team: Array<{ role: string; users: string[] }>;
  tasks: Array<{ title: string; dueDate: string }>;
  summary?: string;
  /** Project start / end (YYYY-MM-DD); without them the month's first / last day. */
  startDate?: string;
  endDate?: string;
}

/** The brand's scope as project scope rows (without what / source). */
export function brandScopeForProject(brand: Pick<IBrand, "scopeItems">) {
  return (brand.scopeItems ?? []).map((r: IBrandScopeItem) => ({
    unit: r.unit,
    quantity: r.quantity,
    languages: r.languages,
    ...(r.languageList?.length ? { languageList: [...r.languageList] } : {}),
    sizes: r.sizes,
  }));
}

/** True when projects of this brand have their scope fixed by the brand. */
export function brandLocksScope(brand: Pick<IBrand, "scopeItems"> | null | undefined): boolean {
  return Boolean(brand?.scopeItems?.length);
}

/** Copies the brand's files onto a project (once per file name). Never throws. */
export async function attachBrandFiles(project: IProject, brand: Pick<IBrand, "scopeFiles">, actor: IUser): Promise<number> {
  let added = 0;
  try {
    const projectId = project._id as mongoose.Types.ObjectId;
    const existing = new Set((await ProjectFile.find({ project: projectId }).select("filename").lean()).map((f) => f.filename));
    for (const file of brand.scopeFiles ?? []) {
      if (existing.has(file.filename)) continue;
      const gridFsId = await copyGridFsFile(file.gridFsId, file.filename, {
        project: projectId,
        contentType: file.mimeType,
        uploadedBy: actor._id,
      });
      await ProjectFile.create({
        project: projectId,
        uploadedBy: actor._id,
        filename: file.filename,
        mimeType: file.mimeType,
        size: file.size,
        gridFsId,
      });
      added++;
    }
  } catch (err) {
    console.error("[brand-flow] couldn't attach brand files", String(project._id), err);
  }
  return added;
}

type ScopeRowLike = { unit: string; quantity: number; languages?: number; languageList?: string[]; sizes?: number };

/** Identity of a scope row (unit, quantity, languages, sizes) for matching against the brand's rows. */
export function scopeRowKey(r: ScopeRowLike): string {
  return [r.unit.toLowerCase(), r.quantity, r.languages ?? 1, [...(r.languageList ?? [])].sort().join(","), r.sizes ?? 1].join("|");
}

/**
 * A project of a brand with a scope may cover some of the brand's rows (picked in
 * the project form), never anything else. Returns the rows to store, or an error.
 * An empty pick = the whole brand scope.
 */
export function pickBrandScope(
  brand: Pick<IBrand, "scopeItems" | "name">,
  rows: ScopeRowLike[]
): { rows: ReturnType<typeof brandScopeForProject> } | { error: string } {
  const all = brandScopeForProject(brand);
  if (rows.length === 0) return { rows: all };
  const left = new Map<string, number>();
  for (const r of all) left.set(scopeRowKey(r), (left.get(scopeRowKey(r)) ?? 0) + 1);
  const picked: typeof all = [];
  for (const r of rows) {
    const key = scopeRowKey(r);
    const n = left.get(key) ?? 0;
    if (n === 0) return { error: `This project's scope comes from the brand ${brand.name}: pick its rows, or edit the brand's scope.` };
    left.set(key, n - 1);
    picked.push(all.find((a) => scopeRowKey(a) === key)!);
  }
  return { rows: picked };
}

/**
 * After a brand's scope changes, its open projects follow (archived ones keep theirs):
 * a project on the whole old scope gets the whole new one; a project on some rows keeps
 * those still in the brand (all of them if none are left).
 */
export async function applyBrandScopeToProjects(brand: IBrand, previous: ScopeRowLike[] = []): Promise<number> {
  const brandId = brand._id as mongoose.Types.ObjectId;
  const next = brandScopeForProject(brand);
  const nextKeys = new Set(next.map(scopeRowKey));
  const wasAll = (rows: ScopeRowLike[]) =>
    rows.length === previous.length && rows.map(scopeRowKey).sort().join("\n") === previous.map(scopeRowKey).sort().join("\n");
  const projects = await Project.find({ $or: [{ brand: brandId }, { "naming.brand": brandId }], archivedAt: null }).select("scopeItems");
  let changed = 0;
  for (const p of projects) {
    const current = (p.scopeItems ?? []) as ScopeRowLike[];
    const kept = current.filter((r) => nextKeys.has(scopeRowKey(r)));
    const rows = previous.length === 0 || wasAll(current) || kept.length === 0 ? next : (pickBrandScope(brand, kept) as { rows: typeof next }).rows;
    if (rows.map(scopeRowKey).join("\n") === current.map(scopeRowKey).join("\n")) continue;
    await Project.updateOne({ _id: p._id }, { $set: { scopeItems: rows } });
    changed++;
  }
  return changed;
}

/** Loads a brand by id (for the project write path). */
export async function brandById(id: mongoose.Types.ObjectId | null | undefined) {
  return id ? Brand.findById(id) : null;
}
