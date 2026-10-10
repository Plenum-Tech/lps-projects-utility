import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { logActivity } from "../lib/activityLog.js";
import { touchApiKey, verifyApiKey } from "../lib/apiKeys.js";
import {
  TAG_ID_REGEX,
  ensurePearityTag,
  ipAllowed,
  parseTaskNo,
  pearityActive,
  pearityGenerateUrl,
  pearitySettings,
  recordPearityUsage,
  tagRefs,
  taskContexts,
  taskNoOf,
  utilityTaskUrl,
} from "../lib/pearity.js";
import type { PearityTagRefJson, TaskContext } from "../lib/pearity.js";
import { canViewTaskAsync, param, recordTaskHistory } from "../lib/taskAccess.js";
import { rateLimit } from "../middlewares/rateLimit.js";
import { ApiAuditLog } from "../models/ApiKey.js";
import type { ApiKeyScope, IApiKey } from "../models/ApiKey.js";
import { PearityTag } from "../models/PearityTag.js";
import type { IPearityTag } from "../models/PearityTag.js";
import { archivedProjectIds } from "../models/Project.js";
import { Task } from "../models/Task.js";
import type { ITask } from "../models/Task.js";
import { User } from "../models/User.js";
import type { IUser } from "../models/User.js";

// ---------------------------------------------------------------------------
// Pearity server-to-server API — /api/integrations/pearity/v1
//   Authorization: Bearer <api key>   (scopes pearity:read / pearity:tags)
//   600 requests / minute per key, optional IP allowlist, every call audited.
// Data is scoped to the `email` user's visible tasks (same rules as the UI) and
// limited to codes, titles, status, dates, project / brand / category and the tag.
// ---------------------------------------------------------------------------

type ApiLocals = { pearityKey?: IApiKey; pearityKeyId?: string; errorCode?: string; auditEmail?: string };

function locals(res: Response): ApiLocals {
  return res.locals as ApiLocals;
}

function fail(res: Response, status: number, code: string, error: string): void {
  locals(res).errorCode = code;
  res.status(status).json({ error, code });
}

/** Writes one ApiAuditLog row when the response finishes (path only — no query, no key). */
export function pearityAudit(req: Request, res: Response, next: NextFunction): void {
  const started = Date.now();
  res.setHeader("Cache-Control", "no-store");
  res.on("finish", () => {
    const l = locals(res);
    void ApiAuditLog.create({
      integration: "pearity",
      apiKey: l.pearityKey?._id ?? null,
      keyPrefix: l.pearityKey?.prefix ?? "",
      method: req.method,
      path: `${req.baseUrl}${req.path}`.slice(0, 300),
      email: (l.auditEmail ?? "").slice(0, 254),
      status: res.statusCode,
      code: l.errorCode ?? "",
      ip: req.ip ?? "",
      ms: Date.now() - started,
    }).catch(() => undefined);
  });
  next();
}

// Failed authentication attempts per IP (bad / missing / revoked keys): 30 per 15 minutes.
const AUTH_FAIL_WINDOW_MS = 15 * 60 * 1000;
const AUTH_FAIL_MAX = 30;
const authFailures = new Map<string, { count: number; resetAt: number }>();

function authBlocked(ip: string): boolean {
  const entry = authFailures.get(ip);
  return Boolean(entry && entry.resetAt > Date.now() && entry.count >= AUTH_FAIL_MAX);
}

function noteAuthFailure(ip: string): void {
  const now = Date.now();
  const entry = authFailures.get(ip);
  if (!entry || entry.resetAt <= now) {
    if (authFailures.size > 10_000) authFailures.clear();
    authFailures.set(ip, { count: 1, resetAt: now + AUTH_FAIL_WINDOW_MS });
  } else entry.count += 1;
}

const perKeyLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  keyGenerator: (req) => `key:${(req.res?.locals as ApiLocals | undefined)?.pearityKeyId ?? req.ip}`,
  message: "Rate limit exceeded: 600 requests per minute per API key.",
});

/** Integration on → Bearer key (constant-time) → not revoked → IP allowlist → per-key rate limit. */
export async function pearityApiAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const settings = await pearitySettings();
  if (!pearityActive(settings)) {
    fail(res, 503, "integration_disabled", "The Pearity integration is turned off in Utility.");
    return;
  }
  const ip = req.ip ?? "unknown";
  if (authBlocked(ip)) {
    fail(res, 429, "too_many_auth_failures", "Too many failed authentication attempts. Try again later.");
    return;
  }
  const header = req.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match) {
    noteAuthFailure(ip);
    fail(res, 401, "missing_api_key", "Send the API key as 'Authorization: Bearer <key>'.");
    return;
  }
  const check = await verifyApiKey(match[1]!);
  if (!check.ok) {
    noteAuthFailure(ip);
    if (check.reason === "revoked") fail(res, 401, "revoked_api_key", "This API key has been revoked.");
    else fail(res, 401, "invalid_api_key", "Invalid API key.");
    return;
  }
  const l = locals(res);
  l.pearityKey = check.key;
  l.pearityKeyId = check.key._id.toString();
  if (!ipAllowed(req.ip, settings.allowedIps)) {
    fail(res, 403, "ip_not_allowed", "Requests from this IP address are not allowed for this integration.");
    return;
  }
  perKeyLimit(req, res, () => {
    touchApiKey(check.key, req.ip);
    next();
  });
}

export function requireScope(scope: ApiKeyScope) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (!locals(res).pearityKey?.scopes.includes(scope)) {
      fail(res, 403, "insufficient_scope", `This API key lacks the ${scope} scope.`);
      return;
    }
    next();
  };
}

// --- Helpers -----------------------------------------------------------------------

/** Resolves `email` (query or body) to a user, or responds 400/404. */
async function userForEmail(req: Request, res: Response, raw: unknown): Promise<IUser | undefined> {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  locals(res).auditEmail = email;
  if (!email || email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) {
    fail(res, 400, "invalid_email", "Pass the user's email address (email=...).");
    return undefined;
  }
  const user = await User.findOne({ email });
  if (!user) {
    fail(res, 404, "unknown_user", "No active Utility user has this email address.");
    return undefined;
  }
  return user;
}

/** `:taskId` as an ObjectId or a task code ("GENAI-65"). */
async function findTask(raw: string | undefined): Promise<ITask | null> {
  if (!raw || raw.length > 60) return null;
  if (mongoose.isValidObjectId(raw) && /^[0-9a-f]{24}$/i.test(raw)) return Task.findById(raw);
  return Task.findOne({ shortCode: raw.toUpperCase() });
}

/** Loads `:taskId` visible to `user`, or responds 404 (invisible tasks look missing). */
async function visibleTask(req: Request, res: Response, user: IUser): Promise<ITask | undefined> {
  const task = await findTask(param(req, "taskId"));
  if (!task || !(await canViewTaskAsync(user, task))) {
    fail(res, 404, "task_not_found", "Task not found (or this user can't view it).");
    return undefined;
  }
  return task;
}

function iso(value: Date | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

type TaskRow = Pick<
  ITask,
  "title" | "status" | "dueDate" | "actualStartAt" | "actualEndAt" | "shortCode" | "number" | "project" | "category"
> & { _id: mongoose.Types.ObjectId; updatedAt: Date };

function taskJson(
  task: TaskRow,
  context: TaskContext,
  tag: PearityTagRefJson | null,
  generateUrl: string | null
) {
  return {
    taskId: task._id.toString(),
    taskCode: context.taskCode,
    taskNo: context.taskNo,
    title: task.title,
    status: task.status,
    dueDate: iso(task.dueDate),
    actualStartAt: iso(task.actualStartAt),
    actualEndAt: iso(task.actualEndAt),
    updatedAt: iso(task.updatedAt),
    taskTag: context.fields.taskTag || null,
    scopeUnit: context.fields.scopeUnit || null,
    quantity: context.fields.quantity ? Number(context.fields.quantity) : null,
    shortName: context.fields.shortName || null,
    project: context.project
      ? {
          id: context.project.id,
          name: context.project.name,
          code: context.project.code,
          tag: context.project.tag || null,
          month: context.project.month || null,
          type: context.project.type || null,
        }
      : null,
    brand: context.brand,
    category: context.category,
    utilityUrl: utilityTaskUrl(task._id),
    pearityTag: tag,
    tagUrl: tag?.tagUrl ?? null,
    generateUrl,
  };
}

/** Serializes many tasks: contexts + tags in a fixed number of queries. */
async function tasksJson(tasks: TaskRow[]) {
  const settings = await pearitySettings();
  const ids = tasks.map((t) => t._id);
  const [contexts, tagDocs] = await Promise.all([
    taskContexts(tasks),
    ids.length ? PearityTag.find({ task: { $in: ids } }).lean<IPearityTag[]>() : Promise.resolve([] as IPearityTag[]),
  ]);
  const refs = await tagRefs(tagDocs, { contexts });
  const tagByTask = new Map(tagDocs.map((t) => [t.task.toString(), t]));
  return tasks.map((task) => {
    const id = task._id.toString();
    const context = contexts.get(id)!;
    const tag = tagByTask.get(id);
    return taskJson(task, context, refs.get(id) ?? null, tag ? pearityGenerateUrl(settings, tag, task._id, context) : null);
  });
}

function parseLimit(raw: unknown, fallback = 50): number | null {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 200) return null;
  return n;
}

function parseSince(raw: unknown): Date | null | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw !== "string") return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

interface Cursor {
  t: number;
  i: string;
}

function encodeCursor(date: Date, id: mongoose.Types.ObjectId): string {
  return Buffer.from(JSON.stringify({ t: date.getTime(), i: id.toString() })).toString("base64url");
}

function decodeCursor(raw: unknown): Cursor | null | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw !== "string" || raw.length > 200) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<Cursor>;
    if (typeof parsed.t !== "number" || !Number.isFinite(parsed.t) || typeof parsed.i !== "string") return null;
    if (!/^[0-9a-f]{24}$/i.test(parsed.i)) return null;
    return { t: parsed.t, i: parsed.i };
  } catch {
    return null;
  }
}

// --- Endpoints ------------------------------------------------------------------------

/** GET /tasks?email=&status=open|all&updatedSince=&limit=&cursor= — newest-updated first. */
export async function apiListTasks(req: Request, res: Response): Promise<void> {
  const user = await userForEmail(req, res, req.query.email);
  if (!user) return;
  const status = req.query.status ?? "open";
  if (status !== "open" && status !== "all") {
    fail(res, 400, "invalid_status", "status must be open or all");
    return;
  }
  const limit = parseLimit(req.query.limit);
  if (limit === null) {
    fail(res, 400, "invalid_limit", "limit must be an integer between 1 and 200");
    return;
  }
  const since = parseSince(req.query.updatedSince);
  if (since === null) {
    fail(res, 400, "invalid_updated_since", "updatedSince must be an ISO 8601 date-time");
    return;
  }
  const cursor = decodeCursor(req.query.cursor);
  if (cursor === null) {
    fail(res, 400, "invalid_cursor", "cursor is not valid — pass nextCursor from the previous page");
    return;
  }

  // The user's assigned tasks (task or subtask assignee), outside archived projects.
  const and: Record<string, unknown>[] = [{ $or: [{ assignees: user._id }, { "subtasks.assignee": user._id }] }];
  const archived = await archivedProjectIds();
  if (archived.length > 0) and.push({ project: { $nin: archived } });
  if (status === "open") and.push({ status: { $ne: "completed" } });
  if (since) {
    const tagged = await PearityTag.find({ createdAt: { $gte: since } }).select("task").lean();
    and.push({ $or: [{ updatedAt: { $gte: since } }, { _id: { $in: tagged.map((t) => t.task) } }] });
  }
  if (cursor) {
    const at = new Date(cursor.t);
    const id = new mongoose.Types.ObjectId(cursor.i);
    and.push({ $or: [{ updatedAt: { $lt: at } }, { updatedAt: at, _id: { $lt: id } }] });
  }

  const rows = await Task.find({ $and: and })
    .select("title status dueDate actualStartAt actualEndAt shortCode number project category updatedAt tag titleParts iteration priority startDate estimateMinutes")
    .sort({ updatedAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean<TaskRow[]>();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  res.json({
    tasks: await tasksJson(page),
    nextCursor: rows.length > limit && last ? encodeCursor(last.updatedAt, last._id) : null,
  });
}

/** GET /tasks/:taskId?email= */
export async function apiGetTask(req: Request, res: Response): Promise<void> {
  const user = await userForEmail(req, res, req.query.email);
  if (!user) return;
  const task = await visibleTask(req, res, user);
  if (!task) return;
  const [json] = await tasksJson([task.toObject() as unknown as TaskRow]);
  res.json({ task: json });
}

/** POST /tasks/:taskId/tag { email } — idempotent: { created, tag, generateUrl }. */
export async function apiCreateTag(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const user = await userForEmail(req, res, body.email);
  if (!user) return;
  const task = await visibleTask(req, res, user);
  if (!task) return;
  await respondWithTag(req, res, user, task, false);
}

/** Shared get-or-create for both POST endpoints (atomic, records a "pearity" usage). */
async function respondWithTag(req: Request, res: Response, user: IUser, task: ITask, includeTask: boolean): Promise<void> {
  const taskId = task._id as mongoose.Types.ObjectId;
  const context = (await taskContexts([task])).get(taskId.toString())!;
  if (context.project?.archived) {
    fail(res, 409, "task_read_only", "This task belongs to an archived project.");
    return;
  }
  const settings = await pearitySettings();
  const { tag, created } = await ensurePearityTag(task, context, user._id as mongoose.Types.ObjectId, "pearity");
  await recordPearityUsage(tag, user._id as mongoose.Types.ObjectId, "pearity");
  recordTaskHistory(taskId, user, "pearity_generated", {
    tagId: tag.tagId,
    tagName: tag.tagName,
    created,
    source: "pearity",
  });
  if (created) {
    logActivity({
      action: "pearity_tag_created",
      actor: user,
      targetType: "Task",
      targetId: taskId,
      targetName: task.title,
      details: { tagId: tag.tagId, tagName: tag.tagName, source: "pearity", keyPrefix: locals(res).pearityKey?.prefix },
      ip: req.ip,
    });
  }
  const ref = (await tagRefs([tag], { contexts: new Map([[taskId.toString(), context]]) })).get(taskId.toString())!;
  const generateUrl = pearityGenerateUrl(settings, tag, taskId, context);
  if (!includeTask) {
    res.status(created ? 201 : 200).json({ created, tag: ref, tagUrl: ref.tagUrl, generateUrl });
    return;
  }
  const row = task.toObject() as unknown as TaskRow;
  res.status(created ? 201 : 200).json({
    created,
    tag: ref,
    task: taskJson(row, context, ref, generateUrl),
    tagUrl: ref.tagUrl,
    generateUrl,
  });
}

// --- Task number (taskNo) lookup ---------------------------------------------------

const TASK_NO_LOOKUP_LIMIT = 20;

/**
 * Resolves a human task number ("GenAI Hub-65", "pear-12", "#56", "56") to one task
 * the user can view. An exact (case-insensitive) shortCode match wins over a task
 * number; archived-project tasks are only used when no active task matches.
 * Responds 400 / 404 / 409 and returns undefined on failure.
 */
export async function resolveTaskNo(res: Response, input: unknown, user: IUser): Promise<ITask | undefined> {
  const parsed = parseTaskNo(input);
  if (!parsed) {
    fail(res, 400, "invalid_task_no", "Pass the task number (taskNo=...), e.g. GenAI Hub-65 or #56.");
    return undefined;
  }
  const archived = new Set((await archivedProjectIds()).map((id) => id.toString()));
  const isArchived = (t: ITask) => Boolean(t.project && archived.has(t.project.toString()));

  if (parsed.codePattern) {
    const matches = await Task.find({ shortCode: { $regex: parsed.codePattern } }).limit(TASK_NO_LOOKUP_LIMIT);
    const visible: ITask[] = [];
    for (const task of matches) if (await canViewTaskAsync(user, task)) visible.push(task);
    const active = visible.filter((t) => !isArchived(t));
    const pool = active.length > 0 ? active : visible;
    if (pool.length > 1) {
      fail(
        res,
        409,
        "ambiguous_task_no",
        `More than one task has the number "${parsed.value}". Use the task id (GET /tasks/:taskId) instead.`
      );
      return undefined;
    }
    if (pool.length === 1) return pool[0];
  }
  if (parsed.number) {
    const task = await Task.findOne({ number: parsed.number });
    if (task && (await canViewTaskAsync(user, task))) return task;
  }
  fail(res, 404, "task_not_found", "Task not found (or this user can't view it).");
  return undefined;
}

/** GET /tasks/by-no?taskNo=&email= — { task, pearityTag | null, generateUrl | null }, always fresh. */
export async function apiGetTaskByNo(req: Request, res: Response): Promise<void> {
  const user = await userForEmail(req, res, req.query.email);
  if (!user) return;
  const task = await resolveTaskNo(res, req.query.taskNo, user);
  if (!task) return;
  const [json] = await tasksJson([task.toObject() as unknown as TaskRow]);
  res.json({ task: json, pearityTag: json!.pearityTag, tagUrl: json!.tagUrl, generateUrl: json!.generateUrl });
}

/** POST /tasks/by-no/tag { taskNo, email } — idempotent: { created, tag, task, generateUrl }. */
export async function apiCreateTagByNo(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const user = await userForEmail(req, res, body.email);
  if (!user) return;
  const task = await resolveTaskNo(res, body.taskNo, user);
  if (!task) return;
  await respondWithTag(req, res, user, task, true);
}

function tagJson(tag: IPearityTag, ref: PearityTagRefJson, taskNo: string | null) {
  return {
    tagNo: typeof tag.tagNo === "number" ? tag.tagNo : null,
    tagId: tag.tagId,
    tagName: tag.tagName,
    taskId: tag.task.toString(),
    taskNo,
    taskCode: tag.taskCodeSnapshot,
    brand: tag.brandSnapshot?.id ? { id: tag.brandSnapshot.id.toString(), name: tag.brandSnapshot.name } : null,
    category: tag.categorySnapshot?.id
      ? { id: tag.categorySnapshot.id.toString(), name: tag.categorySnapshot.name }
      : null,
    createdAt: ref.createdAt,
    createdBy: ref.createdBy,
    tagUrl: ref.tagUrl,
    usageCount: tag.usageCount ?? 0,
    lastUsedAt: iso(tag.lastUsedAt),
    updatedAt: iso(tag.updatedAt),
  };
}

/** GET /tags/:tagId — resolves a tag (legacy random id) back to its Utility task. */
export async function apiGetTag(req: Request, res: Response): Promise<void> {
  const tagId = param(req, "tagId") ?? "";
  const tag = TAG_ID_REGEX.test(tagId) ? await PearityTag.findOne({ tagId }).lean<IPearityTag>() : null;
  await respondWithTagLookup(res, tag);
}

/** GET /tags/by-no/:tagNo — resolves a tag number (1, 2, 3, …) back to its Utility task. */
export async function apiGetTagByNo(req: Request, res: Response): Promise<void> {
  const raw = (param(req, "tagNo") ?? "").trim().replace(/^#/, "");
  if (!/^\d{1,9}$/.test(raw) || Number(raw) < 1) {
    fail(res, 400, "invalid_tag_no", "tagNo must be a positive whole number, e.g. 12.");
    return;
  }
  const tag = await PearityTag.findOne({ tagNo: Number(raw) }).lean<IPearityTag>();
  await respondWithTagLookup(res, tag);
}

async function respondWithTagLookup(res: Response, tag: IPearityTag | null): Promise<void> {
  if (!tag) {
    fail(res, 404, "tag_not_found", "Tag not found.");
    return;
  }
  const task = await Task.findById(tag.task)
    .select("title status dueDate actualStartAt actualEndAt shortCode number project category updatedAt tag titleParts iteration priority startDate estimateMinutes")
    .lean<TaskRow>();
  const ref = (await tagRefs([tag])).get(tag.task.toString())!;
  res.json({ tag: tagJson(tag, ref, task ? taskNoOf(task) : null), task: task ? (await tasksJson([task]))[0] : null });
}

/** GET /tags?updatedSince=&limit=&cursor= — bulk sync, oldest-updated first. */
export async function apiListTags(req: Request, res: Response): Promise<void> {
  const limit = parseLimit(req.query.limit, 100);
  if (limit === null) {
    fail(res, 400, "invalid_limit", "limit must be an integer between 1 and 200");
    return;
  }
  const since = parseSince(req.query.updatedSince);
  if (since === null) {
    fail(res, 400, "invalid_updated_since", "updatedSince must be an ISO 8601 date-time");
    return;
  }
  const cursor = decodeCursor(req.query.cursor);
  if (cursor === null) {
    fail(res, 400, "invalid_cursor", "cursor is not valid — pass nextCursor from the previous page");
    return;
  }
  const and: Record<string, unknown>[] = [];
  if (since) and.push({ updatedAt: { $gte: since } });
  if (cursor) {
    const at = new Date(cursor.t);
    const id = new mongoose.Types.ObjectId(cursor.i);
    and.push({ $or: [{ updatedAt: { $gt: at } }, { updatedAt: at, _id: { $gt: id } }] });
  }
  const rows = await PearityTag.find(and.length ? { $and: and } : {})
    .sort({ updatedAt: 1, _id: 1 })
    .limit(limit + 1)
    .lean<IPearityTag[]>();
  const page = rows.slice(0, limit);
  const [refs, taskRows] = await Promise.all([
    tagRefs(page),
    page.length
      ? Task.find({ _id: { $in: page.map((t) => t.task) } })
          .select("shortCode number")
          .lean<Array<{ _id: mongoose.Types.ObjectId; shortCode?: string | null; number?: number | null }>>()
      : Promise.resolve([]),
  ]);
  const taskNoById = new Map(taskRows.map((t) => [t._id.toString(), taskNoOf(t)]));
  const last = page[page.length - 1];
  res.json({
    tags: page.map((tag) =>
      tagJson(tag, refs.get(tag.task.toString())!, taskNoById.get(tag.task.toString()) ?? null)
    ),
    nextCursor: rows.length > limit && last ? encodeCursor(last.updatedAt, last._id as mongoose.Types.ObjectId) : null,
  });
}

/** JSON 404 inside the v1 API. */
export function apiNotFound(_req: Request, res: Response): void {
  fail(res, 404, "not_found", "Unknown endpoint.");
}

