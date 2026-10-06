import type { Request, Response } from "express";
import mongoose from "mongoose";
import { logActivity } from "../lib/activityLog.js";
import { parseHhmm } from "../lib/appTime.js";
import { isDuplicateKeyError } from "../lib/errors.js";
import { isInvalidObjectId, param } from "../lib/projectAccess.js";
import { recalcProjectProgress } from "../lib/projectProgress.js";
import { Project } from "../models/Project.js";
import { ProjectCategory } from "../models/ProjectCategory.js";
import {
  DEADLINE_REMINDER_TARGETS,
  getProjectSettings,
  LOG_TIME_FOR,
} from "../models/ProjectSettings.js";
import type { DeadlineReminderTarget, LogTimeFor } from "../models/ProjectSettings.js";
import { PROJECT_STATUS_COLORS, ProjectStatus, seedProjectStatuses } from "../models/ProjectStatus.js";
import type { ProjectStatusColor } from "../models/ProjectStatus.js";

function parseName(raw: unknown, max: number): string | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { error: "name is required" };
  if (raw.trim().length > max) return { error: `name must be ${max} characters or fewer` };
  return raw.trim();
}

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

/** GET /api/project-meta/statuses — any user; ordered, with `projectCount`. Seeds defaults on first use. */
export async function listStatuses(_req: Request, res: Response): Promise<void> {
  if ((await ProjectStatus.countDocuments()) === 0) await seedProjectStatuses();
  const [statuses, counts] = await Promise.all([
    ProjectStatus.find().sort({ order: 1, createdAt: 1 }),
    Project.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
  ]);
  const byId = new Map(counts.map((c) => [c._id.toString(), c.count]));
  res.json({
    statuses: statuses.map((s) => ({ ...(s.toJSON() as unknown as Record<string, unknown>), projectCount: byId.get(s._id.toString()) ?? 0 })),
    total: statuses.length,
    limit: null,
    offset: 0,
  });
}

interface StatusBody {
  name?: unknown;
  color?: unknown;
  isCompleted?: unknown;
  active?: unknown;
}

function applyStatusFields(body: StatusBody, target: InstanceType<typeof ProjectStatus>, creating: boolean): string | null {
  if (body.name !== undefined || creating) {
    const name = parseName(body.name, 40);
    if (typeof name !== "string") return name.error;
    target.name = name;
  }
  if (body.color !== undefined) {
    if (typeof body.color !== "string" || !PROJECT_STATUS_COLORS.includes(body.color as ProjectStatusColor)) {
      return `color must be one of: ${PROJECT_STATUS_COLORS.join(", ")}`;
    }
    target.color = body.color as ProjectStatusColor;
  }
  if (body.isCompleted !== undefined) {
    if (typeof body.isCompleted !== "boolean") return "isCompleted must be a boolean";
    target.isCompleted = body.isCompleted;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") return "active must be a boolean";
    if (!body.active && target.isDefault) return "The default status cannot be deactivated";
    target.active = body.active;
  }
  return null;
}

/** POST /api/project-meta/statuses — admin. */
export async function createStatus(req: Request, res: Response): Promise<void> {
  const status = new ProjectStatus({ isDefault: false, active: true });
  const error = applyStatusFields((req.body ?? {}) as StatusBody, status, true);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  const last = await ProjectStatus.findOne().sort({ order: -1 }).select("order");
  status.order = (last?.order ?? -1) + 1;
  try {
    await status.save();
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      res.status(409).json({ error: "A status with this name already exists" });
      return;
    }
    throw err;
  }
  res.status(201).json({ status: status.toJSON() });
}

/** PATCH /api/project-meta/statuses/:id — admin. Toggling isCompleted recalculates affected projects. */
export async function updateStatus(req: Request, res: Response): Promise<void> {
  const id = param(req, "id");
  const status = id && !isInvalidObjectId(id) ? await ProjectStatus.findById(id) : null;
  if (!status) {
    res.status(404).json({ error: "Status not found" });
    return;
  }
  const wasCompleted = status.isCompleted;
  const error = applyStatusFields((req.body ?? {}) as StatusBody, status, false);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  try {
    await status.save();
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      res.status(409).json({ error: "A status with this name already exists" });
      return;
    }
    throw err;
  }
  if (wasCompleted !== status.isCompleted) {
    const projects = await Project.find({ status: status._id }).select("_id");
    for (const p of projects) await recalcProjectProgress(p._id as mongoose.Types.ObjectId);
  }
  res.json({ status: status.toJSON() });
}

/** POST /api/project-meta/statuses/:id/default — admin. */
export async function setDefaultStatus(req: Request, res: Response): Promise<void> {
  const id = param(req, "id");
  const status = id && !isInvalidObjectId(id) ? await ProjectStatus.findById(id) : null;
  if (!status) {
    res.status(404).json({ error: "Status not found" });
    return;
  }
  if (!status.active) {
    res.status(400).json({ error: "An inactive status cannot be the default" });
    return;
  }
  await ProjectStatus.updateMany({ _id: { $ne: status._id } }, { $set: { isDefault: false } });
  status.isDefault = true;
  await status.save();
  res.json({ status: status.toJSON() });
}

/** PUT /api/project-meta/statuses/order — admin; `{ ids: [...] }` in display order. */
export async function reorderStatuses(req: Request, res: Response): Promise<void> {
  const { ids } = (req.body ?? {}) as { ids?: unknown };
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || isInvalidObjectId(id))) {
    res.status(400).json({ error: "ids must be an array of status IDs" });
    return;
  }
  const unique = [...new Set(ids as string[])];
  const count = await ProjectStatus.countDocuments({ _id: { $in: unique } });
  if (count !== unique.length) {
    res.status(404).json({ error: "Status not found" });
    return;
  }
  await ProjectStatus.bulkWrite(
    unique.map((id, order) => ({ updateOne: { filter: { _id: id }, update: { $set: { order } } } }))
  );
  const statuses = await ProjectStatus.find().sort({ order: 1, createdAt: 1 });
  res.json({ statuses: statuses.map((s) => s.toJSON()), total: statuses.length, limit: null, offset: 0 });
}

/**
 * DELETE /api/project-meta/statuses/:id[?reassignTo=<statusId>] — admin.
 * The default status cannot be deleted; a status used by projects needs `reassignTo`.
 */
export async function deleteStatus(req: Request, res: Response): Promise<void> {
  const id = param(req, "id");
  const status = id && !isInvalidObjectId(id) ? await ProjectStatus.findById(id) : null;
  if (!status) {
    res.status(404).json({ error: "Status not found" });
    return;
  }
  if (status.isDefault) {
    res.status(400).json({ error: "The default status cannot be deleted" });
    return;
  }
  const used = await Project.countDocuments({ status: status._id });
  let reassigned = 0;
  if (used > 0) {
    const target = req.query.reassignTo;
    if (typeof target !== "string" || isInvalidObjectId(target) || target === status._id.toString()) {
      res.status(409).json({ error: `This status is used by ${used} project(s). Pass reassignTo to move them.`, projectCount: used });
      return;
    }
    const next = await ProjectStatus.findById(target);
    if (!next) {
      res.status(404).json({ error: "reassignTo status not found" });
      return;
    }
    const projects = await Project.find({ status: status._id }).select("_id");
    const result = await Project.updateMany({ status: status._id }, { $set: { status: next._id } });
    reassigned = result.modifiedCount;
    for (const p of projects) await recalcProjectProgress(p._id as mongoose.Types.ObjectId);
  }
  await status.deleteOne();
  res.json({ success: true, projectsReassigned: reassigned });
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/** GET /api/project-meta/categories — any user. */
export async function listCategories(_req: Request, res: Response): Promise<void> {
  const categories = await ProjectCategory.find().sort({ name: 1 });
  res.json({ categories: categories.map((c) => c.toJSON()), total: categories.length, limit: null, offset: 0 });
}

/** POST /api/project-meta/categories — admin; `{ name }`. */
export async function createCategory(req: Request, res: Response): Promise<void> {
  const name = parseName((req.body ?? {}).name, 60);
  if (typeof name !== "string") {
    res.status(400).json({ error: name.error });
    return;
  }
  try {
    const category = await ProjectCategory.create({ name });
    res.status(201).json({ category: category.toJSON() });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      res.status(409).json({ error: "A category with this name already exists" });
      return;
    }
    throw err;
  }
}

/** PATCH /api/project-meta/categories/:id — admin. */
export async function updateCategory(req: Request, res: Response): Promise<void> {
  const id = param(req, "id");
  const category = id && !isInvalidObjectId(id) ? await ProjectCategory.findById(id) : null;
  if (!category) {
    res.status(404).json({ error: "Category not found" });
    return;
  }
  const name = parseName((req.body ?? {}).name, 60);
  if (typeof name !== "string") {
    res.status(400).json({ error: name.error });
    return;
  }
  category.name = name;
  try {
    await category.save();
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      res.status(409).json({ error: "A category with this name already exists" });
      return;
    }
    throw err;
  }
  res.json({ category: category.toJSON() });
}

/** DELETE /api/project-meta/categories/:id — admin; clears it from projects. */
export async function deleteCategory(req: Request, res: Response): Promise<void> {
  const id = param(req, "id");
  const category = id && !isInvalidObjectId(id) ? await ProjectCategory.findById(id) : null;
  if (!category) {
    res.status(404).json({ error: "Category not found" });
    return;
  }
  await category.deleteOne();
  const result = await Project.updateMany({ category: category._id }, { $set: { category: null } });
  res.json({ success: true, projectsUpdated: result.modifiedCount });
}

// ---------------------------------------------------------------------------
// Settings (singleton)
// ---------------------------------------------------------------------------

/** GET /api/project-meta/settings — admin. */
export async function getSettings(_req: Request, res: Response): Promise<void> {
  const settings = await getProjectSettings();
  res.json({ settings: settings.toJSON() });
}

/**
 * GET /api/project-meta/settings/time — any signed-in user: the time-logging
 * rules the UI needs (where time may be logged), nothing else.
 */
export async function getTimeSettings(_req: Request, res: Response): Promise<void> {
  const settings = await getProjectSettings();
  res.json({ settings: { logTimeFor: settings.logTimeFor } });
}

interface SettingsBody {
  logTimeFor?: unknown;
  approvalRequired?: unknown;
  autoStopTimerAt?: unknown;
  trackerReminderAt?: unknown;
  deadlineReminderDays?: unknown;
  deadlineReminderTo?: unknown;
  dailyTimeLogReport?: unknown;
}

/** PATCH /api/project-meta/settings — admin. */
export async function updateSettings(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as SettingsBody;
  const keys = Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined);
  if (keys.length === 0) {
    res.status(400).json({ error: "At least one field to update is required" });
    return;
  }
  const settings = await getProjectSettings();

  if (body.logTimeFor !== undefined) {
    if (typeof body.logTimeFor !== "string" || !LOG_TIME_FOR.includes(body.logTimeFor as LogTimeFor)) {
      res.status(400).json({ error: "logTimeFor must be project or task" });
      return;
    }
    settings.logTimeFor = body.logTimeFor as LogTimeFor;
  }
  for (const field of ["approvalRequired", "dailyTimeLogReport"] as const) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== "boolean") {
      res.status(400).json({ error: `${field} must be a boolean` });
      return;
    }
    settings[field] = body[field] as boolean;
  }
  for (const field of ["autoStopTimerAt", "trackerReminderAt"] as const) {
    const raw = body[field];
    if (raw === undefined) continue;
    if (raw === null || raw === "") {
      settings[field] = null;
      continue;
    }
    if (parseHhmm(raw) === null) {
      res.status(400).json({ error: `${field} must be "HH:mm" (24h) or null` });
      return;
    }
    settings[field] = raw as string;
  }
  if (body.deadlineReminderDays !== undefined) {
    const v = body.deadlineReminderDays;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 60) {
      res.status(400).json({ error: "deadlineReminderDays must be an integer between 0 and 60" });
      return;
    }
    settings.deadlineReminderDays = v;
  }
  if (body.deadlineReminderTo !== undefined) {
    const v = body.deadlineReminderTo;
    if (!Array.isArray(v) || v.some((t) => typeof t !== "string" || !DEADLINE_REMINDER_TARGETS.includes(t as DeadlineReminderTarget))) {
      res.status(400).json({ error: `deadlineReminderTo must be an array of: ${DEADLINE_REMINDER_TARGETS.join(", ")}` });
      return;
    }
    settings.deadlineReminderTo = [...new Set(v as DeadlineReminderTarget[])];
  }
  await settings.save();

  logActivity({
    action: "project_settings_updated",
    actor: req.user,
    targetType: "project_settings",
    targetId: settings._id as mongoose.Types.ObjectId,
    targetName: "Project & time-log settings",
    details: { fields: keys },
    ip: req.ip,
  });
  res.json({ settings: settings.toJSON() });
}
