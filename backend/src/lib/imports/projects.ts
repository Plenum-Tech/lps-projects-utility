import mongoose from "mongoose";
import { applyProjectStatus, createProjectCore, updateProjectCore, type ProjectBody } from "../../controllers/projects.js";
import { Brand, BRAND_LIMITS, brandNameKey } from "../../models/Brand.js";
import { Department } from "../../models/Department.js";
import { Project, PROJECT_CODE_REGEX, PROJECT_LIMITS } from "../../models/Project.js";
import type { IProject } from "../../models/Project.js";
import { ProjectCategory } from "../../models/ProjectCategory.js";
import { getDefaultProjectStatus, ProjectStatus } from "../../models/ProjectStatus.js";
import { isDuplicateKeyError } from "../errors.js";
import { exactNameRegex } from "../pagination.js";
import { canCreateProject, canManageProject, isInvalid } from "../projectAccess.js";
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
import * as V from "./values.js";
import type { IUser } from "../../models/User.js";

// ---------------------------------------------------------------------------
// Projects import: per-row validation (no writes) and the run, which goes
// through createProjectCore / updateProjectCore / applyProjectStatus.
// ---------------------------------------------------------------------------

export interface ProjectPlan {
  action: "create" | "update" | "skip";
  existingId: string | null;
  body: ProjectBody;
  /** Category to create first (admins), by name. */
  createCategory: string | null;
  /** Brand to create first (admins), by name. */
  createBrand?: string | null;
  statusId: string | null;
  code: string;
}

interface ProjectContext extends BaseContext {
  departments: Map<string, { _id: mongoose.Types.ObjectId; name: string }>;
  categories: Map<string, { _id: mongoose.Types.ObjectId; name: string }>;
  brands: Map<string, { _id: mongoose.Types.ObjectId; name: string; active: boolean }>;
  statuses: Array<{ _id: mongoose.Types.ObjectId; name: string; active: boolean; isDefault: boolean }>;
  existing: Map<string, IProject>;
  takenCodes: Set<string>;
}

async function projectContext(actor: IUser, options: ImportOptions): Promise<ProjectContext> {
  await getDefaultProjectStatus(); // seeds the default statuses on a fresh database
  const [base, departments, categories, brands, statuses, projects] = await Promise.all([
    baseContext("projects", actor, options),
    Department.find().select("name").lean(),
    ProjectCategory.find().select("name").lean(),
    Brand.find().select("name active").lean(),
    ProjectStatus.find().select("name active isDefault").sort({ order: 1 }).lean(),
    Project.find().select("code name manager createdBy departments members archivedAt isPublic status brand"),
  ]);
  return {
    ...base,
    departments: byLowerName(departments as Array<{ _id: mongoose.Types.ObjectId; name: string }>),
    categories: byLowerName(categories as Array<{ _id: mongoose.Types.ObjectId; name: string }>),
    brands: byLowerName(brands as Array<{ _id: mongoose.Types.ObjectId; name: string; active: boolean }>),
    statuses: statuses as ProjectContext["statuses"],
    existing: new Map(projects.map((p) => [p.code, p])),
    takenCodes: new Set(projects.map((p) => p.code)),
  };
}

function uniqueCode(base: string, taken: Set<string>): string {
  let code = base.replace(/[^A-Z0-9]/g, "").slice(0, 10);
  if (code.length < 2) code = `${code}PR`.slice(0, 2);
  if (!taken.has(code)) return code;
  for (let n = 2; n < 10_000; n++) {
    const suffix = String(n);
    const candidate = code.slice(0, 10 - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
  return code;
}

function validateRow(ctx: ProjectContext, r: RowReader, row: number, fileCodes: Map<string, number>): RowPlan<ProjectPlan> {
  const issues = new RowIssues();
  const { actor, options } = ctx;
  for (const f of r.oversizeFields()) issues.error(`${f}: cell is longer than 5000 characters`);

  // --- code / action ---
  const rawCode = r.text("code").toUpperCase();
  let code = rawCode;
  let action: ProjectPlan["action"] = "create";
  let existing: IProject | undefined;
  if (rawCode) {
    if (!PROJECT_CODE_REGEX.test(rawCode)) issues.error(`Project code "${rawCode}" must be 2-10 letters or digits`);
    const firstRow = fileCodes.get(rawCode);
    if (firstRow !== undefined) issues.error(`Duplicate project code "${rawCode}" (already used on row ${firstRow})`);
    else fileCodes.set(rawCode, row);
    existing = ctx.existing.get(rawCode);
    if (existing) {
      if (options.onExisting === "skip") action = "skip";
      else {
        action = "update";
        if (existing.archivedAt) issues.error(`Project ${rawCode} is archived and read-only`);
        else if (!canManageProject(actor, existing)) issues.error(`You can't edit project ${rawCode}`);
      }
    }
  }

  const name = r.text("name");
  if (!name && action !== "update") issues.error("Project name is required");
  if (name.length > PROJECT_LIMITS.nameMax) issues.error(`Project name must be ${PROJECT_LIMITS.nameMax} characters or fewer`);

  if (action === "skip") {
    issues.warn(`Project code ${rawCode} already exists — row will be skipped`);
    return issues.result(row, "skip", {
      action, existingId: existing!._id.toString(), body: {}, createCategory: null, statusId: null, code: rawCode,
    });
  }
  if (action === "create" && !rawCode && name) {
    code = uniqueCode(V.codeFromName(name), new Set([...ctx.takenCodes, ...fileCodes.keys()]));
    fileCodes.set(code, row);
    issues.note(`Code ${code} generated from the name`);
  }

  const body: ProjectBody = {};
  if (name) body.name = name;
  if (action === "create") body.code = code;

  const summary = r.text("summary");
  if (summary) {
    if (summary.length > PROJECT_LIMITS.summaryMax) issues.error(`Summary must be ${PROJECT_LIMITS.summaryMax} characters or fewer`);
    body.summary = summary;
  }

  // --- category ---
  let createCategory: string | null = null;
  const categoryName = r.text("category");
  if (categoryName) {
    const found = ctx.categories.get(categoryName.toLowerCase());
    if (found) body.category = found._id.toString();
    else if (categoryName.length > 60) issues.warn(`Category "${categoryName.slice(0, 30)}…" is too long — skipped`);
    else if (actor.role === "admin") {
      createCategory = categoryName;
      issues.note(`Category "${categoryName}" will be created`);
    } else issues.warn(`Unknown category "${categoryName}" skipped`);
  }

  // --- brand (matched by name, case-insensitive; admins create missing ones) ---
  let createBrand: string | null = null;
  const brandName = r.text("brand").replace(/\s+/g, " ");
  if (brandName) {
    const found = ctx.brands.get(brandName.toLowerCase());
    if (found) {
      if (found.active || (existing?.brand && existing.brand.equals(found._id))) body.brand = found._id.toString();
      else issues.warn(`Brand "${found.name}" is inactive — skipped`);
    } else if (brandName.length > BRAND_LIMITS.nameMax) issues.warn(`Brand "${brandName.slice(0, 30)}…" is too long — skipped`);
    else if (actor.role === "admin") {
      createBrand = brandName;
      issues.note(`Brand "${brandName}" will be created`);
    } else issues.warn(`Unknown brand "${brandName}" skipped`);
  }

  // --- departments (heads: only their own) ---
  const deptNames = V.list(r.get("departments"));
  if (deptNames.length > 0) {
    const ids: string[] = [];
    for (const d of deptNames) {
      const found = ctx.departments.get(d.toLowerCase());
      if (!found) issues.warn(`Unknown department "${d}" skipped`);
      else if (actor.role === "head" && (!actor.department || !found._id.equals(actor.department))) {
        issues.error(`Heads can only import projects for their own department ("${found.name}" is not yours)`);
      } else ids.push(found._id.toString());
    }
    if (ids.length > PROJECT_LIMITS.maxDepartments) issues.error(`At most ${PROJECT_LIMITS.maxDepartments} departments`);
    if (ids.length > 0) body.departments = ids;
  }

  // --- people ---
  const managerToken = r.text("manager");
  if (managerToken) {
    const resolved = ctx.people.resolve([managerToken]);
    reportPeople(issues, "Project manager", resolved, options, 0);
    if (resolved.users[0]) body.manager = resolved.users[0]._id.toString();
  }
  const memberTokens = V.list(r.get("members"));
  if (memberTokens.length > 0) {
    const resolved = ctx.people.resolve(memberTokens);
    reportPeople(issues, "Members", resolved, options, 0);
    if (resolved.users.length > PROJECT_LIMITS.maxMembers) issues.error(`A project can have at most ${PROJECT_LIMITS.maxMembers} members`);
    if (resolved.users.length > 0) {
      if (action === "update") {
        // Update: members are added (never removed) through the manager/members flow — kept simple: warn.
        issues.warn("Members are not changed when updating an existing project");
      } else body.members = resolved.users.map((u) => u._id.toString());
    }
  }

  // --- status ---
  let statusId: string | null = null;
  const statusName = r.text("status");
  if (statusName) {
    const found = ctx.statuses.find((s) => V.statusKey(s.name) === V.statusKey(statusName));
    if (!found) issues.warn(`Unknown status "${statusName}" — ${action === "create" ? "default status used" : "status unchanged"}`);
    else if (!found.active) issues.warn(`Status "${found.name}" is inactive — ${action === "create" ? "default status used" : "status unchanged"}`);
    else statusId = found._id.toString();
  }
  if (action === "create" && statusId) body.status = statusId;

  // --- dates ---
  const start = V.dateOnly(r.get("startDate"), ctx.dateFormat);
  const deadline = V.dateOnly(r.get("deadline"), ctx.dateFormat);
  if (V.isValueError(start)) issues.error(`Start date: ${start.error}`);
  else if (start) body.startDate = start;
  else if (action === "create") issues.error("Start date is required");
  if (V.isValueError(deadline)) issues.error(`Deadline: ${deadline.error}`);
  else if (deadline) body.deadline = deadline;
  const effectiveStart =
    typeof body.startDate === "string" ? body.startDate : existing?.startDate ? existing.startDate.toISOString().slice(0, 10) : null;
  if (typeof body.deadline === "string" && effectiveStart && body.deadline < effectiveStart) {
    issues.error("Deadline must be on or after the start date");
  }

  // --- the rest ---
  const modeText = r.text("progressMode");
  if (modeText) {
    const mode = V.progressMode(modeText);
    if (mode) body.progressMode = mode;
    else issues.warn(`Unknown progress mode "${modeText}" — ${action === "create" ? "task completion used" : "unchanged"}`);
  }
  const hours = V.number(r.get("hoursAllocated"), "Hours allocated", 1_000_000);
  if (V.isValueError(hours)) issues.error(hours.error);
  else if (hours !== null) body.hoursAllocated = hours;
  const budget = V.number(r.get("budget"), "Budget", 1_000_000_000_000);
  if (V.isValueError(budget)) issues.error(budget.error);
  else if (budget !== null) body.budget = budget;
  const isPublic = V.bool(r.get("isPublic"), "Public");
  if (V.isValueError(isPublic)) issues.error(isPublic.error);
  else if (isPublic !== null) body.isPublic = isPublic;

  if (action === "update" && Object.keys(body).length === 0 && !statusId && !createCategory && !createBrand) {
    issues.warn("No mapped values to update — row will be skipped");
    return issues.result(row, "skip", {
      action: "skip", existingId: existing!._id.toString(), body, createCategory, createBrand, statusId, code,
    });
  }

  return issues.result(row, action, {
    action,
    existingId: existing ? existing._id.toString() : null,
    body,
    createCategory,
    createBrand,
    statusId,
    code,
  });
}

/** Validates every row (no writes). */
export async function validateProjectRows(
  actor: IUser,
  options: ImportOptions,
  rows: ParsedRow[],
  columns: Map<string, number>
): Promise<RowPlan<ProjectPlan>[]> {
  if (!canCreateProject(actor)) {
    return rows.map((r) => ({ row: r.row, status: "error", action: null, messages: ["You can't import projects"] }));
  }
  const ctx = await projectContext(actor, options);
  const fileCodes = new Map<string, number>();
  return rows.map((row) => validateRow(ctx, new RowReader(row, columns), row.row, fileCodes));
}

async function ensureProjectCategory(name: string): Promise<string> {
  try {
    const created = await ProjectCategory.create({ name });
    return created._id.toString();
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const found = await ProjectCategory.findOne({ name: exactNameRegex(name) });
    return found!._id.toString();
  }
}

async function ensureBrand(name: string): Promise<string> {
  const existing = await Brand.findOne({ nameKey: brandNameKey(name) });
  if (existing) return existing._id.toString();
  try {
    const created = await Brand.create({ name });
    return created._id.toString();
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const found = await Brand.findOne({ nameKey: brandNameKey(name) });
    return found!._id.toString();
  }
}

export interface RunRowResult {
  status: "created" | "updated" | "skipped" | "error";
  messages: string[];
  recordId?: mongoose.Types.ObjectId;
  recordRef?: string;
  created?: { kind: "project" | "task"; id: mongoose.Types.ObjectId };
}

/** Executes one validated project row through the shared create/update paths. */
export async function runProjectRow(
  actor: IUser,
  plan: ProjectPlan,
  options: ImportOptions,
  ip: string | undefined,
  jobId: string
): Promise<RunRowResult> {
  if (plan.action === "skip") {
    return { status: "skipped", messages: [`Project ${plan.code} already exists`], recordId: new mongoose.Types.ObjectId(plan.existingId!), recordRef: plan.code };
  }
  const body: ProjectBody = { ...plan.body };
  if (plan.createCategory) {
    body.category = await ensureProjectCategory(plan.createCategory);
    invalidate("projectCategory:");
  }
  if (plan.createBrand) body.brand = await ensureBrand(plan.createBrand);
  const writeOptions = { sendEmail: options.sendEmails, activityExtra: { importJob: jobId } };

  if (plan.action === "create") {
    const result = await createProjectCore(actor, body, ip, writeOptions);
    if (isInvalid(result)) return { status: "error", messages: [result.error] };
    const id = result.project._id as mongoose.Types.ObjectId;
    return { status: "created", messages: [], recordId: id, recordRef: result.project.code, created: { kind: "project", id } };
  }

  const project = await Project.findById(plan.existingId);
  if (!project) return { status: "error", messages: ["The project no longer exists"] };
  const messages: string[] = [];
  if (Object.keys(body).length > 0) {
    const result = await updateProjectCore(actor, project, body, ip, writeOptions);
    if (isInvalid(result)) return { status: "error", messages: [result.error] };
  }
  if (plan.statusId) {
    const gate = await applyProjectStatus(actor, project, new mongoose.Types.ObjectId(plan.statusId), ip, {
      sendEmail: options.sendEmails,
    });
    if (gate) messages.push(`Status not changed: ${gate.error}`);
  }
  return { status: "updated", messages, recordId: project._id as mongoose.Types.ObjectId, recordRef: project.code };
}
