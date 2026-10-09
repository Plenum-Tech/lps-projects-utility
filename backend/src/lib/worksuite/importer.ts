import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { ActivityLog } from "../../models/ActivityLog.js";
import { Counter, TASK_NUMBER_COUNTER } from "../../models/Counter.js";
import { Department } from "../../models/Department.js";
import { Milestone } from "../../models/Milestone.js";
import { PROJECT_CODE_REGEX, PROJECT_LIMITS, Project } from "../../models/Project.js";
import type { ProgressMode } from "../../models/Project.js";
import { ProjectCategory } from "../../models/ProjectCategory.js";
import { PROJECT_FILE_LIMITS, ProjectFile } from "../../models/ProjectFile.js";
import { ProjectNote } from "../../models/ProjectNote.js";
import { ProjectStatus, seedProjectStatuses } from "../../models/ProjectStatus.js";
import { TASK_LIMITS, Task } from "../../models/Task.js";
import type { TaskStatus } from "../../models/Task.js";
import { TaskCategory } from "../../models/TaskCategory.js";
import { TaskComment } from "../../models/TaskComment.js";
import { TASK_FILE_LIMITS, TaskFile } from "../../models/TaskFile.js";
import { TaskHistory } from "../../models/TaskHistory.js";
import type { TaskHistoryAction } from "../../models/TaskHistory.js";
import { TASK_LABEL_COLORS, TaskLabel } from "../../models/TaskLabel.js";
import type { TaskLabelColor } from "../../models/TaskLabel.js";
import { TASK_NOTE_LIMITS, TaskNote } from "../../models/TaskNote.js";
import { TimeLog } from "../../models/TimeLog.js";
import { User } from "../../models/User.js";
import { nextEmployeeId } from "../employeeIds.js";
import { uploadToGridFs } from "../gridfs.js";
import { computeProgress } from "../projectProgress.js";
import { ensureTaskCounter, nextTaskNumber } from "../taskNumbers.js";
import { checkAttachment } from "./files.js";
import { htmlToText, truncate } from "./html.js";
import { ImportReport } from "./report.js";
import { dateOnly, num, readDump, str, utcDateTime } from "./sqlDump.js";
import type { SqlRow, TableSpec } from "./sqlDump.js";
import { scanTarGz } from "./tarStream.js";
import { LEGACY_SOURCE, chunks, legacyKey, loadLegacyIds, writePlanned } from "./writer.js";
import type { PlannedDoc } from "./writer.js";

// ---------------------------------------------------------------------------
// Worksuite (MySQL dump) → Projects Utility import. See prompts/worksuite-migration.md.
// Order: departments → users → categories/statuses/labels → projects (+ members,
// milestones, notes) → tasks (+ assignees, subtasks, labels) → comments, notes,
// history → files → time logs → pins → counters → progress recalculation.
// Idempotent: every document carries legacy {source, table, id}; re-runs update.
// ---------------------------------------------------------------------------

type Id = mongoose.Types.ObjectId;
const newId = () => new mongoose.Types.ObjectId();

export interface ImportOptions {
  sqlPath: string;
  backupPath: string | null;
  company: number;
  dryRun: boolean;
  skipFiles: boolean;
  log: (line: string) => void;
}

// --- small helpers -----------------------------------------------------------

function groupBy(rows: SqlRow[], column: string): Map<number, SqlRow[]> {
  const map = new Map<number, SqlRow[]>();
  for (const row of rows) {
    const key = num(row[column]);
    if (key === null) continue;
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return map;
}

function idOf(row: SqlRow): number {
  return num(row.id) ?? 0;
}

function createdAtOf(row: SqlRow, fallback = new Date()): Date {
  return utcDateTime(row.created_at) ?? utcDateTime(row.updated_at) ?? fallback;
}

function updatedAtOf(row: SqlRow, createdAt: Date): Date {
  const updated = utcDateTime(row.updated_at);
  return updated && updated.getTime() >= createdAt.getTime() ? updated : createdAt;
}

function clamp(value: number | null, min: number, max: number): number | null {
  if (value === null) return null;
  return Math.max(min, Math.min(max, value));
}

const EMAIL_REGEX = /^\S+@\S+\.\S+$/;

/** Worksuite hex label colour → nearest theme token. */
function colorToken(hex: string): TaskLabelColor {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "primary";
  const v = parseInt(m[1]!, 16);
  const r = ((v >> 16) & 255) / 255;
  const g = ((v >> 8) & 255) / 255;
  const b = (v & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 0.08) return "muted";
  let h = 0;
  if (max === r) h = ((g - b) / (max - min)) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  h = (h * 60 + 360) % 360;
  if (h < 15 || h >= 340) return "destructive";
  const tokens: TaskLabelColor[] = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"];
  return tokens[Math.min(4, Math.floor(((h - 15) / 325) * 5))] ?? "primary";
}
void TASK_LABEL_COLORS;

/** Board column slug → task status (what users saw in Worksuite). */
function statusFromBoard(slug: string, fallbackCompleted: boolean): TaskStatus {
  const s = slug.toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "completed" || s === "done") return "completed";
  if (s === "waiting_approval" || s === "review" || s === "in_review") return "in_review";
  if (s === "in_process" || s === "doing" || s === "in_progress") return "in_progress";
  if (s === "incomplete" || s === "to_do" || s === "todo") return "todo";
  return fallbackCompleted ? "completed" : "todo";
}

const PROJECT_STATUS_NAMES: Record<string, string> = {
  "in progress": "In progress",
  "not started": "Not started",
  "on hold": "On hold",
  canceled: "Cancelled",
  cancelled: "Cancelled",
  finished: "Finished",
};

const PROGRESS_MODES: Record<string, ProgressMode> = {
  manual: "manual",
  task_completion: "task_completion",
  project_total_time: "total_time",
  project_deadline: "deadline",
};

const HISTORY_ACTIONS: Record<string, TaskHistoryAction> = {
  createActivity: "created",
  statusActivity: "status_changed",
  fileActivity: "file_added",
  subTaskCreateActivity: "subtask_added",
  subTaskUpdateActivity: "subtask_updated",
};

/** "WEB", "ab12", "Some Project 2024" → a valid 2-10 char code base. */
function codeBase(shortCode: string, name: string, legacyId: number): string {
  const direct = shortCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (direct.length >= 2 && direct.length <= 10) return direct;
  const source = shortCode.trim() || name;
  const words = source.split(/[^A-Za-z0-9]+/).filter(Boolean);
  let initials = words.map((w) => (/^\d+$/.test(w) ? w.slice(-2) : w[0]!)).join("").toUpperCase();
  if (initials.length > 10) initials = initials.slice(0, 10);
  if (initials.length >= 2) return initials;
  if (direct.length > 10) return direct.slice(0, 10);
  return `P${legacyId}`.slice(0, 10);
}

function uniqueCode(base: string, used: Set<string>): string {
  if (!used.has(base) && PROJECT_CODE_REGEX.test(base)) return base;
  for (let k = 2; k < 100000; k++) {
    const suffix = String(k);
    const candidate = base.slice(0, 10 - suffix.length) + suffix;
    if (!used.has(candidate) && PROJECT_CODE_REGEX.test(candidate)) return candidate;
  }
  throw new Error("Could not generate a unique project code");
}

/** Trailing task sequence number from a Worksuite short code ("Web site-12" → 12, "37" → 37). */
function shortCodeNumber(code: string): number | null {
  const m = /(?:^|-)\s*(\d{1,9})$/.exec(code.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

// --- dump specification (only the columns we need; never passwords) ------------

function dumpSpecs(company: number): Record<string, TableSpec> {
  const byCompany = (r: SqlRow) => num(r.company_id) === company;
  return {
    companies: { columns: ["id", "timezone"], where: (r) => num(r.id) === company },
    roles: { columns: ["id", "company_id", "name"], where: byCompany },
    role_user: { columns: ["user_id", "role_id"] },
    taskboard_columns: { columns: ["id", "company_id", "slug", "column_name"], where: byCompany },
    teams: { columns: ["id", "company_id", "team_name", "created_at", "updated_at"], where: byCompany },
    designations: { columns: ["id", "company_id", "name"], where: byCompany },
    users: { columns: ["id", "company_id", "is_superadmin", "name", "email", "status", "created_at", "updated_at"], where: byCompany },
    employee_details: {
      columns: [
        "user_id", "company_id", "employee_id", "hourly_rate", "department_id", "designation_id", "joining_date",
        "date_of_birth", "probation_end_date", "internship_end_date", "notice_period_start_date", "notice_period_end_date",
      ],
      where: byCompany,
    },
    project_category: { columns: ["id", "company_id", "category_name", "created_at", "updated_at"], where: byCompany },
    project_status_settings: { columns: ["id", "company_id", "status_name"], where: byCompany },
    projects: {
      columns: [
        "id", "company_id", "project_name", "project_short_code", "project_summary", "project_admin", "start_date", "deadline",
        "category_id", "team_id", "completion_percent", "calculate_task_progress", "project_budget", "hours_allocated", "status",
        "added_by", "public", "manual_timelog", "need_approval_by_admin", "created_at", "updated_at", "deleted_at",
      ],
      where: byCompany,
    },
    project_departments: { columns: ["project_id", "team_id"] },
    project_members: { columns: ["id", "user_id", "project_id", "hourly_rate", "created_at"] },
    project_milestones: {
      columns: ["id", "company_id", "project_id", "milestone_title", "summary", "status", "start_date", "end_date", "created_at", "updated_at"],
      where: byCompany,
    },
    project_notes: { columns: ["id", "project_id", "title", "type", "details", "added_by", "created_at", "updated_at"] },
    project_user_notes: { columns: ["user_id", "project_note_id"] },
    project_files: {
      columns: [
        "id", "company_id", "user_id", "project_id", "filename", "hashname", "size", "google_url", "dropbox_link",
        "external_link_name", "external_link", "added_by", "created_at", "updated_at",
      ],
      // company_id is often NULL here: scoped through the project instead.
    },
    task_category: { columns: ["id", "company_id", "category_name", "created_at", "updated_at"], where: byCompany },
    task_label_list: { columns: ["id", "company_id", "label_name", "color", "description", "created_at", "updated_at"], where: byCompany },
    task_labels: { columns: ["id", "label_id", "task_id"] },
    tasks: {
      columns: [
        "id", "task_short_code", "company_id", "heading", "description", "due_date", "start_date", "project_id", "task_category_id",
        "priority", "status", "board_column_id", "completed_on", "created_by", "recurring_task_id", "milestone_id", "is_private",
        "estimate_hours", "estimate_minutes", "added_by", "repeat", "created_at", "updated_at", "deleted_at",
      ],
      where: byCompany,
    },
    task_users: { columns: ["id", "task_id", "user_id"] },
    sub_tasks: {
      columns: ["id", "task_id", "title", "due_date", "start_date", "status", "assigned_to", "added_by", "last_updated_by", "description", "created_at", "updated_at"],
    },
    sub_task_files: {
      columns: ["id", "user_id", "sub_task_id", "filename", "hashname", "size", "google_url", "dropbox_link", "external_link", "external_link_name", "created_at", "updated_at"],
    },
    task_comments: { columns: ["id", "comment", "user_id", "task_id", "created_at", "updated_at"] },
    task_notes: { columns: ["id", "task_id", "user_id", "note", "added_by", "created_at", "updated_at"] },
    task_files: {
      columns: ["id", "user_id", "task_id", "filename", "hashname", "size", "google_url", "dropbox_link", "external_link", "external_link_name", "added_by", "created_at", "updated_at"],
    },
    task_history: { columns: ["id", "task_id", "sub_task_id", "user_id", "details", "board_column_id", "created_at"] },
    project_time_logs: {
      columns: [
        "id", "company_id", "project_id", "task_id", "user_id", "start_time", "end_time", "memo", "hourly_rate", "earnings", "approved",
        "approved_by", "rejected", "rejected_by", "rejected_at", "reject_reason", "added_by", "edited_by_user", "created_at", "updated_at",
      ],
      where: byCompany,
    },
    project_time_log_breaks: { columns: ["id", "company_id", "project_time_log_id", "start_time", "end_time", "reason"], where: byCompany },
    pinned: { columns: ["id", "company_id", "project_id", "task_id", "user_id"], where: byCompany },
  };
}

// --- the import -----------------------------------------------------------------

export async function runWorksuiteImport(opts: ImportOptions): Promise<ImportReport> {
  const { dryRun, log } = opts;
  const report = new ImportReport();
  const now = new Date();

  // ---- 0. Read the dump ----------------------------------------------------------
  const t0 = Date.now();
  const dump = await readDump(opts.sqlPath, dumpSpecs(opts.company));
  const T = (name: string): SqlRow[] => dump.tables.get(name) ?? [];
  log(`dump parsed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const dumpCounts: Record<string, number> = {};
  for (const [name, rows] of dump.tables) dumpCounts[name] = rows.length;
  report.notes.dumpRowsInScope = Object.values(dumpCounts).reduce((a, b) => a + b, 0);
  (report as unknown as { dump: Record<string, number> }).dump = dumpCounts;

  const tz = str(T("companies")[0]?.timezone);
  if (tz && tz !== "UTC") report.suggestions.push(`Set App Settings → Timezone to ${tz} (the Worksuite company timezone).`);

  // ---- 1. Departments (teams) ---------------------------------------------------------
  /** Generic "match by name (case-insensitive) or create" for small reference collections. */
  async function matchOrCreate(
    model: mongoose.Model<any>,
    table: string,
    entity: string,
    rows: SqlRow[],
    nameOf: (row: SqlRow) => string,
    extra: (row: SqlRow) => Record<string, unknown> = () => ({})
  ): Promise<Map<number, Id>> {
    const result = new Map<number, Id>();
    const legacy = await loadLegacyIds(model);
    const existing = await model.find().select("name").lean<Array<{ _id: Id; name: string }>>();
    const byName = new Map(existing.map((d) => [d.name.trim().toLowerCase(), d._id]));
    const planned: PlannedDoc[] = [];
    const plannedByName = new Map<string, Id>();
    const matchedIds: Array<{ id: Id; legacyId: number }> = [];
    report.source(entity, rows.length);
    for (const row of rows) {
      const legacyId = idOf(row);
      const name = nameOf(row);
      if (!name) {
        report.skip(entity, "missing_name", legacyId);
        continue;
      }
      const known = legacy.get(legacyKey(table, legacyId));
      if (known) {
        result.set(legacyId, known);
        report.entity(entity).updated++;
        continue;
      }
      const lower = name.toLowerCase();
      const match = byName.get(lower);
      if (match) {
        result.set(legacyId, match);
        report.entity(entity).matched++;
        matchedIds.push({ id: match, legacyId });
        continue;
      }
      const dup = plannedByName.get(lower);
      if (dup) {
        result.set(legacyId, dup);
        report.entity(entity).matched++;
        continue;
      }
      const createdAt = createdAtOf(row, now);
      const id = newId();
      plannedByName.set(lower, id);
      planned.push({ table, legacyId, _id: id, exists: false, set: { name, ...extra(row), createdAt, updatedAt: updatedAtOf(row, createdAt) } });
      result.set(legacyId, id);
    }
    const written = await writePlanned(model, entity, planned, report, dryRun);
    for (const doc of planned) if (!written.ok.has(doc.legacyId)) result.delete(doc.legacyId);
    if (!dryRun && matchedIds.length) {
      await model.collection.bulkWrite(
        matchedIds.map((m) => ({
          updateOne: {
            filter: { _id: m.id, legacy: { $exists: false } },
            update: { $set: { legacy: { source: LEGACY_SOURCE, table, id: m.legacyId, matched: true } } },
          },
        })),
        { ordered: false }
      );
    }
    return result;
  }

  const deptIds = await matchOrCreate(Department, "teams", "departments", T("teams"), (r) => str(r.team_name).trim());
  log(`departments: ${deptIds.size}`);

  // ---- 2. Users -------------------------------------------------------------------------
  const roleName = new Map(T("roles").map((r) => [idOf(r), str(r.name).toLowerCase()]));
  const rolesByUser = new Map<number, string[]>();
  for (const ru of T("role_user")) {
    const name = roleName.get(num(ru.role_id) ?? -1);
    if (!name) continue;
    const uid = num(ru.user_id)!;
    rolesByUser.set(uid, [...(rolesByUser.get(uid) ?? []), name]);
  }
  const empByUser = new Map(T("employee_details").map((e) => [num(e.user_id)!, e]));
  const designationName = new Map(T("designations").map((d) => [idOf(d), str(d.name).trim()]));

  const userLegacy = await loadLegacyIds(User);
  const existingUsers = await User.find()
    .select("email role employeeId department designation hourlyRate dateOfBirth joiningDate probationEndDate internshipEndDate noticePeriodStart noticePeriodEnd legacy")
    .lean<Array<Record<string, any>>>();
  const existingById = new Map(existingUsers.map((u) => [String(u._id), u]));
  const existingByEmail = new Map(existingUsers.map((u) => [String(u.email), u]));
  const employeeIdOwner = new Map<string, string>();
  for (const u of existingUsers) if (u.employeeId) employeeIdOwner.set(String(u.employeeId), String(u._id));

  const userIds = new Map<number, Id>();
  const userInfo = new Map<string, { department: Id | null; hourlyRate: number; role: string }>();
  const userRows = T("users");
  report.source("users", userRows.length);
  const plannedUsers: PlannedDoc[] = [];
  const pendingEmployeeIds: PlannedDoc[] = [];
  const legacyAdmins: Array<{ legacyId: number; id: Id }> = [];

  for (const row of [...userRows].sort((a, b) => idOf(a) - idOf(b))) {
    const legacyId = idOf(row);
    if (num(row.is_superadmin) === 1) {
      report.skip("users", "superadmin", legacyId);
      continue;
    }
    const roles = rolesByUser.get(legacyId) ?? [];
    if (!roles.includes("admin") && !roles.includes("employee")) {
      report.skip("users", roles.includes("client") ? "client" : "no_role", legacyId);
      continue;
    }
    const email = str(row.email).trim().toLowerCase();
    if (!EMAIL_REGEX.test(email)) {
      report.skip("users", "missing_email", legacyId);
      continue;
    }
    if (str(row.status) === "deactive") report.note("inactiveUsers", legacyId);
    const role = roles.includes("admin") ? "admin" : "employee";
    const emp = empByUser.get(legacyId);
    const createdAt = createdAtOf(row, now);
    const profile: Record<string, unknown> = {
      department: emp ? (deptIds.get(num(emp.department_id) ?? -1) ?? null) : null,
      designation: emp ? truncate(designationName.get(num(emp.designation_id) ?? -1) ?? "", 100) : "",
      hourlyRate: clamp(num(emp?.hourly_rate ?? null), 0, 100000) ?? 0,
      joiningDate: emp ? dateOnly(emp.joining_date) : null,
      dateOfBirth: emp ? dateOnly(emp.date_of_birth) : null,
      probationEndDate: emp ? dateOnly(emp.probation_end_date) : null,
      internshipEndDate: emp ? dateOnly(emp.internship_end_date) : null,
      noticePeriodStart: emp ? dateOnly(emp.notice_period_start_date) : null,
      noticePeriodEnd: emp ? dateOnly(emp.notice_period_end_date) : null,
    };
    const wantedEmployeeId = truncate(str(emp?.employee_id ?? null).trim(), 30);

    const legacyIdHit = userLegacy.get(legacyKey("users", legacyId));
    const existing = legacyIdHit ? existingById.get(String(legacyIdHit)) : existingByEmail.get(email);
    const matched = Boolean(existing && (!existing.legacy || existing.legacy.matched));

    const employeeIdFree = (ownerId: string) =>
      wantedEmployeeId && (!employeeIdOwner.has(wantedEmployeeId) || employeeIdOwner.get(wantedEmployeeId) === ownerId);

    if (existing && matched) {
      // Pre-existing account (same email): fill empty profile fields only; password, name and role are kept.
      const id = existing._id as Id;
      const set: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(profile)) {
        const current = existing[key];
        const empty = current === null || current === undefined || current === "" || (key === "hourlyRate" && current === 0);
        if (empty && value !== null && value !== "" && value !== 0) set[key] = value;
      }
      if (!existing.employeeId && employeeIdFree(String(id))) {
        set.employeeId = wantedEmployeeId;
        employeeIdOwner.set(wantedEmployeeId, String(id));
      }
      plannedUsers.push({ table: "users", legacyId, _id: id, exists: true, set, matched: true });
      report.entity("users").matched++;
      userIds.set(legacyId, id);
      userInfo.set(String(id), {
        department: (set.department as Id | undefined) ?? (existing.department as Id | null) ?? null,
        hourlyRate: Number(set.hourlyRate ?? existing.hourlyRate ?? 0),
        role: String(existing.role),
      });
      if (role === "admin" && existing.role !== "admin") report.note("matchedUsersKeptRole", legacyId);
      continue;
    }

    const id = (existing?._id as Id | undefined) ?? newId();
    const doc: PlannedDoc = {
      table: "users",
      legacyId,
      _id: id,
      exists: Boolean(existing),
      set: { name: truncate(str(row.name).trim() || email.split("@")[0]!, 100), ...profile, createdAt, updatedAt: updatedAtOf(row, createdAt) },
    };
    if (!existing) {
      const insertOnly: Record<string, unknown> = {
        email,
        role,
        password: await bcrypt.hash(crypto.randomBytes(24).toString("base64url"), 10),
        passwordSetupRequired: true,
        pinnedProjects: [],
        pinnedTasks: [],
      };
      if (employeeIdFree(String(id))) {
        insertOnly.employeeId = wantedEmployeeId;
        employeeIdOwner.set(wantedEmployeeId, String(id));
      } else {
        if (wantedEmployeeId) report.note("employeeIdConflicts", legacyId);
        pendingEmployeeIds.push(doc);
      }
      doc.insertOnly = insertOnly;
    }
    plannedUsers.push(doc);
    userIds.set(legacyId, id);
    userInfo.set(String(id), {
      department: (profile.department as Id | null) ?? null,
      hourlyRate: Number(profile.hourlyRate ?? 0),
      role: existing ? String(existing.role) : role,
    });
    if ((existing ? String(existing.role) : role) === "admin") legacyAdmins.push({ legacyId, id });
  }
  if (!dryRun) {
    for (const doc of pendingEmployeeIds) doc.insertOnly!.employeeId = await nextEmployeeId();
  }
  const writtenUsers = await writePlanned(User, "users", plannedUsers, report, dryRun);
  report.entity("users").updated -= plannedUsers.filter((d) => d.matched && writtenUsers.ok.has(d.legacyId)).length;
  for (const doc of plannedUsers) if (!writtenUsers.ok.has(doc.legacyId)) userIds.delete(doc.legacyId);
  log(`users: ${userIds.size}`);

  const user = (legacyUserId: unknown): Id | null => {
    const n = num(legacyUserId as never);
    return n === null ? null : (userIds.get(n) ?? null);
  };

  // Fallback actor for required references whose Worksuite user wasn't imported.
  let fallbackActor: Id | null = legacyAdmins.find((a) => userIds.has(a.legacyId))?.id ?? null;
  if (!fallbackActor) {
    const admin = await User.findOne({ role: "admin" }).sort({ createdAt: 1 }).select("_id").lean();
    fallbackActor = (admin?._id as Id | undefined) ?? null;
  }
  if (!fallbackActor) throw new Error("No admin user available to attribute imported records to");
  const actorOr = (legacyUserId: unknown, noteKey: string, legacyId: number): Id => {
    const id = user(legacyUserId);
    if (id) return id;
    report.count(noteKey);
    void legacyId;
    return fallbackActor!;
  };

  // ---- 3. Categories, statuses, labels -----------------------------------------------------
  const projectCategoryIds = await matchOrCreate(ProjectCategory, "project_category", "projectCategories", T("project_category"), (r) =>
    truncate(str(r.category_name).trim(), 60)
  );
  const taskCategoryIds = await matchOrCreate(TaskCategory, "task_category", "taskCategories", T("task_category"), (r) =>
    truncate(str(r.category_name).trim(), 60)
  );
  const labelIds = await matchOrCreate(
    TaskLabel,
    "task_label_list",
    "taskLabels",
    T("task_label_list"),
    (r) => truncate(str(r.label_name).trim(), 40),
    (r) => ({ color: colorToken(str(r.color)), description: truncate(htmlToText(str(r.description)), 200) || undefined })
  );

  if (!dryRun) await seedProjectStatuses();
  const statuses = await ProjectStatus.find().select("name isDefault").lean();
  const statusByName = new Map(statuses.map((s) => [s.name.toLowerCase(), s._id as Id]));
  let defaultStatus = (statuses.find((s) => s.isDefault)?._id as Id | undefined) ?? statusByName.get("in progress") ?? null;
  report.source("projectStatuses", T("project_status_settings").length);
  for (const row of T("project_status_settings")) {
    const raw = str(row.status_name).trim();
    const name = PROJECT_STATUS_NAMES[raw.toLowerCase()] ?? truncate(raw.charAt(0).toUpperCase() + raw.slice(1), 40);
    if (!name) {
      report.skip("projectStatuses", "missing_name", idOf(row));
      continue;
    }
    if (statusByName.has(name.toLowerCase())) {
      report.entity("projectStatuses").matched++;
      continue;
    }
    const id = newId();
    if (!dryRun) {
      await ProjectStatus.collection.insertOne({
        _id: id,
        name,
        color: "primary",
        isDefault: false,
        isCompleted: false,
        order: statuses.length + 1,
        active: true,
        legacy: { source: LEGACY_SOURCE, table: "project_status_settings", id: idOf(row) },
        createdAt: now,
        updatedAt: now,
        __v: 0,
      });
    }
    statusByName.set(name.toLowerCase(), id);
    report.entity("projectStatuses").created++;
  }
  if (!defaultStatus) defaultStatus = statusByName.get("in progress") ?? newId();
  const statusFor = (raw: string): Id => {
    const name = PROJECT_STATUS_NAMES[raw.trim().toLowerCase()] ?? raw.trim();
    return statusByName.get(name.toLowerCase()) ?? defaultStatus!;
  };

  // ---- 4. Pre-pass over tasks (needed for project members) ---------------------------------
  const projectRows = T("projects");
  const liveProjectIds = new Set(projectRows.filter((p) => p.deleted_at === null).map(idOf));
  const taskRows = T("tasks");
  const taskUsersByTask = groupBy(
    [...T("task_users")].sort((a, b) => idOf(a) - idOf(b)),
    "task_id"
  );
  const importableTasks = taskRows.filter((t) => {
    if (t.deleted_at !== null) return false;
    const pid = num(t.project_id);
    return pid === null || liveProjectIds.has(pid);
  });
  const assigneesOf = new Map<number, Id[]>();
  for (const t of importableTasks) {
    const list: Id[] = [];
    const seen = new Set<string>();
    for (const tu of taskUsersByTask.get(idOf(t)) ?? []) {
      const id = user(tu.user_id);
      if (id && !seen.has(String(id))) {
        seen.add(String(id));
        list.push(id);
      }
    }
    assigneesOf.set(idOf(t), list);
  }

  // ---- 5. Projects -----------------------------------------------------------------------
  const projectLegacy = await loadLegacyIds(Project);
  const allProjects = await Project.find().select("code members taskCounter legacy").lean<Array<Record<string, any>>>();
  const projectById = new Map(allProjects.map((p) => [String(p._id), p]));
  const usedCodes = new Set(allProjects.map((p) => String(p.code)));
  const membersByProject = groupBy([...T("project_members")].sort((a, b) => idOf(a) - idOf(b)), "project_id");
  const deptsByProject = groupBy(T("project_departments"), "project_id");
  const tasksByProject = groupBy(importableTasks, "project_id");

  const projectIds = new Map<number, Id>();
  const projectCode = new Map<string, string>();
  const projectManager = new Map<number, Id | null>();
  const plannedProjects: PlannedDoc[] = [];
  report.source("projects", projectRows.length);
  for (const row of [...projectRows].sort((a, b) => idOf(a) - idOf(b))) {
    const legacyId = idOf(row);
    if (row.deleted_at !== null) {
      report.skip("projects", "deleted", legacyId);
      continue;
    }
    const known = projectLegacy.get(legacyKey("projects", legacyId));
    const existing = known ? projectById.get(String(known)) : undefined;
    const id = known ?? newId();
    const name = truncate(str(row.project_name).trim() || `Project ${legacyId}`, PROJECT_LIMITS.nameMax);
    let code: string;
    if (existing) code = String(existing.code);
    else {
      code = uniqueCode(codeBase(str(row.project_short_code), name, legacyId), usedCodes);
      usedCodes.add(code);
    }
    projectCode.set(String(id), code);

    const manager = user(row.project_admin);
    projectManager.set(legacyId, manager);
    const createdAt = createdAtOf(row, now);

    // Members: project_members, then task assignees who weren't members (Worksuite allowed that).
    const members: Array<{ user: Id; hourlyRate: number; addedAt: Date }> = [];
    const memberSet = new Set<string>();
    for (const m of membersByProject.get(legacyId) ?? []) {
      const uid = user(m.user_id);
      if (!uid || memberSet.has(String(uid))) continue;
      memberSet.add(String(uid));
      members.push({ user: uid, hourlyRate: clamp(num(m.hourly_rate), 0, PROJECT_LIMITS.maxHourlyRate) ?? 0, addedAt: utcDateTime(m.created_at) ?? createdAt });
    }
    let addedFromTasks = 0;
    for (const t of tasksByProject.get(legacyId) ?? []) {
      for (const uid of assigneesOf.get(idOf(t)) ?? []) {
        if (memberSet.has(String(uid))) continue;
        memberSet.add(String(uid));
        members.push({ user: uid, hourlyRate: userInfo.get(String(uid))?.hourlyRate ?? 0, addedAt: createdAt });
        addedFromTasks++;
      }
    }
    if (addedFromTasks) report.count("projectMembersAddedFromTaskAssignees", addedFromTasks);
    // Keep members someone added in the app after a previous run.
    for (const m of (existing?.members as Array<{ user: Id; hourlyRate: number; addedAt: Date }> | undefined) ?? []) {
      if (!memberSet.has(String(m.user))) {
        memberSet.add(String(m.user));
        members.push(m);
      }
    }
    if (members.length > PROJECT_LIMITS.maxMembers) {
      report.note("projectMembersTruncated", legacyId);
      members.length = PROJECT_LIMITS.maxMembers;
    }

    const departments: Id[] = [];
    for (const teamId of [num(row.team_id), ...(deptsByProject.get(legacyId) ?? []).map((d) => num(d.team_id))]) {
      const dept = teamId === null ? undefined : deptIds.get(teamId);
      if (dept && !departments.some((d) => d.equals(dept))) departments.push(dept);
    }
    departments.splice(PROJECT_LIMITS.maxDepartments);

    const startDate = dateOnly(row.start_date) ?? dateOnly(row.created_at) ?? dateOnly(now.toISOString())!;
    const deadline = dateOnly(row.deadline);
    const progressMode = PROGRESS_MODES[str(row.calculate_task_progress)] ?? "manual";
    const budget = num(row.project_budget);
    const hours = num(row.hours_allocated);
    const summary = truncate(htmlToText(str(row.project_summary)), PROJECT_LIMITS.summaryMax);
    if (htmlToText(str(row.project_summary)).length > PROJECT_LIMITS.summaryMax) report.note("projectSummaryTruncated", legacyId);

    plannedProjects.push({
      table: "projects",
      legacyId,
      _id: id,
      exists: Boolean(existing),
      set: {
        name,
        summary: summary || undefined,
        category: projectCategoryIds.get(num(row.category_id) ?? -1) ?? null,
        departments,
        manager,
        members,
        status: statusFor(str(row.status)),
        startDate,
        deadline,
        progressMode,
        progress: clamp(num(row.completion_percent), 0, 100) ?? 0,
        hoursAllocated: hours !== null && hours > 0 ? hours : null,
        budget: budget !== null && budget > 0 ? budget : null,
        isPublic: num(row.public) === 1,
        manualTimeLogs: str(row.manual_timelog) === "enable",
        requireTaskApproval: str(row.need_approval_by_admin) === "1",
        createdBy: actorOr(row.added_by, "projectCreatorFallbacks", legacyId),
        archivedAt: null,
        createdAt,
        updatedAt: updatedAtOf(row, createdAt),
      },
      insertOnly: { code, taskCounter: 0, brand: null },
    });
    projectIds.set(legacyId, id);
  }
  const writtenProjects = await writePlanned(Project, "projects", plannedProjects, report, dryRun);
  for (const doc of plannedProjects) if (!writtenProjects.ok.has(doc.legacyId)) projectIds.delete(doc.legacyId);
  log(`projects: ${projectIds.size}`);
  const project = (legacyProjectId: unknown): Id | null => {
    const n = num(legacyProjectId as never);
    return n === null ? null : (projectIds.get(n) ?? null);
  };

  // ---- 5b. Milestones ----------------------------------------------------------------------
  const milestoneLegacy = await loadLegacyIds(Milestone);
  const milestoneIds = new Map<number, Id>();
  const plannedMilestones: PlannedDoc[] = [];
  report.source("milestones", T("project_milestones").length);
  for (const row of T("project_milestones")) {
    const legacyId = idOf(row);
    const pid = project(row.project_id);
    if (!pid) {
      report.skip("milestones", "missing_project", legacyId);
      continue;
    }
    const known = milestoneLegacy.get(legacyKey("project_milestones", legacyId));
    const createdAt = createdAtOf(row, now);
    const updatedAt = updatedAtOf(row, createdAt);
    const complete = str(row.status) === "complete";
    const id = known ?? newId();
    plannedMilestones.push({
      table: "project_milestones",
      legacyId,
      _id: id,
      exists: Boolean(known),
      set: {
        project: pid,
        title: truncate(str(row.milestone_title).trim() || `Milestone ${legacyId}`, 150),
        summary: truncate(htmlToText(str(row.summary)), 2000) || undefined,
        startDate: dateOnly(row.start_date),
        endDate: dateOnly(row.end_date),
        status: complete ? "complete" : "incomplete",
        completedAt: complete ? updatedAt : null,
        createdAt,
        updatedAt,
      },
    });
    milestoneIds.set(legacyId, id);
  }
  const writtenMilestones = await writePlanned(Milestone, "milestones", plannedMilestones, report, dryRun);
  for (const doc of plannedMilestones) if (!writtenMilestones.ok.has(doc.legacyId)) milestoneIds.delete(doc.legacyId);

  // ---- 5c. Project notes (+ link-only project files) ------------------------------------------
  const noteLegacy = await loadLegacyIds(ProjectNote);
  const sharedByNote = groupBy(T("project_user_notes"), "project_note_id");
  const plannedProjectNotes: PlannedDoc[] = [];
  const companyProjectIds = new Set(projectRows.map(idOf));
  const projectNoteRows = T("project_notes").filter((r) => companyProjectIds.has(num(r.project_id) ?? -1));
  report.source("projectNotes", projectNoteRows.length);
  for (const row of projectNoteRows) {
    const legacyId = idOf(row);
    const pid = project(row.project_id);
    if (!pid) {
      report.skip("projectNotes", "missing_project", legacyId);
      continue;
    }
    const known = noteLegacy.get(legacyKey("project_notes", legacyId));
    const createdAt = createdAtOf(row, now);
    const isPrivate = num(row.type) === 1;
    const sharedWith: Id[] = [];
    for (const s of sharedByNote.get(legacyId) ?? []) {
      const uid = user(s.user_id);
      if (uid && !sharedWith.some((x) => x.equals(uid))) sharedWith.push(uid);
    }
    const body = htmlToText(str(row.details));
    if (body.length > 10000) report.note("projectNoteBodyTruncated", legacyId);
    plannedProjectNotes.push({
      table: "project_notes",
      legacyId,
      _id: known ?? newId(),
      exists: Boolean(known),
      set: {
        project: pid,
        author: actorOr(row.added_by, "projectNoteAuthorFallbacks", legacyId),
        title: truncate(str(row.title).trim() || "Note", 150),
        body: truncate(body, 10000),
        visibility: isPrivate ? "private" : "members",
        sharedWith: isPrivate ? sharedWith : [],
        createdAt,
        updatedAt: updatedAtOf(row, createdAt),
      },
    });
  }
  // Project files that are only links (Google Drive / Dropbox / external) become notes.
  const linkOf = (row: SqlRow): string => str(row.google_url).trim() || str(row.dropbox_link).trim() || str(row.external_link).trim();
  const projectFileRows = T("project_files").filter((r) => companyProjectIds.has(num(r.project_id) ?? -1));
  for (const row of projectFileRows) {
    if (str(row.hashname).trim() || !linkOf(row)) continue;
    const legacyId = idOf(row);
    const pid = project(row.project_id);
    if (!pid) {
      report.skip("projectFiles", "missing_project", legacyId);
      continue;
    }
    const known = noteLegacy.get(legacyKey("project_files", legacyId));
    const createdAt = createdAtOf(row, now);
    const name = str(row.external_link_name).trim() || str(row.filename).trim() || "Link";
    plannedProjectNotes.push({
      table: "project_files",
      legacyId,
      _id: known ?? newId(),
      exists: Boolean(known),
      set: {
        project: pid,
        author: actorOr(row.user_id ?? row.added_by, "projectNoteAuthorFallbacks", legacyId),
        title: truncate(`Linked file: ${name}`, 150),
        body: truncate(linkOf(row), 10000),
        visibility: "members",
        sharedWith: [],
        createdAt,
        updatedAt: updatedAtOf(row, createdAt),
      },
    });
    report.count("projectFileLinksAsNotes");
  }
  await writePlanned(ProjectNote, "projectNotes", plannedProjectNotes, report, dryRun);

  // ---- 6. Tasks ------------------------------------------------------------------------------
  const boardSlug = new Map(T("taskboard_columns").map((c) => [idOf(c), str(c.slug) || str(c.column_name)]));
  const statusOfColumn = (columnId: unknown, completedFlag: boolean): TaskStatus =>
    statusFromBoard(boardSlug.get(num(columnId as never) ?? -1) ?? "", completedFlag);

  const taskLegacy = await loadLegacyIds(Task);
  // Existing imported tasks: keep their numbers / short codes / subtask ids.
  const existingTaskDocs = taskLegacy.size
    ? await Task.collection
        .find({ "legacy.source": LEGACY_SOURCE }, {
          projection: {
            shortCode: 1,
            project: 1,
            "subtasks._id": 1,
            "subtasks.legacy": 1,
            "subtasks.actualStartAt": 1,
            "subtasks.actualEndAt": 1,
            "subtasks.actualStartSource": 1,
            "subtasks.actualEndSource": 1,
          },
        })
        .toArray()
    : [];
  const subtaskIdByLegacy = new Map<number, Id>();
  /** Actual dates already on imported subtasks (the subtasks array is rewritten on re-runs). */
  type SubActual = { actualStartAt?: Date | null; actualEndAt?: Date | null; actualStartSource?: string | null; actualEndSource?: string | null };
  const subtaskActualByLegacy = new Map<number, SubActual>();
  for (const t of existingTaskDocs) {
    for (const s of (t.subtasks as Array<{ _id: Id; legacy?: { id?: number } } & SubActual> | undefined) ?? []) {
      if (typeof s.legacy?.id !== "number") continue;
      subtaskIdByLegacy.set(s.legacy.id, s._id);
      subtaskActualByLegacy.set(s.legacy.id, s);
    }
  }
  const importedProjectIdList = [...projectIds.values()];
  const usedShortCodes = new Map<string, Set<string>>();
  const maxSeqByProject = new Map<string, number>();
  for (const p of importedProjectIdList) {
    usedShortCodes.set(String(p), new Set());
    maxSeqByProject.set(String(p), Number(projectById.get(String(p))?.taskCounter ?? 0));
  }
  if (importedProjectIdList.length) {
    const cursor = Task.collection.find({ project: { $in: importedProjectIdList } }, { projection: { shortCode: 1, project: 1 } });
    for await (const t of cursor) {
      if (!t.shortCode) continue;
      const key = String(t.project);
      usedShortCodes.get(key)?.add(String(t.shortCode));
      const n = shortCodeNumber(String(t.shortCode));
      if (n !== null && n > (maxSeqByProject.get(key) ?? 0)) maxSeqByProject.set(key, n);
    }
  }

  const labelsByTask = groupBy(T("task_labels"), "task_id");
  const subtasksByTask = groupBy([...T("sub_tasks")].sort((a, b) => idOf(a) - idOf(b)), "task_id");
  const taskIdByLegacy = new Map<number, Id>();
  for (const t of importableTasks) {
    const legacyId = idOf(t);
    const pid = num(t.project_id);
    if (pid !== null && !projectIds.has(pid)) continue;
    taskIdByLegacy.set(legacyId, taskLegacy.get(legacyKey("tasks", legacyId)) ?? newId());
  }

  report.source("tasks", taskRows.length);
  report.source("subtasks", 0);
  const plannedTasks: PlannedDoc[] = [];
  const subtaskLookup = new Map<number, { task: Id; sub: Id; title: string }>();
  const taskAssignedBy = new Map<number, Id>();
  const taskStatusByLegacy = new Map<number, TaskStatus>();
  /** Actual end per legacy task: completed_on of completed tasks (see step 9b). */
  const actualEndByLegacy = new Map<number, Date>();
  const newTaskOrder: Array<{ doc: PlannedDoc; createdAt: Date; projectKey: string | null; wanted: number | null }> = [];

  for (const row of [...taskRows].sort((a, b) => idOf(a) - idOf(b))) {
    const legacyId = idOf(row);
    if (row.deleted_at !== null) {
      report.skip("tasks", "deleted", legacyId);
      continue;
    }
    const pidLegacy = num(row.project_id);
    const pid = pidLegacy === null ? null : (projectIds.get(pidLegacy) ?? null);
    if (pidLegacy !== null && !pid) {
      report.skip("tasks", liveProjectIds.has(pidLegacy) ? "missing_project" : "project_deleted", legacyId);
      continue;
    }
    const id = taskIdByLegacy.get(legacyId)!;
    const exists = taskLegacy.has(legacyKey("tasks", legacyId));
    const createdAt = createdAtOf(row, now);
    const updatedAt = updatedAtOf(row, createdAt);

    // Title / description
    const heading = str(row.heading).replace(/\s+/g, " ").trim() || `Task ${legacyId}`;
    let description = htmlToText(str(row.description));
    let title = heading;
    if (heading.length > 200) {
      title = truncate(heading, 200);
      description = description ? `${heading}\n\n${description}` : heading;
    }
    if (description.length > TASK_LIMITS.maxDescription) {
      report.note("taskDescriptionTruncated", legacyId);
      description = truncate(description, TASK_LIMITS.maxDescription);
    }

    const status = statusOfColumn(row.board_column_id, str(row.status) === "completed");
    taskStatusByLegacy.set(legacyId, status);
    if (status === "completed") actualEndByLegacy.set(legacyId, utcDateTime(row.completed_on) ?? updatedAt);
    const manager = pidLegacy === null ? null : (projectManager.get(pidLegacy) ?? null);
    let assignedBy = user(row.created_by) ?? user(row.added_by) ?? manager;
    if (!assignedBy) {
      report.count("taskAssignedByFallbacks");
      assignedBy = fallbackActor;
    }
    taskAssignedBy.set(legacyId, assignedBy);
    let assignees = assigneesOf.get(legacyId) ?? [];
    if (assignees.length === 0) {
      report.note("tasksWithoutImportedAssignee", legacyId);
      assignees = [assignedBy];
    }
    if (assignees.length > TASK_LIMITS.maxAssignees) {
      report.note("taskAssigneesTruncated", legacyId);
      assignees = assignees.slice(0, TASK_LIMITS.maxAssignees);
    }
    const labels: Id[] = [];
    for (const tl of labelsByTask.get(legacyId) ?? []) {
      const lid = labelIds.get(num(tl.label_id) ?? -1);
      if (lid && !labels.some((l) => l.equals(lid))) labels.push(lid);
    }
    if (labels.length > TASK_LIMITS.maxLabels) {
      report.note("taskLabelsTruncated", legacyId);
      labels.length = TASK_LIMITS.maxLabels;
    }

    // Subtasks
    const subRows = subtasksByTask.get(legacyId) ?? [];
    report.source("subtasks", subRows.length);
    const subtasks: Array<Record<string, unknown>> = [];
    for (const s of subRows) {
      const subLegacy = idOf(s);
      if (subtasks.length >= TASK_LIMITS.maxSubtasks) {
        report.skip("subtasks", "too_many_subtasks", subLegacy);
        continue;
      }
      const fullTitle = htmlToText(str(s.title)).replace(/\s+/g, " ").trim() || `Subtask ${subLegacy}`;
      let subDescription = htmlToText(str(s.description));
      if (fullTitle.length > 200) subDescription = subDescription ? `${fullTitle}\n\n${subDescription}` : fullTitle;
      const done = str(s.status) === "complete";
      const subId = subtaskIdByLegacy.get(subLegacy) ?? newId();
      const subTitle = truncate(fullTitle, 200);
      const subCompletedAt = done ? (utcDateTime(s.updated_at) ?? updatedAt) : null;
      // Actual end = updated_at of completed subtasks (source import) — only when
      // empty or import-sourced; a manual or in-app value is never overwritten.
      const prevActual = subtaskActualByLegacy.get(subLegacy) ?? {};
      let subActualEnd = prevActual.actualEndAt ?? null;
      let subActualEndSource = prevActual.actualEndSource ?? null;
      if (!subActualEnd || subActualEndSource === "import") {
        subActualEnd = done ? subCompletedAt : null;
        subActualEndSource = subActualEnd ? "import" : null;
      }
      const subActualStart = prevActual.actualStartAt ?? null;
      if (subActualEnd && subActualStart && subActualEnd.getTime() < subActualStart.getTime() && subActualEndSource === "import") {
        subActualEnd = null;
        subActualEndSource = null;
      }
      subtasks.push({
        _id: subId,
        title: subTitle,
        description: truncate(subDescription, 2000),
        done,
        assignee: user(s.assigned_to),
        startDate: dateOnly(s.start_date),
        dueDate: dateOnly(s.due_date),
        completedAt: subCompletedAt,
        actualStartAt: subActualStart,
        actualStartSource: subActualStart ? (prevActual.actualStartSource ?? null) : null,
        actualEndAt: subActualEnd,
        actualEndSource: subActualEndSource,
        createdBy: user(s.added_by) ?? assignedBy,
        updatedBy: user(s.last_updated_by),
        legacy: { source: LEGACY_SOURCE, table: "sub_tasks", id: subLegacy },
      });
      subtaskLookup.set(subLegacy, { task: id, sub: subId, title: subTitle });
      report.entity("subtasks").created += exists ? 0 : 1;
      report.entity("subtasks").updated += exists ? 1 : 0;
    }

    const estimate = (num(row.estimate_hours) ?? 0) * 60 + (num(row.estimate_minutes) ?? 0);
    const recurringParentLegacy = num(row.recurring_task_id);
    if (num(row.repeat) === 1) report.note("formerlyRecurringTasks", legacyId);
    if (num(row.is_private) === 1) report.note("privateTasks", legacyId);
    const firstAssignee = assignees[0]!;

    const doc: PlannedDoc = {
      table: "tasks",
      legacyId,
      _id: id,
      exists,
      set: {
        title,
        description: description || undefined,
        assignees,
        assignedBy,
        department: userInfo.get(String(firstAssignee))?.department ?? null,
        category: taskCategoryIds.get(num(row.task_category_id) ?? -1) ?? null,
        project: pid,
        milestone: milestoneIds.get(num(row.milestone_id) ?? -1) ?? null,
        estimateMinutes: estimate > 0 ? Math.min(estimate, TASK_LIMITS.maxEstimateMinutes) : null,
        labels,
        status,
        priority: ["low", "medium", "high"].includes(str(row.priority)) ? str(row.priority) : "medium",
        startDate: dateOnly(row.start_date),
        dueDate: dateOnly(row.due_date),
        subtasks,
        // Imported disabled: nothing is generated right after the import (see report.formerlyRecurringTasks).
        recurrence: null,
        recurringParent: recurringParentLegacy === null ? null : (taskIdByLegacy.get(recurringParentLegacy) ?? null),
        completedAt: status === "completed" ? (utcDateTime(row.completed_on) ?? updatedAt) : null,
        submittedAt: status === "in_review" ? updatedAt : null,
        // actualStartAt / actualEndAt are written by step 9b (never in this $set, so re-runs keep manual values).
        createdAt,
        updatedAt,
      },
    };
    plannedTasks.push(doc);
    if (!exists) {
      const projectKey = pid ? String(pid) : null;
      newTaskOrder.push({ doc, createdAt, projectKey, wanted: projectKey ? shortCodeNumber(str(row.task_short_code)) : null });
    }
  }

  // Numbers: an imported task keeps its Worksuite id as our task number, so the
  // numbers people know (and Pearity's taskNo) stay the same. A task created in the
  // app that already holds such a number is moved to the next free number first.
  // Short codes (per project) are assigned for new tasks only.
  newTaskOrder.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.doc.legacyId - b.doc.legacyId);
  if (newTaskOrder.length) {
    const wanted = newTaskOrder.map((e) => e.doc.legacyId);
    const clashing = await Task.find({ number: { $in: wanted }, "legacy.table": { $ne: "tasks" } })
      .select("_id number")
      .lean();
    if (clashing.length) {
      if (!dryRun) {
        await ensureTaskCounter();
        // Renumbered app tasks must land above every incoming Worksuite id, or they
        // would collide with a task written later in this same run.
        await Counter.updateOne({ _id: TASK_NUMBER_COUNTER }, { $max: { seq: Math.max(...wanted) } });
      }
      for (const t of clashing) {
        report.note("appTasksRenumbered", t.number as number);
        if (!dryRun) {
          await Task.updateOne({ _id: t._id, number: t.number }, { $set: { number: await nextTaskNumber() } });
        }
      }
      log(`tasks: ${clashing.length} app-created task(s) renumbered to free their Worksuite numbers`);
    }
  }
  const needsCode: typeof newTaskOrder = [];
  for (const entry of newTaskOrder) {
    entry.doc.insertOnly = { number: entry.doc.legacyId, position: entry.createdAt.getTime(), shortCode: null };
    if (!entry.projectKey) continue;
    const used = usedShortCodes.get(entry.projectKey)!;
    const code = projectCode.get(entry.projectKey)!;
    const candidate = entry.wanted !== null ? `${code}-${entry.wanted}` : null;
    if (candidate && !used.has(candidate)) {
      used.add(candidate);
      entry.doc.insertOnly.shortCode = candidate;
      if (entry.wanted! > (maxSeqByProject.get(entry.projectKey) ?? 0)) maxSeqByProject.set(entry.projectKey, entry.wanted!);
    } else {
      if (candidate) report.note("taskShortCodesReassigned", entry.doc.legacyId);
      needsCode.push(entry);
    }
  }
  for (const entry of needsCode) {
    const key = entry.projectKey!;
    const code = projectCode.get(key)!;
    const used = usedShortCodes.get(key)!;
    let n = (maxSeqByProject.get(key) ?? 0) + 1;
    while (used.has(`${code}-${n}`)) n++;
    used.add(`${code}-${n}`);
    maxSeqByProject.set(key, n);
    entry.doc.insertOnly!.shortCode = `${code}-${n}`;
  }

  const writtenTasks = await writePlanned(Task, "tasks", plannedTasks, report, dryRun);
  const taskIds = new Map<number, Id>();
  for (const doc of plannedTasks) if (writtenTasks.ok.has(doc.legacyId)) taskIds.set(doc.legacyId, doc._id);
  const writtenTaskIds = new Set([...taskIds.values()].map(String));
  for (const [subLegacy, info] of [...subtaskLookup]) if (!writtenTaskIds.has(String(info.task))) subtaskLookup.delete(subLegacy);
  log(`tasks: ${taskIds.size}`);
  const task = (legacyTaskId: unknown): Id | null => {
    const n = num(legacyTaskId as never);
    return n === null ? null : (taskIds.get(n) ?? null);
  };

  // Project task counters (never lowered).
  if (!dryRun) {
    const ops = [...maxSeqByProject].filter(([, n]) => n > 0).map(([pid, n]) => ({
      updateOne: { filter: { _id: new mongoose.Types.ObjectId(pid) }, update: { $max: { taskCounter: n } } },
    }));
    for (const batch of chunks(ops)) await Project.collection.bulkWrite(batch, { ordered: false });
    const highest = await Task.findOne({ number: { $ne: null } }).sort({ number: -1 }).select("number").lean();
    if (highest?.number) await Counter.updateOne({ _id: TASK_NUMBER_COUNTER }, { $max: { seq: highest.number } }, { upsert: true });
  }

  // ---- 7. Comments, notes, history -------------------------------------------------------------
  const commentLegacy = await loadLegacyIds(TaskComment);
  const plannedComments: PlannedDoc[] = [];
  const allTaskIdsInScope = new Set(taskRows.map(idOf));
  const commentRows = T("task_comments").filter((r) => allTaskIdsInScope.has(num(r.task_id) ?? -1));
  report.source("taskComments", commentRows.length);
  for (const row of commentRows) {
    const legacyId = idOf(row);
    const tid = task(row.task_id);
    if (!tid) {
      report.skip("taskComments", "missing_task", legacyId);
      continue;
    }
    const author = user(row.user_id);
    if (!author) {
      report.skip("taskComments", "author_not_imported", legacyId);
      continue;
    }
    const body = htmlToText(str(row.comment));
    if (!body) {
      report.skip("taskComments", "empty", legacyId);
      continue;
    }
    if (body.length > 5000) report.note("taskCommentTruncated", legacyId);
    const known = commentLegacy.get(legacyKey("task_comments", legacyId));
    const createdAt = createdAtOf(row, now);
    plannedComments.push({
      table: "task_comments",
      legacyId,
      _id: known ?? newId(),
      exists: Boolean(known),
      set: { task: tid, author, body: truncate(body, 5000), mentions: [], createdAt, updatedAt: updatedAtOf(row, createdAt) },
    });
  }
  // Link-only task / subtask files become a comment.
  const taskFileRows = T("task_files").filter((r) => allTaskIdsInScope.has(num(r.task_id) ?? -1));
  const subTaskParent = new Map(T("sub_tasks").map((s) => [idOf(s), num(s.task_id)]));
  const subTaskFileRows = T("sub_task_files").filter((r) => allTaskIdsInScope.has(subTaskParent.get(num(r.sub_task_id) ?? -1) ?? -1));
  const linkComment = (row: SqlRow, table: string, tid: Id | null, legacyId: number, entity: string) => {
    if (!tid) {
      report.skip(entity, "missing_task", legacyId);
      return;
    }
    const known = commentLegacy.get(legacyKey(table, legacyId));
    const createdAt = createdAtOf(row, now);
    const name = str(row.external_link_name).trim() || str(row.filename).trim() || "file";
    plannedComments.push({
      table,
      legacyId,
      _id: known ?? newId(),
      exists: Boolean(known),
      set: {
        task: tid,
        author: user(row.user_id) ?? user(row.added_by) ?? taskAssignedBy.get(num(row.task_id) ?? -1) ?? fallbackActor!,
        body: truncate(`Linked file: ${name} — ${linkOf(row)}`, 5000),
        mentions: [],
        createdAt,
        updatedAt: updatedAtOf(row, createdAt),
      },
    });
    report.count("fileLinksAsComments");
  };
  for (const row of taskFileRows) if (!str(row.hashname).trim() && linkOf(row)) linkComment(row, "task_files", task(row.task_id), idOf(row), "taskFiles");
  for (const row of subTaskFileRows) {
    if (str(row.hashname).trim() || !linkOf(row)) continue;
    linkComment(row, "sub_task_files", task(subTaskParent.get(num(row.sub_task_id) ?? -1)), idOf(row), "subtaskFiles");
  }
  await writePlanned(TaskComment, "taskComments", plannedComments, report, dryRun);
  log(`comments planned: ${plannedComments.length}`);

  const taskNoteLegacy = await loadLegacyIds(TaskNote);
  const plannedTaskNotes: PlannedDoc[] = [];
  const taskNoteRows = T("task_notes").filter((r) => allTaskIdsInScope.has(num(r.task_id) ?? -1));
  report.source("taskNotes", taskNoteRows.length);
  for (const row of taskNoteRows) {
    const legacyId = idOf(row);
    const tid = task(row.task_id);
    if (!tid) {
      report.skip("taskNotes", "missing_task", legacyId);
      continue;
    }
    const author = user(row.user_id) ?? user(row.added_by);
    if (!author) {
      report.skip("taskNotes", "author_not_imported", legacyId);
      continue;
    }
    const body = htmlToText(str(row.note));
    if (!body) {
      report.skip("taskNotes", "empty", legacyId);
      continue;
    }
    if (body.length > TASK_NOTE_LIMITS.maxBody) report.note("taskNoteTruncated", legacyId);
    const known = taskNoteLegacy.get(legacyKey("task_notes", legacyId));
    const createdAt = createdAtOf(row, now);
    plannedTaskNotes.push({
      table: "task_notes",
      legacyId,
      _id: known ?? newId(),
      exists: Boolean(known),
      set: {
        task: tid,
        author,
        title: "",
        body: truncate(body, TASK_NOTE_LIMITS.maxBody),
        visibility: "task",
        mentions: [],
        pinned: false,
        createdAt,
        updatedAt: updatedAtOf(row, createdAt),
      },
    });
  }
  await writePlanned(TaskNote, "taskNotes", plannedTaskNotes, report, dryRun);

  const historyLegacy = await loadLegacyIds(TaskHistory);
  const historyRows = T("task_history")
    .filter((r) => allTaskIdsInScope.has(num(r.task_id) ?? -1))
    .sort((a, b) => num(a.task_id)! - num(b.task_id)! || createdAtOf(a, now).getTime() - createdAtOf(b, now).getTime() || idOf(a) - idOf(b));
  report.source("taskHistory", historyRows.length);
  const plannedHistory: PlannedDoc[] = [];
  let lastTaskForStatus = -1;
  let previousStatus: TaskStatus = "todo";
  for (const row of historyRows) {
    const legacyId = idOf(row);
    const legacyTask = num(row.task_id)!;
    if (legacyTask !== lastTaskForStatus) {
      lastTaskForStatus = legacyTask;
      previousStatus = "todo";
    }
    const tid = task(legacyTask);
    if (!tid) {
      report.skip("taskHistory", "missing_task", legacyId);
      continue;
    }
    const key = str(row.details).trim();
    const action: TaskHistoryAction = HISTORY_ACTIONS[key] ?? "updated";
    let details: Record<string, unknown>;
    switch (action) {
      case "created":
        details = { imported: true };
        if (row.board_column_id !== null) previousStatus = statusOfColumn(row.board_column_id, false);
        break;
      case "status_changed": {
        const to: TaskStatus = row.board_column_id !== null ? statusOfColumn(row.board_column_id, false) : (taskStatusByLegacy.get(legacyTask) ?? previousStatus);
        details = { from: previousStatus, to };
        previousStatus = to;
        break;
      }
      case "subtask_added":
      case "subtask_updated": {
        const sub = subtaskLookup.get(num(row.sub_task_id) ?? -1);
        details = { subtaskId: sub ? String(sub.sub) : null, title: sub?.title ?? null, ...(action === "subtask_updated" ? { fields: [] } : {}) };
        break;
      }
      case "file_added":
        details = { imported: true };
        break;
      default:
        details = { fields: [], worksuite: key };
    }
    const known = historyLegacy.get(legacyKey("task_history", legacyId));
    plannedHistory.push({
      table: "task_history",
      legacyId,
      _id: known ?? newId(),
      exists: Boolean(known),
      set: { task: tid, actor: user(row.user_id), action, details, createdAt: createdAtOf(row, now) },
    });
  }
  await writePlanned(TaskHistory, "taskHistory", plannedHistory, report, dryRun);
  log(`history planned: ${plannedHistory.length}`);

  // ---- 8. Files (GridFS) ---------------------------------------------------------------------------
  await importFiles();

  async function importFiles(): Promise<void> {
    type FileRef = {
      entity: "taskFiles" | "subtaskFiles" | "projectFiles";
      table: string;
      legacyId: number;
      key: string;
      filename: string;
      row: SqlRow;
      task?: Id;
      subtask?: Id | null;
      project?: Id;
    };
    const taskFileLegacy = await loadLegacyIds(TaskFile);
    const projectFileLegacy = await loadLegacyIds(ProjectFile);
    const refs = new Map<string, FileRef[]>();
    const perTask = new Map<string, number>();
    const perProject = new Map<string, number>();
    if (taskIds.size) {
      for (const r of await TaskFile.aggregate<{ _id: Id; n: number }>([{ $match: { task: { $in: [...taskIds.values()] } } }, { $group: { _id: "$task", n: { $sum: 1 } } }])) {
        perTask.set(String(r._id), r.n);
      }
    }
    if (projectIds.size) {
      for (const r of await ProjectFile.aggregate<{ _id: Id; n: number }>([{ $match: { project: { $in: [...projectIds.values()] } } }, { $group: { _id: "$project", n: { $sum: 1 } } }])) {
        perProject.set(String(r._id), r.n);
      }
    }
    const add = (ref: FileRef) => {
      const list = refs.get(ref.key);
      if (list) list.push(ref);
      else refs.set(ref.key, [ref]);
    };

    const hashed = (r: SqlRow) => str(r.hashname).trim();
    const taskHashed = taskFileRows.filter(hashed);
    const subHashed = subTaskFileRows.filter(hashed);
    const projectHashed = projectFileRows.filter(hashed);
    report.source("taskFiles", taskFileRows.length);
    report.source("subtaskFiles", subTaskFileRows.length);
    report.source("projectFiles", projectFileRows.length);

    for (const row of taskHashed) {
      const legacyId = idOf(row);
      const tid = task(row.task_id);
      if (!tid) report.skip("taskFiles", "missing_task", legacyId);
      else if (taskFileLegacy.has(legacyKey("task_files", legacyId))) report.entity("taskFiles").updated++;
      else add({ entity: "taskFiles", table: "task_files", legacyId, key: `task-files/${num(row.task_id)}/${hashed(row)}`, filename: str(row.filename).trim() || hashed(row), row, task: tid, subtask: null });
    }
    for (const row of subHashed) {
      const legacyId = idOf(row);
      const sub = subtaskLookup.get(num(row.sub_task_id) ?? -1);
      if (!sub) report.skip("subtaskFiles", "missing_subtask", legacyId);
      else if (taskFileLegacy.has(legacyKey("sub_task_files", legacyId))) report.entity("subtaskFiles").updated++;
      else add({ entity: "subtaskFiles", table: "sub_task_files", legacyId, key: `sub-task-files/${num(row.sub_task_id)}/${hashed(row)}`, filename: str(row.filename).trim() || hashed(row), row, task: sub.task, subtask: sub.sub });
    }
    for (const row of projectHashed) {
      const legacyId = idOf(row);
      const pid = project(row.project_id);
      if (!pid) report.skip("projectFiles", "missing_project", legacyId);
      else if (projectFileLegacy.has(legacyKey("project_files", legacyId))) report.entity("projectFiles").updated++;
      else add({ entity: "projectFiles", table: "project_files", legacyId, key: `project-files/${num(row.project_id)}/${hashed(row)}`, filename: str(row.filename).trim() || hashed(row), row, project: pid });
    }
    const pendingCount = [...refs.values()].reduce((a, l) => a + l.length, 0);
    if (!pendingCount) return;
    if (opts.skipFiles || !opts.backupPath) {
      for (const list of refs.values()) for (const ref of list) report.skip(ref.entity, "files_skipped", ref.legacyId);
      return;
    }

    const PATH_RE = /(?:^|\/)public\/user-uploads\/((?:task-files|sub-task-files|project-files)\/\d+\/[^/]+)$/;
    const found = new Set<string>();
    const tf0 = Date.now();
    await scanTarGz(
      opts.backupPath,
      (info) => {
        if (info.path.includes("/.trash/")) return false;
        const m = PATH_RE.exec(info.path);
        if (!m || !refs.has(m[1]!) || found.has(m[1]!)) return false;
        found.add(m[1]!);
        if (info.size > TASK_FILE_LIMITS.maxBytes) {
          for (const ref of refs.get(m[1]!)!) report.skip(ref.entity, "oversized_file", ref.legacyId);
          return false;
        }
        return true;
      },
      async (info, data) => {
        const key = PATH_RE.exec(info.path)![1]!;
        for (const ref of refs.get(key) ?? []) {
          const check = checkAttachment(ref.filename, data);
          if (!check.ok) {
            report.skip(ref.entity, check.reason, ref.legacyId);
            continue;
          }
          const createdAt = createdAtOf(ref.row, now);
          const uploader = user(ref.row.user_id) ?? user(ref.row.added_by) ?? fallbackActor!;
          const filename = truncate(ref.filename, 255);
          if (ref.entity === "projectFiles") {
            const count = perProject.get(String(ref.project)) ?? 0;
            if (count >= PROJECT_FILE_LIMITS.maxFilesPerProject) {
              report.skip(ref.entity, "too_many_files", ref.legacyId);
              continue;
            }
            perProject.set(String(ref.project), count + 1);
          } else {
            const count = perTask.get(String(ref.task)) ?? 0;
            if (count >= TASK_FILE_LIMITS.maxFilesPerTask) {
              report.skip(ref.entity, "too_many_files", ref.legacyId);
              continue;
            }
            perTask.set(String(ref.task), count + 1);
          }
          if (dryRun) {
            report.entity(ref.entity).created++;
            continue;
          }
          const legacy = { source: LEGACY_SOURCE, table: ref.table, id: ref.legacyId };
          const gridFsId = await uploadToGridFs(check.data, filename, {
            contentType: check.mime,
            ...(ref.project ? { project: ref.project } : { task: ref.task }),
            uploadedBy: uploader,
            legacy,
          });
          const doc = ref.project
            ? { _id: newId(), project: ref.project, uploadedBy: uploader, filename, mimeType: check.mime, size: check.data.length, gridFsId, legacy, createdAt, updatedAt: updatedAtOf(ref.row, createdAt), __v: 0 }
            : { _id: newId(), task: ref.task, subtask: ref.subtask ?? null, uploadedBy: uploader, filename, mimeType: check.mime, size: check.data.length, gridFsId, legacy, createdAt, updatedAt: updatedAtOf(ref.row, createdAt), __v: 0 };
          await (ref.project ? ProjectFile : TaskFile).collection.insertOne(doc);
          report.entity(ref.entity).created++;
        }
      }
    );
    for (const [key, list] of refs) if (!found.has(key)) for (const ref of list) report.skip(ref.entity, "missing_file", ref.legacyId);
    log(`files scanned in ${((Date.now() - tf0) / 1000).toFixed(1)}s (found ${found.size} of ${refs.size})`);
  }

  // ---- 9. Time logs -------------------------------------------------------------------------------
  const timeLogLegacy = await loadLegacyIds(TimeLog);
  const breaksByLog = groupBy(T("project_time_log_breaks"), "project_time_log_id");
  const plannedLogs: PlannedDoc[] = [];
  report.source("timeLogs", T("project_time_logs").length);
  for (const row of T("project_time_logs")) {
    const legacyId = idOf(row);
    const start = utcDateTime(row.start_time);
    const end = utcDateTime(row.end_time);
    if (!end) {
      report.skip("timeLogs", "running_timer", legacyId);
      continue;
    }
    if (!start || end.getTime() < start.getTime()) {
      report.skip("timeLogs", "invalid_times", legacyId);
      continue;
    }
    const uid = user(row.user_id);
    if (!uid) {
      report.skip("timeLogs", "user_not_imported", legacyId);
      continue;
    }
    const pidLegacy = num(row.project_id);
    const pid = pidLegacy === null ? null : project(pidLegacy);
    const tidLegacy = num(row.task_id);
    const tid = tidLegacy === null ? null : task(tidLegacy);
    if (pidLegacy !== null && !pid) report.note("timeLogsWithoutProject", legacyId);
    if (tidLegacy !== null && !tid) report.note("timeLogsWithoutTask", legacyId);
    const breaks: Array<{ startTime: Date; endTime: Date | null; reason?: string }> = [];
    let breakMs = 0;
    for (const b of breaksByLog.get(legacyId) ?? []) {
      const bs = utcDateTime(b.start_time);
      if (!bs) continue;
      const be = utcDateTime(b.end_time) ?? end;
      if (be.getTime() > bs.getTime()) breakMs += be.getTime() - bs.getTime();
      breaks.push({ startTime: bs, endTime: be, reason: truncate(str(b.reason).trim(), 200) || undefined });
    }
    const breakMinutes = Math.round(breakMs / 60000);
    const durationMinutes = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000) - breakMinutes);
    const rejected = num(row.rejected) === 1;
    const approved = !rejected && num(row.approved) === 1;
    const createdAt = createdAtOf(row, start);
    const updatedAt = updatedAtOf(row, createdAt);
    const known = timeLogLegacy.get(legacyKey("project_time_logs", legacyId));
    plannedLogs.push({
      table: "project_time_logs",
      legacyId,
      _id: known ?? newId(),
      exists: Boolean(known),
      set: {
        user: uid,
        project: pid,
        task: tid,
        startTime: start,
        endTime: end,
        breaks,
        durationMinutes,
        breakMinutes,
        memo: truncate(htmlToText(str(row.memo)), 500),
        source: "timer",
        hourlyRate: Math.max(0, num(row.hourly_rate) ?? 0),
        earnings: Math.max(0, num(row.earnings) ?? 0),
        status: rejected ? "rejected" : approved ? "approved" : "pending",
        reviewedBy: rejected ? user(row.rejected_by) : approved ? user(row.approved_by) : null,
        reviewedAt: rejected ? (utcDateTime(row.rejected_at) ?? updatedAt) : approved && user(row.approved_by) ? updatedAt : null,
        rejectReason: rejected ? truncate(htmlToText(str(row.reject_reason)), 1000) || undefined : undefined,
        addedBy: user(row.added_by) ?? uid,
        editedBy: user(row.edited_by_user),
        autoStopped: false,
        createdAt,
        updatedAt,
      },
    });
  }
  await writePlanned(TimeLog, "timeLogs", plannedLogs, report, dryRun);
  log(`time logs planned: ${plannedLogs.length}`);

  // ---- 9b. Actual start / end ---------------------------------------------------------------------
  // End = completed_on of completed tasks. Start = the first history entry that moved
  // the task to the Doing / In Process column, else its earliest time log. Source
  // "import"; written only where the value is empty or still import-sourced, so a
  // re-run never overwrites a manual (or app-set) value.
  const firstDoing = new Map<number, Date>();
  for (const row of historyRows) {
    // Only entries that moved the task (status change) or created it in that column.
    const moved = HISTORY_ACTIONS[str(row.details).trim()];
    if (moved !== "status_changed" && moved !== "created") continue;
    if (row.board_column_id === null || statusOfColumn(row.board_column_id, false) !== "in_progress") continue;
    const legacyTask = num(row.task_id);
    if (legacyTask === null) continue;
    const at = createdAtOf(row, now);
    const known = firstDoing.get(legacyTask);
    if (!known || at.getTime() < known.getTime()) firstDoing.set(legacyTask, at);
  }
  const firstLog = new Map<number, Date>();
  for (const row of T("project_time_logs")) {
    const legacyTask = num(row.task_id);
    const start = utcDateTime(row.start_time);
    if (legacyTask === null || !start || !utcDateTime(row.end_time)) continue;
    const known = firstLog.get(legacyTask);
    if (!known || start.getTime() < known.getTime()) firstLog.set(legacyTask, start);
  }
  const actualOps: Array<{ updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> } }> = [];
  let plannedStarts = 0;
  let plannedEnds = 0;
  for (const [legacyTask, tid] of taskIds) {
    const start = firstDoing.get(legacyTask) ?? firstLog.get(legacyTask) ?? null;
    const end = actualEndByLegacy.get(legacyTask) ?? null;
    if (start) plannedStarts++;
    if (end) plannedEnds++;
    for (const [field, source, value] of [
      ["actualStartAt", "actualStartSource", start],
      ["actualEndAt", "actualEndSource", end],
    ] as const) {
      actualOps.push(
        value
          ? {
              updateOne: {
                filter: { _id: tid, $or: [{ [field]: null }, { [source]: "import" }] },
                update: { $set: { [field]: value, [source]: "import" } },
              },
            }
          : { updateOne: { filter: { _id: tid, [source]: "import" }, update: { $set: { [field]: null, [source]: null } } } }
      );
    }
  }
  report.count("actualStartsFromWorksuite", plannedStarts);
  report.count("actualEndsFromWorksuite", plannedEnds);
  if (!dryRun) {
    let modified = 0;
    for (const batch of chunks(actualOps)) {
      const result = await Task.collection.bulkWrite(batch as any, { ordered: false });
      modified += result.modifiedCount;
    }
    report.count("actualDatesWritten", modified);
  }
  log(`actual dates: ${plannedStarts} starts, ${plannedEnds} ends`);

  // ---- 10. Pins -----------------------------------------------------------------------------------
  const pinsByUser = new Map<string, { projects: Id[]; tasks: Id[] }>();
  report.source("pins", T("pinned").length);
  for (const row of T("pinned")) {
    const legacyId = idOf(row);
    const uid = user(row.user_id);
    if (!uid) {
      report.skip("pins", "user_not_imported", legacyId);
      continue;
    }
    const entry = pinsByUser.get(String(uid)) ?? { projects: [], tasks: [] };
    if (num(row.task_id) !== null) {
      const tid = task(row.task_id);
      if (!tid) {
        report.skip("pins", "missing_task", legacyId);
        continue;
      }
      entry.tasks.push(tid);
    } else {
      const pid = project(row.project_id);
      if (!pid) {
        report.skip("pins", "missing_project", legacyId);
        continue;
      }
      entry.projects.push(pid);
    }
    pinsByUser.set(String(uid), entry);
    report.entity("pins").updated++;
  }
  if (!dryRun && pinsByUser.size) {
    await User.collection.bulkWrite(
      [...pinsByUser].map(([uid, pins]) => ({
        updateOne: {
          filter: { _id: new mongoose.Types.ObjectId(uid) },
          update: { $addToSet: { pinnedProjects: { $each: pins.projects }, pinnedTasks: { $each: pins.tasks } } },
        },
      })),
      { ordered: false }
    );
  }

  // ---- 11. Progress recalculation + activity -----------------------------------------------------------
  if (!dryRun && projectIds.size) {
    const docs = await Project.find({ _id: { $in: [...projectIds.values()] } });
    const ops: Array<{ updateOne: { filter: { _id: Id }; update: { $set: { progress: number } } } }> = [];
    for (const p of docs) {
      const next = await computeProgress(p, now);
      if (next !== p.progress) ops.push({ updateOne: { filter: { _id: p._id as Id }, update: { $set: { progress: next } } } });
    }
    for (const batch of chunks(ops)) await Project.collection.bulkWrite(batch, { ordered: false });
    report.count("projectProgressRecalculated", ops.length);

    await ActivityLog.create({
      action: "import_completed",
      actor: null,
      actorName: "Worksuite import",
      targetType: "import",
      targetName: "Worksuite",
      details: {
        source: "worksuite",
        company: opts.company,
        counts: Object.fromEntries(Object.entries(report.entities).map(([k, c]) => [k, { created: c.created, updated: c.updated, skipped: c.skipped }])),
      },
    });
  }

  return report;
}
