import type { Request, Response } from "express";
import mongoose from "mongoose";
import { scheduleProjectTag } from "../lib/tagAssign.js";
import { TEAM_ROLE_KEYS } from "../lib/manpowerRoles.js";
import { logActivity } from "../lib/activityLog.js";
import { csvDate, csvHours, EXPORT_ROW_LIMIT, parseIdList, sendCsv, toCsv } from "../lib/csv.js";
import { isDuplicateKeyError } from "../lib/errors.js";
import { deleteFromGridFs } from "../lib/gridfs.js";
import { formatDueDate, notifyUsers } from "../lib/notifications.js";
import { exactNameRegex, parsePagination, searchRegex } from "../lib/pagination.js";
import {
  composeProjectName,
  detectLegacyNaming,
  NAMING_SEPARATOR,
  parseMonthInput,
  parseStructuredName,
  PROJECT_NAMING_LIMITS,
  tidy,
} from "../lib/projectNaming.js";
import { naturalSortKey } from "../lib/naturalSort.js";
import {
  canCreateProject,
  canManageProject,
  canViewProject,
  canViewRates,
  departmentUserIds,
  ensureNotArchived,
  getProjectOr404,
  getViewableProjectOr404,
  isInvalid,
  isInvalidObjectId,
  isProjectMember,
  loggedTotalsByProject,
  param,
  PROJECT_POPULATE,
  projectLink,
  projectPermissions,
  projectVisibilityFilter,
  pushProjectUpdate,
  recordProjectActivity,
  serializeProjects,
  taskCountsByProject,
} from "../lib/projectAccess.js";
import type { Invalid } from "../lib/projectAccess.js";
import { recalcProjectProgress } from "../lib/projectProgress.js";
import { addDays, appDayStart } from "../lib/appTime.js";
import { projectIdsCompletedWithin } from "../lib/projectCompletion.js";
import { activeInRangeFilter, PROGRESS_NOT_DONE } from "../lib/myProjects.js";
import { parseDateOnly } from "../lib/taskAccess.js";
import { appToday } from "../lib/taskJobs.js";
import { nextTaskNumber } from "../lib/taskNumbers.js";
import { stopTimersWhere } from "../lib/timeLogs.js";
import { Brand } from "../models/Brand.js";
import { Department } from "../models/Department.js";
import { Meeting } from "../models/Meeting.js";
import { Milestone } from "../models/Milestone.js";
import { Notification } from "../models/Notification.js";
import { type IProjectTeamEntry, Project, PROGRESS_MODES, PROJECT_CODE_REGEX, PROJECT_LIMITS } from "../models/Project.js";
import type { IProject, IProjectNaming, ProgressMode } from "../models/Project.js";
import type { PipelineStage } from "mongoose";
import { ProjectActivity } from "../models/ProjectActivity.js";
import { ProjectCategory } from "../models/ProjectCategory.js";
import { ProjectFile } from "../models/ProjectFile.js";
import { ProjectNote } from "../models/ProjectNote.js";
import { getProjectTypes } from "../models/ProjectSettings.js";
import { completedStatusIds, getDefaultProjectStatus, ProjectStatus } from "../models/ProjectStatus.js";
import { Task } from "../models/Task.js";
import { TaskComment } from "../models/TaskComment.js";
import { TaskFile } from "../models/TaskFile.js";
import { TaskHistory } from "../models/TaskHistory.js";
import { TimeLog } from "../models/TimeLog.js";
import type { IUser } from "../models/User.js";
import { User } from "../models/User.js";
import { WeeklyTimesheet } from "../models/WeeklyTimesheet.js";
import { listTasksForProject } from "./tasks.js";

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function bad(error: string, status = 400): Invalid {
  return { status, error };
}

function send(res: Response, invalid: Invalid): void {
  res.status(invalid.status).json({ error: invalid.error });
}

/** Optional date-only field: undefined = untouched, null/"" = cleared. */
function optionalDate(raw: unknown, field: string): Date | null | undefined | Invalid {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const parsed = parseDateOnly(raw);
  return parsed ?? bad(`${field} must be a valid date (YYYY-MM-DD)`);
}

function optionalNumber(raw: unknown, field: string, max: number): number | null | undefined | Invalid {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > max) {
    return bad(`${field} must be a number between 0 and ${max}`);
  }
  return Math.round(raw * 100) / 100;
}

function optionalBoolean(raw: unknown, field: string): boolean | undefined | Invalid {
  if (raw === undefined) return undefined;
  if (typeof raw !== "boolean") return bad(`${field} must be a boolean`);
  return raw;
}

function parseCode(raw: unknown): string | Invalid {
  if (typeof raw !== "string") return bad("code is required (2-10 letters/digits)");
  const code = raw.trim().toUpperCase();
  if (!PROJECT_CODE_REGEX.test(code)) return bad("code must be 2-10 uppercase letters or digits");
  return code;
}

async function parseCategory(raw: unknown): Promise<mongoose.Types.ObjectId | null | Invalid> {
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string" || isInvalidObjectId(raw)) return bad("category must be a valid category ID or null");
  if (!(await ProjectCategory.exists({ _id: raw }))) return bad("Category not found", 404);
  return new mongoose.Types.ObjectId(raw);
}


/** First and last day (UTC midnight) of a "YYYY-MM" month: a project's dates follow its month. */
function monthBounds(month: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number);
  return { start: new Date(Date.UTC(y!, m! - 1, 1)), end: new Date(Date.UTC(y!, m!, 0)) };
}

/** Brand id or null/"" (no brand). Inactive brands can't be newly assigned (`current` = the project's brand). */
async function parseBrand(
  raw: unknown,
  current: mongoose.Types.ObjectId | null = null
): Promise<mongoose.Types.ObjectId | null | Invalid> {
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string" || isInvalidObjectId(raw)) return bad("brand must be a valid brand ID or null");
  const brand = await Brand.findById(raw).select("active");
  if (!brand) return bad("Brand not found", 404);
  if (!brand.active && !(current && current.equals(brand._id as mongoose.Types.ObjectId))) {
    return bad("This brand is inactive");
  }
  return brand._id as mongoose.Types.ObjectId;
}

async function parseStatus(raw: unknown): Promise<mongoose.Types.ObjectId | Invalid> {
  if (typeof raw !== "string" || isInvalidObjectId(raw)) return bad("status must be a valid status ID");
  const status = await ProjectStatus.findById(raw).select("active");
  if (!status) return bad("Status not found", 404);
  if (!status.active) return bad("This status is inactive");
  return status._id as mongoose.Types.ObjectId;
}

// ---------------------------------------------------------------------------
// Structured names (`Brand_Type_MonYYYY_Name`, lib/projectNaming.ts)
// ---------------------------------------------------------------------------

interface ParsedNaming {
  naming: IProjectNaming;
  name: string;
}

/**
 * `naming: { brand, type, month, title }` → the parts + composed name.
 * `current` = the project's naming (a type removed from Settings may be kept;
 * an inactive brand may be kept).
 */
async function parseNaming(
  raw: unknown,
  current: { naming?: IProjectNaming | null; brand?: mongoose.Types.ObjectId | null } = {}
): Promise<ParsedNaming | Invalid> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return bad("naming must be an object { brand, type, month, title }");
  }
  const input = raw as { brand?: unknown; type?: unknown; month?: unknown; title?: unknown };
  const missing = (["brand", "type", "month", "title"] as const).filter((k) => {
    const v = input[k];
    return v === undefined || v === null || (typeof v === "string" && !tidy(v));
  });
  if (missing.length > 0) {
    const labels = missing.map((k) => (k === "title" ? "name" : k));
    return bad(`Project ${labels.join(", ")} ${labels.length === 1 ? "is" : "are"} required`);
  }

  const brandId = await parseBrand(input.brand, current.naming?.brand ?? current.brand ?? null);
  if (isInvalid(brandId)) return brandId;
  if (!brandId) return bad("Brand is required");
  const brand = await Brand.findById(brandId).select("name").lean<{ name: string }>();
  if (!brand) return bad("Brand not found", 404);
  if (brand.name.includes(NAMING_SEPARATOR)) {
    return bad(`The brand name "${brand.name}" contains "_" — rename the brand first`);
  }

  if (typeof input.type !== "string") return bad("type must be text");
  const typeText = tidy(input.type);
  const keptType =
    current.naming && current.naming.type.toLowerCase() === typeText.toLowerCase() ? current.naming.type : null;
  const types = await getProjectTypes();
  const type = types.find((t) => t.toLowerCase() === typeText.toLowerCase()) ?? keptType;
  if (!type) return bad(`type must be one of: ${types.join(", ")}`);

  const month = parseMonthInput(input.month);
  if (!month) return bad('month must be a month like "2026-10"');

  if (typeof input.title !== "string") return bad("name must be text");
  const title = tidy(input.title);
  if (title.includes(NAMING_SEPARATOR)) return bad('Name can\'t contain "_" (it separates the parts)');
  if (title.length > PROJECT_NAMING_LIMITS.titleMax) {
    return bad(`Name must be ${PROJECT_NAMING_LIMITS.titleMax} characters or fewer`);
  }

  return {
    naming: { brand: brandId, type, month, title },
    name: composeProjectName(brand.name, type, month, title),
  };
}

/** 409 when another active (non-archived) project already has this name (case-insensitive, no collation). */
async function ensureUniqueName(name: string, excludeId?: mongoose.Types.ObjectId): Promise<Invalid | null> {
  const filter: Record<string, unknown> = { archivedAt: null, name: exactNameRegex(name) };
  if (excludeId) filter._id = { $ne: excludeId };
  const clash = await Project.findOne(filter).select("code").lean<{ code: string }>();
  return clash ? bad(`A project named "${name}" already exists (${clash.code})`, 409) : null;
}

/** Heads may only use their own department; admins any existing department. */
async function parseDepartments(actor: IUser, raw: unknown): Promise<mongoose.Types.ObjectId[] | Invalid> {
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string" || isInvalidObjectId(id))) {
    return bad("departments must be an array of department IDs");
  }
  const ids = [...new Set(raw as string[])];
  if (ids.length > PROJECT_LIMITS.maxDepartments) return bad(`At most ${PROJECT_LIMITS.maxDepartments} departments`);
  if (actor.role === "head" && ids.some((id) => !actor.department || id !== actor.department.toString())) {
    return bad("Heads can only create projects for their own department", 403);
  }
  const count = await Department.countDocuments({ _id: { $in: ids } });
  if (count !== ids.length) return bad("Department not found", 404);
  return ids.map((id) => new mongoose.Types.ObjectId(id));
}

async function parseUserId(raw: unknown, field: string): Promise<mongoose.Types.ObjectId | null | Invalid> {
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string" || isInvalidObjectId(raw)) return bad(`${field} must be a valid user ID or null`);
  if (!(await User.exists({ _id: raw }))) return bad(`${field} user not found`, 404);
  return new mongoose.Types.ObjectId(raw);
}

interface MemberInput {
  user: mongoose.Types.ObjectId;
  hourlyRate: number;
}

/** `team`: [{ role, users[] }] with plan roles or "others"; empty roles are dropped. */
async function parseTeam(raw: unknown): Promise<IProjectTeamEntry[] | Invalid> {
  if (!Array.isArray(raw)) return bad("team must be an array of { role, users }");
  const entries: IProjectTeamEntry[] = [];
  const ids = new Set<string>();
  for (const item of raw as Array<{ role?: unknown; users?: unknown }>) {
    if (!item || typeof item.role !== "string" || !TEAM_ROLE_KEYS.includes(item.role)) return bad("team has an unknown role");
    if (entries.some((e) => e.role === item.role)) return bad(`team role ${item.role} appears twice`);
    if (!Array.isArray(item.users)) return bad("team users must be an array");
    const users: mongoose.Types.ObjectId[] = [];
    for (const u of item.users) {
      if (typeof u !== "string" || isInvalidObjectId(u)) return bad("team must contain valid user IDs");
      if (!users.some((x) => x.toString() === u)) users.push(new mongoose.Types.ObjectId(u));
      ids.add(u);
    }
    if (users.length) entries.push({ role: item.role, users });
  }
  if (ids.size > PROJECT_LIMITS.maxMembers) return bad(`A project can have at most ${PROJECT_LIMITS.maxMembers} members`);
  if (ids.size && (await User.countDocuments({ _id: { $in: [...ids] } })) !== ids.size) return bad("A person on the team doesn't exist", 404);
  return entries;
}

/** Everyone on the team (unique). */
function teamUserIds(team: IProjectTeamEntry[]): mongoose.Types.ObjectId[] {
  const seen = new Map<string, mongoose.Types.ObjectId>();
  for (const e of team) for (const u of e.users) seen.set(u.toString(), u);
  return [...seen.values()];
}

/** `members`: array of user IDs or `{ user, hourlyRate? }`. */
async function parseMembers(raw: unknown): Promise<MemberInput[] | Invalid> {
  if (!Array.isArray(raw)) return bad("members must be an array");
  const byId = new Map<string, MemberInput>();
  for (const item of raw) {
    const input = typeof item === "string" ? { user: item } : ((item ?? {}) as { user?: unknown; hourlyRate?: unknown });
    if (typeof input.user !== "string" || isInvalidObjectId(input.user)) return bad("members must contain valid user IDs");
    const rate = optionalNumber((input as { hourlyRate?: unknown }).hourlyRate, "hourlyRate", PROJECT_LIMITS.maxHourlyRate);
    if (isInvalid(rate)) return rate;
    byId.set(input.user, { user: new mongoose.Types.ObjectId(input.user), hourlyRate: rate ?? 0 });
  }
  if (byId.size > PROJECT_LIMITS.maxMembers) return bad(`A project can have at most ${PROJECT_LIMITS.maxMembers} members`);
  const count = await User.countDocuments({ _id: { $in: [...byId.keys()] } });
  if (count !== byId.size) return bad("Member not found", 404);
  return [...byId.values()];
}

function memberCardRows(project: Pick<IProject, "deadline" | "startDate">): Array<[string, string]> {
  const rows: Array<[string, string]> = [["Start date", formatDueDate(project.startDate) ?? "-"]];
  rows.push(["Deadline", formatDueDate(project.deadline ?? null) ?? "No deadline"]);
  return rows;
}

/**
 * `project_member_added` to the given users (the actor is skipped). Exported for
 * invitation acceptance, where the actor is the inviter (null if since deleted).
 */
export function notifyMembersAdded(
  project: IProject,
  userIds: mongoose.Types.ObjectId[],
  actor: IUser | null,
  sendEmail = true
): void {
  if (userIds.length === 0) return;
  const actorName = actor?.name ?? "An admin";
  notifyUsers({
    recipients: userIds,
    actor,
    type: "project_member_added",
    title: "Added to a project",
    message: `${actorName} added you to ${project.code} · ${project.name}.`,
    link: projectLink(project._id as mongoose.Types.ObjectId),
    project: project._id as mongoose.Types.ObjectId,
    skipEmail: !sendEmail,
    email: {
      subject: `📁 You were added to ${project.name}`,
      heading: "Added to a Project",
      intro: `${actorName} added you to this project.`,
      cardTitle: `${project.code} · ${project.name}`,
      rows: memberCardRows(project),
      quote: project.summary || null,
      buttonLabel: "Open Project",
    },
  });
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

/** `{ project, permissions, stats }` for the detail page. */
export async function loadProjectDetail(projectId: mongoose.Types.ObjectId, user: IUser) {
  const raw = await Project.findById(projectId);
  if (!raw) return null;
  const status = await ProjectStatus.findById(raw.status).select("isCompleted").lean();
  const permissions = projectPermissions(user, raw, { statusCompleted: Boolean(status?.isCompleted) });

  const populated = await Project.findById(projectId).populate(PROJECT_POPULATE);
  if (!populated) return null;
  const [project] = await serializeProjects([populated], user);

  const today = appToday();
  const [counts, logged, overdueTasks, milestones, milestoneTasks] = await Promise.all([
    taskCountsByProject([projectId]),
    loggedTotalsByProject([projectId]),
    Task.countDocuments({ project: projectId, status: { $ne: "completed" }, dueDate: { $lt: today } }),
    Milestone.find({ project: projectId }).sort({ endDate: 1, createdAt: 1 }),
    Task.aggregate<{ _id: mongoose.Types.ObjectId; total: number; completed: number }>([
      { $match: { project: projectId, milestone: { $ne: null } } },
      {
        $group: {
          _id: "$milestone",
          total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
        },
      },
    ]),
  ]);
  const totals = logged.get(projectId.toString());
  const byMilestone = new Map(milestoneTasks.map((m) => [m._id.toString(), m]));

  const stats = {
    taskCounts: counts.get(projectId.toString()) ?? (project!.taskCounts as Record<string, number>),
    overdueTasks,
    loggedMinutes: totals?.minutes ?? 0,
    approvedMinutes: totals?.approvedMinutes ?? 0,
    pendingMinutes: totals?.pendingMinutes ?? 0,
    allocatedMinutes: raw.hoursAllocated ? Math.round(raw.hoursAllocated * 60) : null,
    earnings: canViewRates(user, raw) ? (totals?.earnings ?? 0) : null,
    memberCount: raw.members.length,
    milestones: {
      total: milestones.length,
      completed: milestones.filter((m) => m.status === "complete").length,
      items: milestones.map((m) => {
        const t = byMilestone.get(m._id.toString());
        return {
          _id: m._id,
          title: m.title,
          status: m.status,
          startDate: m.startDate,
          endDate: m.endDate,
          taskCount: t?.total ?? 0,
          completedTaskCount: t?.completed ?? 0,
          progress: m.status === "complete" ? 100 : t && t.total > 0 ? Math.round((t.completed / t.total) * 100) : 0,
        };
      }),
    },
  };

  return { project: project!, permissions, stats };
}

async function respondDetail(res: Response, projectId: mongoose.Types.ObjectId, user: IUser, status = 200): Promise<void> {
  const detail = await loadProjectDetail(projectId, user);
  if (!detail) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  res.status(status).json(detail);
}

// ---------------------------------------------------------------------------
// List / create
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// List / filters / sorting
// ---------------------------------------------------------------------------

export const PROJECT_SORT_FIELDS = ["createdAt", "code", "name", "startDate", "deadline", "progress", "status"] as const;
type ProjectSortField = (typeof PROJECT_SORT_FIELDS)[number];

interface ProjectSort {
  field: ProjectSortField;
  dir: 1 | -1;
}

/** `?sort=<field>&dir=asc|desc` — default newest first. */
function parseProjectSort(req: Request): ProjectSort | Invalid {
  const { sort, dir } = req.query;
  if (dir !== undefined && dir !== "" && dir !== "asc" && dir !== "desc") return bad("dir must be asc or desc");
  if (sort === undefined || sort === "") return { field: "createdAt", dir: dir === "asc" ? 1 : -1 };
  if (typeof sort !== "string" || !PROJECT_SORT_FIELDS.includes(sort as ProjectSortField)) {
    return bad(`sort must be one of: ${PROJECT_SORT_FIELDS.join(", ")}`);
  }
  return { field: sort as ProjectSortField, dir: dir === "desc" ? -1 : 1 };
}

/** `?progress=0-20,21-40,…` → `$or` of progress ranges (lower bound exclusive above 0). */
function parseProgressBuckets(raw: unknown): Record<string, unknown> | null | Invalid {
  if (raw === undefined || raw === "") return null;
  if (typeof raw !== "string") return bad("progress must look like 0-20,21-40");
  const ranges: Record<string, unknown>[] = [];
  for (const part of raw.split(",")) {
    const match = /^\s*(\d{1,3})\s*-\s*(\d{1,3})\s*$/.exec(part);
    const lo = match ? Number(match[1]) : NaN;
    const hi = match ? Number(match[2]) : NaN;
    if (!match || lo > hi || hi > 100) return bad("progress must look like 0-20,21-40 (0-100)");
    // "21-40" also catches 20.x so fractional values never fall between buckets.
    ranges.push({ progress: { ...(lo === 0 ? { $gte: 0 } : { $gt: lo - 1 }), $lte: hi } });
  }
  return ranges.length === 1 ? ranges[0]! : { $or: ranges };
}

/** Strict optional "YYYY-MM-DD" query param. */
function queryDate(raw: unknown, name: string): Date | undefined | Invalid {
  if (raw === undefined || raw === "") return undefined;
  return parseDateOnly(raw) ?? bad(`${name} must be a valid date (YYYY-MM-DD)`);
}

/**
 * Filters shared by GET /api/projects and /export: status, category, department,
 * manager, member, search (name/code/summary), archived=true, pinned=true,
 * deadline=overdue, from/to (start→deadline overlaps; no deadline = open-ended),
 * progress buckets, completed=true (completed status) with optional
 * completedFrom/completedTo (app-timezone days; completion date as on My dashboard,
 * memberOnly, active, deadlineFrom/To, activeFrom/To — see lib/myProjects.ts;
 * see lib/projectCompletion.ts).
 */
async function buildProjectFilter(req: Request): Promise<Record<string, unknown>[] | Invalid> {
  const user = req.user!;
  const and: Record<string, unknown>[] = [projectVisibilityFilter(user)];

  and.push(req.query.archived === "true" ? { archivedAt: { $ne: null } } : { archivedAt: null });

  const idFilters: Array<[unknown, string, string]> = [
    [req.query.status, "status", "status"],
    [req.query.category, "category", "category"],
    [req.query.brand === "none" ? undefined : req.query.brand, "brand", "brand"],
    [req.query.department, "departments", "department"],
    [req.query.manager, "manager", "manager"],
  ];
  for (const [value, field, name] of idFilters) {
    if (value === undefined || value === "") continue;
    if (typeof value !== "string" || isInvalidObjectId(value)) return bad(`${name} must be a valid ID`);
    and.push({ [field]: new mongoose.Types.ObjectId(value) });
  }

  if (req.query.brand === "none") and.push({ brand: null });

  // Structured-name Type ("none" = legacy names) and Month ("YYYY-MM").
  const type = req.query.type;
  if (type !== undefined && type !== "") {
    if (typeof type !== "string" || type.length > 60) return bad("type must be a project type");
    and.push(type === "none" ? { naming: null } : { "naming.type": exactNameRegex(type) });
  }
  const month = req.query.month;
  if (month !== undefined && month !== "") {
    if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return bad("month must be YYYY-MM");
    and.push({ "naming.month": month });
  }

  // Member = on the team or the manager (managers are added as members; legacy
  // data may lack it) — the same "my projects" as My dashboard.
  const member = req.query.member;
  if (member !== undefined && member !== "") {
    if (typeof member !== "string" || isInvalidObjectId(member)) return bad("member must be a valid ID");
    const memberId = new mongoose.Types.ObjectId(member);
    and.push({ $or: [{ "members.user": memberId }, { manager: memberId }] });
  }

  // My dashboard links (Worksuite definitions, lib/myProjects.ts):
  // `memberOnly=<id>` — on the team (members[].user; a manager-only project is excluded);
  // `active=1` — progress ≠ 100; `deadlineFrom/To` — deadline within the days;
  // `activeFrom/To` — active in the days for memberOnly (else the caller).
  const memberOnly = req.query.memberOnly;
  let memberOnlyId: mongoose.Types.ObjectId | null = null;
  if (memberOnly !== undefined && memberOnly !== "") {
    if (typeof memberOnly !== "string" || isInvalidObjectId(memberOnly)) return bad("memberOnly must be a valid ID");
    memberOnlyId = new mongoose.Types.ObjectId(memberOnly);
    and.push({ "members.user": memberOnlyId });
  }
  const active = req.query.active;
  if (active !== undefined && active !== "") {
    if (active !== "1" && active !== "true") return bad("active must be 1 or true");
    and.push({ ...PROGRESS_NOT_DONE });
  }
  const deadlineFrom = queryDate(req.query.deadlineFrom, "deadlineFrom");
  if (isInvalid(deadlineFrom)) return deadlineFrom;
  const deadlineTo = queryDate(req.query.deadlineTo, "deadlineTo");
  if (isInvalid(deadlineTo)) return deadlineTo;
  if (deadlineFrom && deadlineTo && deadlineFrom.getTime() > deadlineTo.getTime()) {
    return bad("deadlineFrom must be on or before deadlineTo");
  }
  if (deadlineFrom || deadlineTo) {
    and.push({
      deadline: { $ne: null, ...(deadlineFrom ? { $gte: deadlineFrom } : {}), ...(deadlineTo ? { $lte: deadlineTo } : {}) },
    });
  }
  const activeFrom = queryDate(req.query.activeFrom, "activeFrom");
  if (isInvalid(activeFrom)) return activeFrom;
  const activeTo = queryDate(req.query.activeTo, "activeTo");
  if (isInvalid(activeTo)) return activeTo;
  if (activeFrom || activeTo) {
    if (!activeFrom || !activeTo) return bad("activeFrom and activeTo go together");
    if (activeFrom.getTime() > activeTo.getTime()) return bad("activeFrom must be on or before activeTo");
    and.push(await activeInRangeFilter(memberOnlyId ?? (user._id as mongoose.Types.ObjectId), activeFrom, activeTo));
  }

  if (req.query.pinned === "true") {
    and.push({ _id: { $in: user.pinnedProjects ?? [] } });
  }

  if (req.query.deadline !== undefined && req.query.deadline !== "") {
    if (req.query.deadline !== "overdue") return bad("deadline must be overdue");
    and.push({ deadline: { $ne: null, $lt: appToday() }, status: { $nin: await completedStatusIds() } });
  }

  const from = queryDate(req.query.from, "from");
  if (isInvalid(from)) return from;
  const to = queryDate(req.query.to, "to");
  if (isInvalid(to)) return to;
  if (from && to && from.getTime() > to.getTime()) return bad("from must be on or before to");
  if (to) and.push({ startDate: { $lte: to } });
  if (from) and.push({ $or: [{ deadline: null }, { deadline: { $gte: from } }] });

  const progress = parseProgressBuckets(req.query.progress);
  if (isInvalid(progress)) return progress;
  if (progress) and.push(progress);

  const search = searchRegex(req.query.search);
  if (search) and.push({ $or: [{ name: search }, { code: search }, { summary: search }] });

  const completed = req.query.completed;
  if (completed !== undefined && completed !== "" && completed !== "true" && completed !== "false") {
    return bad("completed must be true or false");
  }
  const completedFrom = queryDate(req.query.completedFrom, "completedFrom");
  if (isInvalid(completedFrom)) return completedFrom;
  const completedTo = queryDate(req.query.completedTo, "completedTo");
  if (isInvalid(completedTo)) return completedTo;
  if (completedFrom && completedTo && completedFrom.getTime() > completedTo.getTime()) {
    return bad("completedFrom must be on or before completedTo");
  }
  if (completedFrom || completedTo) {
    if (completed === "false") return bad("completedFrom/completedTo require completed=true");
    // Every other filter applies first; only the matching completed projects are dated.
    const ids = await projectIdsCompletedWithin(
      { $and: [...and] },
      {
        start: completedFrom ? appDayStart(completedFrom) : undefined,
        end: completedTo ? appDayStart(addDays(completedTo, 1)) : undefined,
      }
    );
    and.push({ _id: { $in: ids } });
  } else if (completed === "true") {
    and.push({ status: { $in: await completedStatusIds() } });
  } else if (completed === "false") {
    and.push({ status: { $nin: await completedStatusIds() } });
  }

  return and;
}

/** Ids of one page of projects in `sort` order (status = the status's configured order). */
async function sortedProjectIds(
  filter: Record<string, unknown>,
  sort: ProjectSort,
  limit: number | null,
  offset: number
): Promise<mongoose.Types.ObjectId[]> {
  const d = sort.dir;
  const pipeline: PipelineStage[] = [{ $match: filter }];
  let order: Record<string, 1 | -1>;
  switch (sort.field) {
    case "code":
    case "name":
      // Natural, case-insensitive (computed key — see lib/naturalSort.ts).
      pipeline.push({ $addFields: { _sortKey: naturalSortKey(`$${sort.field}`) } });
      order = { _sortKey: d, _id: d };
      break;
    case "startDate":
    case "progress":
      order = { [sort.field]: d, _id: d };
      break;
    case "deadline":
      // No deadline sorts last in either direction.
      pipeline.push({ $addFields: { _missing: { $cond: [{ $eq: [{ $ifNull: ["$deadline", null] }, null] }, 1, 0] } } });
      order = { _missing: 1, deadline: d, _id: d };
      break;
    case "status":
      pipeline.push(
        {
          $lookup: {
            from: ProjectStatus.collection.name,
            localField: "status",
            foreignField: "_id",
            as: "_status",
          },
        },
        {
          $addFields: {
            _statusOrder: { $ifNull: [{ $arrayElemAt: ["$_status.order", 0] }, 9999] },
            _statusName: naturalSortKey({ $arrayElemAt: ["$_status.name", 0] }),
          },
        }
      );
      order = { _statusOrder: d, _statusName: d, _id: d };
      break;
    default:
      order = { createdAt: d, _id: d };
  }
  pipeline.push({ $sort: order });
  if (offset > 0) pipeline.push({ $skip: offset });
  if (limit !== null) pipeline.push({ $limit: limit });
  pipeline.push({ $project: { _id: 1 } });
  const rows = await Project.aggregate<{ _id: mongoose.Types.ObjectId }>(pipeline);
  return rows.map((r) => r._id);
}

/** Populated projects in the given id order. */
async function loadProjectsInOrder(ids: mongoose.Types.ObjectId[]): Promise<IProject[]> {
  if (ids.length === 0) return [];
  const docs = await Project.find({ _id: { $in: ids } }).populate(PROJECT_POPULATE);
  const byId = new Map(docs.map((p) => [String(p._id), p]));
  return ids.flatMap((id) => byId.get(id.toString()) ?? []);
}

/**
 * GET /api/projects — filters: status, category, department, manager, member,
 * search, archived=true, pinned=true, deadline=overdue, from/to, progress;
 * sort/dir; pagination.
 */
export async function listProjects(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const { limit, offset } = parsePagination(req);
  const and = await buildProjectFilter(req);
  if (isInvalid(and)) return send(res, and);
  const sort = parseProjectSort(req);
  if (isInvalid(sort)) return send(res, sort);

  const filter = { $and: and };
  const [ids, total] = await Promise.all([sortedProjectIds(filter, sort, limit, offset), Project.countDocuments(filter)]);
  const projects = await loadProjectsInOrder(ids);
  res.json({ projects: await serializeProjects(projects, user), total, limit, offset });
}

/**
 * GET /api/projects/export — CSV of the list filters + sort, or `?ids=a,b,c`
 * (still limited to visible projects; archived and active alike). UTF-8 BOM,
 * capped at 5000 rows.
 */
export async function exportProjects(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const sort = parseProjectSort(req);
  if (isInvalid(sort)) return send(res, sort);

  let and: Record<string, unknown>[];
  const ids = parseIdList(req.query.ids);
  if (ids) {
    if (ids.length === 0 || ids.some((id) => isInvalidObjectId(id))) {
      return send(res, bad("ids must be a comma-separated list of project IDs"));
    }
    if (ids.length > EXPORT_ROW_LIMIT) return send(res, bad(`At most ${EXPORT_ROW_LIMIT} ids can be exported`));
    and = [projectVisibilityFilter(user), { _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } }];
  } else {
    const built = await buildProjectFilter(req);
    if (isInvalid(built)) return send(res, built);
    and = built;
  }

  const filter = { $and: and };
  const [pageIds, total] = await Promise.all([
    sortedProjectIds(filter, sort, EXPORT_ROW_LIMIT, 0),
    Project.countDocuments(filter),
  ]);
  type Row = Omit<IProject, "status" | "category" | "brand" | "manager" | "departments" | "members"> & {
    status?: { name?: string } | null;
    category?: { name?: string } | null;
    brand?: { name?: string } | null;
    manager?: { name?: string } | null;
    departments: Array<{ name?: string }>;
    members: Array<{ user?: { name?: string } | null }>;
  };
  const docs = await Project.find({ _id: { $in: pageIds } })
    .populate([
      { path: "status", select: "name" },
      { path: "category", select: "name" },
      { path: "brand", select: "name" },
      { path: "manager", select: "name" },
      { path: "departments", select: "name" },
      { path: "members.user", select: "name" },
    ])
    .lean<Row[]>();
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  const [counts, logged] = await Promise.all([taskCountsByProject(pageIds), loggedTotalsByProject(pageIds)]);

  const headers = [
    "Code",
    "Project",
    "Category",
    "Brand",
    "Departments",
    "Manager",
    "Members",
    "Start date",
    "Deadline",
    "Status",
    "Progress (%)",
    "Tasks",
    "Open tasks",
    "Hours logged",
    "Archived",
    "Type",
    "Month",
    "Name part",
  ];
  const rows = pageIds.flatMap((id) => {
    const p = byId.get(id.toString());
    if (!p) return [];
    const c = counts.get(id.toString());
    return [
      [
        p.code,
        p.name,
        p.category?.name ?? "",
        p.brand?.name ?? "",
        p.departments.map((d) => d.name ?? "").filter(Boolean).join("; "),
        p.manager?.name ?? "",
        p.members.map((m) => m.user?.name ?? "").filter(Boolean).join("; "),
        csvDate(p.startDate),
        csvDate(p.deadline),
        p.status?.name ?? "",
        p.progress,
        c?.total ?? 0,
        c?.open ?? 0,
        csvHours(logged.get(id.toString())?.minutes ?? 0),
        p.archivedAt ? "Yes" : "No",
        p.naming?.type ?? "",
        p.naming?.month ?? "",
        p.naming?.title ?? "",
      ],
    ];
  });

  sendCsv(res, "projects", toCsv(headers, rows), { rows: rows.length, total });
}

const BULK_LIMIT = 200;
const PROJECT_BULK_ACTIONS = ["status", "archive", "restore", "delete"] as const;
type ProjectBulkAction = (typeof PROJECT_BULK_ACTIONS)[number];

/**
 * POST /api/projects/bulk — `{ ids (≤200), action: "status" | "archive" |
 * "restore" | "delete", status? }` → `{ updated, updatedIds, skipped: [{ id, reason }] }`.
 * Each project goes through the same function as the single endpoint
 * (permission checks, activity, notifications, SSE).
 */
export async function bulkProjects(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const body = (req.body ?? {}) as { ids?: unknown; action?: unknown; status?: unknown };
  if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.some((id) => typeof id !== "string" || isInvalidObjectId(id))) {
    return send(res, bad("ids must be a non-empty array of project IDs"));
  }
  const ids = [...new Set(body.ids as string[])];
  if (ids.length > BULK_LIMIT) return send(res, bad(`At most ${BULK_LIMIT} projects can be updated at once`));
  if (typeof body.action !== "string" || !PROJECT_BULK_ACTIONS.includes(body.action as ProjectBulkAction)) {
    return send(res, bad(`action must be one of: ${PROJECT_BULK_ACTIONS.join(", ")}`));
  }
  const action = body.action as ProjectBulkAction;
  let statusId: mongoose.Types.ObjectId | null = null;
  if (action === "status") {
    const parsed = await parseStatus(body.status);
    if (isInvalid(parsed)) return send(res, parsed);
    statusId = parsed;
  }
  if (action === "delete" && actor.role !== "admin") {
    return send(res, bad("Only admins can delete projects", 403));
  }

  const projects = await Project.find({ _id: { $in: ids } });
  const byId = new Map(projects.map((p) => [String(p._id), p]));
  const updatedIds: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const id of ids) {
    const project = byId.get(id);
    if (!project || !canViewProject(actor, project)) {
      skipped.push({ id, reason: "Project not found" });
      continue;
    }
    try {
      let result: Invalid | null;
      if (action === "status") {
        if (project.status.equals(statusId!)) {
          skipped.push({ id, reason: "Already in this status" });
          continue;
        }
        result = await applyProjectStatus(actor, project, statusId!, req.ip);
      } else if (action === "archive") result = await applyArchive(actor, project, req.ip);
      else if (action === "restore") result = await applyRestore(actor, project, req.ip);
      else result = await applyProjectDelete(actor, project, req.ip);
      if (result) skipped.push({ id, reason: result.error });
      else updatedIds.push(id);
    } catch (err) {
      console.error("[projects] bulk item failed", id, err);
      skipped.push({ id, reason: "Unexpected error" });
    }
  }
  res.json({ updated: updatedIds.length, updatedIds, skipped });
}


export interface ProjectBody {
  /** Legacy free-text name (imports / legacy projects only). */
  name?: unknown;
  /** Structured name parts `{ brand, type, month, title }` (required on create). */
  naming?: unknown;
  code?: unknown;
  summary?: unknown;
  category?: unknown;
  brand?: unknown;
  departments?: unknown;
  manager?: unknown;
  members?: unknown;
  status?: unknown;
  startDate?: unknown;
  deadline?: unknown;
  progressMode?: unknown;
  progress?: unknown;
  hoursAllocated?: unknown;
  budget?: unknown;
  isPublic?: unknown;
  manualTimeLogs?: unknown;
  requireTaskApproval?: unknown;
  /** [{ role, users[] }] — the role-based team; its people are added as members. */
  team?: unknown;
}

function parseName(raw: unknown): string | Invalid {
  if (typeof raw !== "string" || !raw.trim()) return bad("name is required");
  if (raw.trim().length > PROJECT_LIMITS.nameMax) return bad(`name must be ${PROJECT_LIMITS.nameMax} characters or fewer`);
  return raw.trim();
}

function parseSummary(raw: unknown): string | undefined | Invalid {
  if (raw === undefined || raw === null) return raw === null ? "" : undefined;
  if (typeof raw !== "string" || raw.trim().length > PROJECT_LIMITS.summaryMax) {
    return bad(`summary must be ${PROJECT_LIMITS.summaryMax} characters or fewer`);
  }
  return raw.trim();
}

function parseProgress(raw: unknown): number | undefined | Invalid {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 100) return bad("progress must be between 0 and 100");
  return Math.round(raw);
}

export interface ProjectWriteOptions {
  /** false = in-app notifications only, no emails (bulk imports). Default true. */
  sendEmail?: boolean;
  /** Extra details for the project activity / audit entries (e.g. the import job). */
  activityExtra?: Record<string, unknown>;
  /** Create with a free-text `name` when `naming` is absent (Excel import, with a warning). */
  allowLegacyName?: boolean;
}

/**
 * Creates a project (POST /api/projects and imports share this path):
 * permission, validation, code uniqueness, default status, progress, activity,
 * `project_member_added` notifications and SSE.
 */
export async function createProjectCore(
  actor: IUser,
  body: ProjectBody,
  ip: string | undefined,
  options: ProjectWriteOptions = {}
): Promise<Invalid | { project: IProject }> {
  if (!canCreateProject(actor)) {
    return bad("Only admins and department heads can create projects", 403);
  }

  let name: string;
  let naming: IProjectNaming | null = null;
  if (body.naming !== undefined && body.naming !== null) {
    const parsed = await parseNaming(body.naming);
    if (isInvalid(parsed)) return parsed;
    ({ name, naming } = parsed);
  } else if (options.allowLegacyName) {
    const parsed = parseName(body.name);
    if (isInvalid(parsed)) return parsed;
    name = parsed;
  } else {
    return bad("Project brand, type, month and name are required");
  }
  const code = parseCode(body.code);
  if (isInvalid(code)) return code;
  const summary = parseSummary(body.summary);
  if (isInvalid(summary)) return summary;

  let category: mongoose.Types.ObjectId | null = null;
  if (body.category !== undefined) {
    const parsed = await parseCategory(body.category);
    if (isInvalid(parsed)) return parsed;
    category = parsed;
  }

  let brand: mongoose.Types.ObjectId | null = naming?.brand ?? null;
  if (body.brand !== undefined && !naming) {
    const parsed = await parseBrand(body.brand);
    if (isInvalid(parsed)) return parsed;
    brand = parsed;
  }

  let departments: mongoose.Types.ObjectId[] = actor.role === "head" && actor.department ? [actor.department] : [];
  if (body.departments !== undefined) {
    const parsed = await parseDepartments(actor, body.departments);
    if (isInvalid(parsed)) return parsed;
    departments = parsed.length > 0 || actor.role === "admin" ? parsed : departments;
  }

  let manager: mongoose.Types.ObjectId | null = null;
  if (body.manager !== undefined) {
    const parsed = await parseUserId(body.manager, "manager");
    if (isInvalid(parsed)) return parsed;
    manager = parsed;
  }

  let members: MemberInput[] = [];
  if (body.members !== undefined) {
    const parsed = await parseMembers(body.members);
    if (isInvalid(parsed)) return parsed;
    members = parsed;
  }
  if (manager && !members.some((m) => m.user.equals(manager!))) members.push({ user: manager, hourlyRate: 0 });
  let team: IProjectTeamEntry[] = [];
  if (body.team !== undefined) {
    const parsed = await parseTeam(body.team);
    if (isInvalid(parsed)) return parsed;
    team = parsed;
    for (const u of teamUserIds(team)) if (!members.some((m) => m.user.equals(u))) members.push({ user: u, hourlyRate: 0 });
    if (members.length > PROJECT_LIMITS.maxMembers) return bad(`A project can have at most ${PROJECT_LIMITS.maxMembers} members`);
  }

  let status: mongoose.Types.ObjectId;
  if (body.status !== undefined) {
    const parsed = await parseStatus(body.status);
    if (isInvalid(parsed)) return parsed;
    status = parsed;
  } else {
    status = (await getDefaultProjectStatus())._id as mongoose.Types.ObjectId;
  }

  const startDate = optionalDate(body.startDate, "startDate");
  if (isInvalid(startDate)) return startDate;
  const rawDeadline = optionalDate(body.deadline, "deadline");
  if (isInvalid(rawDeadline)) return rawDeadline;
  // The month is the project's period: without explicit dates, start/end are its first/last day.
  const bounds = naming ? monthBounds(naming.month) : null;
  const start = startDate ?? bounds?.start ?? appToday();
  const deadline = rawDeadline === undefined ? (bounds?.end ?? null) : rawDeadline;
  if (deadline && deadline.getTime() < start.getTime()) return bad("deadline must be on or after startDate");

  let progressMode: ProgressMode = "task_completion";
  if (body.progressMode !== undefined) {
    if (typeof body.progressMode !== "string" || !PROGRESS_MODES.includes(body.progressMode as ProgressMode)) {
      return bad(`progressMode must be one of: ${PROGRESS_MODES.join(", ")}`);
    }
    progressMode = body.progressMode as ProgressMode;
  }
  const progress = parseProgress(body.progress);
  if (isInvalid(progress)) return progress;
  const hoursAllocated = optionalNumber(body.hoursAllocated, "hoursAllocated", 1_000_000);
  if (isInvalid(hoursAllocated)) return hoursAllocated;
  const budget = optionalNumber(body.budget, "budget", 1_000_000_000_000);
  if (isInvalid(budget)) return budget;
  const isPublic = optionalBoolean(body.isPublic, "isPublic");
  if (isInvalid(isPublic)) return isPublic;
  const manualTimeLogs = optionalBoolean(body.manualTimeLogs, "manualTimeLogs");
  if (isInvalid(manualTimeLogs)) return manualTimeLogs;
  const requireTaskApproval = optionalBoolean(body.requireTaskApproval, "requireTaskApproval");
  if (isInvalid(requireTaskApproval)) return requireTaskApproval;

  const clash = await ensureUniqueName(name);
  if (clash) return clash;

  let project: IProject;
  try {
    project = await Project.create({
      name,
      naming,
      code,
      summary: summary || undefined,
      category,
      brand,
      departments,
      manager,
      members: members.map((m) => ({ user: m.user, hourlyRate: m.hourlyRate, addedAt: new Date() })),
      team,
      status,
      startDate: start,
      deadline: deadline ?? null,
      progressMode,
      progress: progressMode === "manual" ? (progress ?? 0) : 0,
      hoursAllocated: hoursAllocated ?? null,
      budget: budget ?? null,
      isPublic: isPublic ?? false,
      manualTimeLogs: manualTimeLogs ?? true,
      requireTaskApproval: requireTaskApproval ?? true,
      createdBy: actor._id,
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) return bad(`Project code "${code}" is already in use`, 409);
    throw error;
  }
  const projectId = project._id as mongoose.Types.ObjectId;

  await recalcProjectProgress(projectId);
  recordProjectActivity(projectId, actor, "created", { name, code, members: members.length, ...options.activityExtra });
  logActivity({
    action: "project_created",
    actor,
    targetType: "project",
    targetId: projectId,
    targetName: `${code} · ${name}`,
    details: { members: members.length, departments: departments.length, ...options.activityExtra },
    ip,
  });
  notifyMembersAdded(project, members.map((m) => m.user), actor, options.sendEmail !== false);
  pushProjectUpdate(project, "created", { actorId: actor._id.toString() });
  scheduleProjectTag(projectId);
  return { project };
}

/** POST /api/projects — admin, or a head for their own department. */
export async function createProject(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const result = await createProjectCore(actor, (req.body ?? {}) as ProjectBody, req.ip);
  if (isInvalid(result)) return send(res, result);
  await respondDetail(res, result.project._id as mongoose.Types.ObjectId, actor, 201);
}

/**
 * GET /api/projects/:id/naming-suggestion — the four name parts to pre-fill the
 * edit form: the stored ones, or (legacy name) the brand from Project.brand and
 * type / month / name detected from the old name. The month falls back to the
 * start date's month (`monthSource: "startDate"`).
 */
export async function getNamingSuggestion(req: Request, res: Response): Promise<void> {
  const project = await getViewableProjectOr404(req, res);
  if (!project) return;
  if (project.naming) {
    res.json({
      suggestion: {
        brand: project.naming.brand.toString(),
        type: project.naming.type,
        month: project.naming.month,
        title: project.naming.title,
        legacy: false,
        monthSource: "naming",
        typeDetected: true,
      },
    });
    return;
  }
  const [types, brand] = await Promise.all([
    getProjectTypes(),
    project.brand ? Brand.findById(project.brand).select("name").lean<{ name: string }>() : null,
  ]);
  const start = project.startDate;
  const detected = detectLegacyNaming(project.name, types, brand?.name ?? null, start.getUTCFullYear());
  const startMonth = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
  res.json({
    suggestion: {
      brand: project.brand ? project.brand.toString() : null,
      type: detected.type,
      month: detected.month ?? startMonth,
      title: detected.title,
      legacy: true,
      monthSource: detected.month ? "name" : "startDate",
      typeDetected: Boolean(detected.type),
    },
  });
}

/** GET /api/projects/:id — `{ project, permissions, stats }`. */
export async function getProject(req: Request, res: Response): Promise<void> {
  const project = await getViewableProjectOr404(req, res);
  if (!project) return;
  await respondDetail(res, project._id as mongoose.Types.ObjectId, req.user!);
}

/**
 * Updates the given fields of a project (PATCH /api/projects/:id and imports in
 * "Update" mode): permission, validation, activity, notifications, SSE.
 * Status is not changed here (see `applyProjectStatus`).
 */
export async function updateProjectCore(
  actor: IUser,
  project: IProject,
  body: ProjectBody,
  ip: string | undefined,
  options: ProjectWriteOptions = {}
): Promise<Invalid | { changed: string[] }> {
  if (!canManageProject(actor, project)) {
    return bad("Only the project manager, its creator or an admin can edit this project", 403);
  }
  if (project.archivedAt) return bad("This project is archived and read-only. Restore it first.", 409);
  const changed: string[] = [];
  let newManager: mongoose.Types.ObjectId | null = null;
  const newTeamMembers: mongoose.Types.ObjectId[] = [];

  // Name: `naming` converts a legacy name / changes the parts; a brand change on a
  // structured project re-composes the name; a plain `name` only for legacy projects.
  const monthBefore = project.naming?.month ?? null;
  let namingInput: unknown = body.naming;
  if (namingInput === undefined && project.naming && body.brand !== undefined) {
    if (body.brand === null || body.brand === "") return bad("Brand is required for a structured project name");
    const current = project.naming;
    namingInput = { brand: body.brand, type: current.type, month: current.month, title: current.title };
  }
  if (namingInput === null) return bad("naming can't be cleared");
  if (namingInput !== undefined) {
    const parsed = await parseNaming(namingInput, { naming: project.naming ?? null, brand: project.brand ?? null });
    if (isInvalid(parsed)) return parsed;
    const before = project.naming;
    const namingChanged =
      !before ||
      !before.brand.equals(parsed.naming.brand) ||
      before.type !== parsed.naming.type ||
      before.month !== parsed.naming.month ||
      before.title !== parsed.naming.title;
    if (namingChanged) {
      project.naming = parsed.naming;
      changed.push("naming");
    }
    if (parsed.name !== project.name) {
      const clash = await ensureUniqueName(parsed.name, project._id as mongoose.Types.ObjectId);
      if (clash) return clash;
      project.name = parsed.name;
      changed.push("name");
    }
    if (String(project.brand ?? "") !== String(parsed.naming.brand)) {
      project.brand = parsed.naming.brand;
      changed.push("brand");
    }
  } else if (body.name !== undefined) {
    const name = parseName(body.name);
    if (isInvalid(name)) return name;
    if (name !== project.name) {
      if (project.naming) {
        return bad("This project uses a structured name — change its brand, type, month or name instead");
      }
      const clash = await ensureUniqueName(name, project._id as mongoose.Types.ObjectId);
      if (clash) return clash;
      project.name = name;
      changed.push("name");
    }
  }
  if (body.code !== undefined) {
    const code = parseCode(body.code);
    if (isInvalid(code)) return code;
    // Existing task short codes are never rewritten — only new tasks use the new code.
    if (code !== project.code) {
      project.code = code;
      changed.push("code");
    }
  }
  if (body.summary !== undefined) {
    const summary = parseSummary(body.summary);
    if (isInvalid(summary)) return summary;
    project.summary = summary || undefined;
    changed.push("summary");
  }
  if (body.category !== undefined) {
    const category = await parseCategory(body.category);
    if (isInvalid(category)) return category;
    project.category = category;
    changed.push("category");
  }
  if (body.brand !== undefined && namingInput === undefined) {
    const brand = await parseBrand(body.brand, project.brand ?? null);
    if (isInvalid(brand)) return brand;
    if (String(brand ?? "") !== String(project.brand ?? "")) {
      project.brand = brand;
      changed.push("brand");
    }
  }
  if (body.departments !== undefined) {
    const departments = await parseDepartments(actor, body.departments);
    if (isInvalid(departments)) return departments;
    project.departments = departments;
    changed.push("departments");
  }
  if (body.manager !== undefined) {
    const manager = await parseUserId(body.manager, "manager");
    if (isInvalid(manager)) return manager;
    const before = project.manager ? project.manager.toString() : null;
    if ((manager ? manager.toString() : null) !== before) {
      project.manager = manager;
      changed.push("manager");
      if (manager && !isProjectMember(manager, project)) {
        project.members.push({ user: manager, hourlyRate: 0, addedAt: new Date() });
        newManager = manager;
      }
    }
  }

  if (body.team !== undefined) {
    const team = await parseTeam(body.team);
    if (isInvalid(team)) return team;
    project.team = team;
    project.markModified("team");
    changed.push("team");
    for (const u of teamUserIds(team)) {
      if (isProjectMember(u, project)) continue;
      project.members.push({ user: u, hourlyRate: 0, addedAt: new Date() });
      newTeamMembers.push(u);
    }
    if (project.members.length > PROJECT_LIMITS.maxMembers) {
      return bad(`A project can have at most ${PROJECT_LIMITS.maxMembers} members`);
    }
  }

  const startDate = optionalDate(body.startDate, "startDate");
  if (isInvalid(startDate)) return startDate;
  const deadline = optionalDate(body.deadline, "deadline");
  if (isInvalid(deadline)) return deadline;
  if (startDate === null) return bad("startDate cannot be cleared");
  const nextStart = startDate ?? project.startDate;
  const nextDeadline = deadline === undefined ? (project.deadline ?? null) : deadline;
  if (nextDeadline && nextDeadline.getTime() < nextStart.getTime()) {
    return bad("deadline must be on or after startDate");
  }
  if (startDate) {
    project.startDate = startDate;
    changed.push("startDate");
  }
  if (deadline !== undefined) {
    project.deadline = deadline;
    project.lastDeadlineReminderOn = null;
    changed.push("deadline");
  }
  // Month changed and no explicit dates: the dates follow the new month.
  if (
    project.naming &&
    project.naming.month !== monthBefore &&
    body.startDate === undefined &&
    body.deadline === undefined
  ) {
    const bounds = monthBounds(project.naming.month);
    project.startDate = bounds.start;
    project.deadline = bounds.end;
    project.lastDeadlineReminderOn = null;
    changed.push("startDate", "deadline");
  }

  if (body.progressMode !== undefined) {
    if (typeof body.progressMode !== "string" || !PROGRESS_MODES.includes(body.progressMode as ProgressMode)) {
      return bad(`progressMode must be one of: ${PROGRESS_MODES.join(", ")}`);
    }
    project.progressMode = body.progressMode as ProgressMode;
    changed.push("progressMode");
  }
  const progress = parseProgress(body.progress);
  if (isInvalid(progress)) return progress;
  if (progress !== undefined) {
    if (project.progressMode !== "manual") return bad("progress can only be set in manual progress mode");
    project.progress = progress;
    changed.push("progress");
  }

  const numericFields: Array<["hoursAllocated" | "budget", number]> = [
    ["hoursAllocated", 1_000_000],
    ["budget", 1_000_000_000_000],
  ];
  for (const [field, max] of numericFields) {
    const value = optionalNumber(body[field], field, max);
    if (isInvalid(value)) return value;
    if (value !== undefined) {
      project[field] = value;
      changed.push(field);
    }
  }
  const booleanFields = ["isPublic", "manualTimeLogs", "requireTaskApproval"] as const;
  for (const field of booleanFields) {
    const value = optionalBoolean(body[field], field);
    if (isInvalid(value)) return value;
    if (value !== undefined) {
      project[field] = value;
      changed.push(field);
    }
  }

  if (changed.length === 0) return bad("At least one field to update is required");

  try {
    await project.save();
  } catch (error) {
    if (isDuplicateKeyError(error)) return bad(`Project code "${project.code}" is already in use`, 409);
    throw error;
  }
  const projectId = project._id as mongoose.Types.ObjectId;

  await recalcProjectProgress(projectId);
  recordProjectActivity(projectId, actor, "updated", { fields: changed, ...options.activityExtra });
  if (changed.includes("manager")) {
    recordProjectActivity(projectId, actor, "manager_changed", { manager: project.manager?.toString() ?? null });
  }
  logActivity({
    action: "project_updated",
    actor,
    targetType: "project",
    targetId: projectId,
    targetName: `${project.code} · ${project.name}`,
    details: { fields: changed, ...options.activityExtra },
    ip,
  });
  const added = [...(newManager ? [newManager] : []), ...newTeamMembers.filter((u) => !newManager?.equals(u))];
  if (added.length) notifyMembersAdded(project, added, actor, options.sendEmail !== false);
  pushProjectUpdate(project, "updated", { fields: changed, actorId: actor._id.toString() });
  if (changed.some((f) => f === "naming" || f === "name" || f === "brand")) scheduleProjectTag(projectId, true);
  return { changed };
}

/** PATCH /api/projects/:id — manager/creator/admin. Status uses PATCH /:id/status. */
export async function updateProject(req: Request, res: Response): Promise<void> {
  const project = await getProjectOr404(req, res);
  if (!project) return;
  const actor = req.user!;
  if (!canManageProject(actor, project)) {
    res.status(403).json({ error: "Only the project manager, its creator or an admin can edit this project" });
    return;
  }
  if (!ensureNotArchived(project, res)) return;
  const result = await updateProjectCore(actor, project, (req.body ?? {}) as ProjectBody, req.ip);
  if (isInvalid(result)) return send(res, result);
  await respondDetail(res, project._id as mongoose.Types.ObjectId, actor);
}

const ARCHIVED_READ_ONLY = "This project is archived and read-only. Restore it first.";

/** Who may change a project's status (and whether it is writable). */
function statusGate(actor: IUser, project: IProject): Invalid | null {
  if (!canManageProject(actor, project)) {
    return bad("Only the project manager, its creator or an admin can change the status", 403);
  }
  if (project.archivedAt) return bad(ARCHIVED_READ_ONLY, 409);
  return null;
}

/**
 * Changes a project's status (PATCH /:id/status and bulk "status"): permission,
 * activity, notifications, SSE. Completed statuses set progress to 100.
 */
export async function applyProjectStatus(
  actor: IUser,
  project: IProject,
  statusId: mongoose.Types.ObjectId,
  ip: string | undefined,
  options: { sendEmail?: boolean } = {}
): Promise<Invalid | null> {
  const gate = statusGate(actor, project);
  if (gate) return gate;
  const projectId = project._id as mongoose.Types.ObjectId;
  if (project.status.equals(statusId)) return null;

  const [from, to] = await Promise.all([
    ProjectStatus.findById(project.status).select("name").lean(),
    ProjectStatus.findById(statusId).select("name isCompleted").lean(),
  ]);
  project.status = statusId;
  if (to?.isCompleted) project.progress = 100;
  await project.save();
  await recalcProjectProgress(projectId);

  recordProjectActivity(projectId, actor, "status_changed", { from: from?.name ?? null, to: to?.name ?? null });
  logActivity({
    action: "project_updated",
    actor,
    targetType: "project",
    targetId: projectId,
    targetName: `${project.code} · ${project.name}`,
    details: { fields: ["status"], from: from?.name, to: to?.name },
    ip,
  });

  // Manager, members and admins (Worksuite skipped admins) — never the actor.
  const admins = await User.find({ role: "admin" }).select("_id").lean();
  notifyUsers({
    recipients: [
      ...(project.manager ? [project.manager] : []),
      ...project.members.map((m) => m.user),
      ...admins.map((a) => a._id),
    ],
    actor,
    type: "project_status_changed",
    title: "Project status changed",
    message: `${actor.name} moved ${project.code} · ${project.name} from ${from?.name ?? "-"} to ${to?.name ?? "-"}.`,
    link: projectLink(projectId),
    project: projectId,
    skipEmail: options.sendEmail === false,
    email: {
      subject: `🔄 ${project.name}: ${to?.name ?? "status changed"}`,
      heading: "Project Status Changed",
      intro: `${actor.name} changed the status of this project.`,
      cardTitle: `${project.code} · ${project.name}`,
      rows: [
        ["From", from?.name ?? "-"],
        ["To", to?.name ?? "-"],
      ],
      buttonLabel: "Open Project",
    },
  });
  pushProjectUpdate(project, "status-changed", { status: statusId.toString(), actorId: actor._id.toString() });
  return null;
}

/** PATCH /api/projects/:id/status — `{ status }`. Completed statuses set progress to 100. */
export async function updateProjectStatus(req: Request, res: Response): Promise<void> {
  const project = await getProjectOr404(req, res);
  if (!project) return;
  const actor = req.user!;
  const gate = statusGate(actor, project);
  if (gate) return send(res, gate);
  const statusId = await parseStatus((req.body ?? {}).status);
  if (isInvalid(statusId)) return send(res, statusId);
  const result = await applyProjectStatus(actor, project, statusId, req.ip);
  if (result) return send(res, result);
  await respondDetail(res, project._id as mongoose.Types.ObjectId, actor);
}

/** Archives a project (POST /:id/archive and bulk "archive"): stops running timers, hides tasks from boards. */
async function applyArchive(actor: IUser, project: IProject, ip: string | undefined): Promise<Invalid | null> {
  if (!canManageProject(actor, project)) {
    return bad("Only the project manager, its creator or an admin can archive this project", 403);
  }
  if (project.archivedAt) return bad("Project is already archived", 409);
  project.archivedAt = new Date();
  await project.save();
  const projectId = project._id as mongoose.Types.ObjectId;
  const stopped = await stopTimersWhere({ project: projectId }, actor);

  recordProjectActivity(projectId, actor, "archived", { timersStopped: stopped });
  logActivity({
    action: "project_archived",
    actor,
    targetType: "project",
    targetId: projectId,
    targetName: `${project.code} · ${project.name}`,
    details: { timersStopped: stopped },
    ip,
  });
  pushProjectUpdate(project, "archived", { actorId: actor._id.toString() });
  return null;
}

/** POST /api/projects/:id/archive — stops running timers, hides tasks from boards. */
export async function archiveProject(req: Request, res: Response): Promise<void> {
  const project = await getProjectOr404(req, res);
  if (!project) return;
  const result = await applyArchive(req.user!, project, req.ip);
  if (result) return send(res, result);
  await respondDetail(res, project._id as mongoose.Types.ObjectId, req.user!);
}

/** Restores an archived project (POST /:id/restore and bulk "restore"). */
async function applyRestore(actor: IUser, project: IProject, ip: string | undefined): Promise<Invalid | null> {
  if (!canManageProject(actor, project)) {
    return bad("Only the project manager, its creator or an admin can restore this project", 403);
  }
  if (!project.archivedAt) return bad("Project is not archived", 409);
  if (project.naming) {
    const clash = await ensureUniqueName(project.name, project._id as mongoose.Types.ObjectId);
    if (clash) return bad(`${clash.error} — rename one of them first`, 409);
  }
  project.archivedAt = null;
  await project.save();
  const projectId = project._id as mongoose.Types.ObjectId;
  recordProjectActivity(projectId, actor, "restored");
  logActivity({
    action: "project_updated",
    actor,
    targetType: "project",
    targetId: projectId,
    targetName: `${project.code} · ${project.name}`,
    details: { restored: true },
    ip,
  });
  pushProjectUpdate(project, "restored", { actorId: actor._id.toString() });
  return null;
}

/** POST /api/projects/:id/restore. */
export async function restoreProject(req: Request, res: Response): Promise<void> {
  const project = await getProjectOr404(req, res);
  if (!project) return;
  const result = await applyRestore(req.user!, project, req.ip);
  if (result) return send(res, result);
  await respondDetail(res, project._id as mongoose.Types.ObjectId, req.user!);
}

/** Deletes tasks with their comments, files (GridFS), history and notifications. */
async function deleteTasksCascade(taskIds: mongoose.Types.ObjectId[]): Promise<void> {
  if (taskIds.length === 0) return;
  const files = await TaskFile.find({ task: { $in: taskIds } }).select("gridFsId");
  await Promise.all([
    Task.deleteMany({ _id: { $in: taskIds } }),
    TaskComment.deleteMany({ task: { $in: taskIds } }),
    TaskFile.deleteMany({ task: { $in: taskIds } }),
    TaskHistory.deleteMany({ task: { $in: taskIds } }),
    Notification.deleteMany({ task: { $in: taskIds } }),
    WeeklyTimesheet.updateMany({ "entries.task": { $in: taskIds } }, { $pull: { entries: { task: { $in: taskIds } } } }),
    User.updateMany({ pinnedTasks: { $in: taskIds } }, { $pull: { pinnedTasks: { $in: taskIds } } }),
  ]);
  for (const f of files) await deleteFromGridFs(f.gridFsId);
}

/**
 * Deletes an archived project with everything in it (DELETE /:id and bulk
 * "delete"). Admin only. Returns what was removed.
 */
async function applyProjectDelete(
  actor: IUser,
  project: IProject,
  ip: string | undefined
): Promise<Invalid | null> {
  const result = await deleteProjectCascade(actor, project, ip);
  return isInvalid(result) ? result : null;
}

async function deleteProjectCascade(
  actor: IUser,
  project: IProject,
  ip: string | undefined
): Promise<Invalid | { tasks: number; timeLogs: number; files: number }> {
  if (actor.role !== "admin") return bad("Only admins can delete projects", 403);
  if (!project.archivedAt) return bad("Archive the project before deleting it", 409);
  const projectId = project._id as mongoose.Types.ObjectId;
  const audience = { ...project.toObject(), _id: projectId } as unknown as IProject;

  const tasks = await Task.find({ project: projectId }).select("_id");
  const files = await ProjectFile.find({ project: projectId }).select("gridFsId");
  await deleteTasksCascade(tasks.map((t) => t._id as mongoose.Types.ObjectId));
  const logs = await TimeLog.deleteMany({ project: projectId });
  await Promise.all([
    ProjectFile.deleteMany({ project: projectId }),
    ProjectNote.deleteMany({ project: projectId }),
    ProjectActivity.deleteMany({ project: projectId }),
    Milestone.deleteMany({ project: projectId }),
    Notification.deleteMany({ project: projectId }),
    User.updateMany({ pinnedProjects: projectId }, { $pull: { pinnedProjects: projectId } }),
    // Meetings are kept, but become private to their creator and admins.
    Meeting.updateMany({ project: projectId }, { $set: { project: null } }),
  ]);
  for (const f of files) await deleteFromGridFs(f.gridFsId);
  await Project.deleteOne({ _id: projectId });

  logActivity({
    action: "project_deleted",
    actor,
    targetType: "project",
    targetId: projectId,
    targetName: `${project.code} · ${project.name}`,
    details: { tasks: tasks.length, timeLogs: logs.deletedCount, files: files.length },
    ip,
  });
  pushProjectUpdate(audience, "deleted", { actorId: actor._id.toString() });
  return { tasks: tasks.length, timeLogs: logs.deletedCount, files: files.length };
}

/** DELETE /api/projects/:id — admin only, archived projects only. Cascades everything. */
export async function deleteProject(req: Request, res: Response): Promise<void> {
  const project = await getProjectOr404(req, res);
  if (!project) return;
  const result = await deleteProjectCascade(req.user!, project, req.ip);
  if (isInvalid(result)) return send(res, result);
  res.json({ success: true, deleted: result });
}

/**
 * POST /api/projects/:id/duplicate — `{ name, code, includeTasks?, startDate?, deadline? }`.
 * Copies settings, members and milestones (as incomplete); tasks (with
 * subtasks) get new short codes and go back to `todo`.
 */
export async function duplicateProject(req: Request, res: Response): Promise<void> {
  const source = await getViewableProjectOr404(req, res);
  if (!source) return;
  const actor = req.user!;
  if (!canCreateProject(actor)) {
    res.status(403).json({ error: "Only admins and department heads can create projects" });
    return;
  }
  if (!canManageProject(actor, source)) {
    res.status(403).json({ error: "Only the project manager, its creator or an admin can duplicate this project" });
    return;
  }
  const body = (req.body ?? {}) as {
    name?: unknown;
    naming?: unknown;
    code?: unknown;
    includeTasks?: unknown;
    startDate?: unknown;
    deadline?: unknown;
  };
  // Structured copies stay structured: explicit `naming`, a `name` in the
  // Brand_Type_MonYYYY_Name format (brand stays the source's), or "<name> (copy)".
  let name: string;
  let naming: IProjectNaming | null = null;
  let namingInput: unknown = body.naming;
  if (namingInput === undefined && source.naming) {
    const fromName = typeof body.name === "string" ? parseStructuredName(body.name) : null;
    if (body.name === undefined || fromName) {
      namingInput = {
        brand: source.naming.brand.toString(),
        type: fromName?.type ?? source.naming.type,
        month: fromName?.month ?? source.naming.month,
        title: fromName ? fromName.title : `${source.naming.title} (copy)`.slice(0, PROJECT_NAMING_LIMITS.titleMax),
      };
    }
  }
  if (namingInput !== undefined && namingInput !== null) {
    const parsed = await parseNaming(namingInput, { naming: source.naming ?? null, brand: source.brand ?? null });
    if (isInvalid(parsed)) return send(res, parsed);
    ({ name, naming } = parsed);
  } else {
    const parsed = parseName(body.name ?? `${source.name} (copy)`);
    if (isInvalid(parsed)) return send(res, parsed);
    name = parsed;
  }
  const clash = await ensureUniqueName(name);
  if (clash) return send(res, clash);
  const code = parseCode(body.code);
  if (isInvalid(code)) return send(res, code);
  const includeTasks = optionalBoolean(body.includeTasks, "includeTasks");
  if (isInvalid(includeTasks)) return send(res, includeTasks);
  const startDate = optionalDate(body.startDate, "startDate");
  if (isInvalid(startDate)) return send(res, startDate);
  const deadline = optionalDate(body.deadline, "deadline");
  if (isInvalid(deadline)) return send(res, deadline);
  const start = startDate ?? appToday();
  const nextDeadline = deadline === undefined ? null : deadline;
  if (nextDeadline && nextDeadline.getTime() < start.getTime()) return send(res, bad("deadline must be on or after startDate"));

  const departments =
    actor.role === "head" && actor.department ? [actor.department] : source.departments;
  const status = await getDefaultProjectStatus();

  // People the copy may keep: admins keep everyone; heads only their own
  // department (plus themselves). The manager falls back to the actor.
  const scope =
    actor.role === "admin"
      ? null
      : new Set([actor._id.toString(), ...(await departmentUserIds(actor.department)).map((id) => id.toString())]);
  const inScope = (id: mongoose.Types.ObjectId) => !scope || scope.has(id.toString());
  const manager = source.manager && inScope(source.manager) ? source.manager : actor.role === "admin" ? (source.manager ?? null) : actor._id;
  const members = source.members
    .filter((m) => inScope(m.user))
    .map((m) => ({ user: m.user, hourlyRate: m.hourlyRate, addedAt: new Date() }));
  if (manager && !members.some((m) => m.user.equals(manager))) {
    members.push({ user: manager as mongoose.Types.ObjectId, hourlyRate: 0, addedAt: new Date() });
  }

  let copy: IProject;
  try {
    copy = await Project.create({
      name,
      naming,
      code,
      summary: source.summary,
      category: source.category ?? null,
      brand: naming?.brand ?? source.brand ?? null,
      departments,
      manager,
      members,
      status: status._id,
      startDate: start,
      deadline: nextDeadline,
      progressMode: source.progressMode,
      progress: 0,
      hoursAllocated: source.hoursAllocated ?? null,
      budget: source.budget ?? null,
      isPublic: source.isPublic,
      manualTimeLogs: source.manualTimeLogs,
      requireTaskApproval: source.requireTaskApproval,
      createdBy: actor._id,
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      res.status(409).json({ error: `Project code "${code}" is already in use` });
      return;
    }
    throw error;
  }
  const copyId = copy._id as mongoose.Types.ObjectId;
  const sourceId = source._id as mongoose.Types.ObjectId;

  // Milestones → incomplete copies
  const milestones = await Milestone.find({ project: sourceId });
  const milestoneMap = new Map<string, mongoose.Types.ObjectId>();
  for (const m of milestones) {
    const created = await Milestone.create({
      project: copyId,
      title: m.title,
      summary: m.summary,
      startDate: m.startDate ?? null,
      endDate: m.endDate ?? null,
      status: "incomplete",
      completedAt: null,
    });
    milestoneMap.set(m._id.toString(), created._id as mongoose.Types.ObjectId);
  }

  // Tasks (+ subtasks) → todo with fresh short codes (counter only)
  let taskCount = 0;
  if (includeTasks) {
    const memberSet = new Set(copy.members.map((m) => m.user.toString()));
    const tasks = await Task.find({ project: sourceId }).sort({ createdAt: 1 });
    for (const t of tasks) {
      let assignees = t.assignees.filter((id) => memberSet.has(id.toString()));
      if (assignees.length === 0) {
        // Admin copies drop tasks without remaining members; a head's copy
        // reassigns tasks of out-of-department people to the head.
        if (!scope) continue;
        assignees = [actor._id as mongoose.Types.ObjectId];
        if (!memberSet.has(actor._id.toString())) {
          memberSet.add(actor._id.toString());
          await Project.updateOne(
            { _id: copyId },
            { $push: { members: { user: actor._id, hourlyRate: 0, addedAt: new Date() } } }
          );
        }
      }
      const counter = await Project.findOneAndUpdate(
        { _id: copyId },
        { $inc: { taskCounter: 1 } },
        { returnDocument: "after" }
      );
      const assigneeSet = new Set(assignees.map((id) => id.toString()));
      await Task.create({
        title: t.title,
        description: t.description,
        assignees,
        assignedBy: actor._id,
        department: actor.role === "head" ? (actor.department ?? null) : (t.department ?? departments[0] ?? null),
        category: t.category ?? null,
        labels: t.labels,
        status: "todo",
        priority: t.priority,
        startDate: null,
        dueDate: null,
        position: Date.now() + taskCount,
        project: copyId,
        milestone: t.milestone ? (milestoneMap.get(t.milestone.toString()) ?? null) : null,
        shortCode: `${copy.code}-${counter!.taskCounter}`,
        number: await nextTaskNumber(),
        estimateMinutes: t.estimateMinutes ?? null,
        subtasks: t.subtasks.map((s) => ({
          title: s.title,
          description: s.description ?? "",
          done: false,
          assignee: s.assignee && assigneeSet.has(s.assignee.toString()) ? s.assignee : null,
          dueDate: null,
          completedAt: null,
          createdBy: actor._id,
        })),
      });
      taskCount++;
    }
  }

  await recalcProjectProgress(copyId);
  recordProjectActivity(copyId, actor, "duplicated", { from: sourceId.toString(), tasks: taskCount });
  recordProjectActivity(sourceId, actor, "duplicated", { to: copyId.toString(), code });
  logActivity({
    action: "project_created",
    actor,
    targetType: "project",
    targetId: copyId,
    targetName: `${code} · ${name}`,
    details: { duplicatedFrom: sourceId.toString(), tasks: taskCount, milestones: milestones.length },
    ip: req.ip,
  });
  notifyMembersAdded(copy, copy.members.map((m) => m.user), actor);
  scheduleProjectTag(copy._id as mongoose.Types.ObjectId, true);
  pushProjectUpdate(copy, "created", { actorId: actor._id.toString(), duplicatedFrom: sourceId.toString() });

  await respondDetail(res, copyId, actor, 201);
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/** POST /api/projects/:id/members — `{ userIds[], hourlyRate? }`. */
export async function addMembers(req: Request, res: Response): Promise<void> {
  const project = await getProjectOr404(req, res);
  if (!project) return;
  const actor = req.user!;
  if (!canManageProject(actor, project)) {
    res.status(403).json({ error: "Only the project manager, its creator or an admin can manage members" });
    return;
  }
  if (!ensureNotArchived(project, res)) return;

  const { userIds, hourlyRate } = (req.body ?? {}) as { userIds?: unknown; hourlyRate?: unknown };
  if (!Array.isArray(userIds) || userIds.length === 0 || userIds.some((id) => typeof id !== "string" || isInvalidObjectId(id))) {
    return send(res, bad("userIds must be a non-empty array of user IDs"));
  }
  const rate = optionalNumber(hourlyRate, "hourlyRate", PROJECT_LIMITS.maxHourlyRate);
  if (isInvalid(rate)) return send(res, rate);
  const ids = [...new Set(userIds as string[])];
  const count = await User.countDocuments({ _id: { $in: ids } });
  if (count !== ids.length) return send(res, bad("User not found", 404));

  const added: mongoose.Types.ObjectId[] = [];
  for (const id of ids) {
    const oid = new mongoose.Types.ObjectId(id);
    if (isProjectMember(oid, project)) continue;
    project.members.push({ user: oid, hourlyRate: rate ?? 0, addedAt: new Date() });
    added.push(oid);
  }
  if (project.members.length > PROJECT_LIMITS.maxMembers) {
    return send(res, bad(`A project can have at most ${PROJECT_LIMITS.maxMembers} members`));
  }
  if (added.length > 0) {
    await project.save();
    const projectId = project._id as mongoose.Types.ObjectId;
    recordProjectActivity(projectId, actor, "member_added", { users: added.map(String) });
    notifyMembersAdded(project, added, actor);
    pushProjectUpdate(project, "members-changed", { added: added.map(String) });
  }
  await respondDetail(res, project._id as mongoose.Types.ObjectId, actor);
}

/** PATCH /api/projects/:id/members/:userId — `{ hourlyRate }`. */
export async function updateMember(req: Request, res: Response): Promise<void> {
  const project = await getProjectOr404(req, res);
  if (!project) return;
  const actor = req.user!;
  if (!canManageProject(actor, project)) {
    res.status(403).json({ error: "Only the project manager, its creator or an admin can manage members" });
    return;
  }
  if (!ensureNotArchived(project, res)) return;
  const userId = param(req, "userId");
  const row = userId ? project.members.find((m) => m.user.toString() === userId) : undefined;
  if (!row) {
    res.status(404).json({ error: "Member not found" });
    return;
  }
  const rate = optionalNumber((req.body ?? {}).hourlyRate, "hourlyRate", PROJECT_LIMITS.maxHourlyRate);
  if (isInvalid(rate)) return send(res, rate);
  if (rate === undefined || rate === null) return send(res, bad("hourlyRate is required"));
  row.hourlyRate = rate;
  await project.save();
  recordProjectActivity(project._id as mongoose.Types.ObjectId, actor, "member_rate_changed", { user: userId });
  pushProjectUpdate(project, "members-changed", { updated: userId });
  await respondDetail(res, project._id as mongoose.Types.ObjectId, actor);
}

/**
 * DELETE /api/projects/:id/members/:userId[?force=true]. Refuses (409) while
 * the user has open tasks in the project; `force` unassigns them (tasks where
 * they were the only assignee move to the project manager, or the actor).
 * Their running timer on the project is stopped; historical logs stay.
 */
export async function removeMember(req: Request, res: Response): Promise<void> {
  const project = await getProjectOr404(req, res);
  if (!project) return;
  const actor = req.user!;
  if (!canManageProject(actor, project)) {
    res.status(403).json({ error: "Only the project manager, its creator or an admin can manage members" });
    return;
  }
  if (!ensureNotArchived(project, res)) return;
  const userId = param(req, "userId");
  if (!userId || isInvalidObjectId(userId) || !project.members.some((m) => m.user.toString() === userId)) {
    res.status(404).json({ error: "Member not found" });
    return;
  }
  const uid = new mongoose.Types.ObjectId(userId);
  if (project.manager && project.manager.equals(uid)) {
    res.status(400).json({ error: "Change the project manager before removing them from the project" });
    return;
  }

  const projectId = project._id as mongoose.Types.ObjectId;
  const openTasks = await Task.find({ project: projectId, assignees: uid, status: { $ne: "completed" } });
  if (openTasks.length > 0 && req.query.force !== "true") {
    res.status(409).json({
      error: `This member still has ${openTasks.length} open task(s) in the project. Use force to unassign them.`,
      openTasks: openTasks.length,
    });
    return;
  }

  const fallback = project.manager && !project.manager.equals(uid) ? project.manager : actor._id;
  for (const task of openTasks) {
    const remaining = task.assignees.filter((id) => !id.equals(uid));
    task.assignees = remaining.length > 0 ? remaining : [fallback];
    for (const subtask of task.subtasks) {
      if (subtask.assignee && subtask.assignee.equals(uid)) subtask.assignee = null;
    }
    await task.save();
  }

  project.set(
    "members",
    project.members
      .filter((m) => !m.user.equals(uid))
      .map((m) => ({ user: m.user, hourlyRate: m.hourlyRate, addedAt: m.addedAt }))
  );
  await project.save();
  const stopped = await stopTimersWhere({ project: projectId, user: uid }, actor);

  recordProjectActivity(projectId, actor, "member_removed", { user: userId, tasksUnassigned: openTasks.length, timersStopped: stopped });
  pushProjectUpdate(project, "members-changed", { removed: userId }, [uid]);
  await respondDetail(res, projectId, actor);
}

// ---------------------------------------------------------------------------
// Pin / activity / tasks
// ---------------------------------------------------------------------------

/** PUT /api/projects/:id/pin. */
export async function pinProject(req: Request, res: Response): Promise<void> {
  const project = await getViewableProjectOr404(req, res);
  if (!project) return;
  await User.updateOne({ _id: req.user!._id }, { $addToSet: { pinnedProjects: project._id } });
  res.json({ pinned: true });
}

/** DELETE /api/projects/:id/pin. */
export async function unpinProject(req: Request, res: Response): Promise<void> {
  const id = param(req, "id");
  if (!id || isInvalidObjectId(id)) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  await User.updateOne({ _id: req.user!._id }, { $pull: { pinnedProjects: new mongoose.Types.ObjectId(id) } });
  res.json({ pinned: false });
}

/** GET /api/projects/:id/activity — newest first, paginated. */
export async function listProjectActivity(req: Request, res: Response): Promise<void> {
  const project = await getViewableProjectOr404(req, res);
  if (!project) return;
  const { limit, offset } = parsePagination(req);
  const filter = { project: project._id };
  let query = ProjectActivity.find(filter).populate("actor", "name email").sort({ createdAt: -1 });
  if (limit !== null) query = query.skip(offset).limit(limit);
  const [activity, total] = await Promise.all([query, ProjectActivity.countDocuments(filter)]);
  res.json({ activity: activity.map((a) => a.toJSON()), total, limit, offset });
}

/** GET /api/projects/:id/tasks — same as GET /api/tasks?project=:id (list or ?view=board). */
export async function listProjectTasks(req: Request, res: Response): Promise<void> {
  const project = await getViewableProjectOr404(req, res);
  if (!project) return;
  await listTasksForProject(req, res, project);
}

/** GET /api/projects/:id/members/assignable — members (for task assignee pickers). */
export async function listAssignableMembers(req: Request, res: Response): Promise<void> {
  const project = await getViewableProjectOr404(req, res);
  if (!project) return;
  const users = await User.find({ _id: { $in: project.members.map((m) => m.user) } })
    .select("name email role department")
    .sort({ name: 1 });
  res.json({ users: users.map((u) => u.toJSON()), total: users.length, limit: null, offset: 0 });
}

