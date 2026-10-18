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

/** After a brand's scope changes: its open projects follow (archived ones keep theirs). */
export async function applyBrandScopeToProjects(brand: IBrand): Promise<number> {
  const brandId = brand._id as mongoose.Types.ObjectId;
  const res = await Project.updateMany(
    { $or: [{ brand: brandId }, { "naming.brand": brandId }], archivedAt: null },
    { $set: { scopeItems: brandScopeForProject(brand) } }
  );
  return res.modifiedCount;
}

/** Loads a brand by id (for the project write path). */
export async function brandById(id: mongoose.Types.ObjectId | null | undefined) {
  return id ? Brand.findById(id) : null;
}
