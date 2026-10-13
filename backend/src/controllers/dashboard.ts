import type { Request, Response } from "express";
import mongoose from "mongoose";
import { ActivityLog } from "../models/ActivityLog.js";
import { Attendance } from "../models/Attendance.js";
import { Department } from "../models/Department.js";
import { Leave } from "../models/Leave.js";
import { LEAVE_TYPES } from "../models/LeaveType.js";
import { LeavePolicy } from "../models/LeavePolicy.js";
import { PerformanceReview } from "../models/PerformanceReview.js";
import { Task } from "../models/Task.js";
import { User } from "../models/User.js";
import { EmployeeDocument } from "../models/EmployeeDocument.js";
import { archivedProjectIds, Project } from "../models/Project.js";
import { completedWithin, projectCompletionDates } from "../lib/projectCompletion.js";
import { activeInRangeFilter, memberProjectFilter, PROGRESS_NOT_DONE } from "../lib/myProjects.js";
import { cached } from "../lib/refCache.js";
import { completedStatusIds } from "../models/ProjectStatus.js";
import { TimeLog } from "../models/TimeLog.js";
import { addDays, appDayStart, appToday, currentWeekStart, mondayOf } from "../lib/appTime.js";
import { anniversaryIn, canViewHrOf, daysBetween, hrScopeOf, initialsOf, nextAnniversary } from "../lib/hr.js";
import { headDepartmentTaskFilter, parseDateOnly } from "../lib/taskAccess.js";
import { appTimeZone } from "../lib/taskJobs.js";

// ---------------------------------------------------------------------------

/** Returns the first day of the current month as UTC midnight. */
function startOfCurrentMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
}

/** Returns the last day of the current month as UTC midnight. */
function endOfCurrentMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 0));
}

/** Calculates working days (excludes weekends) in a date range. */
function workingDaysBetween(from: Date, toExclusive: Date): number {
  const msPerDay = 86_400_000;
  const totalDays = Math.floor((toExclusive.getTime() - from.getTime()) / msPerDay);
  let count = 0;
  for (let i = 0; i < totalDays; i++) {
    const day = new Date(from.getTime() + i * msPerDay);
    const dow = day.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------

/**
 * Dashboard analytics endpoint — returns aggregated metrics for the dashboard.
 * Admins see org-wide data; heads are scoped to their department.
 */
export async function getDashboardAnalytics(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const isAdmin = user.role === "admin";

  const from = startOfCurrentMonth();
  const to = endOfCurrentMonth();
  const toExclusive = new Date(to.getTime() + 86_400_000);

  // Department filter for heads.
  const departmentFilter: Record<string, unknown> = {};
  if (!isAdmin && user.department) {
    departmentFilter.department = user.department;
  }

  // Heads' task counts: tasks of their department, including tasks where any
  // assignee (not only the first) belongs to it.
  const taskFilter: Record<string, unknown> =
    !isAdmin && user.department ? await headDepartmentTaskFilter(user.department) : {};

  // Employee filter (exclude admins).
  const employeeFilter: Record<string, unknown> = { role: { $ne: "admin" } };
  if (!isAdmin && user.department) {
    employeeFilter.department = user.department;
  }

  // ---------------------------------------------------------------
  // 1. Summary counts
  // ---------------------------------------------------------------
  const [totalEmployees, totalDepartments, activeTasks, pendingLeaves, completedTasks] =
    await Promise.all([
      User.countDocuments(employeeFilter),
      isAdmin ? Department.countDocuments() : Department.countDocuments({ _id: user.department }),
      Task.countDocuments({
        ...taskFilter,
        status: { $nin: ["completed", "rejected"] },
      }),
      Leave.countDocuments({
        ...departmentFilter,
        status: "pending",
      }),
      Task.countDocuments({
        ...taskFilter,
        status: "completed",
      }),
    ]);

  // ---------------------------------------------------------------
  // 2. Attendance overview (current month)
  // ---------------------------------------------------------------
  const employees = await User.find(employeeFilter).select("_id");
  const employeeIds = employees.map((e) => e._id);

  const attendanceOverview = { present: 0, absent: 0, late: 0, half_day: 0, on_leave: 0 };
  let attendanceRate = 0;

  if (employeeIds.length > 0) {
    const attendanceRecords = await Attendance.find({
      user: { $in: employeeIds },
      date: { $gte: from, $lt: toExclusive },
    }).select("user status");

    for (const record of attendanceRecords) {
      attendanceOverview[record.status as keyof typeof attendanceOverview]++;
    }

    const workingDays = workingDaysBetween(from, toExclusive);
    const attendedCount =
      attendanceOverview.present + attendanceOverview.late + attendanceOverview.half_day;
    attendanceRate =
      workingDays > 0 && employeeIds.length > 0
        ? Math.round((attendedCount / (workingDays * employeeIds.length)) * 10000) / 100
        : 0;
  }

  // ---------------------------------------------------------------
  // 3. Leave stats (current month)
  // ---------------------------------------------------------------
  const leaveStats = { pending: 0, approved: 0, rejected: 0, byType: [] as { type: string; count: number }[] };

  if (employeeIds.length > 0) {
    const leaveRecords = await Leave.find({
      user: { $in: employeeIds },
      createdAt: { $gte: from, $lt: toExclusive },
    }).select("leaveType status");

    for (const leave of leaveRecords) {
      if (leave.status === "pending") leaveStats.pending++;
      else if (leave.status === "approved") leaveStats.approved++;
      else if (leave.status === "rejected") leaveStats.rejected++;
    }

    // By type
    const typeMap = new Map<string, number>();
    for (const leave of leaveRecords) {
      typeMap.set(leave.leaveType, (typeMap.get(leave.leaveType) ?? 0) + 1);
    }
    leaveStats.byType = Array.from(typeMap.entries()).map(([type, count]) => ({ type, count }));
  }

  // ---------------------------------------------------------------
  // 4. Task stats (current month)
  // ---------------------------------------------------------------
  const taskStats = { todo: 0, in_progress: 0, in_review: 0, completed: 0, rejected: 0 };

  if (employeeIds.length > 0) {
    const taskRecords = await Task.find({
      ...taskFilter,
      createdAt: { $gte: from, $lt: toExclusive },
    }).select("status");

    for (const task of taskRecords) {
      taskStats[task.status as keyof typeof taskStats]++;
    }
  }

  // ---------------------------------------------------------------
  // 5. Department stats
  // ---------------------------------------------------------------
  const departments = isAdmin
    ? await Department.find().sort({ name: 1 })
    : user.department
      ? await Department.find({ _id: user.department })
      : [];

  const departmentStats: {
    name: string;
    memberCount: number;
    attendanceRate: number;
  }[] = [];

  if (departments.length > 0) {
    const deptIds = departments.map((d) => d._id);
    const deptEmployees = await User.find({
      department: { $in: deptIds },
      role: { $ne: "admin" },
    }).select("name department");

    const membersByDept = new Map<string, mongoose.Types.ObjectId[]>();
    for (const emp of deptEmployees) {
      const deptId = emp.department!.toString();
      const list = membersByDept.get(deptId) ?? [];
      list.push(emp._id);
      membersByDept.set(deptId, list);
    }

    const allDeptEmployeeIds = deptEmployees.map((e) => e._id);
    const deptAttendance = allDeptEmployeeIds.length > 0
      ? await Attendance.find({
          user: { $in: allDeptEmployeeIds },
          date: { $gte: from, $lt: toExclusive },
        }).select("user status")
      : [];

    const workingDays = workingDaysBetween(from, toExclusive);

    for (const dept of departments) {
      const deptId = dept._id.toString();
      const memberIds = membersByDept.get(deptId) ?? [];
      const memberIdSet = new Set(memberIds.map((id) => id.toString()));

      let present = 0;
      let late = 0;
      let halfDay = 0;
      for (const record of deptAttendance) {
        if (memberIdSet.has(record.user.toString())) {
          if (record.status === "present") present++;
          else if (record.status === "late") late++;
          else if (record.status === "half_day") halfDay++;
        }
      }

      const attendedCount = present + late + halfDay;
      const deptAttendanceRate =
        workingDays > 0 && memberIds.length > 0
          ? Math.round((attendedCount / (workingDays * memberIds.length)) * 10000) / 100
          : 0;

      departmentStats.push({
        name: dept.name,
        memberCount: memberIds.length,
        attendanceRate: deptAttendanceRate,
      });
    }
  }

  // ---------------------------------------------------------------
  // 6. Recent activity (last 10)
  // ---------------------------------------------------------------
  const recentActivityRaw = await ActivityLog.find()
    .sort({ createdAt: -1 })
    .limit(10)
    .select("action actorName targetName details")
    .lean();

  const recentActivity = recentActivityRaw.map((log) => ({
    action: log.action,
    actorName: log.actorName ?? "System",
    targetName: log.targetName ?? "",
    createdAt: (log as unknown as Record<string, unknown>)["createdAt"] as string,
    details: log.details as Record<string, unknown> | undefined,
  }));

  // ---------------------------------------------------------------
  // Response
  // ---------------------------------------------------------------
  res.json({
    scope: "admin",

    summary: {
      totalEmployees,
      totalDepartments,
      activeTasks,
      pendingLeaves,
      attendanceRate,
      completedTasks,
    },
    attendanceOverview,
    leaveStats,
    taskStats,
    departmentStats,
    recentActivity,
  });
}

// ---------------------------------------------------------------------------
// Employee dashboard
// ---------------------------------------------------------------------------

/**
 * Employee dashboard — returns the logged-in user's personal stats:
 * attendance, leave balance, tasks, and recent activity.
 */
export async function getEmployeeDashboard(req: Request, res: Response): Promise<void> {
  const userId = req.user!._id;

  const now = new Date();
  const from = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
  const to = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 0));
  const toExclusive = new Date(to.getTime() + 86_400_000);

  // Year start for leave balance calculation.
  const yearStart = new Date(Date.UTC(now.getFullYear(), 0, 1));

  // ---------------------------------------------------------------
  // 1. Attendance this month
  // ---------------------------------------------------------------
  const attendanceRecords = await Attendance.find({
    user: userId,
    date: { $gte: from, $lt: toExclusive },
  }).select("status date");

  const attendanceOverview = { present: 0, absent: 0, late: 0, half_day: 0, on_leave: 0 };
  for (const record of attendanceRecords) {
    attendanceOverview[record.status as keyof typeof attendanceOverview]++;
  }

  const workingDays = workingDaysBetween(from, toExclusive);
  const attended = attendanceOverview.present + attendanceOverview.late + attendanceOverview.half_day;
  const attendanceRate =
    workingDays > 0
      ? Math.round((attended / workingDays) * 10000) / 100
      : 0;

  // ---------------------------------------------------------------
  // 2. Leave balance
  // ---------------------------------------------------------------
  const policies = await LeavePolicy.find();
  const policyMap = new Map(policies.map((p) => [p.leaveType, p]));

  const usedLeaves = await Leave.find({
    user: userId,
    status: { $in: ["approved", "pending"] },
    startDate: { $gte: yearStart },
  }).select("leaveType days status");

  const leaveBalance: Record<string, { used: number; remaining: number; total: number }> = {};
  for (const type of LEAVE_TYPES) {
    const policy = policyMap.get(type);
    const total = policy?.maxDaysPerYear ?? 0;
    const used = usedLeaves
      .filter((l) => l.leaveType === type)
      .reduce((sum, l) => sum + l.days, 0);
    leaveBalance[type] = { used, remaining: Math.max(0, total - used), total };
  }

  // ---------------------------------------------------------------
  // 3. Tasks
  // ---------------------------------------------------------------
  const [activeTasks, completedTasks] = await Promise.all([
    Task.find({ assignees: userId, status: { $nin: ["completed", "rejected"] } })
      .select("title status priority dueDate")
      .sort({ dueDate: 1 })
      .limit(5),
    Task.countDocuments({ assignees: userId, status: "completed" }),
  ]);

  // ---------------------------------------------------------------
  // 4. Recent activity (user's own)
  // ---------------------------------------------------------------
  const recentActivityRaw = await ActivityLog.find({ actor: userId })
    .sort({ createdAt: -1 })
    .limit(5)
    .select("action targetName createdAt")
    .lean();

  const recentActivity = recentActivityRaw.map((log) => ({
    action: log.action,
    targetName: log.targetName ?? "",
    createdAt: (log as unknown as Record<string, unknown>)["createdAt"] as string,
  }));

  // ---------------------------------------------------------------
  // Response
  // ---------------------------------------------------------------
  res.json({
    scope: "employee",
    attendance: {
      overview: attendanceOverview,
      rate: attendanceRate,
      workingDays,
    },
    leaveBalance,
    tasks: {
      active: activeTasks.map((t) => t.toJSON()),
      completedCount: completedTasks,
    },
    recentActivity,
  });
}

// ---------------------------------------------------------------------------
// Personal dashboard ("My dashboard") — GET /api/dashboard/me, /me/calendar,
// /me/timelogs. Every user, every role. Date-only comparisons use APP_TIMEZONE.
// ---------------------------------------------------------------------------

/** Every list in GET /api/dashboard/me is capped at this many rows. */
const MY_LIST_CAP = 10;
const BIRTHDAY_WINDOW_DAYS = 30;
const HR_END_WINDOW_DAYS = 30;
const DOCUMENT_EXPIRY_WINDOW_DAYS = 60;
const MY_CALENDAR_LIMIT = 500;
const MY_CALENDAR_MAX_DAYS = 100;

type ObjectId = mongoose.Types.ObjectId;

interface PersonRef {
  _id: ObjectId;
  name: string;
  designation: string;
}

function personRef(u: { _id: unknown; name?: string; designation?: string }): PersonRef {
  return { _id: u._id as ObjectId, name: u.name ?? "", designation: u.designation ?? "" };
}

/** "PEAR-12" or "#12" (or "" for un-migrated tasks). */
function myTaskCode(task: { shortCode?: string | null; number?: number | null }): string {
  return task.shortCode || (task.number ? `#${task.number}` : "");
}

async function archivedProjectIdList(): Promise<ObjectId[]> {
  return archivedProjectIds();
}

/** Tasks assigned to `userId`, excluding archived projects (same as the task list). */
function myTaskBase(userId: ObjectId, archived: ObjectId[]): Record<string, unknown> {
  return archived.length > 0 ? { assignees: userId, project: { $nin: archived } } : { assignees: userId };
}

/** Projects the user is a member or the manager of. */
function myProjectsFilter(userId: ObjectId): Record<string, unknown> {
  return { archivedAt: null, $or: [{ "members.user": userId }, { manager: userId }] };
}

/** Date-only "YYYY-MM-DD" of a stored date-only value. */
function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** My dashboard periods: the last N days ending today (app timezone), or all time. */
export const MY_PERIODS = ["7d", "30d", "90d", "120d", "365d", "all"] as const;
export type MyPeriodKey = (typeof MY_PERIODS)[number];
const MY_PERIOD_DAYS: Record<Exclude<MyPeriodKey, "all">, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "120d": 120,
  "365d": 365,
};
const DEFAULT_MY_PERIOD: MyPeriodKey = "all";

interface DayRange {
  /** Date-only bounds (UTC midnight of the calendar dates, inclusive). */
  from: Date;
  to: Date;
  /** UTC instants: 00:00 app time on `from` … 00:00 app time the day after `to` (exclusive). */
  start: Date;
  end: Date;
}

interface MyPeriod {
  key: MyPeriodKey;
  /** null for "all". */
  current: DayRange | null;
  previous: DayRange | null;
}

function dayRange(from: Date, to: Date): DayRange {
  return { from, to, start: appDayStart(from), end: appDayStart(addDays(to, 1)) };
}

/** `?period=` → resolved ranges (undefined/"" → all; null when invalid). */
function resolveMyPeriod(raw: unknown, today: Date): MyPeriod | null {
  const key = raw === undefined || raw === "" ? DEFAULT_MY_PERIOD : raw;
  if (typeof key !== "string" || !(MY_PERIODS as readonly string[]).includes(key)) return null;
  if (key === "all") return { key, current: null, previous: null };
  const days = MY_PERIOD_DAYS[key as Exclude<MyPeriodKey, "all">];
  const from = addDays(today, -(days - 1));
  return {
    key: key as MyPeriodKey,
    current: dayRange(from, today),
    previous: dayRange(addDays(from, -days), addDays(from, -1)),
  };
}

/** Share (one decimal) or null without a denominator. */
function pct1(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

export interface WeekTimelogs {
  weekStart: string;
  weekEnd: string;
  days: Array<{ date: string; minutes: number; breakMinutes: number }>;
  totalMinutes: number;
  totalBreakMinutes: number;
}

/**
 * Per-day worked/break minutes Mon–Sun for the user's finished time logs
 * (pending + approved — the same rows as GET /api/timelogs totals), grouped by
 * the start time's calendar day in APP_TIMEZONE.
 */
async function computeWeekTimelogs(userId: ObjectId, weekStart: Date): Promise<WeekTimelogs> {
  const rows = await TimeLog.aggregate<{ _id: string; minutes: number; breakMinutes: number }>([
    {
      $match: {
        user: userId,
        endTime: { $ne: null },
        status: { $in: ["pending", "approved"] },
        startTime: { $gte: appDayStart(weekStart), $lt: appDayStart(addDays(weekStart, 7)) },
      },
    },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$startTime", timezone: appTimeZone() } },
        minutes: { $sum: "$durationMinutes" },
        breakMinutes: { $sum: "$breakMinutes" },
      },
    },
  ]);
  const byDay = new Map(rows.map((r) => [r._id, r]));
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = dateKey(addDays(weekStart, i));
    const row = byDay.get(date);
    return { date, minutes: row?.minutes ?? 0, breakMinutes: row?.breakMinutes ?? 0 };
  });
  return {
    weekStart: dateKey(weekStart),
    weekEnd: dateKey(addDays(weekStart, 6)),
    days,
    totalMinutes: days.reduce((sum, d) => sum + d.minutes, 0),
    totalBreakMinutes: days.reduce((sum, d) => sum + d.breakMinutes, 0),
  };
}

type HrUserRow = {
  _id: ObjectId;
  name: string;
  designation?: string;
  department?: ObjectId | null;
  dateOfBirth?: Date | null;
  joiningDate?: Date | null;
  probationEndDate?: Date | null;
  internshipEndDate?: Date | null;
  noticePeriodStart?: Date | null;
  noticePeriodEnd?: Date | null;
};

/**
 * GET /api/dashboard/me?period=7d|30d|90d|120d|365d|all — one aggregated call
 * for the personal dashboard (default all; see prompts/my-dashboard-period.md).
 * "All time" counts exactly like Worksuite's employee dashboard:
 * - Pending (= Open tasks): assigned to me, not completed;
 * - Tasks overdue: those due before today (date-only, app timezone);
 * - Projects (= In progress): I'm a member (members[].user, not manager-only),
 *   progress ≠ 100, not archived;
 * - Projects overdue: those with a deadline on or before today ("earlier than now").
 * The period (last N days ending today, app timezone) narrows these base sets
 * (created/due, active in, deadline in the period) and dates the completed tiles
 * (with the previous equal period); My tasks follows it. Every tile equals the
 * total of the /tasks or /projects list it links to. The people / HR / document cards are
 * forward-looking and ignore it. Restricted lists (probation / notice / internship / document expiries) are
 * scoped: self (employee, head without department) / department (head) / all (admin).
 */
export async function getMyDashboard(req: Request, res: Response): Promise<void> {
  const me = req.user!;
  const meId = me._id as ObjectId;
  const today = appToday();
  const scope = hrScopeOf(me);
  const period = resolveMyPeriod(req.query.period, today);
  if (!period) {
    res.status(400).json({ error: `period must be one of: ${MY_PERIODS.join(", ")}` });
    return;
  }
  const cur = period.current;
  const prev = period.previous;

  const [archived, completedStatuses, department, deptMembers] = await Promise.all([
    archivedProjectIdList(),
    completedStatusIds(),
    me.department ? Department.findById(me.department).select("name").lean() : Promise.resolve(null),
    scope === "department"
      ? User.find({ department: me.department }).select("_id").lean()
      : Promise.resolve([] as Array<{ _id: unknown }>),
  ]);
  const taskBase = myTaskBase(meId, archived);
  const isDate = (field: string) => ({ $eq: [{ $type: field }, "date"] });

  const docFilter: Record<string, unknown> = {
    expiryDate: { $ne: null, $lte: addDays(today, DOCUMENT_EXPIRY_WINDOW_DAYS) },
  };
  if (scope === "self") docFilter.user = meId;
  else if (scope === "department") docFilter.user = { $in: [meId, ...deptMembers.map((m) => m._id as ObjectId)] };

  // Open tasks in the period: created or due inside it (all time: every open task).
  const openMatch: Record<string, unknown> = { ...taskBase, status: { $ne: "completed" } };
  if (cur) {
    openMatch.$or = [
      { createdAt: { $gte: cur.start, $lt: cur.end } },
      { dueDate: { $gte: cur.from, $lte: cur.to } },
    ];
  }
  // Overdue: due before today (and, with a period, on or after its first day).
  const overdueCond: Record<string, unknown>[] = [isDate("$dueDate"), { $lt: ["$dueDate", today] }];
  if (cur) overdueCond.push({ $gte: ["$dueDate", cur.from] });

  // Completed by me: completedAt in the current or previous period (all time: every completed task).
  const completedMatch: Record<string, unknown> = { ...taskBase, status: "completed" };
  if (cur && prev) completedMatch.completedAt = { $gte: prev.start, $lt: cur.end };
  const inCurrent = cur
    ? { $and: [isDate("$completedAt"), { $gte: ["$completedAt", cur.start] }] }
    : true;
  // On time: completed (app-timezone day) on or before the due date.
  const onTimeCond = {
    $and: [
      inCurrent,
      isDate("$completedAt"),
      isDate("$dueDate"),
      {
        $lte: [
          // When the work actually ended (closing it later doesn't make it late).
          { $dateToString: { format: "%Y-%m-%d", date: { $ifNull: ["$actualEndAt", "$completedAt"] }, timezone: appTimeZone() } },
          { $dateToString: { format: "%Y-%m-%d", date: "$dueDate" } },
        ],
      },
    ],
  };

  const logMatch: Record<string, unknown> = {
    user: meId,
    endTime: { $ne: null },
    status: { $in: ["pending", "approved"] },
  };
  if (cur) logMatch.startTime = { $gte: cur.start, $lt: cur.end };

  // Projects (Worksuite): member, progress ≠ 100, not archived; with a period,
  // also active in it. Overdue: deadline on or before today (inside the period).
  const memberProjects = memberProjectFilter(meId);
  const inProgressBase = { ...memberProjects, ...PROGRESS_NOT_DONE };
  const projectDeadline: Record<string, unknown> = { $ne: null, $lte: today };
  if (cur) projectDeadline.$gte = cur.from;

  const [
    taskCounts,
    myTaskRows,
    projectsInProgress,
    projectsOverdue,
    finished,
    leavesToday,
    people,
    docRows,
    docTotal,
    weekTimelogs,
    completedRows,
    loggedRows,
  ] = await Promise.all([
    Task.aggregate<{ open: number; overdue: number }>([
      { $match: openMatch },
      {
        $group: {
          _id: null,
          open: { $sum: 1 },
          overdue: { $sum: { $cond: [{ $and: overdueCond }, 1, 0] } },
        },
      },
    ]),
    Task.aggregate([
      { $match: openMatch },
      { $addFields: { _noDue: { $cond: [isDate("$dueDate"), 0, 1] } } },
      { $sort: { _noDue: 1, dueDate: 1, _id: 1 } },
      { $limit: MY_LIST_CAP },
      { $project: { title: 1, shortCode: 1, number: 1, labels: 1, status: 1, dueDate: 1, priority: 1, project: 1 } },
    ]),
    (cur ? activeInRangeFilter(meId, cur.from, cur.to) : Promise.resolve(null)).then((active) =>
      Project.countDocuments(active ? { $and: [inProgressBase, active] } : inProgressBase)
    ),
    Project.countDocuments({ ...inProgressBase, deadline: projectDeadline }),
    // My finished projects (completed status) — dated below for the Completed tile.
    Project.find({ ...memberProjects, status: { $in: completedStatuses } })
      .select("_id updatedAt")
      .lean<Array<{ _id: ObjectId; updatedAt: Date }>>(),
    Leave.find({ status: "approved", startDate: { $lte: today }, endDate: { $gte: today } })
      .select("user endDate")
      .populate<{ user: { _id: ObjectId; name: string; designation?: string } | null }>({
        path: "user",
        select: "name designation",
      })
      .sort({ endDate: 1, _id: 1 })
      .limit(200)
      .lean(),
    // Everyone's HR dates (birthdays, anniversaries, probation…): identical for every
    // caller, so cached for a minute (dropped on any user write, see lib/refCache.ts).
    cached("user:hr-people", 60_000, () => User.find({
      $or: [
        { dateOfBirth: { $ne: null } },
        { joiningDate: { $ne: null } },
        { probationEndDate: { $ne: null } },
        { internshipEndDate: { $ne: null } },
        { noticePeriodEnd: { $ne: null } },
      ],
    })
      .select(
        "name designation department dateOfBirth joiningDate probationEndDate internshipEndDate noticePeriodStart noticePeriodEnd"
      )
      .lean<HrUserRow[]>()),
    EmployeeDocument.find(docFilter)
      .select("name type user expiryDate")
      .populate<{ user: { _id: ObjectId; name: string } | null }>({ path: "user", select: "name" })
      .sort({ expiryDate: 1, _id: 1 })
      .limit(MY_LIST_CAP)
      .lean(),
    EmployeeDocument.countDocuments(docFilter),
    computeWeekTimelogs(meId, currentWeekStart()),
    Task.aggregate<{ count: number; previous: number; withDue: number; onTime: number }>([
      { $match: completedMatch },
      {
        $group: {
          _id: null,
          count: { $sum: { $cond: [inCurrent, 1, 0] } },
          previous: { $sum: { $cond: [inCurrent, 0, 1] } },
          withDue: {
            $sum: { $cond: [{ $and: [inCurrent, isDate("$completedAt"), isDate("$dueDate")] }, 1, 0] },
          },
          onTime: { $sum: { $cond: [onTimeCond, 1, 0] } },
        },
      },
    ]),
    TimeLog.aggregate<{ minutes: number }>([
      { $match: logMatch },
      { $group: { _id: null, minutes: { $sum: "$durationMinutes" } } },
    ]),
  ]);

  // --- Tasks ------------------------------------------------------------------
  const counts = taskCounts[0] ?? { open: 0, overdue: 0 };

  const [populated, completionDates] = await Promise.all([
    Task.populate(myTaskRows, [
      { path: "labels", select: "name color" },
      { path: "project", select: "name code" },
    ]),
    // When each finished project was completed (shared with GET /api/projects?completed).
    cur ? projectCompletionDates(finished) : Promise.resolve(new Map<string, Date>()),
  ]);
  const populatedTasks = populated as unknown as Array<{
    _id: ObjectId;
    title: string;
    shortCode?: string | null;
    number?: number | null;
    labels: Array<{ _id: ObjectId; name: string; color: string }>;
    status: string;
    dueDate?: Date | null;
    priority: string;
    project?: { _id: ObjectId; name: string; code: string } | null;
  }>;
  const myTasks = populatedTasks.map((t) => ({
    _id: t._id,
    code: myTaskCode(t),
    title: t.title,
    labels: (t.labels ?? []).filter(Boolean).map((l) => ({ _id: l._id, name: l.name, color: l.color })),
    status: t.status,
    dueDate: t.dueDate ?? null,
    priority: t.priority,
    project: t.project ? { _id: t.project._id, name: t.project.name, code: t.project.code } : null,
    overdue: Boolean(t.dueDate && t.dueDate.getTime() < today.getTime()),
  }));

  // --- Projects ---------------------------------------------------------------
  // Finished = in a completed status; its completion moment is the last status
  // change (projects that never changed status fall back to updatedAt).
  const completionOf = (p: (typeof finished)[number]): Date =>
    completionDates.get(String(p._id)) ?? p.updatedAt;
  const completedProjects = cur
    ? {
        count: finished.filter((p) => completedWithin(completionOf(p), cur)).length,
        previous: prev ? finished.filter((p) => completedWithin(completionOf(p), prev)).length : null,
      }
    : { count: finished.length, previous: null };

  const done = completedRows[0] ?? { count: 0, previous: 0, withDue: 0, onTime: 0 };
  const completedTasks = {
    count: done.count,
    onTimePct: pct1(done.onTime, done.withDue),
    previous: cur ? done.previous : null,
  };

  // --- People cards -----------------------------------------------------------
  const onLeave = leavesToday
    .filter((l) => l.user)
    .map((l) => ({ user: personRef(l.user!), until: l.endDate }));

  const birthdays: Array<{ user: PersonRef; day: number; month: number; inDays: number }> = [];
  const joinings: Array<{ user: PersonRef; kind: "joining" | "anniversary"; years: number; date: Date }> = [];
  type EndRow = { user: PersonRef; date: Date; inDays: number; startDate?: Date | null };
  const probation: EndRow[] = [];
  const notice: EndRow[] = [];
  const internship: EndRow[] = [];
  const windowEnd = addDays(today, HR_END_WINDOW_DAYS);
  const inWindow = (d: Date | null | undefined): d is Date =>
    Boolean(d && d.getTime() >= today.getTime() && d.getTime() <= windowEnd.getTime());

  for (const u of people) {
    const ref = personRef(u);
    if (u.dateOfBirth) {
      const next = nextAnniversary(u.dateOfBirth, today);
      const inDays = daysBetween(today, next);
      if (inDays <= BIRTHDAY_WINDOW_DAYS) {
        // Day + month only — the birth year is never exposed here.
        birthdays.push({ user: ref, day: u.dateOfBirth.getUTCDate(), month: u.dateOfBirth.getUTCMonth() + 1, inDays });
      }
    }
    if (u.joiningDate && u.joiningDate.getTime() <= today.getTime()) {
      const years = today.getUTCFullYear() - u.joiningDate.getUTCFullYear();
      if (anniversaryIn(u.joiningDate, today.getUTCFullYear()).getTime() === today.getTime()) {
        joinings.push({ user: ref, kind: years === 0 ? "joining" : "anniversary", years, date: u.joiningDate });
      }
    }
    if (!canViewHrOf(me, { _id: u._id, department: u.department ?? null })) continue;
    if (inWindow(u.probationEndDate)) {
      probation.push({ user: ref, date: u.probationEndDate, inDays: daysBetween(today, u.probationEndDate) });
    }
    if (inWindow(u.noticePeriodEnd)) {
      notice.push({
        user: ref,
        startDate: u.noticePeriodStart ?? null,
        date: u.noticePeriodEnd,
        inDays: daysBetween(today, u.noticePeriodEnd),
      });
    }
    if (inWindow(u.internshipEndDate)) {
      internship.push({ user: ref, date: u.internshipEndDate, inDays: daysBetween(today, u.internshipEndDate) });
    }
  }
  const byDaysThenName = (a: { inDays: number; user: PersonRef }, b: { inDays: number; user: PersonRef }) =>
    a.inDays - b.inDays || a.user.name.localeCompare(b.user.name);
  birthdays.sort(byDaysThenName);
  probation.sort(byDaysThenName);
  notice.sort(byDaysThenName);
  internship.sort(byDaysThenName);
  joinings.sort((a, b) => a.years - b.years || a.user.name.localeCompare(b.user.name));

  const documentExpiries = docRows
    .filter((d) => d.user && d.expiryDate)
    .map((d) => ({
      _id: d._id,
      name: d.name,
      type: d.type,
      user: { _id: d.user!._id, name: d.user!.name },
      expiryDate: d.expiryDate!,
      inDays: daysBetween(today, d.expiryDate!),
    }));

  res.json({
    today: dateKey(today),
    period: { key: period.key, from: cur ? dateKey(cur.from) : null, to: dateKey(today) },
    hrScope: scope,
    profile: {
      _id: meId,
      name: me.name,
      email: me.email,
      role: me.role,
      designation: me.designation ?? "",
      employeeId: me.employeeId ?? null,
      department: department ? { _id: department._id, name: department.name } : null,
      avatarInitials: initialsOf(me.name),
      joiningDate: me.joiningDate ?? null,
    },
    counts: {
      // Worksuite: Profile → Open tasks and Tasks → Pending are the same number,
      // as are Profile → Projects and Projects → In progress.
      openTasks: counts.open,
      pendingTasks: counts.open,
      overdueTasks: counts.overdue,
      projects: projectsInProgress,
      projectsInProgress,
      projectsOverdue,
    },
    completedTasks,
    completedProjects,
    /** Finished time logs (pending + approved) started in the period. */
    loggedMinutes: loggedRows[0]?.minutes ?? 0,
    myTasks,
    onLeaveToday: onLeave.slice(0, MY_LIST_CAP),
    birthdays: birthdays.slice(0, MY_LIST_CAP),
    joiningsAndAnniversaries: joinings.slice(0, MY_LIST_CAP),
    probation: probation.slice(0, MY_LIST_CAP),
    notice: notice.slice(0, MY_LIST_CAP),
    internship: internship.slice(0, MY_LIST_CAP),
    documentExpiries,
    totals: {
      onLeaveToday: onLeave.length,
      birthdays: birthdays.length,
      joiningsAndAnniversaries: joinings.length,
      probation: probation.length,
      notice: notice.length,
      internship: internship.length,
      documentExpiries: docTotal,
    },
    weekTimelogs,
  });
}

/** "YYYY-MM-DD" query param → date-only value (undefined when absent, "invalid" otherwise). */
function dateQuery(raw: unknown): Date | undefined | "invalid" {
  if (raw === undefined || raw === "") return undefined;
  return parseDateOnly(raw) ?? "invalid";
}

/** GET /api/dashboard/me/timelogs?weekStart=YYYY-MM-DD (any day; normalised to its Monday). */
export async function getMyWeekTimelogs(req: Request, res: Response): Promise<void> {
  const raw = dateQuery(req.query.weekStart);
  if (raw === "invalid") {
    res.status(400).json({ error: "weekStart must be a valid date (YYYY-MM-DD)" });
    return;
  }
  const weekStart = raw ? mondayOf(raw) : currentWeekStart();
  res.json({ today: dateKey(appToday()), ...(await computeWeekTimelogs(req.user!._id as ObjectId, weekStart)) });
}

interface CalendarItem {
  /** Unique per item: "<kind>:<id>". */
  id: string;
  kind: "task" | "subtask" | "leave" | "project_deadline";
  title: string;
  /** Date-only "YYYY-MM-DD" (inclusive). */
  start: string;
  end: string;
  status: string;
  priority?: string;
  code?: string;
  taskId?: ObjectId;
  subtaskId?: ObjectId;
  leaveId?: ObjectId;
  leaveType?: string;
  project?: { _id: ObjectId; name: string; code: string } | null;
}

/**
 * GET /api/dashboard/me/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD (≤ 100 days):
 * my tasks (start→due, or due), my subtasks due, my leaves (approved + pending)
 * and deadlines of projects I'm a member/manager of. Max 500 items.
 */
export async function getMyCalendar(req: Request, res: Response): Promise<void> {
  const from = dateQuery(req.query.from);
  const to = dateQuery(req.query.to);
  if (!from || !to || from === "invalid" || to === "invalid") {
    res.status(400).json({ error: "from and to are required (YYYY-MM-DD)" });
    return;
  }
  if (from.getTime() > to.getTime()) {
    res.status(400).json({ error: "from must be on or before to" });
    return;
  }
  if (daysBetween(from, to) > MY_CALENDAR_MAX_DAYS) {
    res.status(400).json({ error: `The calendar range can be at most ${MY_CALENDAR_MAX_DAYS} days` });
    return;
  }

  const meId = req.user!._id as ObjectId;
  const archived = await archivedProjectIdList();
  const notArchived = archived.length > 0 ? { project: { $nin: archived } } : {};

  type TaskRow = {
    _id: ObjectId;
    title: string;
    shortCode?: string | null;
    number?: number | null;
    status: string;
    priority: string;
    startDate?: Date | null;
    dueDate: Date;
    project?: { _id: ObjectId; name: string; code: string } | null;
  };
  type SubRow = {
    _id: ObjectId;
    title: string;
    shortCode?: string | null;
    number?: number | null;
    project?: ObjectId | null;
    sub: { _id: ObjectId; title: string; done: boolean; dueDate: Date };
  };

  const [tasks, subtasks, leaves, projects, completedStatuses] = await Promise.all([
    Task.find({
      ...myTaskBase(meId, archived),
      $and: [
        { dueDate: { $ne: null, $gte: from } },
        { $or: [{ dueDate: { $lte: to } }, { startDate: { $ne: null, $lte: to } }] },
      ],
    })
      .select("title shortCode number status priority startDate dueDate project")
      .populate({ path: "project", select: "name code" })
      .sort({ dueDate: 1, _id: 1 })
      .limit(MY_CALENDAR_LIMIT + 1)
      .lean<TaskRow[]>(),
    Task.aggregate<SubRow>([
      { $match: { "subtasks.assignee": meId, ...notArchived } },
      { $unwind: "$subtasks" },
      { $match: { "subtasks.assignee": meId, "subtasks.dueDate": { $gte: from, $lte: to } } },
      { $sort: { "subtasks.dueDate": 1, _id: 1 } },
      { $limit: MY_CALENDAR_LIMIT + 1 },
      {
        $project: {
          title: 1,
          shortCode: 1,
          number: 1,
          project: 1,
          sub: {
            _id: "$subtasks._id",
            title: "$subtasks.title",
            done: "$subtasks.done",
            dueDate: "$subtasks.dueDate",
          },
        },
      },
    ]),
    Leave.find({ user: meId, status: { $in: ["approved", "pending"] }, startDate: { $lte: to }, endDate: { $gte: from } })
      .select("leaveType startDate endDate status")
      .sort({ startDate: 1 })
      .limit(MY_CALENDAR_LIMIT + 1)
      .lean(),
    Project.find({ ...myProjectsFilter(meId), deadline: { $gte: from, $lte: to } })
      .select("name code deadline status")
      .sort({ deadline: 1 })
      .limit(MY_CALENDAR_LIMIT + 1)
      .lean(),
    completedStatusIds(),
  ]);

  const items: CalendarItem[] = [];
  for (const t of tasks) {
    const due = t.dueDate;
    const start = t.startDate && t.startDate.getTime() <= due.getTime() ? t.startDate : due;
    items.push({
      id: `task:${t._id}`,
      kind: "task",
      title: t.title,
      start: dateKey(start),
      end: dateKey(due),
      status: t.status,
      priority: t.priority,
      code: myTaskCode(t),
      taskId: t._id,
      project: t.project ? { _id: t.project._id, name: t.project.name, code: t.project.code } : null,
    });
  }
  for (const s of subtasks) {
    items.push({
      id: `subtask:${s.sub._id}`,
      kind: "subtask",
      title: s.sub.title,
      start: dateKey(s.sub.dueDate),
      end: dateKey(s.sub.dueDate),
      status: s.sub.done ? "done" : "open",
      code: myTaskCode(s),
      taskId: s._id,
      subtaskId: s.sub._id,
    });
  }
  for (const l of leaves) {
    const type = String(l.leaveType);
    items.push({
      id: `leave:${l._id}`,
      kind: "leave",
      title: `${type.charAt(0).toUpperCase()}${type.slice(1)} leave`,
      start: dateKey(l.startDate),
      end: dateKey(l.endDate),
      status: l.status,
      leaveId: l._id as ObjectId,
      leaveType: type,
    });
  }
  const completedSet = new Set(completedStatuses.map((id) => id.toString()));
  for (const p of projects) {
    if (!p.deadline) continue;
    items.push({
      id: `project_deadline:${p._id}`,
      kind: "project_deadline",
      title: p.name,
      start: dateKey(p.deadline),
      end: dateKey(p.deadline),
      status: completedSet.has(String(p.status)) ? "completed" : "open",
      code: p.code,
      project: { _id: p._id as ObjectId, name: p.name, code: p.code },
    });
  }

  const KIND_ORDER: Record<CalendarItem["kind"], number> = { project_deadline: 0, leave: 1, task: 2, subtask: 3 };
  items.sort((a, b) => a.start.localeCompare(b.start) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.title.localeCompare(b.title));
  const total = items.length;
  res.json({
    from: dateKey(from),
    to: dateKey(to),
    items: items.slice(0, MY_CALENDAR_LIMIT),
    total,
    limit: MY_CALENDAR_LIMIT,
    truncated: total > MY_CALENDAR_LIMIT,
  });
}
