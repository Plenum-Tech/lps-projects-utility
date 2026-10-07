import "dotenv/config";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { connectDB, disconnectDB } from "../db/index.js";
import { Counter, TASK_NUMBER_COUNTER } from "../models/Counter.js";
import { Department } from "../models/Department.js";
import { Notification } from "../models/Notification.js";
import { Project } from "../models/Project.js";
import { ProjectStatus, seedProjectStatuses } from "../models/ProjectStatus.js";
import { Task } from "../models/Task.js";
import { TaskComment } from "../models/TaskComment.js";
import { TimeLog } from "../models/TimeLog.js";
import { User } from "../models/User.js";

/**
 * Load-test data set for deploy/k6/load-test.js (see DEPLOY-AZURE.md):
 *   150 users (5 department heads + 145 employees) + 1 admin, 5 departments,
 *   30 projects, 5,000 tasks, 20,000 comments, 10,000 time logs, 3,000 notifications.
 *
 *   MONGO_URI=mongodb://127.0.0.1:27018/lps_load bun run seed:load -- --reset
 *
 * Refuses to run against a database named `ems` (the dev database) and, without
 * --reset, against a database that already has users. --reset drops the database first.
 * Logins: load-user-001@lps.test … load-user-150@lps.test and load-admin@lps.test,
 * all with LOAD_PASSWORD (default "LoadTest-2026!").
 */

const USERS = 150;
const HEADS = 5;
const PROJECTS = 30;
const TASKS = 5_000;
const COMMENTS = 20_000;
const TIMELOGS = 10_000;
const NOTIFICATIONS_PER_USER = 20;
const PROJECTS_PER_USER = 3;
const DAY = 86_400_000;

const PASSWORD = process.env.LOAD_PASSWORD || "LoadTest-2026!";
const STATUSES = ["todo", "todo", "in_progress", "in_progress", "in_review", "completed", "completed", "rejected"] as const;
const PRIORITIES = ["low", "medium", "medium", "high", "urgent"] as const;
const WORDS =
  "update review design draft fix improve report client sprint backlog api schema deploy test release migrate plan audit sync refactor docs".split(
    " "
  );

// Deterministic PRNG so every run produces the same data set.
let seed = 42;
function rand(): number {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
}
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
const words = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(" ");
const utcMidnight = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const pad = (n: number, size = 3) => String(n).padStart(size, "0");

async function insertInChunks(collection: mongoose.Collection, docs: object[], size = 2_000): Promise<void> {
  for (let i = 0; i < docs.length; i += size) {
    await collection.insertMany(docs.slice(i, i + size), { ordered: false });
  }
}

async function main(): Promise<void> {
  const reset = process.argv.includes("--reset");
  // No automatic index builds before the safety check below (indexes are built explicitly after it).
  process.env.MONGO_AUTO_INDEX = "false";
  await connectDB();
  const dbName = mongoose.connection.name;
  if (dbName === "ems") {
    throw new Error('Refusing to seed load data into the "ems" database — point MONGO_URI at a scratch database (e.g. /lps_load).');
  }
  if (reset) {
    await mongoose.connection.dropDatabase();
    console.log(`🧹 Dropped database "${dbName}"`);
  } else if ((await User.estimatedDocumentCount()) > 0) {
    throw new Error(`Database "${dbName}" already has users — re-run with --reset to wipe it first.`);
  }
  // Build every model's indexes up front (as the app would on boot).
  await Promise.all(
    [User, Department, Project, ProjectStatus, Task, TaskComment, TimeLog, Notification, Counter].map((m) => m.createIndexes())
  );

  const now = new Date();
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  // --- Departments -------------------------------------------------------
  const departments = await Department.insertMany(
    ["Engineering", "Design", "Operations", "Finance", "Sales"].map((name) => ({ name, description: `${name} (load test)` }))
  );

  // --- Users ---------------------------------------------------------------
  const userDocs = [];
  const adminId = new mongoose.Types.ObjectId();
  userDocs.push({ _id: adminId, name: "Load Admin", email: "load-admin@lps.test", role: "admin", department: null, employeeId: "LT-000" });
  for (let i = 1; i <= USERS; i++) {
    const dept = departments[(i - 1) % departments.length]!;
    userDocs.push({
      _id: new mongoose.Types.ObjectId(),
      name: `Load User ${pad(i)}`,
      email: `load-user-${pad(i)}@lps.test`,
      role: i <= HEADS ? "head" : "employee",
      department: dept._id,
      employeeId: `LT-${pad(i)}`,
    });
  }
  const users = userDocs.map((u) => ({
    ...u,
    password: passwordHash,
    hourlyRate: 0,
    pinnedProjects: [],
    pinnedTasks: [],
    lastTrackerReminderOn: null,
    lastHrReminderKeys: [],
    designation: u.role === "head" ? "Department head" : "Engineer",
    joiningDate: new Date(now.getTime() - 400 * DAY),
    emailPreferences: {
      taskAssigned: false,
      taskUpdates: false,
      taskComments: false,
      taskReminders: false,
      projectUpdates: false,
      timeLogs: false,
      teamUpdates: false,
      hrReminders: false,
      leaveRequests: false,
    },
    createdAt: now,
    updatedAt: now,
    __v: 0,
  }));
  await insertInChunks(User.collection, users);
  const staff = users.slice(1); // the 150 load users
  console.log(`👥 ${users.length} users`);

  // --- Projects ------------------------------------------------------------
  await seedProjectStatuses();
  const defaultStatus = await ProjectStatus.findOne({ isDefault: true }).lean();
  const membersByProject: mongoose.Types.ObjectId[][] = Array.from({ length: PROJECTS }, () => []);
  staff.forEach((u, i) => {
    for (let k = 0; k < PROJECTS_PER_USER; k++) membersByProject[(i + k * 10) % PROJECTS]!.push(u._id);
  });
  const projects = membersByProject.map((members, p) => {
    const manager = staff[p % HEADS]!; // heads manage projects
    const memberIds = [...new Set([manager._id.toString(), ...members.map(String)])].map((id) => new mongoose.Types.ObjectId(id));
    return {
      _id: new mongoose.Types.ObjectId(),
      name: `Load Project ${pad(p + 1, 2)} ${words(2)}`,
      code: `LP${pad(p + 1, 2)}`,
      description: words(12),
      category: null,
      departments: [departments[p % departments.length]!._id],
      manager: manager._id,
      members: memberIds.map((user) => ({ _id: new mongoose.Types.ObjectId(), user, hourlyRate: 0, addedAt: now })),
      status: defaultStatus!._id,
      startDate: utcMidnight(new Date(now.getTime() - 120 * DAY)),
      deadline: utcMidnight(new Date(now.getTime() + (30 + p * 3) * DAY)),
      progressMode: "task_completion",
      progress: 0,
      hoursAllocated: null,
      budget: null,
      isPublic: false,
      manualTimeLogs: true,
      requireTaskApproval: true,
      taskCounter: 0,
      createdBy: adminId,
      archivedAt: null,
      lastDeadlineReminderOn: null,
      createdAt: now,
      updatedAt: now,
      __v: 0,
    };
  });

  // --- Tasks ---------------------------------------------------------------
  const userDept = new Map(staff.map((u) => [u._id.toString(), u.department]));
  const tasks = [];
  const tasksByUser = new Map<string, { task: mongoose.Types.ObjectId; project: mongoose.Types.ObjectId }[]>();
  for (let t = 0; t < TASKS; t++) {
    const p = t % PROJECTS;
    const project = projects[p]!;
    const members = project.members.map((m) => m.user);
    const assignee = pick(members);
    const assignees = rand() < 0.2 ? [...new Set([assignee, pick(members)].map(String))].map((id) => new mongoose.Types.ObjectId(id)) : [assignee];
    const createdAt = new Date(now.getTime() - Math.floor(rand() * 120) * DAY - Math.floor(rand() * DAY));
    const status = pick(STATUSES);
    project.taskCounter += 1;
    const id = new mongoose.Types.ObjectId();
    tasks.push({
      _id: id,
      title: `${words(4)} #${t + 1}`,
      description: words(20),
      assignees,
      assignedBy: project.manager,
      department: userDept.get(assignee.toString()) ?? null,
      category: null,
      project: project._id,
      milestone: null,
      shortCode: `${project.code}-${project.taskCounter}`,
      number: t + 1,
      estimateMinutes: rand() < 0.5 ? 60 * (1 + Math.floor(rand() * 8)) : null,
      labels: [],
      status,
      priority: pick(PRIORITIES),
      startDate: null,
      dueDate: rand() < 0.8 ? utcMidnight(new Date(now.getTime() + Math.floor(rand() * 90 - 30) * DAY)) : null,
      position: createdAt.getTime(),
      subtasks: [],
      recurrence: null,
      recurringParent: null,
      lastReminderSentOn: null,
      lastManualReminderAt: null,
      submittedAt: null,
      reviewedAt: null,
      reviewedBy: null,
      completedAt: status === "completed" ? new Date(createdAt.getTime() + 3 * DAY) : null,
      sourceMeeting: null,
      createdAt,
      updatedAt: createdAt,
      __v: 0,
    });
    for (const a of assignees) {
      const list = tasksByUser.get(a.toString()) ?? [];
      list.push({ task: id, project: project._id });
      tasksByUser.set(a.toString(), list);
    }
  }
  await insertInChunks(Project.collection, projects);
  await insertInChunks(Task.collection, tasks);
  await Counter.updateOne({ _id: TASK_NUMBER_COUNTER }, { $set: { seq: TASKS } }, { upsert: true });
  console.log(`📁 ${projects.length} projects, ✅ ${tasks.length} tasks`);

  // --- Comments ------------------------------------------------------------
  const comments = [];
  for (let c = 0; c < COMMENTS; c++) {
    const task = tasks[c % TASKS]!;
    const at = new Date(task.createdAt.getTime() + Math.floor(rand() * 5 * DAY));
    comments.push({
      task: task._id,
      author: rand() < 0.5 ? task.assignedBy : pick(task.assignees),
      body: words(15),
      mentions: [],
      editedAt: null,
      createdAt: at,
      updatedAt: at,
      __v: 0,
    });
  }
  await insertInChunks(TaskComment.collection, comments);
  console.log(`💬 ${comments.length} comments`);

  // --- Time logs (one 2 h entry per user per day, going back in time; never overlapping) ---
  const logs = [];
  const perUser = Math.ceil(TIMELOGS / staff.length);
  for (const [i, u] of staff.entries()) {
    const assigned = tasksByUser.get(u._id.toString()) ?? [];
    for (let k = 0; k < perUser && logs.length < TIMELOGS; k++) {
      const target = assigned.length > 0 ? assigned[(i + k) % assigned.length]! : null;
      const day = utcMidnight(new Date(now.getTime() - (k + 1) * DAY));
      const startTime = new Date(day.getTime() + 4 * 3_600_000); // 04:00 UTC
      const endTime = new Date(startTime.getTime() + 120 * 60_000);
      logs.push({
        user: u._id,
        project: target?.project ?? null,
        task: target?.task ?? null,
        startTime,
        endTime,
        breaks: [],
        durationMinutes: 120,
        breakMinutes: 0,
        memo: words(5),
        source: "manual",
        hourlyRate: 0,
        earnings: 0,
        status: "approved",
        reviewedBy: adminId,
        reviewedAt: endTime,
        weeklyTimesheet: null,
        addedBy: u._id,
        editedBy: null,
        autoStopped: false,
        createdAt: endTime,
        updatedAt: endTime,
        __v: 0,
      });
    }
  }
  await insertInChunks(TimeLog.collection, logs);
  console.log(`⏱️  ${logs.length} time logs`);

  // --- Notifications ---------------------------------------------------------
  const notifications = [];
  for (const u of staff) {
    const assigned = tasksByUser.get(u._id.toString()) ?? [];
    for (let n = 0; n < NOTIFICATIONS_PER_USER; n++) {
      const target = assigned[n % Math.max(assigned.length, 1)];
      const at = new Date(now.getTime() - n * 3_600_000);
      notifications.push({
        recipient: u._id,
        actor: adminId,
        type: "task_assigned",
        title: "Task assigned",
        message: `You were assigned a task (${words(3)})`,
        read: n >= 5,
        link: target ? `/tasks?task=${target.task.toString()}` : "/tasks",
        task: target?.task ?? null,
        project: target?.project ?? null,
        createdAt: at,
        updatedAt: at,
        __v: 0,
      });
    }
  }
  await insertInChunks(Notification.collection, notifications);
  console.log(`🔔 ${notifications.length} notifications`);
  console.log(`✅ Load data ready in "${dbName}". Password for all load users: LOAD_PASSWORD (default shown in the script header).`);
}

main()
  .then(() => disconnectDB())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error("❌ Load seed failed:", error instanceof Error ? error.message : error);
    await disconnectDB().catch(() => undefined);
    process.exit(1);
  });
