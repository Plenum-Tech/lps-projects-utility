import crypto from "node:crypto";
import { BlockList, isIP } from "node:net";
import mongoose from "mongoose";
import { Brand } from "../models/Brand.js";
import { IntegrationSettings } from "../models/IntegrationSettings.js";
import { PearityTag, PearityTagUsage } from "../models/PearityTag.js";
import type { IPearityTag, PearityUsageSource } from "../models/PearityTag.js";
import { Project } from "../models/Project.js";
import { TaskCategory } from "../models/TaskCategory.js";
import { User } from "../models/User.js";
import { settingsAppUrl } from "./companySettings.js";
import { isDuplicateKeyError } from "./errors.js";
import { cached, invalidate } from "./refCache.js";

// ---------------------------------------------------------------------------
// Pearity tag integration (Utility is the source of truth): tag naming, the
// atomic one-tag-per-task create, usage, the engine URL template and the
// integration settings snapshot. See docs/pearity-integration.md.
// ---------------------------------------------------------------------------

/** Placeholders the production-engine URL template may use (values are URL-encoded). */
export const PEARITY_PLACEHOLDERS = ["tagId", "tagName", "taskId", "taskCode", "brand", "category", "project"] as const;
export type PearityPlaceholder = (typeof PEARITY_PLACEHOLDERS)[number];

export const TAG_FALLBACKS = { brand: "NoBrand", category: "General" } as const;

// --- Settings ----------------------------------------------------------------

export interface PearitySettingsSnapshot {
  enabled: boolean;
  engineUrlTemplate: string;
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
}

export interface TaskContext {
  taskCode: string;
  project: { id: string; name: string; code: string; archived: boolean } | null;
  brand: { id: string; name: string } | null;
  category: { id: string; name: string } | null;
}

/** "GENAI-65"; tasks without a project use "Task-<number>". */
export function pearityTaskCode(task: Pick<TaskLike, "_id" | "shortCode" | "number">): string {
  if (task.shortCode) return task.shortCode;
  if (task.number) return `Task-${task.number}`;
  return `Task-${task._id.toString().slice(-6)}`;
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
      ? Project.find({ _id: { $in: projectIds } }).select("name code brand archivedAt").lean()
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
      project: project
        ? { id: project._id.toString(), name: project.name, code: project.code, archived: Boolean(project.archivedAt) }
        : null,
      brand: brand ? { id: brand._id.toString(), name: brand.name } : null,
      category: category ? { id: category._id.toString(), name: category.name } : null,
    });
  }
  return out;
}

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

// --- Create / usage --------------------------------------------------------------

/**
 * Returns the task's tag, creating it on first use. Atomic and idempotent: an
 * upsert on the unique `task` index, and a concurrent create that loses the
 * race (duplicate key) re-reads the winner's tag.
 */
export async function ensurePearityTag(
  task: TaskLike,
  context: TaskContext,
  actorId: mongoose.Types.ObjectId | null,
  source: PearityUsageSource
): Promise<{ tag: IPearityTag; created: boolean }> {
  const existing = await PearityTag.findOne({ task: task._id });
  if (existing) return { tag: existing, created: false };

  const baseName = buildTagName(context);
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
        return { tag: result.value, created: !result.lastErrorObject?.updatedExisting };
      }
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
    }
    // Lost the race on `task` (re-read the winner), or a tagId collision (retry).
    const raced = await PearityTag.findOne({ task: task._id });
    if (raced) return { tag: raced, created: false };
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
  tag: Pick<IPearityTag, "tagId" | "tagName">,
  taskId: mongoose.Types.ObjectId | string,
  context: TaskContext
): string | null {
  if (!settings.engineUrlTemplate) return null;
  return fillTemplate(settings.engineUrlTemplate, {
    tagId: tag.tagId,
    tagName: tag.tagName,
    taskId: taskId.toString(),
    taskCode: context.taskCode,
    brand: context.brand?.name ?? "",
    category: context.category?.name ?? "",
    project: context.project?.name ?? "",
  });
}

export interface PearityTagRefJson {
  tagId: string;
  tagName: string;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
}

/** `{ tagId, tagName, createdAt, createdBy: { id, name } }` for many tags (one user query). */
export async function tagRefs(tags: IPearityTag[] | Array<Record<string, any>>): Promise<Map<string, PearityTagRefJson>> {
  const userIds = [...new Set(tags.map((t) => (t.createdBy ? String(t.createdBy) : "")).filter(Boolean))];
  const users = userIds.length ? await User.find({ _id: { $in: userIds } }).select("name").lean() : [];
  const nameById = new Map(users.map((u) => [u._id.toString(), u.name]));
  const out = new Map<string, PearityTagRefJson>();
  for (const tag of tags) {
    const createdBy = tag.createdBy ? String(tag.createdBy) : null;
    out.set(String(tag.task), {
      tagId: tag.tagId,
      tagName: tag.tagName,
      createdAt: new Date(tag.createdAt).toISOString(),
      createdBy: createdBy ? { id: createdBy, name: nameById.get(createdBy) ?? "Former user" } : null,
    });
  }
  return out;
}

/** Tags for a page of tasks, keyed by task id (one query + one user query). */
export async function pearityTagsByTask(taskIds: mongoose.Types.ObjectId[]): Promise<Map<string, PearityTagRefJson>> {
  if (taskIds.length === 0) return new Map();
  const tags = await PearityTag.find({ task: { $in: taskIds } }).lean();
  return tagRefs(tags);
}
