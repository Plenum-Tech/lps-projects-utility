import mongoose from "mongoose";
import { Brand } from "../models/Brand.js";
import { PearityTag } from "../models/PearityTag.js";
import { Project, type IProject } from "../models/Project.js";
import { getProjectTypes } from "../models/ProjectSettings.js";
import { Task } from "../models/Task.js";
import { isDuplicateKeyError } from "./errors.js";
import { detectLegacyNaming } from "./projectNaming.js";
import { buildProjectTag, buildTaskTag, firstFreeTag, tagFamilyFilter, type ProjectTagParts } from "./tags.js";

// ---------------------------------------------------------------------------
// Stores project and task tags (see lib/tags.ts for the format).
//  - A project's tag follows its name: recomputed when brand/type/month/name change.
//  - A task's tag is set at creation and follows its project / scope unit /
//    quantity until Pearity uses it (Generate); from then on it never changes.
// ---------------------------------------------------------------------------

type ProjectForTag = Pick<IProject, "name" | "naming" | "brand" | "startDate"> & { _id: mongoose.Types.ObjectId };

/** Tag parts from the structured name, else detected from a legacy name. */
export function projectTagParts(
  project: ProjectForTag,
  brand: { name: string; shortName?: string | null } | null,
  types: readonly string[]
): ProjectTagParts {
  if (project.naming) {
    return {
      brandName: brand?.name ?? null,
      brandShortName: brand?.shortName ?? null,
      month: project.naming.month,
      type: project.naming.type,
      title: project.naming.title,
    };
  }
  const detected = detectLegacyNaming(project.name, types, brand?.name ?? null, project.startDate ? project.startDate.getUTCFullYear() : null);
  return {
    brandName: brand?.name ?? null,
    brandShortName: brand?.shortName ?? null,
    month: detected.month,
    type: detected.type,
    title: detected.title || project.name,
  };
}

/** The project's base tag (before de-duplication). */
async function projectBaseTag(project: ProjectForTag, types?: readonly string[]): Promise<string> {
  const brandId = project.naming?.brand ?? project.brand ?? null;
  const brand = brandId ? await Brand.findById(brandId).select("name shortName").lean() : null;
  return buildProjectTag(projectTagParts(project, brand, types ?? (await getProjectTypes())));
}

/** Keeps the current tag when it already is `base` or a numbered variant of it. */
function sameFamily(current: string | null | undefined, base: string): boolean {
  if (!current) return false;
  return tagFamilyFilter(base).$regex.test(current);
}

/** Sets (or refreshes) a project's tag. Returns the tag. */
export async function ensureProjectTag(projectId: mongoose.Types.ObjectId | string): Promise<string | null> {
  const project = await Project.findById(projectId).select("name naming brand startDate tag").lean<ProjectForTag & { tag?: string | null }>();
  if (!project) return null;
  const base = await projectBaseTag(project);
  if (sameFamily(project.tag, base)) return project.tag!;
  const taken = await Project.find({ tag: tagFamilyFilter(base), _id: { $ne: project._id } }).select("tag").lean();
  const tag = firstFreeTag(base, taken.map((p) => (p as { tag?: string }).tag ?? ""));
  await Project.updateOne({ _id: project._id }, { $set: { tag } });
  return tag;
}

/**
 * Sets a task's tag (creation, or a change of project / scope unit / quantity).
 * Frozen once the task has a Pearity tag, so Pearity's copy always matches.
 */
export async function ensureTaskTag(taskId: mongoose.Types.ObjectId | string): Promise<string | null> {
  const task = await Task.findById(taskId).select("project titleParts number tag").lean();
  if (!task) return null;
  if (task.tag && (await PearityTag.exists({ task: task._id }))) return task.tag;
  let projectTag: string | null = null;
  if (task.project) {
    const project = await Project.findById(task.project).select("tag").lean<{ tag?: string | null }>();
    projectTag = project?.tag || (await ensureProjectTag(task.project));
  }
  const base = buildTaskTag({ projectTag, titleParts: task.titleParts ?? null, number: task.number ?? null });
  if (sameFamily(task.tag, base)) return task.tag!;
  for (let attempt = 0; attempt < 4; attempt++) {
    const taken = await Task.find({ tag: tagFamilyFilter(base), _id: { $ne: task._id } }).select("tag").lean();
    const tag = firstFreeTag(base, taken.map((t) => t.tag ?? ""));
    try {
      await Task.updateOne({ _id: task._id }, { $set: { tag } });
      return tag;
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err; // a concurrent create took it — try the next number
    }
  }
  return null;
}

/** Re-tags a project's tasks after its tag changed (tasks already used by Pearity keep theirs). */
export async function retagProjectTasks(projectId: mongoose.Types.ObjectId): Promise<void> {
  const tasks = await Task.find({ project: projectId }).select("_id").lean();
  for (const t of tasks) await ensureTaskTag(t._id);
}

/** Fire-and-forget wrappers: tags never block or fail a save. */
export function scheduleProjectTag(projectId: mongoose.Types.ObjectId, retagTasks = false): void {
  void (async () => {
    const before = await Project.findById(projectId).select("tag").lean<{ tag?: string | null }>();
    const tag = await ensureProjectTag(projectId);
    if (retagTasks && tag && tag !== before?.tag) await retagProjectTasks(projectId);
  })().catch((err) => console.error("[tags] project tag failed", err instanceof Error ? err.message : err));
}

export function scheduleTaskTag(taskId: mongoose.Types.ObjectId): void {
  void ensureTaskTag(taskId).catch((err) => console.error("[tags] task tag failed", err instanceof Error ? err.message : err));
}

/**
 * Backfill (script): tags every project, then every task, without one — or all
 * of them with `refresh`. Works in memory so 10k tasks take seconds.
 */
export async function backfillTags(options: { refresh?: boolean; dryRun?: boolean } = {}): Promise<{ projects: number; tasks: number }> {
  const types = await getProjectTypes();
  const [projects, brands] = await Promise.all([
    Project.find({}).select("name naming brand startDate tag").sort({ createdAt: 1 }).lean<Array<ProjectForTag & { tag?: string | null }>>(),
    Brand.find({}).select("name shortName").lean(),
  ]);
  const brandById = new Map(brands.map((b) => [String(b._id), b]));
  const projectTags = new Map<string, string>();
  const usedProjectTags = new Set(projects.filter((p) => p.tag && !options.refresh).map((p) => p.tag!.toUpperCase()));
  let projectCount = 0;
  const projectOps: Array<{ updateOne: { filter: { _id: mongoose.Types.ObjectId }; update: { $set: { tag: string } } } }> = [];
  for (const p of projects) {
    if (p.tag && !options.refresh) {
      projectTags.set(String(p._id), p.tag);
      continue;
    }
    const brandId = p.naming?.brand ?? p.brand ?? null;
    const base = buildProjectTag(projectTagParts(p, brandId ? (brandById.get(String(brandId)) ?? null) : null, types));
    const tag = firstFreeTag(base, usedProjectTags);
    usedProjectTags.add(tag.toUpperCase());
    projectTags.set(String(p._id), tag);
    if (tag !== p.tag) {
      projectCount++;
      projectOps.push({ updateOne: { filter: { _id: p._id }, update: { $set: { tag } } } });
    }
  }

  if (!options.dryRun) for (let i = 0; i < projectOps.length; i += 500) await Project.bulkWrite(projectOps.slice(i, i + 500), { ordered: false });

  const frozen = new Set((await PearityTag.find({}).select("task").lean()).map((t) => String(t.task)));
  const tasks = await Task.find({}).select("project titleParts number tag").sort({ number: 1, _id: 1 }).lean();
  const keep = (t: (typeof tasks)[number]) => Boolean(t.tag) && (!options.refresh || frozen.has(String(t._id)));
  const usedTaskTags = new Set(tasks.filter(keep).map((t) => t.tag!.toUpperCase()));
  let taskCount = 0;
  const taskOps: Array<{ updateOne: { filter: { _id: mongoose.Types.ObjectId }; update: { $set: { tag: string } } } }> = [];
  for (const t of tasks) {
    if (keep(t)) continue;
    const base = buildTaskTag({
      projectTag: t.project ? (projectTags.get(String(t.project)) ?? null) : null,
      titleParts: t.titleParts ?? null,
      number: t.number ?? null,
    });
    const tag = firstFreeTag(base, usedTaskTags);
    usedTaskTags.add(tag.toUpperCase());
    if (tag !== t.tag) {
      taskCount++;
      taskOps.push({ updateOne: { filter: { _id: t._id as mongoose.Types.ObjectId }, update: { $set: { tag } } } });
    }
  }
  if (!options.dryRun) for (let i = 0; i < taskOps.length; i += 500) await Task.bulkWrite(taskOps.slice(i, i + 500), { ordered: false });
  return { projects: projectCount, tasks: taskCount };
}
