import type { Request, Response } from "express";
import mongoose from "mongoose";
import { issueSessionCookie } from "./auth.js";
import { deleteUserDocuments } from "./documents.js";
import { logActivity } from "../lib/activityLog.js";
import { isDuplicateKeyError } from "../lib/errors.js";
import { applyHrFields, isEmployeeIdConflict, parseHrFields } from "../lib/hr.js";
import { parsePagination, searchRegex } from "../lib/pagination.js";
import type { EmailPreferences, IUser } from "../models/User.js";
import { EMAIL_PREFERENCE_KEYS, User } from "../models/User.js";

interface CreateUserBody {
  name?: string;
  email?: string;
  password?: string;
  role?: "admin" | "employee" | "head";
  department?: string | null;
  hourlyRate?: unknown;
}

interface UpdateUserBody {
  name?: string;
  email?: string;
  role?: "admin" | "employee" | "head";
  department?: string | null;
  password?: string;
  hourlyRate?: unknown;
}

/** Default hourly rate (0-100000); undefined = not provided, null = invalid. */
function parseHourlyRate(raw: unknown): number | undefined | null {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 100000) return null;
  return Math.round(raw * 100) / 100;
}

interface UpdateMeBody {
  name?: string;
  currentPassword?: string;
  password?: string;
}

/**
 * A password change bumps tokenVersion, which signs out every session — give
 * the caller's own device a fresh cookie so only the OTHER sessions end.
 */
function keepSession(res: Response, user: IUser): void {
  issueSessionCookie(res, { id: String(user._id), role: user.role, tokenVersion: user.tokenVersion });
}

function isInvalidObjectId(id: string): boolean {
  return !mongoose.isValidObjectId(id);
}

/** Express 5 types params as `string | string[] | undefined` — normalize to a single id. */
function paramId(req: Request): string | undefined {
  const id = req.params.id;
  return typeof id === "string" ? id : undefined;
}

async function getUserOr404(req: Request, res: Response): Promise<IUser | undefined> {
  const id = paramId(req);
  if (!id || isInvalidObjectId(id)) {
    res.status(404).json({ error: "User not found" });
    return undefined;
  }
  const user = await User.findById(id);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return undefined;
  }
  return user;
}

/** Admin-only: lists users with optional search and pagination (e.g. to assign employees to departments). */
export async function listUsers(req: Request, res: Response): Promise<void> {
  const { limit, offset } = parsePagination(req);
  const search = searchRegex(req.query.search);

  const filter: Record<string, unknown> = {};
  if (search) {
    filter.$or = [{ name: search }, { email: search }];
  }
  const { role, department, passwordSetup } = req.query;
  // "Needs password" filter (imported users who haven't set one yet).
  if (passwordSetup === "required") filter.passwordSetupRequired = true;
  else if (passwordSetup === "done") filter.passwordSetupRequired = { $ne: true };
  if (role === "admin" || role === "employee" || role === "head") {
    filter.role = role;
  }
  if (department === "none") {
    filter.department = null;
  } else if (typeof department === "string" && department && !isInvalidObjectId(department)) {
    filter.department = new mongoose.Types.ObjectId(department);
  }

  let query = User.find(filter).sort({ name: 1 });
  if (limit !== null) {
    query = query.skip(offset).limit(limit);
  }

  const [users, total] = await Promise.all([query, User.countDocuments(filter)]);

  res.json({
    users: users.map((user) => user.toJSON()),
    total,
    limit,
    offset,
  });
}

/** Admin-only: creates a new user (admin or employee). There is no public registration endpoint. */
export async function createUser(req: Request, res: Response): Promise<void> {
  const { name, email, password, role, department, hourlyRate } = (req.body ?? {}) as CreateUserBody;
  const hr = parseHrFields((req.body ?? {}) as Record<string, unknown>, undefined, { creating: true });
  if (typeof hr === "string") {
    res.status(400).json({ error: hr });
    return;
  }

  if (!name || !email || !password) {
    res.status(400).json({ error: "name, email and password are required" });
    return;
  }
  const rate = parseHourlyRate(hourlyRate);
  if (rate === null) {
    res.status(400).json({ error: "hourlyRate must be a number between 0 and 100000" });
    return;
  }
  if (
    department !== undefined &&
    department !== null &&
    (typeof department !== "string" || isInvalidObjectId(department))
  ) {
    res.status(400).json({ error: "department must be a valid id or null" });
    return;
  }
  // A head without a department has nothing to manage — require an assignment.
  if (role === "head" && (department === undefined || department === null)) {
    res.status(400).json({ error: "A head of department must be assigned to a department" });
    return;
  }

  try {
    const user = await User.create({
      name: name.trim(),
      email: email.trim().toLowerCase(),
      password,
      role: role === "admin" ? "admin" : role === "head" ? "head" : "employee",
      department:
        department === undefined
          ? undefined
          : department === null
            ? null
            : new mongoose.Types.ObjectId(department),
      hourlyRate: rate ?? 0,
      // Blank employeeId → the model assigns the next "EMP-xxxx".
      ...(hr.designation !== undefined ? { designation: hr.designation } : {}),
      ...(hr.employeeId !== undefined ? { employeeId: hr.employeeId } : {}),
      ...hr.dates,
    });
    logActivity({
      action: "user_created",
      actor: req.user,
      targetType: "user",
      targetId: user._id,
      targetName: user.name,
      details: { role: user.role },
      ip: req.ip,
    });
    res.status(201).json({ user: user.toJSON() });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      res.status(409).json({
        error: isEmployeeIdConflict(error) ? "This employee ID is already in use" : "A user with this email already exists",
      });
      return;
    }
    throw error; // validation errors etc. flow to the global JSON error handler
  }
}

/** Admin-only: updates a user's name/email/role/department and optionally resets the password. */
export async function updateUser(req: Request, res: Response): Promise<void> {
  const user = await getUserOr404(req, res);
  if (!user) return;

  const { name, email, role, department, password, hourlyRate } = (req.body ?? {}) as UpdateUserBody;
  const hr = parseHrFields((req.body ?? {}) as Record<string, unknown>, user);
  if (typeof hr === "string") {
    res.status(400).json({ error: hr });
    return;
  }

  const hasAnyField =
    hr.changed.length > 0 ||
    name !== undefined ||
    email !== undefined ||
    role !== undefined ||
    department !== undefined ||
    password !== undefined ||
    hourlyRate !== undefined;
  const rate = parseHourlyRate(hourlyRate);
  if (rate === null) {
    res.status(400).json({ error: "hourlyRate must be a number between 0 and 100000" });
    return;
  }
  if (!hasAnyField) {
    res.status(400).json({ error: "At least one field to update is required" });
    return;
  }

  // An admin must never be able to demote (or promote) themselves.
  const actor = req.user;
  if (actor && actor._id.equals(user._id) && role !== undefined && role !== user.role) {
    res.status(400).json({ error: "You cannot change your own role" });
    return;
  }

  if (name !== undefined && !name.trim()) {
    res.status(400).json({ error: "name cannot be empty" });
    return;
  }
  if (role !== undefined && role !== "admin" && role !== "employee" && role !== "head") {
    res.status(400).json({ error: "role must be admin, employee, or head" });
    return;
  }
  if (password !== undefined && password.length < 8) {
    res.status(400).json({ error: "password must be at least 8 characters" });
    return;
  }
  if (
    department !== undefined &&
    department !== null &&
    (typeof department !== "string" || isInvalidObjectId(department))
  ) {
    res.status(400).json({ error: "department must be a valid id or null" });
    return;
  }

  // After this update the user must still satisfy "heads have a department".
  const nextRole = role ?? user.role;
  const nextDepartment =
    department === null ? null : department === undefined ? user.department : department;
  if (nextRole === "head" && !nextDepartment) {
    res.status(400).json({ error: "A head of department must be assigned to a department" });
    return;
  }

  const changed: string[] = [];
  if (name !== undefined) {
    user.name = name.trim();
    changed.push("name");
  }
  if (email !== undefined) {
    user.email = email.trim().toLowerCase();
    changed.push("email");
  }
  if (role !== undefined) {
    user.role = role;
    changed.push("role");
  }
  if (department !== undefined) {
    user.department = department === null ? null : new mongoose.Types.ObjectId(department);
    changed.push("department");
  }
  if (password !== undefined) {
    // The model's pre-save hook rehashes whenever password is modified.
    user.password = password;
    user.passwordSetupRequired = false;
    // Signs the user out everywhere (an admin editing themselves keeps this session, below).
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    changed.push("password");
  }
  if (rate !== undefined) {
    user.hourlyRate = rate;
    changed.push("hourlyRate");
  }
  // HR profile fields; a changed end date re-arms its reminders (keys include the date).
  applyHrFields(user, hr);
  changed.push(...hr.changed);

  try {
    await user.save();
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      res.status(409).json({
        error: isEmployeeIdConflict(error) ? "This employee ID is already in use" : "A user with this email already exists",
      });
      return;
    }
    throw error;
  }
  if (password !== undefined && actor?._id.equals(user._id)) keepSession(res, user);

  logActivity({
    action: "user_updated",
    actor: req.user,
    targetType: "user",
    targetId: user._id,
    targetName: user.name,
    details: { changed },
    ip: req.ip,
  });

  res.json({ user: user.toJSON() });
}

/** Admin-only: deletes a user. The admin's own account is protected. */
export async function deleteUser(req: Request, res: Response): Promise<void> {
  const user = await getUserOr404(req, res);
  if (!user) return;

  const actor = req.user;
  if (actor && actor._id.equals(user._id)) {
    res.status(400).json({ error: "You cannot delete your own account" });
    return;
  }

  // Snapshot the target BEFORE removal so the audit trail stays meaningful.
  const deletedId = user._id;
  const deletedName = user.name;
  const deletedEmail = user.email;
  const deletedRole = user.role;

  await user.deleteOne();
  // Cascade: their employee documents and the GridFS files.
  const documentsDeleted = await deleteUserDocuments(deletedId as mongoose.Types.ObjectId);

  logActivity({
    action: "user_deleted",
    actor: req.user,
    targetType: "user",
    targetId: deletedId,
    targetName: deletedName,
    details: { email: deletedEmail, role: deletedRole, documentsDeleted },
    ip: req.ip,
  });

  res.json({ message: "User deleted" });
}

/**
 * Any authenticated user: their own profile, including the HR fields
 * (designation, employee ID, dates — read-only for self) and the department name.
 */
export async function getMe(req: Request, res: Response): Promise<void> {
  const user = await User.findById(req.user!._id).populate({ path: "department", select: "name" });
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json({ user: user.toJSON() });
}

/**
 * Any authenticated user: updates their own profile. Only name + password are
 * editable — email/role/department fields in the body are intentionally ignored
 * (email is the unique login identifier, managed by admins).
 */
export async function updateMe(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const { name, currentPassword, password } = (req.body ?? {}) as UpdateMeBody;

  const hasAnyField = name !== undefined || password !== undefined;
  if (!hasAnyField) {
    res.status(400).json({ error: "At least one field to update is required" });
    return;
  }

  if (name !== undefined && !name.trim()) {
    res.status(400).json({ error: "name cannot be empty" });
    return;
  }

  const changed: string[] = [];
  if (name !== undefined) {
    user.name = name.trim();
    changed.push("name");
  }
  if (password !== undefined) {
    if (password.length < 8) {
      res.status(400).json({ error: "password must be at least 8 characters" });
      return;
    }
    // requireAuth loads the user without the password hash (select: false) —
    // fetch it explicitly to verify the current password.
    const stored = await User.findById(user._id).select("+password");
    if (!stored || !(await stored.comparePassword(currentPassword ?? ""))) {
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }
    user.password = password;
    user.mustChangePassword = false;
    // Signs out every other session (version read fresh, not from the cached req.user);
    // this device gets a new cookie below.
    user.tokenVersion = (stored.tokenVersion ?? 0) + 1;
    changed.push("password");
  }

  await user.save();
  if (changed.includes("password")) keepSession(res, user);

  logActivity({
    action: "profile_updated",
    actor: user,
    details: { changed },
    ip: req.ip,
  });

  res.json({ user: user.toJSON() });
}

/** Current email preferences with defaults filled in (older users have no subdocument). */
function readEmailPreferences(user: IUser): EmailPreferences {
  const prefs = (user.emailPreferences ?? {}) as Partial<EmailPreferences>;
  return {
    taskAssigned: prefs.taskAssigned !== false,
    taskUpdates: prefs.taskUpdates !== false,
    taskComments: prefs.taskComments !== false,
    taskReminders: prefs.taskReminders !== false,
    projectUpdates: prefs.projectUpdates !== false,
    timeLogs: prefs.timeLogs !== false,
    teamUpdates: prefs.teamUpdates !== false,
    hrReminders: prefs.hrReminders !== false,
    leaveRequests: prefs.leaveRequests !== false,
  };
}

/** Any authenticated user: their email notification preferences. */
export async function getEmailPreferences(req: Request, res: Response): Promise<void> {
  res.json({ emailPreferences: readEmailPreferences(req.user!) });
}

/**
 * Any authenticated user: updates any of
 * `{ taskAssigned, taskUpdates, taskComments, taskReminders, projectUpdates, timeLogs, teamUpdates, hrReminders, leaveRequests }`.
 * In-app notifications are always created — these only control email.
 */
export async function updateEmailPreferences(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const body = (req.body ?? {}) as Record<string, unknown>;

  const provided = EMAIL_PREFERENCE_KEYS.filter((key) => body[key] !== undefined);
  if (provided.length === 0) {
    res.status(400).json({ error: `At least one of ${EMAIL_PREFERENCE_KEYS.join(", ")} is required` });
    return;
  }
  for (const key of provided) {
    if (typeof body[key] !== "boolean") {
      res.status(400).json({ error: `${key} must be a boolean` });
      return;
    }
  }

  const next = readEmailPreferences(user);
  for (const key of provided) {
    next[key] = body[key] as boolean;
  }
  user.emailPreferences = next;
  await user.save();

  logActivity({
    action: "profile_updated",
    actor: user,
    details: { changed: ["emailPreferences"], emailPreferences: next },
    ip: req.ip,
  });

  res.json({ emailPreferences: next });
}
