import type { Request, Response } from "express";
import mongoose from "mongoose";
import { applySubtaskDoneActualDates, applySubtaskManualActualDates } from "../lib/actualDates.js";
import type { ActualDateChange } from "../lib/actualDates.js";
import { subtaskTemplate } from "../lib/email.js";
import { deleteFromGridFs } from "../lib/gridfs.js";
import { formatDueDate, notifyTask } from "../lib/notifications.js";
import { searchRegex } from "../lib/pagination.js";
import {
  canManageSubtasks,
  getTaskOr404,
  getViewableTaskOr404,
  isAssignee,
  isInvalidObjectId,
  isSubtaskAssignee,
  loadTaskDetail,
  managesTaskProject,
  param,
  parseDateOnly,
  pushTaskUpdate,
  recordTaskHistory,
} from "../lib/taskAccess.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";
import type { ITask, SubtaskPendingNotify } from "../models/Task.js";
import { TASK_LIMITS } from "../models/Task.js";
import { TaskFile } from "../models/TaskFile.js";
import { TimeLog } from "../models/TimeLog.js";
import type { IUser } from "../models/User.js";
import { STAFF_FILTER, User } from "../models/User.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 2000;

interface SubtaskBody {
  title?: unknown;
  description?: unknown;
  assignee?: unknown;
  startDate?: unknown;
  dueDate?: unknown;
  done?: unknown;
  /** What was done — one way to meet the "note, file or time" rule for ticking rework off. */
  completionNote?: unknown;
  /** ISO date-time; null/"" clears it (back to automatic). */
  actualStartAt?: unknown;
  actualEndAt?: unknown;
  /** "Start now": sets an empty actual start to the current time. */
  startNow?: unknown;
  /** The client uploads files next — hold notifications until POST .../notify. */
  deferNotifications?: unknown;
}

type SubtaskDoc = ITask["subtasks"][number];
type Invalid = { error: string };

/** True when the body touches the subtask's actual dates. */
function touchesActualDates(body: SubtaskBody): boolean {
  return body.actualStartAt !== undefined || body.actualEndAt !== undefined || body.startNow !== undefined;
}

function recordActualChanges(
  taskId: mongoose.Types.ObjectId,
  user: IUser,
  subtask: SubtaskDoc,
  changes: ActualDateChange[]
): void {
  if (changes.length === 0) return;
  recordTaskHistory(taskId, user, "subtask_actual_dates_updated", {
    subtaskId: subtask._id.toString(),
    title: subtask.title,
    changes,
  });
}

function isInvalid(value: unknown): value is Invalid {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    !(value instanceof Date) &&
    !(value instanceof mongoose.Types.ObjectId)
  );
}

function findSubtaskOr404(req: Request, res: Response, task: ITask): SubtaskDoc | undefined {
  const subId = param(req, "subId");
  const subtask = subId && !isInvalidObjectId(subId) ? task.subtasks.id(subId) : null;
  if (!subtask) {
    res.status(404).json({ error: "Rework not found" });
    return undefined;
  }
  return subtask;
}

/** The caller's relationship to a task's subtasks. */
async function subtaskRole(user: IUser, task: ITask) {
  const manage = canManageSubtasks(user, task) || (await managesTaskProject(user, task));
  return {
    manage,
    assignee: isAssignee(user, task),
    subtaskAssignee: isSubtaskAssignee(user, task),
  };
}

/**
 * Who rework may be assigned to: anyone (rework often goes to someone other
 * than the task's assignees).
 */
async function subtaskCandidateFilter(
  _actor: IUser,
  task: ITask
): Promise<Record<string, unknown>> {
  // Anyone on the staff, or an outside guest who is already on this task.
  return { $or: [STAFF_FILTER, { _id: { $in: task.assignees } }] };
}

async function parseSubtaskAssignee(
  raw: unknown,
  actor: IUser,
  task: ITask
): Promise<mongoose.Types.ObjectId | null | Invalid> {
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string" || isInvalidObjectId(raw)) {
    return { error: "assignee must be a valid user ID or null" };
  }
  const filter = await subtaskCandidateFilter(actor, task);
  const allowed = await User.exists({ $and: [{ _id: raw }, filter] });
  if (!allowed) {
    return {
      error:
        "Rework can only be assigned to an existing user",
    };
  }
  return new mongoose.Types.ObjectId(raw);
}

function parseDate(raw: unknown, field: string): Date | null | Invalid {
  if (raw === null || raw === "") return null;
  const parsed = parseDateOnly(raw);
  return parsed ?? { error: `${field} must be a valid date (YYYY-MM-DD)` };
}

function parseTitle(raw: unknown): string | Invalid {
  if (typeof raw !== "string" || !raw.trim()) return { error: "title is required" };
  if (raw.trim().length > MAX_TITLE) return { error: `title must be ${MAX_TITLE} characters or fewer` };
  return raw.trim();
}

function parseDescription(raw: unknown): string | Invalid {
  if (raw === null) return "";
  if (typeof raw !== "string") return { error: "description must be a string" };
  if (raw.trim().length > MAX_DESCRIPTION) {
    return { error: `description must be ${MAX_DESCRIPTION} characters or fewer` };
  }
  return raw.trim();
}

/** Non-blocking warning when the subtask ends after its parent task. */
function dueWarnings(subtask: SubtaskDoc, task: ITask): string[] {
  if (subtask.dueDate && task.dueDate && subtask.dueDate.getTime() > task.dueDate.getTime()) {
    return [`The subtask is due after the task's due date (${formatDueDate(task.dueDate)}).`];
  }
  return [];
}

function subtaskLink(taskId: mongoose.Types.ObjectId, subId: mongoose.Types.ObjectId): string {
  return `/tasks?task=${taskId.toString()}&subtask=${subId.toString()}`;
}

/**
 * Sends one subtask notification (in-app + subtaskTemplate email). Looks up the
 * assignee's name and the attachment count first — fire-and-forget.
 */
function notifySubtask(params: {
  type: "subtask_created" | "subtask_assigned" | "subtask_completed";
  recipients: Array<mongoose.Types.ObjectId | string>;
  task: ITask;
  subtask: SubtaskDoc;
  actor: IUser;
  title: string;
  message: string;
  subject: string;
  heading: string;
  intro: string;
}): void {
  const { task, subtask } = params;
  const taskId = task._id as mongoose.Types.ObjectId;
  void (async () => {
    const [assignee, attachmentCount] = await Promise.all([
      subtask.assignee ? User.findById(subtask.assignee).select("name").lean() : null,
      TaskFile.countDocuments({ task: taskId, subtask: subtask._id }),
    ]);
    notifyTask({
      recipients: params.recipients,
      actor: params.actor,
      type: params.type,
      task: { _id: taskId, title: task.title, dueDate: subtask.dueDate ?? task.dueDate, priority: task.priority },
      title: params.title,
      message: params.message,
      link: subtaskLink(taskId, subtask._id),
      email: {
        subject: params.subject,
        heading: params.heading,
        intro: params.intro,
        render: (firstName) =>
          subtaskTemplate({
            firstName,
            heading: params.heading,
            intro: params.intro,
            taskId: taskId.toString(),
            taskTitle: task.title,
            taskShortCode: task.shortCode ?? null,
            subtaskId: subtask._id.toString(),
            subtaskTitle: subtask.title,
            startDate: formatDueDate(subtask.startDate),
            dueDate: formatDueDate(subtask.dueDate),
            assigneeName: assignee?.name ?? null,
            description: subtask.description || null,
            attachmentCount,
          }),
      },
    });
  })().catch((err) => console.error("[notifications] Subtask notification failed:", err));
}

function notifyAssigned(task: ITask, subtask: SubtaskDoc, actor: IUser): void {
  if (!subtask.assignee) return;
  notifySubtask({
    type: "subtask_assigned",
    recipients: [subtask.assignee],
    task,
    subtask,
    actor,
    title: "Rework assigned",
    message: `${actor.name} assigned you the rework "${subtask.title}" on "${task.title}".`,
    subject: `☑️ Rework assigned: ${subtask.title}`,
    heading: "Rework Assigned",
    intro: `${actor.name} assigned you the rework "${subtask.title}".`,
  });
}

/**
 * Creation fan-out: the subtask assignee gets only `subtask_assigned`; task
 * assignees + creator (minus that assignee) get `subtask_created`.
 */
function notifyCreated(task: ITask, subtask: SubtaskDoc, actor: IUser): void {
  notifyAssigned(task, subtask, actor);
  const skip = subtask.assignee?.toString();
  const recipients = [...task.assignees, task.assignedBy].filter((id) => id.toString() !== skip);
  notifySubtask({
    type: "subtask_created",
    recipients,
    task,
    subtask,
    actor,
    title: "Rework added",
    message: `${actor.name} added the rework "${subtask.title}" to "${task.title}".`,
    subject: `☑️ New rework: ${subtask.title}`,
    heading: "Rework Added",
    intro: `${actor.name} added a rework to "${task.title}".`,
  });
}

function notifyPending(kind: SubtaskPendingNotify, task: ITask, subtask: SubtaskDoc, actor: IUser): void {
  if (kind === "created") notifyCreated(task, subtask, actor);
  else notifyAssigned(task, subtask, actor);
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

/**
 * Task managers and task assignees: adds a subtask
 * `{ title, description?, startDate?, dueDate?, assignee?, deferNotifications? }`.
 */
export async function addSubtask(req: Request, res: Response): Promise<void> {
  const task = await getTaskOr404(req, res);
  if (!task) return;

  const user = req.user!;
  const role = await subtaskRole(user, task);
  if (!role.manage && !role.assignee) {
    res.status(403).json({ error: "Only the task's managers and assignees can add subtasks" });
    return;
  }
  if (task.subtasks.length >= TASK_LIMITS.maxSubtasks) {
    res.status(400).json({ error: `A task can have at most ${TASK_LIMITS.maxSubtasks} rework items` });
    return;
  }

  const body = (req.body ?? {}) as SubtaskBody;
  const title = parseTitle(body.title);
  if (isInvalid(title)) {
    res.status(400).json({ error: title.error });
    return;
  }
  const description = body.description === undefined ? "" : parseDescription(body.description);
  if (isInvalid(description)) {
    res.status(400).json({ error: description.error });
    return;
  }
  const startDate = body.startDate === undefined ? null : parseDate(body.startDate, "startDate");
  if (isInvalid(startDate)) {
    res.status(400).json({ error: startDate.error });
    return;
  }
  const dueDate = body.dueDate === undefined ? null : parseDate(body.dueDate, "dueDate");
  if (isInvalid(dueDate)) {
    res.status(400).json({ error: dueDate.error });
    return;
  }
  if (startDate && dueDate && startDate.getTime() > dueDate.getTime()) {
    res.status(400).json({ error: "startDate must be on or before dueDate" });
    return;
  }
  const assignee = body.assignee === undefined ? null : await parseSubtaskAssignee(body.assignee, user, task);
  if (isInvalid(assignee)) {
    res.status(400).json({ error: assignee.error });
    return;
  }
  const actual = {
    done: false,
    completedAt: null,
    actualStartAt: null as Date | null,
    actualEndAt: null as Date | null,
    actualStartSource: null as "auto" | "manual" | "import" | null,
    actualEndSource: null as "auto" | "manual" | "import" | null,
  };
  const actualChanges = applySubtaskManualActualDates(actual, body);
  if (!Array.isArray(actualChanges)) {
    res.status(actualChanges.status).json({ error: actualChanges.error });
    return;
  }
  const defer = body.deferNotifications === true;

  task.subtasks.push({
    title,
    description,
    done: false,
    assignee,
    startDate,
    dueDate,
    completedAt: null,
    actualStartAt: actual.actualStartAt,
    actualEndAt: actual.actualEndAt,
    actualStartSource: actual.actualStartSource,
    actualEndSource: actual.actualEndSource,
    createdBy: user._id,
    updatedBy: null,
    pendingNotify: defer ? "created" : null,
  });
  await task.save();
  const subtask = task.subtasks[task.subtasks.length - 1]!;
  const taskId = task._id as mongoose.Types.ObjectId;

  recordTaskHistory(taskId, user, "subtask_added", {
    subtaskId: subtask._id.toString(),
    title: subtask.title,
  });
  recordActualChanges(taskId, user, subtask, actualChanges);
  if (!defer) notifyCreated(task, subtask, user);
  pushTaskUpdate(task, "subtask-added", { subtaskId: subtask._id.toString() });

  const detail = await loadTaskDetail(taskId, user);
  res.status(201).json({ ...detail, subtaskId: subtask._id.toString(), warnings: dueWarnings(subtask, task) });
}

/**
 * Edits a subtask. Managers: any field on any subtask. Task assignees: any field
 * on subtasks they created. Done toggles: managers on any subtask; anyone
 * involved (task or subtask assignee) on subtasks assigned to them or unassigned.
 */
export async function updateSubtask(req: Request, res: Response): Promise<void> {
  const task = await getTaskOr404(req, res);
  if (!task) return;

  const user = req.user!;
  const role = await subtaskRole(user, task);
  if (!role.manage && !role.assignee && !role.subtaskAssignee) {
    res.status(403).json({ error: "You don't have access to this task" });
    return;
  }

  const subtask = findSubtaskOr404(req, res, task);
  if (!subtask) return;

  const body = (req.body ?? {}) as SubtaskBody;
  const editingFields = (["title", "description", "assignee", "startDate", "dueDate"] as const).some(
    (key) => body[key] !== undefined
  );
  const editingActual = touchesActualDates(body);
  if (!editingFields && !editingActual && body.done === undefined) {
    res.status(400).json({ error: "At least one field to update is required" });
    return;
  }
  const canEdit = role.manage || (role.assignee && subtask.createdBy.equals(user._id));
  if (editingFields && !canEdit) {
    res.status(403).json({ error: "You can only edit rework you created" });
    return;
  }
  const canToggle =
    role.manage || !subtask.assignee || subtask.assignee.equals(user._id);
  if (body.done !== undefined && !canToggle) {
    res.status(403).json({ error: "You can only tick off rework assigned to you" });
    return;
  }
  // Actual dates: whoever may edit or tick off the subtask.
  if (editingActual && !canEdit && !canToggle) {
    res.status(403).json({ error: "You can't change this subtask's actual dates" });
    return;
  }

  const changed: string[] = [];
  let assigneeChanged = false;
  let doneChanged = false;

  if (body.title !== undefined) {
    const title = parseTitle(body.title);
    if (isInvalid(title)) {
      res.status(400).json({ error: title.error });
      return;
    }
    if (subtask.title !== title) {
      subtask.title = title;
      changed.push("title");
    }
  }

  if (body.description !== undefined) {
    const description = parseDescription(body.description);
    if (isInvalid(description)) {
      res.status(400).json({ error: description.error });
      return;
    }
    if ((subtask.description ?? "") !== description) {
      subtask.description = description;
      changed.push("description");
    }
  }

  for (const field of ["startDate", "dueDate"] as const) {
    if (body[field] === undefined) continue;
    const parsed = parseDate(body[field], field);
    if (isInvalid(parsed)) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    if ((subtask[field]?.getTime() ?? null) !== (parsed?.getTime() ?? null)) {
      subtask[field] = parsed;
      changed.push(field);
    }
  }
  if (subtask.startDate && subtask.dueDate && subtask.startDate.getTime() > subtask.dueDate.getTime()) {
    res.status(400).json({ error: "startDate must be on or before dueDate" });
    return;
  }

  if (body.assignee !== undefined) {
    const current = subtask.assignee?.toString() ?? null;
    const next = body.assignee === "" ? null : body.assignee;
    // Keeping the current assignee never needs the (role-dependent) candidate check.
    if (next !== current) {
      const parsed = await parseSubtaskAssignee(body.assignee, user, task);
      if (isInvalid(parsed)) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      subtask.assignee = parsed;
      assigneeChanged = true;
      changed.push("assignee");
    }
  }

  if (body.done !== undefined) {
    if (typeof body.done !== "boolean") {
      res.status(400).json({ error: "done must be a boolean" });
      return;
    }
    if (body.completionNote !== undefined) {
      if (typeof body.completionNote !== "string" || body.completionNote.trim().length > 2000) {
        res.status(400).json({ error: "completionNote must be 2000 characters or fewer" });
        return;
      }
      subtask.completionNote = body.completionNote.trim();
    }
    if (body.done && !subtask.done) {
      const [file, log] = await Promise.all([
        TaskFile.exists({ task: task._id, subtask: subtask._id }),
        TimeLog.exists({ task: task._id, subtask: subtask._id, status: { $ne: "rejected" } }),
      ]);
      if (!subtask.completionNote?.trim() && !file && !log) {
        res.status(400).json({ error: "Add a note, attach a file or log time on this rework before marking it done" });
        return;
      }
    }
    if (subtask.done !== body.done) {
      const at = new Date();
      subtask.done = body.done;
      subtask.completedAt = body.done ? at : null;
      applySubtaskDoneActualDates(subtask, body.done, at);
      doneChanged = true;
    }
  }

  let actualChanges: ActualDateChange[] = [];
  if (editingActual) {
    const result = applySubtaskManualActualDates(subtask, body);
    if (!Array.isArray(result)) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    actualChanges = result;
  }

  const defer = body.deferNotifications === true;
  if (changed.length > 0 || actualChanges.length > 0) subtask.updatedBy = user._id;
  if (assigneeChanged && subtask.assignee && defer && subtask.pendingNotify !== "created") {
    subtask.pendingNotify = "assigned";
  }

  await task.save();
  const taskId = task._id as mongoose.Types.ObjectId;
  const subtaskId = subtask._id.toString();

  if (doneChanged) {
    recordTaskHistory(taskId, user, subtask.done ? "subtask_completed" : "subtask_reopened", {
      subtaskId,
      title: subtask.title,
    });
    if (subtask.done) {
      notifySubtask({
        type: "subtask_completed",
        recipients: [task.assignedBy, ...task.assignees, subtask.createdBy],
        task,
        subtask,
        actor: user,
        title: "Rework completed",
        message: `${user.name} completed "${subtask.title}" on "${task.title}".`,
        subject: `✅ Rework completed: ${subtask.title}`,
        heading: "Rework Completed",
        intro: `${user.name} completed the rework "${subtask.title}".`,
      });
    }
  }
  if (changed.length > 0) {
    recordTaskHistory(taskId, user, "subtask_updated", { subtaskId, title: subtask.title, fields: changed });
  }
  recordActualChanges(taskId, user, subtask, actualChanges);
  if (assigneeChanged && !defer) notifyAssigned(task, subtask, user);

  pushTaskUpdate(task, "subtask-updated", { subtaskId });

  const detail = await loadTaskDetail(taskId, user);
  res.json({ ...detail, subtaskId, warnings: changed.includes("dueDate") ? dueWarnings(subtask, task) : [] });
}

/** Managers (any subtask) or task assignees (subtasks they created): removes a subtask and its files. */
export async function deleteSubtask(req: Request, res: Response): Promise<void> {
  const task = await getTaskOr404(req, res);
  if (!task) return;

  const user = req.user!;
  const subtask = findSubtaskOr404(req, res, task);
  if (!subtask) return;

  const role = await subtaskRole(user, task);
  if (!role.manage && !(role.assignee && subtask.createdBy.equals(user._id))) {
    res.status(403).json({ error: "You can only remove rework you created" });
    return;
  }

  const subtaskId = subtask._id;
  const subtaskTitle = subtask.title;
  subtask.deleteOne();
  await task.save();
  const taskId = task._id as mongoose.Types.ObjectId;

  // Cascade: the subtask's attachments (documents + GridFS chunks).
  const files = await TaskFile.find({ task: taskId, subtask: subtaskId }).select("gridFsId");
  if (files.length > 0) {
    await TaskFile.deleteMany({ _id: { $in: files.map((f) => f._id) } });
    await Promise.all(files.map((f) => deleteFromGridFs(f.gridFsId)));
  }

  recordTaskHistory(taskId, user, "subtask_removed", {
    subtaskId: subtaskId.toString(),
    title: subtaskTitle,
    files: files.length,
  });
  pushTaskUpdate(task, "subtask-removed", { subtaskId: subtaskId.toString() });

  const detail = await loadTaskDetail(taskId, user);
  res.json(detail);
}

/**
 * Sends the notifications held back by `deferNotifications` (after the form's
 * uploads, so emails carry the attachment count). One-shot and idempotent.
 */
export async function sendDeferredSubtaskNotifications(req: Request, res: Response): Promise<void> {
  const task = await getViewableTaskOr404(req, res);
  if (!task) return;
  const subtask = findSubtaskOr404(req, res, task);
  if (!subtask) return;

  const previous = await Task.findOneAndUpdate(
    {
      _id: task._id,
      subtasks: { $elemMatch: { _id: subtask._id, pendingNotify: { $in: ["created", "assigned"] } } },
    },
    { $set: { "subtasks.$.pendingNotify": null } },
    { returnDocument: "before" }
  );
  const kind = previous?.subtasks.id(subtask._id)?.pendingNotify ?? null;
  if (kind) {
    // The actor is whoever made the change that was deferred, not the caller.
    const actorId = kind === "created" ? subtask.createdBy : (subtask.updatedBy ?? subtask.createdBy);
    const actor = actorId.equals(req.user!._id) ? req.user! : await User.findById(actorId);
    if (actor) notifyPending(kind, task, subtask, actor);
  }
  res.json({ success: true, sent: kind });
}

/** Options for the subtask "Assigned to" picker (follows the assignee rule; ?search=). */
export async function subtaskAssignableUsers(req: Request, res: Response): Promise<void> {
  const task = await getViewableTaskOr404(req, res);
  if (!task) return;

  const and: Record<string, unknown>[] = [await subtaskCandidateFilter(req.user!, task)];
  const search = searchRegex(req.query.search);
  if (search) and.push({ $or: [{ name: search }, { email: search }] });

  const users = await User.find({ $and: and }).select("name email role").sort({ name: 1 }).limit(200);
  res.json({ users: users.map((u) => u.toJSON()), total: users.length, limit: 200, offset: 0 });
}

/**
 * GET /api/tasks/subtasks/mine — open subtasks assigned to me on tasks where I
 * am not a task assignee (those already appear on my board).
 */
export async function mySubtasks(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const tasks = await Task.find({
    subtasks: { $elemMatch: { assignee: user._id, done: false } },
    assignees: { $ne: user._id },
  })
    .select("title shortCode project status subtasks")
    .populate({ path: "project", select: "name code archivedAt" })
    .limit(200);

  const rows: Array<Record<string, unknown>> = [];
  for (const task of tasks) {
    const project = task.project as unknown as { _id: mongoose.Types.ObjectId; name: string; code: string; archivedAt?: Date | null } | null;
    if (project?.archivedAt) continue;
    for (const sub of task.subtasks) {
      if (sub.done || !sub.assignee?.equals(user._id)) continue;
      rows.push({
        _id: sub._id.toString(),
        title: sub.title,
        startDate: sub.startDate ?? null,
        dueDate: sub.dueDate ?? null,
        task: {
          _id: task._id.toString(),
          title: task.title,
          shortCode: task.shortCode ?? null,
          status: task.status,
          project: project ? { _id: project._id.toString(), name: project.name, code: project.code } : null,
        },
      });
    }
  }
  // Soonest due first; undated last.
  rows.sort((a, b) => {
    const ad = (a.dueDate as Date | null)?.getTime() ?? Infinity;
    const bd = (b.dueDate as Date | null)?.getTime() ?? Infinity;
    return ad - bd;
  });
  res.json({ subtasks: rows, total: rows.length });
}
