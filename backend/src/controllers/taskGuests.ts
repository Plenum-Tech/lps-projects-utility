import crypto from "node:crypto";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { issueLink } from "./passwordSetup.js";
import { emailTask, ensureProjectMembers } from "./tasks.js";
import { logActivity } from "../lib/activityLog.js";
import { PRODUCT_NAME } from "../lib/email.js";
import { isCompanyEmail, isGuestUser } from "../lib/guests.js";
import { notifyTask } from "../lib/notifications.js";
import { isInvalid } from "../lib/projectAccess.js";
import {
  canManageTaskAsync,
  getTaskOr404,
  loadTaskDetail,
  pushTaskUpdate,
  recordTaskHistory,
} from "../lib/taskAccess.js";
import { Project } from "../models/Project.js";
import { TASK_LIMITS } from "../models/Task.js";
import type { IUser } from "../models/User.js";
import { User } from "../models/User.js";

// ---------------------------------------------------------------------------
// Invite an outside person to a task (lib/guests.ts).
// ---------------------------------------------------------------------------

const NAME_MAX = 100;
const EMAIL_MAX = 254;

/**
 * POST /api/tasks/:id/guests `{ name, email }` — whoever manages the task
 * (creator, project manager, admin / leadership). The person is added as an
 * assignee:
 * - an existing employee is simply assigned (and joins the project as usual);
 * - an existing guest is reused (access restored if an admin had removed it);
 * - otherwise a guest account is created (no password yet) and emailed a
 *   set-password link: "<inviter> invited you to the task <title>".
 * Company email addresses never become guests (400).
 * Returns the task detail + `invite: { user, guest, created, invitation, setupUrl? }`
 * (`setupUrl` only for admins and only when the email wasn't sent).
 */
export async function inviteTaskGuest(req: Request, res: Response): Promise<void> {
  const task = await getTaskOr404(req, res);
  if (!task) return;
  const actor = req.user!;
  if (isGuestUser(actor) || !(await canManageTaskAsync(actor, task))) {
    res.status(403).json({ error: "Only the task's creator, its project manager or an admin can invite people to it" });
    return;
  }

  const body = (req.body ?? {}) as { name?: unknown; email?: unknown };
  const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!name || name.length > NAME_MAX) {
    res.status(400).json({ error: `Enter the person's name (up to ${NAME_MAX} characters)`, field: "name" });
    return;
  }
  if (!email || email.length > EMAIL_MAX || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: "Enter a valid email address", field: "email" });
    return;
  }

  let user: IUser | null = await User.findOne({ email });
  const staff = Boolean(user && !isGuestUser(user));
  let created = false;
  if (!user) {
    if (isCompanyEmail(email)) {
      res.status(400).json({ error: "This is a company email — add them as an employee", field: "email" });
      return;
    }
  } else if (task.assignees.some((id) => id.equals(user!._id))) {
    res.status(409).json({ error: `${user.name} is already on this task` });
    return;
  }
  if (task.assignees.length >= TASK_LIMITS.maxAssignees) {
    res.status(400).json({ error: `A task can have at most ${TASK_LIMITS.maxAssignees} assignees` });
    return;
  }

  if (!user) {
    // No usable password until they choose one from the emailed link (login refuses it until then).
    user = await User.create({
      name,
      email,
      password: crypto.randomBytes(32).toString("base64url"),
      role: "employee",
      department: null,
      isGuest: true,
      passwordSetupRequired: true,
      guestInvitedBy: actor._id,
    });
    created = true;
  } else if (!staff && user.guestRevokedAt) {
    user.guestRevokedAt = null;
    await user.save();
  }

  // Employees join the project like any other assignee; guests never do.
  if (staff && task.project) {
    const project = await Project.findById(task.project);
    if (project) {
      const ensured = await ensureProjectMembers(actor, project, [user]);
      if (isInvalid(ensured)) {
        res.status(ensured.status).json({ error: ensured.error });
        return;
      }
    }
  }

  task.assignees.push(user._id as mongoose.Types.ObjectId);
  await task.save();
  const taskId = task._id as mongoose.Types.ObjectId;
  recordTaskHistory(taskId, actor, "assignees_changed", {
    added: [user.name],
    removed: [],
    ...(staff ? {} : { guest: true }),
  });
  if (created) {
    logActivity({
      action: "user_created",
      actor,
      targetType: "user",
      targetId: user._id as mongoose.Types.ObjectId,
      targetName: user.name,
      details: { email, guest: true, task: String(taskId) },
      ip: req.ip,
    });
  }
  logActivity({
    action: "task_updated",
    actor,
    targetType: "task",
    targetId: taskId,
    targetName: task.title,
    details: { fields: ["assignees"], assigneesAdded: 1, ...(staff ? {} : { guestInvited: email }) },
    ip: req.ip,
  });

  // A guest without a password gets the set-password link (that email is the invitation);
  // everyone else gets the usual "New task assigned".
  let link: Awaited<ReturnType<typeof issueLink>> | null = null;
  if (!staff && user.passwordSetupRequired) {
    link = await issueLink(user, actor, true, {
      subject: `${actor.name} invited you to a task on ${PRODUCT_NAME}`,
      intro: `${actor.name} invited you to the task “${task.title}” on ${PRODUCT_NAME}.`,
    });
  } else {
    notifyTask({
      recipients: [user._id as mongoose.Types.ObjectId],
      actor,
      type: "task_assigned",
      task: emailTask(task),
      title: "New task assigned",
      message: `${actor.name} assigned you to the task: ${task.title}`,
      email: {
        subject: `📋 New Task Assigned: ${task.title}`,
        heading: "New Task Assigned",
        intro: `${actor.name} added you to this task.`,
      },
    });
  }
  pushTaskUpdate(task, "updated", { fields: ["assignees"] });

  const detail = await loadTaskDetail(taskId, actor);
  res.status(201).json({
    ...detail,
    invite: {
      user: { _id: user._id, name: user.name, email: user.email },
      guest: !staff,
      created,
      // "emailed" / "not_emailed" when a set-password link was issued, null otherwise.
      invitation: link ? (link.emailed ? "emailed" : "not_emailed") : null,
      // The link is a credential: only admins see it, and only when it couldn't be emailed.
      ...(link && !link.emailed && actor.role === "admin" ? { setupUrl: link.setupUrl } : {}),
    },
  });
}

/**
 * Add task form: outside people typed with a new task (`guests: [{ name, email }]`).
 * Before the task exists: checks every row, finds each person (an employee stays an
 * employee) or creates a guest account (no password yet). Returns their ids to assign,
 * the guest accounts created (removed again if the task can't be created) and the guests
 * to invite once it exists — or a 400.
 */
export async function prepareFormGuests(
  raw: unknown,
  actor: IUser
): Promise<
  | { ids: string[]; created: IUser[]; invite: IUser[] }
  | { status: number; error: string; field?: string }
> {
  if (raw === undefined || raw === null) return { ids: [], created: [], invite: [] };
  if (!Array.isArray(raw) || raw.length > 10) return { status: 400, error: "guests must be a list of at most 10 { name, email }", field: "guests" };
  const rows: Array<{ name: string; email: string }> = [];
  for (const entry of raw as Array<Record<string, unknown>>) {
    const name = typeof entry?.name === "string" ? entry.name.trim().replace(/\s+/g, " ") : "";
    const email = typeof entry?.email === "string" ? entry.email.trim().toLowerCase() : "";
    if (!name || name.length > NAME_MAX) return { status: 400, error: `Enter each outside person's name (up to ${NAME_MAX} characters)`, field: "guests" };
    if (!email || email.length > EMAIL_MAX || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: 400, error: `"${email || name}" isn't a valid email address`, field: "guests" };
    if (!rows.some((r) => r.email === email)) rows.push({ name, email });
  }
  const existing = await User.find({ email: { $in: rows.map((r) => r.email) } });
  for (const r of rows) {
    if (!existing.some((u) => u.email === r.email) && isCompanyEmail(r.email)) {
      return { status: 400, error: `${r.email} is a company email — add them as an employee`, field: "guests" };
    }
  }
  const ids: string[] = [];
  const created: IUser[] = [];
  const invite: IUser[] = [];
  for (const r of rows) {
    let user = existing.find((u) => u.email === r.email) ?? null;
    if (!user) {
      user = await User.create({
        name: r.name,
        email: r.email,
        password: crypto.randomBytes(32).toString("base64url"),
        role: "employee",
        department: null,
        isGuest: true,
        passwordSetupRequired: true,
        guestInvitedBy: actor._id,
      });
      created.push(user);
    } else if (isGuestUser(user) && user.guestRevokedAt) {
      user.guestRevokedAt = null;
      await user.save();
    }
    ids.push(String(user._id));
    if (isGuestUser(user) && user.passwordSetupRequired) invite.push(user);
  }
  return { ids, created, invite };
}

/** After the task exists: each new guest gets the set-password link as the invitation. Admins get links that couldn't be emailed. */
export async function inviteFormGuests(
  guests: IUser[],
  task: { title: string },
  actor: IUser
): Promise<Array<{ name: string; email: string; setupUrl?: string }>> {
  const out: Array<{ name: string; email: string; setupUrl?: string }> = [];
  for (const user of guests) {
    const link = await issueLink(user, actor, true, {
      subject: `${actor.name} invited you to a task on ${PRODUCT_NAME}`,
      intro: `${actor.name} invited you to the task “${task.title}” on ${PRODUCT_NAME}.`,
    });
    out.push({ name: user.name, email: user.email, ...(link && !link.emailed && actor.role === "admin" ? { setupUrl: link.setupUrl } : {}) });
  }
  return out;
}
