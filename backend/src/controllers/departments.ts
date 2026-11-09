import type { Request, Response } from "express";
import mongoose from "mongoose";
import { logActivity } from "../lib/activityLog.js";
import { isDuplicateKeyError } from "../lib/errors.js";
import { parsePagination, searchRegex } from "../lib/pagination.js";
import { invalidate } from "../lib/refCache.js";
import { Announcement } from "../models/Announcement.js";
import { Department } from "../models/Department.js";
import { STAFF_FILTER, User } from "../models/User.js";

const MEMBER_SELECT = "name email role";

interface DepartmentBody {
  name?: string;
  description?: string;
  /** User ids (admins or heads) who approve this department's timesheets and time logs. */
  approvers?: unknown;
}

function isInvalidObjectId(id: string): boolean {
  return !mongoose.isValidObjectId(id);
}

/** Express 5 types params as `string | string[] | undefined` — normalize to a single id. */
function paramId(req: Request): string | undefined {
  const id = req.params.id;
  return typeof id === "string" ? id : undefined;
}

function getParamIdOr404(req: Request, res: Response): string | undefined {
  const id = paramId(req);
  if (!id || isInvalidObjectId(id)) {
    res.status(404).json({ error: "Department not found" });
    return undefined;
  }
  return id;
}

/** Admin-only: creates a department. */
export async function createDepartment(req: Request, res: Response): Promise<void> {
  const { name, description } = (req.body ?? {}) as DepartmentBody;

  if (!name || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  try {
    const department = await Department.create({
      name: name.trim(),
      description: description?.trim() || undefined,
    });
    logActivity({
      action: "department_created",
      actor: req.user,
      targetType: "department",
      targetId: department._id,
      targetName: department.name,
      ip: req.ip,
    });
    res.status(201).json({ department: department.toJSON() });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      res.status(409).json({ error: "A department with this name already exists" });
      return;
    }
    throw error;
  }
}

/** Admin-only: lists departments (with member counts), optionally searched and paginated. */
export async function listDepartments(req: Request, res: Response): Promise<void> {
  const { limit, offset } = parsePagination(req);
  const search = searchRegex(req.query.search);

  const filter: Record<string, unknown> = {};
  if (search) {
    filter.$or = [{ name: search }, { description: search }];
  }

  let query = Department.find(filter).sort({ name: 1 });
  if (limit !== null) {
    query = query.skip(offset).limit(limit);
  }

  const [departments, total] = await Promise.all([
    query,
    Department.countDocuments(filter),
  ]);

  // Member counts are computed only for the rows on this page.
  const result = await Promise.all(
    departments.map(async (department) => {
      const json = department.toJSON() as unknown as Record<string, unknown>;
      const [memberCount, approvers, heads] = await Promise.all([
        User.countDocuments({ department: department._id }),
        User.find({ _id: { $in: department.approvers ?? [] } }).select("name").sort({ name: 1 }).lean(),
        User.find({ role: "head", department: department._id }).select("name").sort({ name: 1 }).lean(),
      ]);
      return {
        ...json,
        memberCount,
        approvers: approvers.map((a) => ({ _id: String(a._id), name: a.name })),
        // People with the head role in it: they get its requests too.
        heads: heads.map((h) => ({ _id: String(h._id), name: h.name })),
      };
    })
  );

  res.json({ departments: result, total, limit, offset });
}

/** Admin-only: returns a department with its members. */
export async function getDepartment(req: Request, res: Response): Promise<void> {
  const id = getParamIdOr404(req, res);
  if (!id) return;

  const department = await Department.findById(id);
  if (!department) {
    res.status(404).json({ error: "Department not found" });
    return;
  }

  const members = await User.find({ department: department._id })
    .select(MEMBER_SELECT)
    .sort({ name: 1 });

  res.json({
    department: {
      ...department.toJSON(),
      members: members.map((member) => member.toJSON()),
    },
  });
}

/** Admin-only: updates a department's name/description. */
export async function updateDepartment(req: Request, res: Response): Promise<void> {
  const id = getParamIdOr404(req, res);
  if (!id) return;

  const { name, description, approvers } = (req.body ?? {}) as DepartmentBody;

  if (name !== undefined && !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  let approverIds: string[] | null = null;
  if (approvers !== undefined) {
    if (!Array.isArray(approvers) || approvers.length > 10 || approvers.some((a) => typeof a !== "string" || isInvalidObjectId(a))) {
      res.status(400).json({ error: "approvers must be up to 10 user IDs" });
      return;
    }
    approverIds = [...new Set(approvers as string[])];
    const valid = await User.countDocuments({ _id: { $in: approverIds }, role: { $in: ["admin", "head"] } });
    if (valid !== approverIds.length) {
      res.status(400).json({ error: "Approvers must be admins or heads of department" });
      return;
    }
  }

  const department = await Department.findById(id);
  if (!department) {
    res.status(404).json({ error: "Department not found" });
    return;
  }

  const changed: string[] = [];
  if (name !== undefined) {
    department.name = name.trim();
    changed.push("name");
  }
  if (description !== undefined) {
    department.description = description.trim() || undefined;
    changed.push("description");
  }
  if (approverIds) {
    department.approvers = approverIds.map((a) => new mongoose.Types.ObjectId(a));
    changed.push("approvers");
  }

  try {
    await department.save();
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      res.status(409).json({ error: "A department with this name already exists" });
      return;
    }
    throw error;
  }

  logActivity({
    action: "department_updated",
    actor: req.user,
    targetType: "department",
    targetId: department._id,
    targetName: department.name,
    details: { changed },
    ip: req.ip,
  });
  if (approverIds) invalidate(`user:dept-heads:${String(department._id)}`);

  res.json({ department: department.toJSON() });
}

/** Admin-only: deletes a department and unassigns all of its members. */
export async function deleteDepartment(req: Request, res: Response): Promise<void> {
  const id = getParamIdOr404(req, res);
  if (!id) return;

  const department = await Department.findById(id);
  if (!department) {
    res.status(404).json({ error: "Department not found" });
    return;
  }

  // Snapshot the target BEFORE it is removed so the log stays meaningful.
  const deletedId = department._id;
  const deletedName = department.name;

  await User.updateMany({ department: department._id }, { $set: { department: null } });
  // Announcements are department-scoped — remove them with the department.
  await Announcement.deleteMany({ department: department._id });
  await department.deleteOne();

  logActivity({
    action: "department_deleted",
    actor: req.user,
    targetType: "department",
    targetId: deletedId,
    targetName: deletedName,
    ip: req.ip,
  });

  res.json({ message: "Department deleted" });
}

/** Admin-only: replaces the department's member list (assign/unassign in one call). */
export async function setDepartmentEmployees(req: Request, res: Response): Promise<void> {
  const id = getParamIdOr404(req, res);
  if (!id) return;

  const { userIds } = (req.body ?? {}) as { userIds?: unknown };
  if (
    !Array.isArray(userIds) ||
    userIds.some((id) => typeof id !== "string" || !id)
  ) {
    res.status(400).json({ error: "userIds must be an array of user ids" });
    return;
  }

  const department = await Department.findById(id);
  if (!department) {
    res.status(404).json({ error: "Department not found" });
    return;
  }

  const idSet = [...new Set(userIds as string[])];
  const users = await User.find({ _id: { $in: idSet }, ...STAFF_FILTER }).select("_id");
  if (users.length !== idSet.length) {
    res.status(400).json({ error: "One or more user ids are invalid" });
    return;
  }

  // Compute added/removed counts against the current membership for the audit trail.
  const currentMembers = await User.find({ department: department._id }).select("_id");
  const currentMemberIds = new Set(currentMembers.map((member) => member._id.toString()));
  const added = idSet.filter((userId) => !currentMemberIds.has(userId)).length;
  const removed = [...currentMemberIds].filter((userId) => !idSet.includes(userId)).length;

  // Assign the listed users to this department and unassign former members not in the list.
  await User.updateMany({ _id: { $in: idSet } }, { $set: { department: department._id } });
  await User.updateMany(
    { department: department._id, _id: { $nin: idSet } },
    { $set: { department: null } }
  );

  logActivity({
    action: "department_members_updated",
    actor: req.user,
    targetType: "department",
    targetId: department._id,
    targetName: department.name,
    details: { added, removed },
    ip: req.ip,
  });

  const members = await User.find({ department: department._id })
    .select(MEMBER_SELECT)
    .sort({ name: 1 });

  res.json({
    department: {
      ...department.toJSON(),
      members: members.map((member) => member.toJSON()),
    },
  });
}

/** Any authenticated user: returns their own department (null when unassigned). */
export async function myDepartment(req: Request, res: Response): Promise<void> {
  const user = req.user!;

  if (!user.department) {
    res.json({ department: null });
    return;
  }

  const department = await Department.findById(user.department);
  res.json({ department: department ? department.toJSON() : null });
}
