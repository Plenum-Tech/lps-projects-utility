import mongoose, { type Model, type PipelineStage, type Schema } from "mongoose";
import { z } from "zod/v4";
import { Brand } from "../../models/Brand.js";
import { BrandScopeVersion } from "../../models/BrandScopeVersion.js";
import { ChangeRequest } from "../../models/ChangeRequest.js";
import { Department } from "../../models/Department.js";
import { ManpowerPlan } from "../../models/ManpowerPlan.js";
import { Milestone } from "../../models/Milestone.js";
import { PearityTag, PearityTagUsage } from "../../models/PearityTag.js";
import { Project } from "../../models/Project.js";
import { ProjectCategory } from "../../models/ProjectCategory.js";
import { ProjectStatus } from "../../models/ProjectStatus.js";
import { Task } from "../../models/Task.js";
import { TaskCategory } from "../../models/TaskCategory.js";
import { TaskComment } from "../../models/TaskComment.js";
import { TaskHistory } from "../../models/TaskHistory.js";
import { TaskLabel } from "../../models/TaskLabel.js";
import { TimeLog } from "../../models/TimeLog.js";
import { User } from "../../models/User.js";
import { appTimeZone } from "../appTime.js";
import { ToolInputError } from "./common.js";

// ---------------------------------------------------------------------------
// Dynamic queries for Leadership Insights: when no fixed tool fits, the model
// reads the data catalog (describeData: collections, fields, types, links,
// counts — built from the live Mongoose schemas) and writes ONE read-only
// aggregation (runQuery). The pipeline is checked here before it runs:
// whitelisted collections and stages only, no writes / server-side code,
// sensitive fields stripped at the source and after every join (and refused
// when referenced), a time limit and a row cap.
// ---------------------------------------------------------------------------

/** Fields never exposed (any collection, any depth): secrets, contact data, money, HR, raw import blobs. */
const HIDDEN_FIELD = /password|token|secret|apikey|email|phone|hourlyrate|earnings|budget|revenue|retainer|salary|leavebalance|dateofbirth|employeeid|legacy|^__v$/i;

/** People: only these fields (everything else on a user is personal / HR data). */
const USER_FIELDS = ["_id", "name", "role", "department", "designation", "isGuest", "createdAt"];

interface Source {
  model: Model<any>;
  about: string;
}

const SOURCES: Record<string, Source> = {
  tasks: {
    model: Task,
    about:
      "Work items. status todo|in_progress|in_review|completed|rejected; project → projects; assignees (doers) / assignedBy → users; dueDate, startDate, completedAt, actualStartAt/actualEndAt (when the work really happened); iteration 'rework' = rework of reworkOf (else new work); reworkSource internal|external; titleParts {unit, quantity} links the task to a scope unit (older / imported tasks have none); overScope.status pending|approved|rejected; shortCode e.g. 'J25PZT-12'. Tasks have no brand field: join projects (project) and then brands (projects.brand).",
  },
  projects: {
    model: Project,
    about:
      "Projects (one per brand per month for retainers). brand → brands; code; name ('ZOOM | April 2026 | TikTok'); naming.month 'YYYY-MM' (older projects have none: the month is only in the name); scopeItems [{unit, quantity, languages, sizes}] = approved scope; manager / members → users; archivedAt set = archived; status → projectstatuses.",
  },
  brands: {
    model: Brand,
    about: "Clients / brands. name, organisation (parent group, e.g. ENOC), shortName, active, status, isPitch, leads → users, scopeItems (brand-level scope).",
  },
  timelogs: {
    model: TimeLog,
    about: "Time logged. user → users, project, task; startTime, endTime, durationMinutes (net of breaks); status pending|approved|rejected. Hours only.",
  },
  users: {
    model: User,
    about: "People. name, role, department → departments, designation, isGuest (outside guests). Only these fields are available.",
  },
  departments: { model: Department, about: "Teams / departments. name." },
  manpowerplans: {
    model: ManpowerPlan,
    about:
      "Monthly manpower plan versions. month 'YYYY-MM', version, status (the approved one is live), rows [{brand → brands, name (line), cells: people per role}]. Use the highest approved version of a month.",
  },
  changerequests: { model: ChangeRequest, about: "Approval requests (brand / scope / plan changes). kind, status pending|approved|rejected, requestedBy / decidedBy → users, brand, project, createdAt, decidedAt." },
  milestones: { model: Milestone, about: "Project milestones. project, title, startDate, endDate, status, completedAt." },
  taskcomments: { model: TaskComment, about: "Comments on tasks. task, author → users, body, createdAt." },
  taskhistories: { model: TaskHistory, about: "Task activity log. task, actor → users, action, details, createdAt." },
  taskcategories: { model: TaskCategory, about: "Task categories. name." },
  projectcategories: { model: ProjectCategory, about: "Project categories. name." },
  projectstatuses: { model: ProjectStatus, about: "Project statuses. name, isCompleted." },
  tasklabels: { model: TaskLabel, about: "Task labels. name." },
  brandscopeversions: { model: BrandScopeVersion, about: "History of a brand's approved scope. brand, version, items, at, approvedBy." },
  pearitytags: { model: PearityTag, about: "Pearity (AI generation tool) tags made for tasks. task, tagNo, tagName, usageCount, lastUsedAt, createdBy." },
  pearitytagusages: { model: PearityTagUsage, about: "Each Pearity tag use. tag, task, user, source, at." },
};
const COLLECTIONS = Object.keys(SOURCES) as [string, ...string[]];

// -- Catalog -------------------------------------------------------------------

interface FieldInfo {
  path: string;
  type: string;
  ref?: string;
  values?: string[];
}

function refCollection(ref: unknown): string | undefined {
  if (typeof ref !== "string") return undefined;
  try {
    return mongoose.model(ref).collection.name;
  } catch {
    return ref;
  }
}

function visible(collection: string, path: string): boolean {
  if (path.split(".").some((seg) => HIDDEN_FIELD.test(seg))) return false;
  return collection !== "users" || USER_FIELDS.includes(path.split(".")[0]!);
}

/** The schema's fields (sub-documents and arrays of them flattened as `rows[].brand`). */
function fieldsOf(schema: Schema, collection: string, prefix = "", depth = 0): FieldInfo[] {
  const out: FieldInfo[] = [];
  schema.eachPath((path, type: any) => {
    const full = `${prefix}${path}`;
    if (!visible(collection, full)) return;
    if (type.schema && depth < 2) {
      const array = type.instance === "Array" || type.$isMongooseDocumentArray;
      out.push(...fieldsOf(type.schema, collection, `${full}${array ? "[]" : ""}.`, depth + 1));
      return;
    }
    const caster = type.caster ?? type.$embeddedSchemaType;
    const instance = type.instance === "Array" ? `${caster?.instance ?? "Mixed"}[]` : type.instance;
    const ref = refCollection(type.options?.ref ?? caster?.options?.ref);
    const values = (type.enumValues?.length ? type.enumValues : caster?.enumValues) as string[] | undefined;
    out.push({ path: full, type: instance, ...(ref ? { ref } : {}), ...(values?.length ? { values: values.slice(0, 12) } : {}) });
  });
  return out;
}

const fieldText = (f: FieldInfo) => `${f.path}:${f.type}${f.ref ? `→${f.ref}` : ""}${f.values ? ` [${f.values.join("|")}]` : ""}`;

export const describeDataParams = z.object({
  collections: z
    .array(z.enum(COLLECTIONS))
    .max(6)
    .optional()
    .describe("Collections to describe with all their fields. Leave out for the list of every collection with its document count and key fields."),
});

export async function describeData(args: z.infer<typeof describeDataParams>) {
  const names = args.collections?.length ? args.collections : COLLECTIONS;
  const full = !!args.collections?.length;
  const collections = await Promise.all(
    names.map(async (name) => {
      const src = SOURCES[name]!;
      const fields = fieldsOf(src.model.schema, name);
      // Two recent documents show real values and the shape of free-form fields (e.g. taskhistories.details).
      const examples = full
        ? ((await src.model.aggregate([stripStage(name), { $sort: { _id: -1 } }, { $limit: 2 }]).option({ maxTimeMS: QUERY_TIMEOUT_MS })).map((d) => shorten(plain(d))))
        : undefined;
      return {
        name,
        about: src.about,
        documents: await src.model.estimatedDocumentCount(),
        fields: full ? fields.map(fieldText) : fields.filter((f) => f.ref || f.values || !f.path.includes(".")).slice(0, 25).map((f) => f.path),
        ...(examples ? { examples } : {}),
      };
    })
  );
  return {
    collections,
    rules: QUERY_RULES,
    ...(full ? {} : { next: "Call describeData with the collections you need to see all their fields and types, then runQuery." }),
  };
}

const QUERY_RULES = [
  "runQuery runs ONE MongoDB aggregation pipeline on one collection (read only).",
  "Allowed stages: $match, $project, $addFields/$set, $unset, $group, $sort, $limit, $skip, $unwind, $lookup (to listed collections), $count, $sortByCount, $bucket, $facet, $replaceRoot/$replaceWith.",
  'Ids and dates: {"$oid": "<24 hex>"} and {"$date": "2026-04-01T00:00:00Z"} are converted. You don\'t know ids: join with $lookup and $match on the name (case-insensitive: {"$regex": "zoom", "$options": "i"}).',
  `Dates are stored in UTC; the business timezone is ${appTimeZone()}. Months on projects are 'YYYY-MM' strings (naming.month) — older projects only have the month in their name.`,
  "Return small, aggregated results (group / count / sum) with readable names (join users.name, brands.name, projects.code); at most 200 rows come back. Exclude archived projects (archivedAt: null) unless asked.",
  "If a query returns no rows, don't conclude there is no data yet: check the values you filtered on (e.g. group by that field) and try again.",
  "Emails, passwords, rates, costs, budgets, revenue and HR fields are not available.",
];

// -- Guard -----------------------------------------------------------------------

const ALLOWED_STAGES = new Set([
  "$match", "$project", "$addFields", "$set", "$unset", "$group", "$sort", "$limit", "$skip", "$unwind", "$lookup",
  "$count", "$sortByCount", "$bucket", "$facet", "$replaceRoot", "$replaceWith",
]);
/** Operators refused anywhere in the pipeline (server-side code, writes, other databases). */
const FORBIDDEN_OPERATORS = new Set(["$where", "$function", "$accumulator", "$out", "$merge", "$unionWith", "$graphLookup", "$documents", "$currentOp", "$collStats", "$indexStats", "$planCacheStats", "$listSessions", "$changeStream"]);
const MAX_ROWS = 200;
const QUERY_TIMEOUT_MS = 15_000;

/** Comparison operators whose ISO date strings become dates (dates are stored as dates, never as text). */
const COMPARE = new Set(["$gt", "$gte", "$lt", "$lte", "$eq", "$ne", "$in", "$nin"]);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** {"$oid"} / {"$date"} → ObjectId / Date (and date strings in comparisons); refuses hidden fields and forbidden operators anywhere. */
function revive(value: unknown, where: string, compare = false): unknown {
  if (Array.isArray(value)) return value.map((v) => revive(v, where, compare));
  if (typeof value === "string" && compare && ISO_DAY.test(value)) {
    const d = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (typeof value === "string") {
    const path = value.startsWith("$") && !value.startsWith("$$") ? value.slice(1) : null;
    if (path && path.split(".").some((seg) => HIDDEN_FIELD.test(seg))) throw new ToolInputError(`Field ${path} is not available in Insights.`);
    return value;
  }
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1 && keys[0] === "$oid" && typeof obj.$oid === "string") {
    if (!mongoose.isValidObjectId(obj.$oid)) throw new ToolInputError(`Invalid id ${obj.$oid} in ${where}.`);
    return new mongoose.Types.ObjectId(obj.$oid);
  }
  if (keys.length === 1 && keys[0] === "$date") {
    const d = new Date(String(obj.$date));
    if (Number.isNaN(d.getTime())) throw new ToolInputError(`Invalid date ${String(obj.$date)} in ${where}.`);
    return d;
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (FORBIDDEN_OPERATORS.has(key)) throw new ToolInputError(`${key} is not allowed in Insights queries.`);
    if (!key.startsWith("$") && key.split(".").some((seg) => HIDDEN_FIELD.test(seg))) throw new ToolInputError(`Field ${key} is not available in Insights.`);
    out[key] = revive(obj[key], where, COMPARE.has(key));
  }
  return out;
}

/** Stage that strips what a collection must not show (users: keep the allowed fields only). */
function stripStage(collection: string): PipelineStage {
  if (collection === "users") return { $project: Object.fromEntries(USER_FIELDS.map((f) => [f, 1])) };
  const hidden = new Set<string>(["legacy"]);
  SOURCES[collection]!.model.schema.eachPath((path) => {
    // Cut at the first hidden segment: "legacy.x" → "legacy", "emailPreferences.taskAssigned" → "emailPreferences".
    const segs = path.split(".");
    const at = segs.findIndex((seg) => HIDDEN_FIELD.test(seg));
    if (at >= 0) hidden.add(segs.slice(0, at + 1).join("."));
  });
  return { $project: Object.fromEntries([...hidden].map((f) => [f, 0])) };
}

/** Joined documents under `as` stripped the same way, right after the $lookup. */
function stripJoined(collection: string, as: string): PipelineStage {
  if (collection === "users") {
    return { $set: { [as]: { $map: { input: `$${as}`, as: "u", in: Object.fromEntries(USER_FIELDS.map((f) => [f, `$$u.${f}`])) } } } };
  }
  const strip = stripStage(collection) as { $project: Record<string, 0> };
  return { $project: Object.fromEntries(Object.keys(strip.$project).map((f) => [`${as}.${f}`, 0])) };
}

/** Top-level fields a collection's documents have (what a filter can name). */
function rootsOf(collection: string): Set<string> {
  const roots = new Set(["_id"]);
  SOURCES[collection]!.model.schema.eachPath((path) => {
    if (visible(collection, path)) roots.add(path.split(".")[0]!);
  });
  return roots;
}

/** Field names a $match filters on (through $and / $or / $nor). */
function matchFields(filter: unknown): string[] {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return [];
  return Object.entries(filter as Record<string, unknown>).flatMap(([k, v]) =>
    k === "$and" || k === "$or" || k === "$nor" ? (Array.isArray(v) ? v.flatMap(matchFields) : []) : k.startsWith("$") ? [] : [k]
  );
}

/** Stages after which documents keep their fields (plus what they add): filters can still be checked. */
const SHAPE_KEEPING = new Set(["$match", "$sort", "$limit", "$skip", "$unwind", "$lookup", "$set", "$addFields"]);

/** Refuses a field the documents don't have — the usual cause of an empty result — naming the real ones. */
function checkFields(names: string[], known: Set<string>, collection: string, where: string) {
  const unknown = names.filter((n) => !known.has(n.split(".")[0]!));
  if (unknown.length) {
    throw new ToolInputError(
      `${where}: ${collection} has no field ${unknown.join(", ")}. Its fields: ${[...known].join(", ")}. Check describeData (and its examples) and fix the pipeline.`
    );
  }
}

/** Validates and hardens a pipeline (recursively for $lookup / $facet sub-pipelines). */
function guard(stages: unknown[], collection: string, depth = 0, input: Set<string> | null = rootsOf(collection)): PipelineStage[] {
  if (depth > 3) throw new ToolInputError("Pipeline nests too deep.");
  const out: PipelineStage[] = [stripStage(collection)];
  // Fields documents have while the shape is unchanged (null once a stage reshapes them).
  let known: Set<string> | null = input ? new Set(input) : null;
  stages.forEach((raw, i) => {
    const where = `stage ${i + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 1) throw new ToolInputError(`${where} must be one {"$stage": …} object.`);
    const [op, body] = Object.entries(raw as Record<string, unknown>)[0]!;
    if (!ALLOWED_STAGES.has(op)) throw new ToolInputError(`${op} is not allowed (${where}). Allowed: ${[...ALLOWED_STAGES].join(", ")}.`);
    const before = known;
    if (known) {
      if (op === "$match") checkFields(matchFields(body), known, collection, where);
      if (op === "$unwind") checkFields([String(typeof body === "string" ? body : (body as { path?: unknown })?.path ?? "").replace(/^\$/, "")], known, collection, where);
      if (op === "$lookup" && typeof (body as { localField?: unknown })?.localField === "string") checkFields([(body as { localField: string }).localField], known, collection, where);
      if (op === "$lookup" && typeof (body as { foreignField?: unknown })?.foreignField === "string" && SOURCES[String((body as { from?: unknown }).from)]) {
        checkFields([(body as { foreignField: string }).foreignField], rootsOf(String((body as { from: string }).from)), String((body as { from: string }).from), where);
      }
      if (op === "$lookup") known.add(String((body as { as?: unknown })?.as ?? ""));
      if (op === "$set" || op === "$addFields") Object.keys((body ?? {}) as object).forEach((k) => known!.add(k.split(".")[0]!));
      if (!SHAPE_KEEPING.has(op)) known = null;
    }
    if (op === "$lookup") {
      const l = (body ?? {}) as Record<string, unknown>;
      const from = String(l.from ?? "");
      if (!SOURCES[from]) throw new ToolInputError(`$lookup from "${from}" is not available. Collections: ${COLLECTIONS.join(", ")}.`);
      if (typeof l.as !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(l.as)) throw new ToolInputError(`$lookup needs a simple "as" name (${where}).`);
      const lookup: Record<string, unknown> = { from, as: l.as };
      for (const k of ["localField", "foreignField"] as const) {
        if (l[k] === undefined) continue;
        revive(`$${String(l[k])}`, where); // refuses a hidden field
        lookup[k] = String(l[k]);
      }
      if (l.let !== undefined) lookup.let = revive(l.let, where);
      if (l.pipeline !== undefined) {
        if (!Array.isArray(l.pipeline)) throw new ToolInputError(`$lookup pipeline must be a list (${where}).`);
        lookup.pipeline = guard(l.pipeline, from, depth + 1);
      }
      out.push({ $lookup: lookup } as PipelineStage, stripJoined(from, l.as));
      return;
    }
    if (op === "$facet") {
      const facets = (body ?? {}) as Record<string, unknown>;
      out.push({
        $facet: Object.fromEntries(
          Object.entries(facets).map(([name, sub]) => {
            if (!Array.isArray(sub)) throw new ToolInputError(`$facet ${name} must be a list (${where}).`);
            // Facet input is already stripped: skip the leading strip stage.
            return [name, guard(sub, collection, depth + 1, before).slice(1)];
          })
        ),
      } as PipelineStage);
      return;
    }
    out.push({ [op]: revive(body, where) } as unknown as PipelineStage);
  });
  return out;
}

/** Example documents kept small: long text cut, at most 3 items per array, empty values dropped. */
function shorten(value: unknown): unknown {
  if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 79)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 3).map(shorten);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0))
        .map(([k, v]) => [k, shorten(v)])
    );
  }
  return value;
}

/** JSON-safe rows: ids as strings, dates as ISO, hidden keys dropped (defence in depth). */
function plain(value: unknown): unknown {
  if (value instanceof mongoose.Types.ObjectId) return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 50).map(plain);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => !HIDDEN_FIELD.test(k)).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

export const runQueryParams = z.object({
  purpose: z.string().trim().min(3).max(300).describe("Your plan for this query in one sentence: what it answers and how (shown to the user as 'how this was calculated')."),
  collection: z.enum(COLLECTIONS).describe("Collection the pipeline starts from."),
  pipeline: z.array(z.record(z.string(), z.unknown())).min(1).max(25).describe("MongoDB aggregation stages (JSON). See describeData rules."),
  limit: z.number().int().min(1).max(MAX_ROWS).optional().describe(`Rows to return (default 100, max ${MAX_ROWS}).`),
});

export async function runQuery(args: z.infer<typeof runQueryParams>) {
  const limit = args.limit ?? 100;
  const pipeline = guard(args.pipeline, args.collection);
  pipeline.push({ $limit: limit + 1 });
  const model = SOURCES[args.collection]!.model;
  let docs: unknown[];
  try {
    docs = await model.aggregate(pipeline).option({ maxTimeMS: QUERY_TIMEOUT_MS, allowDiskUse: false }).exec();
  } catch (err) {
    // The database's own message (bad operator, wrong type…) lets the model fix its pipeline.
    const message = err instanceof Error ? err.message.replace(/\s+/g, " ").slice(0, 300) : "query failed";
    throw new ToolInputError(`The query failed: ${message}. Fix the pipeline and try again.`);
  }
  const rows = docs.slice(0, limit).map(plain) as Array<Record<string, unknown>>;
  return {
    purpose: args.purpose,
    collection: args.collection,
    rows,
    rowCount: rows.length,
    ...(docs.length > limit ? { truncated: `More than ${limit} rows: only the first ${limit} are shown — aggregate further or raise limit.` } : {}),
    ...(rows.length === 0 ? { note: "No rows: check the filters (names are case-sensitive unless you use $regex with options 'i'; older projects have no naming.month)." } : {}),
  };
}

/** Collections a runQuery call reads: its own and every $lookup `from`, at any depth. */
export function queryCollections(args: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (o.$lookup && typeof o.$lookup === "object" && typeof (o.$lookup as { from?: unknown }).from === "string") found.add((o.$lookup as { from: string }).from);
    Object.values(o).forEach(walk);
  };
  const a = (args ?? {}) as { collection?: unknown; pipeline?: unknown };
  if (typeof a.collection === "string") found.add(a.collection);
  walk(a.pipeline);
  return [...found];
}

/** Collections a describeData call showed in full. */
export function describedCollections(args: unknown): string[] {
  const c = (args as { collections?: unknown } | null)?.collections;
  return Array.isArray(c) ? c.filter((x): x is string => typeof x === "string") : [];
}
