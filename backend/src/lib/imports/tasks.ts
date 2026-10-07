import mongoose from "mongoose";
import { createTaskCore, isInvalid, type CreateTaskBody } from "../../controllers/tasks.js";
import { Milestone } from "../../models/Milestone.js";
import { Project } from "../../models/Project.js";
import type { IProject } from "../../models/Project.js";
import { Task, TASK_LIMITS } from "../../models/Task.js";
import type { TaskStatus } from "../../models/Task.js";
import { TaskCategory } from "../../models/TaskCategory.js";
import { TaskLabel } from "../../models/TaskLabel.js";
import type { IUser } from "../../models/User.js";
import { isDuplicateKeyError } from "../errors.js";
import { canCreateProjectTasks, canManageProject, isProjectMember } from "../projectAccess.js";
import { invalidate } from "../refCache.js";
import {
  baseContext,
  byLowerName,
  reportPeople,
  RowIssues,
  RowReader,
  type BaseContext,
  type ImportOptions,
  type RowPlan,
} from "./context.js";
import type { ParsedRow } from "./parse.js";
import type { RunRowResult } from "./projects.js";
import * as V from "./values.js";

// ---------------------------------------------------------------------------
// Tasks import: per-row validation (no writes) mirroring createTaskCore's
// rules, and the run, which calls createTaskCore for every row (same
// permissions, numbers/short codes, history, notifications, progress).
// ---------------------------------------------------------------------------

export interface TaskPlan {
  body: CreateTaskBody;
  status: TaskStatus;
  createCategory: string | null;
  createLabels: string[];
}

type Named = { _id: mongoose.Types.ObjectId; name: string };

interface TaskContext extends BaseContext {
  projectsByCode: Map<string, IProject>;
  projectsByName: Map<string, IProject[]>;
  defaultProject: IProject | null;
  milestones: Map<string, Map<string, mongoose.Types.ObjectId>>;
  categories: Map<string, Named>;
  labels: Map<string, Named>;
}

/** True when the user may import tasks at all (admin, head, or manager of a project). */
export async function canImportTasks(actor: IUser): Promise<boolean> {
  if (actor.role === "admin" || actor.role === "head") return true;
  return Boolean(await Project.exists({ manager: actor._id, archivedAt: null }));
}

async function taskContext(actor: IUser, options: ImportOptions, rows: ParsedRow[], columns: Map<string, number>): Promise<TaskContext> {
  const projectCol = columns.get("project");
  const refs = new Set<string>();
  if (projectCol !== undefined) for (const r of rows) {
    const t = V.text(r.cells[projectCol]);
    if (t) refs.add(t);
  }
  const values = [...refs];
  const or: Record<string, unknown>[] = [{ code: { $in: values.map((v) => v.toUpperCase()) } }, { name: { $in: values } }];
  if (options.defaultProject) or.push({ _id: options.defaultProject });
  const [base, projects, categories, labels] = await Promise.all([
    baseContext("tasks", actor, options),
    values.length > 0 || options.defaultProject
      ? Project.find({ $or: or }).collation({ locale: "en", strength: 2 })
      : Promise.resolve([] as IProject[]),
    TaskCategory.find().select("name").lean(),
    TaskLabel.find().select("name").lean(),
  ]);
  const projectsByCode = new Map<string, IProject>();
  const projectsByName = new Map<string, IProject[]>();
  for (const p of projects) {
    projectsByCode.set(p.code, p);
    const k = p.name.trim().toLowerCase();
    projectsByName.set(k, [...(projectsByName.get(k) ?? []), p]);
  }
  const milestoneRows = await Milestone.find({ project: { $in: projects.map((p) => p._id) } }).select("project title").lean();
  const milestones = new Map<string, Map<string, mongoose.Types.ObjectId>>();
  for (const m of milestoneRows) {
    const k = m.project.toString();
    if (!milestones.has(k)) milestones.set(k, new Map());
    milestones.get(k)!.set(m.title.trim().toLowerCase(), m._id as mongoose.Types.ObjectId);
  }
  return {
    ...base,
    projectsByCode,
    projectsByName,
    defaultProject: options.defaultProject ? (projects.find((p) => p._id.toString() === options.defaultProject) ?? null) : null,
    milestones,
    categories: byLowerName(categories as Named[]),
    labels: byLowerName(labels as Named[]),
  };
}

function findProject(ctx: TaskContext, ref: string): IProject | string {
  const byCode = ctx.projectsByCode.get(ref.toUpperCase());
  if (byCode) return byCode;
  const byName = ctx.projectsByName.get(ref.trim().toLowerCase()) ?? [];
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) return `${byName.length} projects are named "${ref}" — use the project code`;
  return `Project "${ref}" not found`;
}

function validateRow(ctx: TaskContext, r: RowReader, row: number): RowPlan<TaskPlan> {
  const issues = new RowIssues();
  const { actor, options } = ctx;
  for (const f of r.oversizeFields()) issues.error(`${f}: cell is longer than 5000 characters`);

  const title = r.text("title");
  if (!title) issues.error("Title is required");
  else if (title.length > 200) issues.error("Title must be 200 characters or fewer");
  const description = r.text("description");
  if (description.length > TASK_LIMITS.maxDescription) issues.error(`Description must be ${TASK_LIMITS.maxDescription} characters or fewer`);

  // --- project ---
  let project: IProject | null = null;
  const projectRef = r.text("project");
  if (projectRef) {
    const found = findProject(ctx, projectRef);
    if (typeof found === "string") issues.error(found);
    else project = found;
  } else if (options.defaultProject) {
    if (!ctx.defaultProject) issues.error("The default project was not found");
    else project = ctx.defaultProject;
  }
  if (project) {
    if (project.archivedAt) issues.error(`Project ${project.code} is archived and read-only`);
    else if (!canCreateProjectTasks(actor, project)) issues.error(`You can't add tasks to project ${project.code}`);
  } else if (!issues.failed && actor.role === "employee") {
    issues.error("Only heads and admins can create tasks outside a project — set a project");
  }

  // --- milestone ---
  const milestoneTitle = r.text("milestone");
  let milestone: string | undefined;
  if (milestoneTitle) {
    if (!project) issues.warn(`Milestone "${milestoneTitle}" skipped (no project)`);
    else {
      const id = ctx.milestones.get(project._id.toString())?.get(milestoneTitle.toLowerCase());
      if (id) milestone = id.toString();
      else issues.warn(`Milestone "${milestoneTitle}" not found in ${project.code} — skipped`);
    }
  }

  // --- assignees ---
  const tokens = V.list(r.get("assignees"));
  let assigneeIds: string[] = [];
  if (tokens.length === 0) issues.error("At least one assignee is required");
  else {
    const resolved = ctx.people.resolve(tokens);
    reportPeople(issues, "Assignees", resolved, options, 1);
    if (resolved.users.length === 0 && !issues.failed) issues.error("No assignee could be matched");
    if (resolved.users.length > TASK_LIMITS.maxAssignees) issues.error(`A task can have at most ${TASK_LIMITS.maxAssignees} assignees`);
    if (project && !issues.failed) {
      const outsiders = resolved.users.filter((u) => !isProjectMember(u._id, project!));
      if (outsiders.length > 0) {
        const names = outsiders.map((u) => u.name).join(", ");
        if (canManageProject(actor, project)) issues.note(`${names} will be added to ${project.code}`);
        else issues.error(`${names} ${outsiders.length === 1 ? "is" : "are"} not a member of ${project.code}`);
      }
    } else if (!project && actor.role === "head") {
      const outside = resolved.users.filter((u) => !actor.department || !u.department || !u.department.equals(actor.department));
      if (outside.length > 0) {
        issues.error(`${outside.map((u) => u.name).join(", ")} ${outside.length === 1 ? "is" : "are"} not in your department`);
      }
    }
    assigneeIds = resolved.users.map((u) => u._id.toString());
  }

  // --- priority / status ---
  const priorityText = r.text("priority");
  let priority: string | undefined;
  if (priorityText) {
    const p = V.priority(priorityText);
    if (p) priority = p;
    else issues.warn(`Unknown priority "${priorityText}" — medium used`);
  }
  let status: TaskStatus = "todo";
  const statusText = r.text("status");
  if (statusText) {
    const s = V.taskStatus(statusText);
    if (s) status = s;
    else issues.warn(`Unknown status "${statusText}" — To do used`);
  }

  // --- dates / estimate ---
  const start = V.dateOnly(r.get("startDate"), ctx.dateFormat);
  const due = V.dateOnly(r.get("dueDate"), ctx.dateFormat);
  if (V.isValueError(start)) issues.error(`Start date: ${start.error}`);
  if (V.isValueError(due)) issues.error(`Due date: ${due.error}`);
  if (typeof start === "string" && typeof due === "string" && due < start) issues.error("Due date must be on or after the start date");
  const estimate = V.estimateMinutes(r.get("estimate"), TASK_LIMITS.maxEstimateMinutes);
  if (V.isValueError(estimate)) issues.error(estimate.error);

  // --- category / labels ---
  let category: string | undefined;
  let createCategory: string | null = null;
  const categoryName = r.text("category");
  if (categoryName) {
    const found = ctx.categories.get(categoryName.toLowerCase());
    if (found) category = found._id.toString();
    else if (categoryName.length > 60) issues.warn(`Category "${categoryName.slice(0, 30)}…" is too long — skipped`);
    else if (actor.role === "admin") {
      createCategory = categoryName;
      issues.note(`Category "${categoryName}" will be created`);
    } else issues.warn(`Unknown category "${categoryName}" skipped`);
  }
  const labels: string[] = [];
  const createLabels: string[] = [];
  for (const name of V.list(r.get("labels"), /[,;\n\r]+/)) {
    const found = ctx.labels.get(name.toLowerCase());
    if (found) labels.push(found._id.toString());
    else if (name.length > 40) issues.warn(`Label "${name.slice(0, 20)}…" is too long — skipped`);
    else if (actor.role === "admin") {
      createLabels.push(name);
      issues.note(`Label "${name}" will be created`);
    } else issues.warn(`Unknown label "${name}" skipped`);
  }
  if (labels.length + createLabels.length > TASK_LIMITS.maxLabels) issues.error(`A task can have at most ${TASK_LIMITS.maxLabels} labels`);

  // --- subtasks ---
  const subtasks = V.list(r.get("subtasks"), /[;\n\r]+/);
  if (subtasks.length > TASK_LIMITS.maxSubtasks) issues.error(`A task can have at most ${TASK_LIMITS.maxSubtasks} subtasks`);
  if (subtasks.some((s) => s.length > 200)) issues.error("Each subtask title must be 200 characters or fewer");

  const body: CreateTaskBody = {
    title,
    assignees: assigneeIds,
    ...(project ? { project: project._id.toString() } : {}),
    ...(milestone ? { milestone } : {}),
    ...(description ? { description } : {}),
    ...(priority ? { priority } : {}),
    ...(typeof start === "string" ? { startDate: start } : {}),
    ...(typeof due === "string" ? { dueDate: due } : {}),
    ...(typeof estimate === "number" ? { estimateMinutes: estimate } : {}),
    ...(category ? { category } : {}),
    ...(labels.length ? { labels } : {}),
    ...(subtasks.length ? { subtasks } : {}),
  };
  return issues.result(row, "create", { body, status, createCategory, createLabels });
}

/** Validates every row (no writes). */
export async function validateTaskRows(
  actor: IUser,
  options: ImportOptions,
  rows: ParsedRow[],
  columns: Map<string, number>
): Promise<RowPlan<TaskPlan>[]> {
  const ctx = await taskContext(actor, options, rows, columns);
  return rows.map((row) => validateRow(ctx, new RowReader(row, columns), row.row));
}

async function ensureNamed(model: "category" | "label", name: string): Promise<string> {
  const Model = (model === "category" ? TaskCategory : TaskLabel) as unknown as mongoose.Model<{ name: string }>;
  const existing = await Model.findOne({ name }).collation({ locale: "en", strength: 2 }).select("_id").lean();
  if (existing) return existing._id.toString();
  try {
    const created = await Model.create({ name });
    return created._id.toString();
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const found = await Model.findOne({ name }).collation({ locale: "en", strength: 2 }).select("_id").lean();
    return found!._id.toString();
  }
}

/** Executes one validated task row through createTaskCore. */
export async function runTaskRow(
  actor: IUser,
  plan: TaskPlan,
  options: ImportOptions,
  ip: string | undefined,
  jobId: string
): Promise<RunRowResult> {
  const body: CreateTaskBody = { ...plan.body };
  if (plan.createCategory) {
    body.category = await ensureNamed("category", plan.createCategory);
    invalidate("taskCategory:");
  }
  if (plan.createLabels.length > 0) {
    const ids = await Promise.all(plan.createLabels.map((name) => ensureNamed("label", name)));
    body.labels = [...((body.labels as string[] | undefined) ?? []), ...ids];
    invalidate("taskLabel:");
  }
  const result = await createTaskCore(actor, body, ip, { importJob: jobId }, {
    status: plan.status,
    sendEmail: options.sendEmails,
  });
  if (isInvalid(result)) return { status: "error", messages: [result.error] };
  const task = await Task.findById(result.taskId).select("shortCode number").lean();
  return {
    status: "created",
    messages: result.warnings,
    recordId: result.taskId,
    recordRef: task?.shortCode ?? (task?.number ? `#${task.number}` : undefined),
    created: { kind: "task", id: result.taskId },
  };
}
