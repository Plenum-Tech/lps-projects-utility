import type { Request, Response } from "express";
import mongoose from "mongoose";
import { logActivity } from "../lib/activityLog.js";
import { isDuplicateKeyError } from "../lib/errors.js";
import { Task } from "../models/Task.js";
import { TaskCategory } from "../models/TaskCategory.js";
import { TaskLabel } from "../models/TaskLabel.js";
import type { TaskLabelColor } from "../models/TaskLabel.js";
import { TASK_LABEL_COLORS } from "../models/TaskLabel.js";
import { getTaskSettings } from "../models/TaskSettings.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Express 5 types params as `string | string[] | undefined` — normalize to a single id. */
function paramId(req: Request): string | undefined {
  const id = req.params.id;
  return typeof id === "string" && mongoose.isValidObjectId(id) ? id : undefined;
}

interface LabelBody {
  name?: unknown;
  color?: unknown;
  description?: unknown;
}

interface CategoryBody {
  name?: unknown;
}

interface SettingsBody {
  reminderBeforeDays?: unknown;
  reminderOnDeadline?: unknown;
  reminderAfterDays?: unknown;
}

function validateName(name: unknown, max: number): string | { error: string } {
  if (typeof name !== "string" || !name.trim()) return { error: "name is required" };
  if (name.trim().length > max) return { error: `name must be ${max} characters or fewer` };
  return name.trim();
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Any authenticated user: all labels, alphabetical. */
export async function listLabels(_req: Request, res: Response): Promise<void> {
  const labels = await TaskLabel.find().sort({ name: 1 });
  res.json({ labels: labels.map((l) => l.toJSON()), total: labels.length, limit: null, offset: 0 });
}

/** Admin: creates a label `{ name, color, description? }`. */
export async function createLabel(req: Request, res: Response): Promise<void> {
  const { name, color, description } = (req.body ?? {}) as LabelBody;
  const parsedName = validateName(name, 40);
  if (typeof parsedName !== "string") {
    res.status(400).json({ error: parsedName.error });
    return;
  }
  if (color !== undefined && (typeof color !== "string" || !TASK_LABEL_COLORS.includes(color as TaskLabelColor))) {
    res.status(400).json({ error: `color must be one of: ${TASK_LABEL_COLORS.join(", ")}` });
    return;
  }
  if (description !== undefined && description !== null && (typeof description !== "string" || description.trim().length > 200)) {
    res.status(400).json({ error: "description must be 200 characters or fewer" });
    return;
  }

  try {
    const label = await TaskLabel.create({
      name: parsedName,
      color: (color as TaskLabelColor) ?? "primary",
      description: typeof description === "string" ? description.trim() || undefined : undefined,
    });
    res.status(201).json({ label: label.toJSON() });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      res.status(409).json({ error: "A label with this name already exists" });
      return;
    }
    throw error;
  }
}

/** Admin: updates a label. */
export async function updateLabel(req: Request, res: Response): Promise<void> {
  const id = paramId(req);
  const label = id ? await TaskLabel.findById(id) : null;
  if (!label) {
    res.status(404).json({ error: "Label not found" });
    return;
  }

  const { name, color, description } = (req.body ?? {}) as LabelBody;
  if (name !== undefined) {
    const parsedName = validateName(name, 40);
    if (typeof parsedName !== "string") {
      res.status(400).json({ error: parsedName.error });
      return;
    }
    label.name = parsedName;
  }
  if (color !== undefined) {
    if (typeof color !== "string" || !TASK_LABEL_COLORS.includes(color as TaskLabelColor)) {
      res.status(400).json({ error: `color must be one of: ${TASK_LABEL_COLORS.join(", ")}` });
      return;
    }
    label.color = color as TaskLabelColor;
  }
  if (description !== undefined) {
    if (description !== null && (typeof description !== "string" || description.trim().length > 200)) {
      res.status(400).json({ error: "description must be 200 characters or fewer" });
      return;
    }
    label.description = typeof description === "string" ? description.trim() || undefined : undefined;
  }

  try {
    await label.save();
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      res.status(409).json({ error: "A label with this name already exists" });
      return;
    }
    throw error;
  }
  res.json({ label: label.toJSON() });
}

/** Admin: deletes a label and pulls it from every task. */
export async function deleteLabel(req: Request, res: Response): Promise<void> {
  const id = paramId(req);
  const label = id ? await TaskLabel.findById(id) : null;
  if (!label) {
    res.status(404).json({ error: "Label not found" });
    return;
  }

  await label.deleteOne();
  const result = await Task.updateMany({ labels: label._id }, { $pull: { labels: label._id } });
  res.json({ success: true, tasksUpdated: result.modifiedCount });
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/** Any authenticated user: all categories, alphabetical. */
export async function listCategories(_req: Request, res: Response): Promise<void> {
  const categories = await TaskCategory.find().sort({ name: 1 });
  res.json({
    categories: categories.map((c) => c.toJSON()),
    total: categories.length,
    limit: null,
    offset: 0,
  });
}

/** Admin: creates a category `{ name }`. */
export async function createCategory(req: Request, res: Response): Promise<void> {
  const parsedName = validateName(((req.body ?? {}) as CategoryBody).name, 60);
  if (typeof parsedName !== "string") {
    res.status(400).json({ error: parsedName.error });
    return;
  }

  try {
    const category = await TaskCategory.create({ name: parsedName });
    res.status(201).json({ category: category.toJSON() });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      res.status(409).json({ error: "A category with this name already exists" });
      return;
    }
    throw error;
  }
}

/** Admin: renames a category. */
export async function updateCategory(req: Request, res: Response): Promise<void> {
  const id = paramId(req);
  const category = id ? await TaskCategory.findById(id) : null;
  if (!category) {
    res.status(404).json({ error: "Category not found" });
    return;
  }

  const parsedName = validateName(((req.body ?? {}) as CategoryBody).name, 60);
  if (typeof parsedName !== "string") {
    res.status(400).json({ error: parsedName.error });
    return;
  }
  category.name = parsedName;

  try {
    await category.save();
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      res.status(409).json({ error: "A category with this name already exists" });
      return;
    }
    throw error;
  }
  res.json({ category: category.toJSON() });
}

/** Admin: deletes a category and clears it from every task. */
export async function deleteCategory(req: Request, res: Response): Promise<void> {
  const id = paramId(req);
  const category = id ? await TaskCategory.findById(id) : null;
  if (!category) {
    res.status(404).json({ error: "Category not found" });
    return;
  }

  await category.deleteOne();
  const result = await Task.updateMany({ category: category._id }, { $set: { category: null } });
  res.json({ success: true, tasksUpdated: result.modifiedCount });
}

// ---------------------------------------------------------------------------
// Reminder settings (singleton)
// ---------------------------------------------------------------------------

/** Admin: current reminder settings. */
export async function getSettings(_req: Request, res: Response): Promise<void> {
  const settings = await getTaskSettings();
  res.json({ settings: settings.toJSON() });
}

/** Admin: updates `{ reminderBeforeDays?, reminderOnDeadline?, reminderAfterDays? }`. */
export async function updateSettings(req: Request, res: Response): Promise<void> {
  const { reminderBeforeDays, reminderOnDeadline, reminderAfterDays } = (req.body ?? {}) as SettingsBody;
  if (reminderBeforeDays === undefined && reminderOnDeadline === undefined && reminderAfterDays === undefined) {
    res.status(400).json({ error: "At least one field to update is required" });
    return;
  }

  const isDays = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 30;
  if (reminderBeforeDays !== undefined && !isDays(reminderBeforeDays)) {
    res.status(400).json({ error: "reminderBeforeDays must be an integer between 0 and 30" });
    return;
  }
  if (reminderAfterDays !== undefined && !isDays(reminderAfterDays)) {
    res.status(400).json({ error: "reminderAfterDays must be an integer between 0 and 30" });
    return;
  }
  if (reminderOnDeadline !== undefined && typeof reminderOnDeadline !== "boolean") {
    res.status(400).json({ error: "reminderOnDeadline must be a boolean" });
    return;
  }

  const settings = await getTaskSettings();
  if (reminderBeforeDays !== undefined) settings.reminderBeforeDays = reminderBeforeDays as number;
  if (reminderAfterDays !== undefined) settings.reminderAfterDays = reminderAfterDays as number;
  if (reminderOnDeadline !== undefined) settings.reminderOnDeadline = reminderOnDeadline as boolean;
  await settings.save();

  logActivity({
    action: "task_settings_updated",
    actor: req.user,
    targetType: "task_settings",
    targetId: settings._id as mongoose.Types.ObjectId,
    targetName: "Task reminder settings",
    details: {
      reminderBeforeDays: settings.reminderBeforeDays,
      reminderOnDeadline: settings.reminderOnDeadline,
      reminderAfterDays: settings.reminderAfterDays,
    },
    ip: req.ip,
  });

  res.json({ settings: settings.toJSON() });
}
