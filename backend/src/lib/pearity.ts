import crypto from "node:crypto";
import { BlockList, isIP } from "node:net";
import mongoose from "mongoose";
import { Brand } from "../models/Brand.js";
import { Counter, PEARITY_TAG_COUNTER } from "../models/Counter.js";
import { IntegrationSettings } from "../models/IntegrationSettings.js";
import { PearityTag, PearityTagUsage } from "../models/PearityTag.js";
import type { IPearityTag, PearityUsageSource } from "../models/PearityTag.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";
import { TaskCategory } from "../models/TaskCategory.js";
import { User } from "../models/User.js";
import { settingsAppUrl } from "./companySettings.js";
import { isDuplicateKeyError } from "./errors.js";
import { projectMonth } from "./projectExpiry.js";
import { ensureTaskTag } from "./tagAssign.js";
import { cached, invalidate } from "./refCache.js";

// ---------------------------------------------------------------------------
// Pearity tag integration (Utility is the source of truth): tag naming, the
// atomic one-tag-per-task create, usage, the engine URL template and the
// integration settings snapshot. See docs/pearity-integration.md.
// ---------------------------------------------------------------------------

/** Placeholders the production-engine URL template may use (values are URL-encoded). */
export const PEARITY_PLACEHOLDERS = [
  "tagNo",
  "tagId",
  "tagName",
  "taskId",
  "taskCode",
  "taskNo",
  "brand",
  "category",
  "project",
  // Task tag and task fields (Generate pre-fills the production engine).
  "taskTag",
  "projectTag",
  "projectCode",
  "title",
  "month",
  "type",
  "scopeUnit",
  "quantity",
  "shortName",
  "iteration",
  "status",
  "priority",
  "startDate",
  "dueDate",
  "estimateMinutes",
] as const;
export type PearityPlaceholder = (typeof PEARITY_PLACEHOLDERS)[number];

export const TAG_FALLBACKS = { brand: "NoBrand", category: "General" } as const;

// --- Settings ----------------------------------------------------------------

export interface PearitySettingsSnapshot {
  enabled: boolean;
  engineUrlTemplate: string;
  /** Optional link for a tag in Pearity; empty → the engine URL is used. */
  tagUrlTemplate: string;
  allowedIps: string[];
  updatedAt: Date | null;
}

const SETTINGS_CACHE_KEY = "integration:pearity";

/** Current Pearity settings (cached 10 s; dropped on every write in this process). */
export async function pearitySettings(): Promise<PearitySettingsSnapshot> {
  return cached(SETTINGS_CACHE_KEY, 10_000, async () => {
    const doc = await IntegrationSettings.findOne({ key: "pearity" }).lean();
    return {
      enabled: Boolean(doc?.enabled),
      engineUrlTemplate: doc?.engineUrlTemplate ?? "",
      tagUrlTemplate: doc?.tagUrlTemplate ?? "",
      allowedIps: doc?.allowedIps ?? [],
      updatedAt: doc?.updatedAt ?? null,
    };
  });
}

export function invalidatePearitySettings(): void {
  invalidate(SETTINGS_CACHE_KEY);
}

/** Enabled and usable (a template is configured). */
export function pearityActive(settings: PearitySettingsSnapshot): boolean {
  return settings.enabled && Boolean(settings.engineUrlTemplate);
}

// --- URL template --------------------------------------------------------------

/** Null when valid, otherwise a readable reason. */
export function templateError(template: string): string | null {
  const value = template.trim();
  if (!value) return "Enter the production engine URL template.";
  if (value.length > 2000) return "The URL template must be at most 2000 characters.";
  if (/\s/.test(value)) return "The URL template can't contain spaces.";
  for (const match of value.matchAll(/\{([^{}]*)\}/g)) {
    if (!(PEARITY_PLACEHOLDERS as readonly string[]).includes(match[1] ?? "")) {
      return `Unknown placeholder {${match[1]}}. Use ${PEARITY_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}.`;
    }
  }
  if (/[{}]/.test(value.replace(/\{[A-Za-z]+\}/g, ""))) return "Unbalanced { } in the URL template.";
  let url: URL;
  try {
    url = new URL(value.replace(/\{[A-Za-z]+\}/g, "x"));
  } catch {
    return "Enter a full URL, e.g. https://app.pearity.ai/production/new?tagId={tagId}";
  }
  if (url.protocol !== "https:") return "The URL template must start with https://";
  if (url.username || url.password) return "The URL template can't contain credentials.";
  return null;
}

/** Replaces each {placeholder} with its URL-encoded value (unknown ones are left as-is). */
export function fillTemplate(template: string, values: Record<PearityPlaceholder, string>): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (whole, name: string) =>
    (PEARITY_PLACEHOLDERS as readonly string[]).includes(name)
      ? encodeURIComponent(values[name as PearityPlaceholder] ?? "")
      : whole
  );
}

// --- Allowed IPs ---------------------------------------------------------------

function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  return mapped ? mapped[1]! : trimmed;
}

/** "203.0.113.7", "2001:db8::1", "203.0.113.0/24" or "2001:db8::/32". */
export function isValidIpEntry(entry: string): boolean {
  const [address, prefix, extra] = entry.trim().split("/");
  if (extra !== undefined || !address) return false;
  const family = isIP(address);
  if (!family) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

/** True when `allowed` is empty or `ip` matches one of its entries. */
export function ipAllowed(ip: string | undefined, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  if (!ip) return false;
  const address = normalizeIp(ip);
  const family = isIP(address);
  if (!family) return false;
  const list = new BlockList();
  for (const entry of allowed) {
    if (!isValidIpEntry(entry)) continue;
    const [base, prefix] = entry.trim().split("/");
    const type = isIP(base!) === 6 ? "ipv6" : "ipv4";
    if (prefix === undefined) list.addAddress(base!, type);
    else list.addSubnet(base!, Number(prefix), type);
  }
  return list.check(address, family === 6 ? "ipv6" : "ipv4");
}

// --- Task context (code, project, brand, category) ------------------------------

export interface TaskLike {
  _id: mongoose.Types.ObjectId;
  shortCode?: string | null;
  number?: number | null;
  project?: mongoose.Types.ObjectId | null;
  category?: mongoose.Types.ObjectId | null;
  // Optional task fields for the engine URL (empty when the caller didn't load them).
  tag?: string | null;
  title?: string | null;
  titleParts?: { unit?: string; quantity?: number; shortName?: string } | null;
  iteration?: string | null;
  status?: string | null;
  priority?: string | null;
  startDate?: Date | null;
  dueDate?: Date | null;
  estimateMinutes?: number | null;
}

/** Task fields the engine URL can carry (Generate loads the whole task). */
export interface TaskFields {
  taskTag: string;
  title: string;
  scopeUnit: string;
  quantity: string;
  shortName: string;
  iteration: string;
  status: string;
  priority: string;
  startDate: string;
  dueDate: string;
  estimateMinutes: string;
}

export interface TaskContext {
  taskCode: string;
  /** The task number users see: shortCode ("GenAI Hub-65") or "#<number>"; null when neither exists. */
  taskNo: string | null;
  project: { id: string; name: string; code: string; archived: boolean; tag: string; month: string; type: string } | null;
  brand: { id: string; name: string } | null;
  category: { id: string; name: string } | null;
  fields: TaskFields;
}

const dateOnly = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : "");

/** "GENAI-65"; tasks without a project use "Task-<number>". */
export function pearityTaskCode(task: Pick<TaskLike, "_id" | "shortCode" | "number">): string {
  if (task.shortCode) return task.shortCode;
  if (task.number) return `Task-${task.number}`;
  return `Task-${task._id.toString().slice(-6)}`;
}

/** The human task number: shortCode when present ("GenAI Hub-65", "PEAR-12"), else "#56". */
export function taskNoOf(task: Pick<TaskLike, "shortCode" | "number">): string | null {
  if (task.shortCode) return task.shortCode;
  if (task.number) return `#${task.number}`;
  return null;
}

/**
 * Parses a taskNo typed or pasted by a user. Trims and collapses repeated spaces;
 * `codePattern` matches a shortCode case-insensitively (exact, anchored, regex
 * metacharacters escaped — no collation, so it works on Cosmos DB vCore); `number`
 * is set for "#56" / "56". Null when the input can't be a task number.
 */
export function parseTaskNo(input: unknown): { value: string; codePattern: RegExp | null; number: number | null } | null {
  if (typeof input !== "string") return null;
  const value = input.trim().replace(/\s+/g, " ");
  if (!value || value.length > 60) return null;
  const numeric = /^#\s?(\d{1,9})$|^(\d{1,9})$/.exec(value);
  const number = numeric ? Number(numeric[1] ?? numeric[2]) : null;
  const codePattern = value.startsWith("#")
    ? null
    : new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, " +")}$`, "i");
  if (!codePattern && !number) return null;
  return { value, codePattern, number: number && number > 0 ? number : null };
}

function refId(value: unknown): mongoose.Types.ObjectId | null {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  const id = (value as { _id?: unknown })._id;
  return id instanceof mongoose.Types.ObjectId ? id : null;
}

/** Project / brand / category names for many tasks — three queries, never N+1. */
export async function taskContexts(tasks: TaskLike[]): Promise<Map<string, TaskContext>> {
  const projectIds = [...new Set(tasks.map((t) => refId(t.project)?.toString()).filter(Boolean))] as string[];
  const categoryIds = [...new Set(tasks.map((t) => refId(t.category)?.toString()).filter(Boolean))] as string[];
  const [projects, categories] = await Promise.all([
    projectIds.length
      ? Project.find({ _id: { $in: projectIds } }).select("name code brand archivedAt tag naming deadline").lean()
      : Promise.resolve([]),
    categoryIds.length ? TaskCategory.find({ _id: { $in: categoryIds } }).select("name").lean() : Promise.resolve([]),
  ]);
  const brandIds = [...new Set(projects.map((p) => (p.brand ? p.brand.toString() : "")).filter(Boolean))];
  const brands = brandIds.length ? await Brand.find({ _id: { $in: brandIds } }).select("name").lean() : [];
  const projectById = new Map(projects.map((p) => [p._id.toString(), p]));
  const brandById = new Map(brands.map((b) => [b._id.toString(), b]));
  const categoryById = new Map(categories.map((c) => [c._id.toString(), c]));

  const out = new Map<string, TaskContext>();
  for (const task of tasks) {
    const project = projectById.get(refId(task.project)?.toString() ?? "");
    const brand = project?.brand ? brandById.get(project.brand.toString()) : undefined;
    const category = categoryById.get(refId(task.category)?.toString() ?? "");
    out.set(task._id.toString(), {
      taskCode: pearityTaskCode(task),
      taskNo: taskNoOf(task),
      project: project
        ? {
            id: project._id.toString(),
            name: project.name,
            code: project.code,
            archived: Boolean(project.archivedAt),
            tag: (project as { tag?: string | null }).tag ?? "",
            month: projectMonth(project as never) ?? "",
            type: project.naming?.type ?? "",
          }
        : null,
      brand: brand ? { id: brand._id.toString(), name: brand.name } : null,
      category: category ? { id: category._id.toString(), name: category.name } : null,
      fields: {
        taskTag: task.tag ?? "",
        title: task.title ?? "",
        scopeUnit: task.titleParts?.unit ?? "",
        quantity: task.titleParts?.quantity ? String(task.titleParts.quantity) : "",
        shortName: task.titleParts?.shortName ?? "",
        iteration: task.iteration ?? "",
        status: task.status ?? "",
        priority: task.priority ?? "",
        startDate: dateOnly(task.startDate),
        dueDate: dateOnly(task.dueDate),
        estimateMinutes: task.estimateMinutes ? String(task.estimateMinutes) : "",
      },
    });
  }
  return out;
}

/** Task fields to select wherever a task context (and its engine URL) is built. */
export const TASK_CONTEXT_FIELDS =
  "shortCode number project category tag title titleParts iteration status priority startDate dueDate estimateMinutes";

// --- Tag naming ------------------------------------------------------------------

/** Spaces and unsafe characters become "-" (accents dropped, runs collapsed). */
export function sanitizeTagPart(value: string | null | undefined, fallback: string): string {
  const cleaned = (value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return cleaned || fallback;
}

/** Brand_Category_TaskCode, e.g. "Ajmal_Design_GenAIHub-65". */
export function buildTagName(context: Pick<TaskContext, "brand" | "category" | "taskCode">): string {
  return [
    sanitizeTagPart(context.brand?.name, TAG_FALLBACKS.brand),
    sanitizeTagPart(context.category?.name, TAG_FALLBACKS.category),
    sanitizeTagPart(context.taskCode, "Task"),
  ].join("_");
}

const TAG_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** "pt_" + 8 random URL-safe characters (36^8 ≈ 2.8e12). */
export function generateTagId(): string {
  let id = "pt_";
  for (let i = 0; i < 8; i += 1) id += TAG_ID_ALPHABET[crypto.randomInt(TAG_ID_ALPHABET.length)];
  return id;
}

export const TAG_ID_REGEX = /^pt_[0-9a-z]{8}$/;

// --- Tag numbers ------------------------------------------------------------------

/** Creates the tag counter at the highest tagNo in use (a concurrent creator may win — fine). */
async function ensureTagCounter(): Promise<void> {
  if (await Counter.exists({ _id: PEARITY_TAG_COUNTER })) return;
  const highest = await PearityTag.findOne({ tagNo: { $gte: 1 } }).sort({ tagNo: -1 }).select("tagNo").lean();
  try {
    await Counter.create({ _id: PEARITY_TAG_COUNTER, seq: highest?.tagNo ?? 0 });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
  }
}

/** Atomically claims the next tag number (1, 2, 3, …). */
export async function nextTagNo(): Promise<number> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const claimed = await Counter.findOneAndUpdate(
      { _id: PEARITY_TAG_COUNTER },
      { $inc: { seq: 1 } },
      { returnDocument: "after" }
    ).lean();
    if (claimed) return claimed.seq;
    await ensureTagCounter();
  }
  throw new Error("Could not claim a Pearity tag number");
}

/**
 * Startup backfill (idempotent): numbers tags created before tagNo existed, in
 * createdAt order, through the counter (so numbers never collide with live creates),
 * then raises the counter to at least the highest tagNo in use.
 */
export async function backfillPearityTagNumbers(): Promise<number> {
  const missing = await PearityTag.find({ $or: [{ tagNo: { $exists: false } }, { tagNo: null }] })
    .select("_id")
    .sort({ createdAt: 1, _id: 1 })
    .lean();
  let numbered = 0;
  for (const row of missing) {
    const tagNo = await nextTagNo();
    const result = await PearityTag.updateOne(
      { _id: row._id, $or: [{ tagNo: { $exists: false } }, { tagNo: null }] },
      // updatedAt moves on, so Pearity's GET /tags?updatedSince= sync picks up the number.
      { $set: { tagNo } }
    );
    numbered += result.modifiedCount;
  }
  const highest = await PearityTag.findOne({ tagNo: { $gte: 1 } }).sort({ tagNo: -1 }).select("tagNo").lean();
  if (highest?.tagNo) {
    await Counter.updateOne({ _id: PEARITY_TAG_COUNTER }, { $max: { seq: highest.tagNo } }, { upsert: true });
  }
  return numbered;
}

function duplicateKeyField(err: unknown): string {
  const pattern = (err as { keyPattern?: Record<string, unknown> }).keyPattern;
  if (pattern) return Object.keys(pattern)[0] ?? "";
  return /index: (\w+?)_/.exec(String((err as Error).message ?? ""))?.[1] ?? "";
}

// --- Create / usage --------------------------------------------------------------

const TAG_NO_WAIT_MS = 1500;
const TAG_NO_POLL_MS = 40;
const TAG_NO_FRESH_MS = 10_000;

/**
 * Gives `tag` its tagNo when it has none: claims the next number and sets it only
 * if still unset (so a tag never gets two numbers, and numbers never repeat).
 */
async function assignTagNo(tag: IPearityTag): Promise<IPearityTag> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tagNo = await nextTagNo();
    try {
      const updated = await PearityTag.findOneAndUpdate(
        { _id: tag._id, $or: [{ tagNo: { $exists: false } }, { tagNo: null }] },
        { $set: { tagNo } },
        { returnDocument: "after" }
      );
      if (updated) return updated;
      // Numbered meanwhile by another request — use theirs (this number is skipped).
      const current = await PearityTag.findById(tag._id);
      if (current?.tagNo) return current;
    } catch (err) {
      // tagNo clash: the counter fell behind (e.g. restored data) — claim another.
      if (!isDuplicateKeyError(err) || duplicateKeyField(err) !== "tagNo") throw err;
    }
  }
  throw new Error("Could not assign a Pearity tag number");
}

/**
 * The tag with its number. A tag that was just created by a concurrent request is
 * numbered by that request, so wait briefly for it instead of claiming a second
 * number (keeps the sequence gapless); older or stuck tags are numbered here.
 */
async function withTagNo(tag: IPearityTag): Promise<IPearityTag> {
  if (tag.tagNo) return tag;
  const createdAt = tag.createdAt ? new Date(tag.createdAt).getTime() : 0;
  if (Date.now() - createdAt < TAG_NO_FRESH_MS) {
    const deadline = Date.now() + TAG_NO_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, TAG_NO_POLL_MS));
      const current = await PearityTag.findById(tag._id);
      if (current?.tagNo) return current;
    }
  }
  return assignTagNo(tag);
}

/**
 * Returns the task's tag, creating it on first use. Atomic and idempotent: an
 * upsert on the unique `task` index, and a concurrent create that loses the
 * race (duplicate key) re-reads the winner's tag. Only the request that actually
 * inserts the tag claims its tagNo, so reuse and lost races never use a number.
 */
export async function ensurePearityTag(
  task: TaskLike,
  context: TaskContext,
  actorId: mongoose.Types.ObjectId | null,
  source: PearityUsageSource
): Promise<{ tag: IPearityTag; created: boolean }> {
  const existing = await PearityTag.findOne({ task: task._id });
  if (existing) return { tag: await withTagNo(existing), created: false };

  // The task's own tag (project tag + scope unit + quantity) is the Pearity tag name.
  const taskTag = await ensureTaskTag(task._id);
  const baseName = taskTag ?? buildTagName(context);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const tagId = generateTagId();
    // Another task already uses this name (e.g. a re-used code): keep names unique.
    const clash = await PearityTag.exists({ tagName: baseName, task: { $ne: task._id } });
    const tagName = clash ? `${baseName}-${tagId.slice(3, 7)}` : baseName;
    try {
      const result = await PearityTag.findOneAndUpdate(
        { task: task._id },
        {
          $setOnInsert: {
            task: task._id,
            tagId,
            tagName,
            taskCodeSnapshot: context.taskCode,
            brandSnapshot: {
              id: context.brand ? new mongoose.Types.ObjectId(context.brand.id) : null,
              name: context.brand?.name ?? "",
            },
            categorySnapshot: {
              id: context.category ? new mongoose.Types.ObjectId(context.category.id) : null,
              name: context.category?.name ?? "",
            },
            createdBy: actorId,
            createdVia: source,
            usageCount: 0,
            lastUsedAt: null,
          },
        },
        { upsert: true, returnDocument: "after", includeResultMetadata: true, runValidators: true }
      );
      if (result.value) {
        const created = !result.lastErrorObject?.updatedExisting;
        return { tag: created ? await assignTagNo(result.value) : await withTagNo(result.value), created };
      }
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
    }
    // Lost the race on `task` (re-read the winner), or a tagId collision (retry).
    const raced = await PearityTag.findOne({ task: task._id });
    if (raced) return { tag: await withTagNo(raced), created: false };
  }
  throw new Error("Could not allocate a Pearity tag id");
}

/** Records one Generate against the tag (one-to-many usage). */
export async function recordPearityUsage(
  tag: IPearityTag,
  userId: mongoose.Types.ObjectId,
  source: PearityUsageSource
): Promise<void> {
  const at = new Date();
  await Promise.all([
    PearityTagUsage.create({ tag: tag._id, task: tag.task, user: userId, source, at }),
    PearityTag.updateOne({ _id: tag._id }, { $inc: { usageCount: 1 }, $set: { lastUsedAt: at } }),
  ]);
}

// --- Serialization ---------------------------------------------------------------

export function utilityTaskUrl(taskId: mongoose.Types.ObjectId | string): string {
  return `${settingsAppUrl()}/tasks?task=${encodeURIComponent(taskId.toString())}`;
}

/** The engine URL for a task's tag, or null when no template is configured. */
export function pearityGenerateUrl(
  settings: PearitySettingsSnapshot,
  tag: Pick<IPearityTag, "tagId" | "tagName" | "tagNo">,
  taskId: mongoose.Types.ObjectId | string,
  context: TaskContext
): string | null {
  return fillPearityUrl(settings.engineUrlTemplate, tag, taskId, context);
}

/**
 * Where a tag opens in Pearity: the tag link template, falling back to the engine
 * URL template. Null when the integration is off or no template is configured.
 */
export function pearityTagUrl(
  settings: PearitySettingsSnapshot,
  tag: Pick<IPearityTag, "tagId" | "tagName" | "tagNo">,
  taskId: mongoose.Types.ObjectId | string,
  context: TaskContext
): string | null {
  if (!pearityActive(settings)) return null;
  return fillPearityUrl(settings.tagUrlTemplate || settings.engineUrlTemplate, tag, taskId, context);
}

function fillPearityUrl(
  template: string,
  tag: Pick<IPearityTag, "tagId" | "tagName" | "tagNo">,
  taskId: mongoose.Types.ObjectId | string,
  context: TaskContext
): string | null {
  if (!template) return null;
  return fillTemplate(template, {
    tagNo: tag.tagNo ? String(tag.tagNo) : "",
    tagId: tag.tagId,
    tagName: tag.tagName,
    taskId: taskId.toString(),
    taskCode: context.taskCode,
    taskNo: context.taskNo ?? "",
    brand: context.brand?.name ?? "",
    category: context.category?.name ?? "",
    project: context.project?.name ?? "",
    taskTag: context.fields.taskTag || tag.tagName,
    projectTag: context.project?.tag ?? "",
    projectCode: context.project?.code ?? "",
    title: context.fields.title,
    month: context.project?.month ?? "",
    type: context.project?.type ?? "",
    scopeUnit: context.fields.scopeUnit,
    quantity: context.fields.quantity,
    shortName: context.fields.shortName,
    iteration: context.fields.iteration,
    status: context.fields.status,
    priority: context.fields.priority,
    startDate: context.fields.startDate,
    dueDate: context.fields.dueDate,
    estimateMinutes: context.fields.estimateMinutes,
  });
}

/**
 * The engine URL for a project (Generate on Pearity from the project page): the
 * same template, with the project tag as {tagName}/{projectTag} and the task-only
 * placeholders left empty. Null when no template is configured.
 */
export function pearityProjectUrl(
  settings: PearitySettingsSnapshot,
  project: {
    id: string;
    name: string;
    code: string;
    tag: string;
    brand: string;
    month: string;
    type: string;
    title: string;
    startDate: Date | null;
    deadline: Date | null;
  }
): string | null {
  if (!settings.engineUrlTemplate) return null;
  const blank = Object.fromEntries(PEARITY_PLACEHOLDERS.map((p) => [p, ""])) as Record<PearityPlaceholder, string>;
  return fillTemplate(settings.engineUrlTemplate, {
    ...blank,
    tagName: project.tag,
    projectTag: project.tag,
    projectCode: project.code,
    project: project.name,
    brand: project.brand,
    month: project.month,
    type: project.type,
    title: project.title,
    startDate: dateOnly(project.startDate),
    dueDate: dateOnly(project.deadline),
  });
}

export interface PearityTagRefJson {
  /** Sequential tag number — the primary identifier (null only before the startup backfill). */
  tagNo: number | null;
  tagId: string;
  tagName: string;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
  /** Opens the tag in Pearity (tag link template, else engine URL); null when off / unset. */
  tagUrl: string | null;
}

/**
 * `{ tagNo, tagId, tagName, createdAt, createdBy: { id, name }, tagUrl }` for many tags.
 * Pass the tags' tasks (or their contexts) when at hand; otherwise they're loaded for `tagUrl`.
 */
export async function tagRefs(
  tags: IPearityTag[] | Array<Record<string, any>>,
  known?: { tasks?: TaskLike[]; contexts?: Map<string, TaskContext> }
): Promise<Map<string, PearityTagRefJson>> {
  const userIds = [...new Set(tags.map((t) => (t.createdBy ? String(t.createdBy) : "")).filter(Boolean))];
  const settings = await pearitySettings();
  const linkable = tags.length > 0 && pearityActive(settings);
  const [users, contexts] = await Promise.all([
    userIds.length ? User.find({ _id: { $in: userIds } }).select("name").lean() : Promise.resolve([]),
    linkable ? tagContexts(tags, known) : Promise.resolve(new Map<string, TaskContext>()),
  ]);
  const nameById = new Map(users.map((u) => [u._id.toString(), u.name]));
  const out = new Map<string, PearityTagRefJson>();
  for (const tag of tags) {
    const createdBy = tag.createdBy ? String(tag.createdBy) : null;
    const context = contexts.get(String(tag.task));
    out.set(String(tag.task), {
      tagNo: typeof tag.tagNo === "number" ? tag.tagNo : null,
      tagId: tag.tagId,
      tagName: tag.tagName,
      createdAt: new Date(tag.createdAt).toISOString(),
      createdBy: createdBy ? { id: createdBy, name: nameById.get(createdBy) ?? "Former user" } : null,
      tagUrl: context ? pearityTagUrl(settings, tag as IPearityTag, String(tag.task), context) : null,
    });
  }
  return out;
}

/** Contexts for the tags' tasks: given contexts first, then the supplied tasks, then a lookup. */
async function tagContexts(
  tags: Array<Record<string, any>>,
  known?: { tasks?: TaskLike[]; contexts?: Map<string, TaskContext> }
): Promise<Map<string, TaskContext>> {
  const out = new Map(known?.contexts ?? []);
  const missing = new Set(tags.map((t) => String(t.task)).filter((id) => !out.has(id)));
  if (missing.size === 0) return out;
  const given = (known?.tasks ?? []).filter((t) => missing.has(t._id.toString()));
  const givenIds = new Set(given.map((t) => t._id.toString()));
  const lookup = [...missing].filter((id) => !givenIds.has(id));
  const loaded = lookup.length
    ? await Task.find({ _id: { $in: lookup } }).select(TASK_CONTEXT_FIELDS).lean<TaskLike[]>()
    : [];
  for (const [id, context] of await taskContexts([...given, ...loaded])) out.set(id, context);
  return out;
}

/** Tags for a page of tasks, keyed by task id (tag + user + context lookups, never N+1). */
export async function pearityTagsByTask(tasks: TaskLike[]): Promise<Map<string, PearityTagRefJson>> {
  if (tasks.length === 0) return new Map();
  const tags = await PearityTag.find({ task: { $in: tasks.map((t) => t._id) } }).lean();
  return tagRefs(tags, { tasks });
}
