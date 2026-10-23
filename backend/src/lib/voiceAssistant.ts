import mongoose from "mongoose";
import { projectBlocksTasks } from "../controllers/tasks.js";
import { Project } from "../models/Project.js";
import { completedStatusIds } from "../models/ProjectStatus.js";
import { composeTaskTitle, Task, TASK_TITLE_LIMITS } from "../models/Task.js";
import type { ITask, TaskStatus } from "../models/Task.js";
import type { IUser } from "../models/User.js";
import { STAFF_FILTER, User } from "../models/User.js";
import { addDays, appDateKey, appTimeZone, appToday, zonedParts, zonedToUtc } from "./appTime.js";
import { isGuestUser } from "./guests.js";
import { canCreateProjectTasks, projectVisibilityFilter } from "./projectAccess.js";
import { isProjectApproved } from "./projectApproval.js";
import { isProjectExpired } from "./projectExpiry.js";
import { SCOPE_UNITS, scopeTotals } from "./scopeUnits.js";
import {
  canManageTask,
  canManageTaskAsync,
  canTransition,
  canViewTaskAsync,
  isAssignee,
  loggedMinutesByTask,
  taskProjectFlags,
} from "./taskAccess.js";
import { richTextToPlain } from "./richText.js";
import {
  briefHtml,
  briefPreview,
  COMMON_WORDS,
  fieldEdit,
  normalizeNumbers,
  editDistance,
  findTaskCodes,
  matchPeople,
  matchProjects,
  matchUnit,
  parseVoiceText,
  tidyBriefRules,
  VOICE_FIELDS,
} from "./voiceParse.js";
import type { Extracted, TidyBrief, VocabPerson, VocabProject, VoiceAction, VoiceField, VoiceIntent } from "./voiceParse.js";

// ---------------------------------------------------------------------------
// Voice task assistant (POST /api/voice/transcribe + /understand). A chat that
// fills ONE action — create a task (new work or rework), close a task, or log
// time — asking only for what's missing, then shows a summary card. It never
// saves: after the person taps confirm the app calls the existing task / time
// endpoints, whose rules stay authoritative.
//
// Each message is read into a draft change by an OpenAI model with a strict
// JSON schema (OPENAI_API_KEY; model VOICE_NLU_MODEL, default gpt-4o-mini), or
// by the rules-based fallback parser (lib/voiceParse.ts) without the key or
// when the model fails. Either way the SERVER then matches the words against
// what the person can really use: projects they may add tasks to, the
// project's scope units, staff, and tasks they can see.
// Speech-to-text: OpenAI /audio/transcriptions (VOICE_STT_MODEL, default
// gpt-4o-mini-transcribe). Audio is never stored or logged.
// ---------------------------------------------------------------------------

const NLU_TIMEOUT_MS = 20_000;
const STT_TIMEOUT_MS = 45_000;
export const VOICE_LIMITS = { maxMessages: 20, maxMessageChars: 2000, maxAudioBytes: 25 * 1024 * 1024 } as const;
/** Same cap as the close dialog's "time spent" (23 h 59 m). */
const MAX_SPENT_MINUTES = 23 * 60 + 59;
/** Statuses a task can be closed (submitted) from — mirrors submitTask. */
const CLOSABLE: TaskStatus[] = ["todo", "in_progress", "rejected"];
const OPEN_STATUSES: TaskStatus[] = ["todo", "in_progress", "in_review", "rejected"];
const STATUS_LABEL: Record<string, string> = {
  todo: "to do",
  in_progress: "in progress",
  in_review: "in review",
  rejected: "rejected",
  completed: "completed",
};

export function voiceConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

// ---------------------------------------------------------------------------
// Draft (sent back by the app with every message; ids are re-checked each time)
// ---------------------------------------------------------------------------

export interface VoiceTaskRef {
  id: string;
  /** Short code ("MO-6"), or "#1234" for a task without one. */
  code: string;
  title: string;
  status: string;
  projectId: string | null;
  loggedMinutes: number;
  /** A final file or link is already recorded (closing needn't ask again). */
  hasFinal: boolean;
  /** The project completes tasks without a review. */
  direct: boolean;
  reviewer: string | null;
}

export interface VoiceDraft {
  action: VoiceAction | null;
  /** The field the last reply asked for. */
  asking: VoiceField | null;
  project: { id: string; name: string; code: string } | null;
  iteration: "new" | "rework" | null;
  unit: string | null;
  quantity: number | null;
  shortName: string | null;
  brief: string | null;
  assignees: Array<{ id: string; name: string }>;
  /** "YYYY-MM-DD". */
  dueDate: string | null;
  startDate: string | null;
  reworkOf: VoiceTaskRef | null;
  reworkSource: "internal" | "external" | null;
  task: VoiceTaskRef | null;
  /** Time spent (ends now), or the actual start / end (ISO instants) — set one or the other. */
  minutes: number | null;
  start: string | null;
  end: string | null;
  /** Close: outcome note; log time: memo. */
  note: string | null;
  finalUrl: string | null;
  /** A file / photo the app holds for the close (uploaded only after confirm). */
  finalFile: { name: string; size: number } | null;
  /** Create: the project whose existing tasks were already offered (asked once per project). */
  existingFor: string | null;
  /** "Work on this task": the task "close it" / "log time" refer to. */
  focusTaskId: string | null;
  /** Create: the tidied brief offered, and what the person chose. */
  briefTidy: TidyBrief | null;
  briefChoice: "tidy" | "plain" | null;
  /** What is saved as the task's description (simple HTML; set by the server each turn). */
  briefHtml: string | null;
  /** Update: new priority / status (To do ↔ In progress). */
  priority: "low" | "medium" | "high" | "urgent" | null;
  status: "todo" | "in_progress" | null;
  /** Update: the task as it is now (re-read by the server every turn), and the task the fields were filled from. */
  baseline: VoiceBaseline | null;
  baseFor: string | null;
  /** Update: the PATCH /api/tasks/:id body and the status move the app sends after "Update task" (set by the server). */
  updatePatch: Record<string, unknown> | null;
  updateStatus: "todo" | "in_progress" | null;
}

/** An existing task's editable fields, before the update. */
export interface VoiceBaseline {
  startDate: string | null;
  dueDate: string | null;
  assignees: Array<{ id: string; name: string }>;
  titleParts: { unit: string; quantity: number; shortName: string } | null;
  title: string;
  priority: "low" | "medium" | "high" | "urgent";
  status: string;
  /** The brief as plain text. */
  brief: string;
  /** The status moves the user may make (of To do / In progress). */
  moves: Array<"todo" | "in_progress">;
}

export function emptyDraft(): VoiceDraft {
  return {
    action: null,
    asking: null,
    project: null,
    iteration: null,
    unit: null,
    quantity: null,
    shortName: null,
    brief: null,
    assignees: [],
    dueDate: null,
    startDate: null,
    reworkOf: null,
    reworkSource: null,
    task: null,
    minutes: null,
    start: null,
    end: null,
    note: null,
    finalUrl: null,
    finalFile: null,
    existingFor: null,
    focusTaskId: null,
    briefTidy: null,
    briefChoice: null,
    priority: null,
    status: null,
    baseline: null,
    baseFor: null,
    updatePatch: null,
    updateStatus: null,
    briefHtml: null,
  };
}

// ---------------------------------------------------------------------------
// What the user can use
// ---------------------------------------------------------------------------

interface ContextProject extends VocabProject {
  /** On the team or the manager (listed first in chips and the speech prompt). */
  mine: boolean;
  updatedAt: number;
  scopeItems: Array<{ unit: string; quantity: number; languages: number; sizes: number }>;
  memberIds: string[];
}

export interface VoiceContext {
  user: IUser;
  today: string;
  /** Projects the user may add tasks to (open, approved, with scope when required). */
  projects: ContextProject[];
  people: VocabPerson[];
  /** Codes of every project the user can see (task codes said as "MO 6"). */
  codes: string[];
}

type LeanProject = {
  _id: mongoose.Types.ObjectId;
  name: string;
  code: string;
  brand?: { name?: string } | null;
  naming?: { month?: string } | null;
  deadline?: Date | null;
  approval?: { status?: string } | null;
  scopeItems?: ContextProject["scopeItems"];
  requiresScope?: boolean;
  manager?: mongoose.Types.ObjectId | null;
  members: Array<{ user: mongoose.Types.ObjectId }>;
  createdBy?: mongoose.Types.ObjectId | null;
  departments: mongoose.Types.ObjectId[];
  isPublic: boolean;
  archivedAt?: Date | null;
  updatedAt?: Date;
};

export async function loadVoiceContext(user: IUser): Promise<VoiceContext> {
  const completed = await completedStatusIds();
  const visible = projectVisibilityFilter(user);
  const [rows, people, codes] = await Promise.all([
    Project.find({ $and: [visible, { archivedAt: null }, ...(completed.length ? [{ status: { $nin: completed } }] : [])] })
      .select("name code brand naming deadline approval scopeItems requiresScope manager members.user createdBy departments isPublic archivedAt updatedAt")
      .populate("brand", "name")
      .lean<LeanProject[]>(),
    User.find(STAFF_FILTER).select("name").sort({ name: 1 }).lean<Array<{ _id: mongoose.Types.ObjectId; name: string }>>(),
    Project.distinct("code", visible) as Promise<string[]>,
  ]);
  const me = String(user._id);
  // The same projects the task form offers: open (not archived / completed / closed), approved,
  // the caller may add tasks there, and new projects only once they have a scope.
  const projects = rows
    .filter(
      (p) =>
        !isProjectExpired(p as never) &&
        isProjectApproved(p) &&
        !projectBlocksTasks(p as never) &&
        canCreateProjectTasks(user, p as never)
    )
    .map<ContextProject>((p) => {
      const memberIds = p.members.map((m) => String(m.user));
      return {
        id: String(p._id),
        code: p.code,
        name: p.name,
        brand: p.brand?.name ?? "",
        units: [...scopeTotals(p.scopeItems as never).values()].map((t) => t.unit),
        mine: memberIds.includes(me) || String(p.manager ?? "") === me,
        updatedAt: p.updatedAt ? new Date(p.updatedAt).getTime() : 0,
        scopeItems: p.scopeItems ?? [],
        memberIds,
      };
    })
    .sort((a, b) => Number(b.mine) - Number(a.mine) || b.updatedAt - a.updatedAt);
  return {
    user,
    today: appDateKey(new Date()),
    projects,
    people: people.map((p) => ({ id: String(p._id), name: p.name })),
    codes: codes.filter(Boolean),
  };
}

/** Units the user may name: the projects' scope units plus the standard ones. */
function allUnits(ctx: VoiceContext): string[] {
  const seen = new Map<string, string>();
  for (const u of [...ctx.projects.flatMap((p) => p.units), ...SCOPE_UNITS]) {
    if (!seen.has(u.toLowerCase())) seen.set(u.toLowerCase(), u);
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

type TaskPurpose = "close" | "log_time" | "rework" | "update";

/** A quick-reply label: cut at a word, at most `max` characters. */
function chip(text: string, max = 48): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > max / 2 ? cut.lastIndexOf(" ") : cut.length).trim()}…`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function toRef(task: ITask): Promise<VoiceTaskRef> {
  const id = task._id as mongoose.Types.ObjectId;
  const [logged, flags, reviewer] = await Promise.all([
    loggedMinutesByTask([id]),
    taskProjectFlags(task),
    task.assignedBy ? User.findById(task.assignedBy).select("name").lean<{ name: string }>() : Promise.resolve(null),
  ]);
  return {
    id: String(id),
    code: task.shortCode || (task.number ? `#${task.number}` : "Task"),
    title: task.title,
    status: task.status,
    projectId: task.project ? String(task.project) : null,
    loggedMinutes: logged.get(String(id)) ?? 0,
    hasFinal: Boolean(task.finalFile?.fileId || task.finalFile?.url),
    direct: flags.skipReview,
    reviewer: reviewer?.name ?? null,
  };
}

/** Whether the user may use this task for the purpose; an error sentence when not. */
async function taskProblem(ctx: VoiceContext, task: ITask, purpose: TaskPurpose): Promise<string | null> {
  const code = task.shortCode || `#${task.number}`;
  if (!(await canViewTaskAsync(ctx.user, task))) return `I couldn't find ${code} among the tasks you can see.`;
  if (purpose === "rework") {
    if (!task.project || !ctx.projects.some((p) => p.id === String(task.project))) {
      return `You can't add tasks in ${code}'s project (it's closed, not approved, or you aren't on it).`;
    }
    return null;
  }
  if (purpose === "update") {
    // The same rule as PATCH /api/tasks/:id (applyTaskUpdate): its assignees, or whoever manages it.
    if (!isAssignee(ctx.user, task) && !(await canManageTaskAsync(ctx.user, task))) {
      return `You can't edit ${code} — only its assignees, its creator, the project manager or an admin can.`;
    }
    return null;
  }
  if (purpose === "close") {
    if (!CLOSABLE.includes(task.status)) {
      return `${code} is ${STATUS_LABEL[task.status] ?? task.status} — only to-do, in-progress or rejected tasks can be closed.`;
    }
    if (!isAssignee(ctx.user, task)) {
      const flags = await taskProjectFlags(task, ctx.user);
      if (!(flags.skipReview && canManageTask(ctx.user, task, flags))) return `You can only close your own tasks — ${code} isn't assigned to you.`;
    }
  }
  return null;
}

/** Finds a task by code / number / title words among the tasks the user can see. */
async function findTask(
  ctx: VoiceContext,
  ref: { code?: string; number?: number; text?: string },
  purpose: TaskPurpose
): Promise<{ task: VoiceTaskRef } | { error: string; choices?: string[] }> {
  let task: ITask | null = null;
  if (ref.code) {
    task = await Task.findOne({ shortCode: new RegExp(`^${escapeRe(ref.code)}$`, "i") });
    if (!task) return { error: `I couldn't find ${ref.code.toUpperCase()}.` };
  } else if (ref.number) {
    task = await Task.findOne({ number: ref.number });
    if (!task) return { error: `I couldn't find task #${ref.number}.` };
  } else if (ref.text) {
    const words = ref.text
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3)
      .slice(0, 6);
    if (!words.length) return { error: "Which task? Say its code, like MO-6." };
    const matches = await Task.find({
      $and: [
        { $or: [{ assignees: ctx.user._id }, { assignedBy: ctx.user._id }] },
        { status: { $in: purpose === "close" ? CLOSABLE : OPEN_STATUSES } },
        ...words.map((w) => ({ title: new RegExp(escapeRe(w), "i") })),
      ],
    })
      .sort({ updatedAt: -1 })
      .limit(5);
    if (matches.length === 0) return { error: `I couldn't find an open task of yours matching "${ref.text}". Say its code, like MO-6.` };
    if (matches.length > 1) {
      return {
        error: "A few tasks match — which one?",
        choices: matches.map((t) => chip(`${t.shortCode || `#${t.number}`} · ${t.title}`)),
      };
    }
    task = matches[0]!;
  }
  if (!task) return { error: "Which task? Say its code, like MO-6." };
  const problem = await taskProblem(ctx, task, purpose);
  if (problem) return { error: problem };
  return { task: await toRef(task) };
}

/** Re-loads a task the draft names (the app's copy isn't trusted); null when no longer usable. */
async function reloadTask(ctx: VoiceContext, ref: unknown, purpose: TaskPurpose): Promise<VoiceTaskRef | null> {
  const id = typeof ref === "object" && ref !== null ? (ref as { id?: unknown }).id : null;
  if (typeof id !== "string" || !mongoose.isValidObjectId(id)) return null;
  const task = await Task.findById(id);
  if (!task || (await taskProblem(ctx, task, purpose))) return null;
  return toRef(task);
}

/** The user's open tasks as quick-reply chips ("MO-6 · Reel 3 – Teaser"). */
async function taskChips(ctx: VoiceContext, purpose: TaskPurpose): Promise<string[]> {
  const tasks = await Task.find({
    assignees: ctx.user._id,
    status: { $in: purpose === "close" ? CLOSABLE : OPEN_STATUSES },
    shortCode: { $type: "string" },
  })
    .select("shortCode title dueDate")
    .sort({ dueDate: 1, updatedAt: -1 })
    .limit(4)
    .lean<Array<{ shortCode: string; title: string }>>();
  return tasks.map((t) => chip(`${t.shortCode} · ${t.title}`));
}

// ---------------------------------------------------------------------------
// Draft clean-up (the app's draft is input like any other)
// ---------------------------------------------------------------------------

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const dayKey = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const instant = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export async function sanitizeDraft(ctx: VoiceContext, raw: unknown): Promise<VoiceDraft> {
  const d = emptyDraft();
  if (typeof raw !== "object" || raw === null) return d;
  const r = raw as Record<string, unknown>;
  d.action = (["create", "close", "log_time", "update"] as const).find((a) => a === r.action) ?? null;
  d.asking = VOICE_FIELDS.find((f) => f === r.asking) ?? null;
  if (d.action === "create") {
    const projectId = typeof r.project === "object" && r.project ? (r.project as { id?: unknown }).id : null;
    const project = ctx.projects.find((p) => p.id === projectId);
    if (project) d.project = { id: project.id, name: project.name, code: project.code };
    d.iteration = r.iteration === "new" || r.iteration === "rework" ? r.iteration : null;
    d.unit = str(r.unit, TASK_TITLE_LIMITS.unitMax);
    const q = Number(r.quantity);
    d.quantity = Number.isInteger(q) && q >= 1 && q <= TASK_TITLE_LIMITS.quantityMax ? q : null;
    d.shortName = str(r.shortName, TASK_TITLE_LIMITS.shortNameMax);
    d.brief = str(r.brief, 2000);
    if (Array.isArray(r.assignees)) {
      const byId = new Map(ctx.people.map((p) => [p.id, p]));
      for (const a of r.assignees as Array<{ id?: unknown }>) {
        const person = typeof a?.id === "string" ? byId.get(a.id) : undefined;
        if (person && !d.assignees.some((x) => x.id === person.id)) d.assignees.push({ id: person.id, name: person.name });
      }
    }
    d.dueDate = dayKey(r.dueDate);
    d.startDate = dayKey(r.startDate);
    d.reworkSource = r.reworkSource === "internal" || r.reworkSource === "external" ? r.reworkSource : null;
    if (d.iteration === "rework") d.reworkOf = await reloadTask(ctx, r.reworkOf, "rework");
    d.existingFor = d.project && r.existingFor === d.project.id ? d.project.id : null;
    const tidy = r.briefTidy as { objective?: unknown; bullets?: unknown } | null | undefined;
    if (d.brief && tidy && typeof tidy.objective === "string" && Array.isArray(tidy.bullets)) {
      d.briefTidy = {
        objective: tidy.objective.slice(0, 500),
        bullets: (tidy.bullets as unknown[]).filter((b): b is string => typeof b === "string").slice(0, 12).map((b) => b.slice(0, 300)),
      };
    }
    d.briefChoice = d.brief && (r.briefChoice === "tidy" || r.briefChoice === "plain") ? r.briefChoice : null;
    if (d.briefChoice === "tidy" && !d.briefTidy) d.briefChoice = null;
  }
  d.focusTaskId = typeof r.focusTaskId === "string" && mongoose.isValidObjectId(r.focusTaskId) ? r.focusTaskId : null;
  if (d.action === "close" || d.action === "log_time") {
    d.task = await reloadTask(ctx, r.task, d.action);
    const m = Number(r.minutes);
    d.minutes = Number.isInteger(m) && m >= 1 && m <= MAX_SPENT_MINUTES ? m : null;
    d.start = instant(r.start);
    d.end = instant(r.end);
    d.note = str(r.note, d.action === "log_time" ? 500 : 2000);
    const url = str(r.finalUrl, 2000);
    d.finalUrl = url && /^https?:\/\/\S+$/i.test(url) ? url : null;
    const file = r.finalFile as { name?: unknown; size?: unknown } | null | undefined;
    if (file && typeof file.name === "string" && Number.isFinite(Number(file.size))) {
      d.finalFile = { name: file.name.slice(0, 200), size: Number(file.size) };
    }
  }
  if (d.action === "update") {
    d.task = await reloadTask(ctx, r.task, "update");
    if (d.task) {
      // The baseline is always re-read; the app's copy is ignored.
      d.baseline = await loadBaseline(ctx, d.task.id);
      d.baseFor = r.baseFor === d.task.id && d.baseline ? d.task.id : null;
    }
    if (d.baseFor) {
      d.startDate = dayKey(r.startDate);
      d.dueDate = dayKey(r.dueDate);
      if (Array.isArray(r.assignees)) {
        const known = new Map([...ctx.people, ...(d.baseline?.assignees ?? [])].map((p) => [p.id, p.name]));
        for (const a of r.assignees as Array<{ id?: unknown }>) {
          const name = typeof a?.id === "string" ? known.get(a.id) : undefined;
          if (name && !d.assignees.some((x) => x.id === a.id)) d.assignees.push({ id: a.id as string, name });
        }
      }
      d.unit = str(r.unit, TASK_TITLE_LIMITS.unitMax);
      const q = Number(r.quantity);
      d.quantity = Number.isInteger(q) && q >= 1 && q <= TASK_TITLE_LIMITS.quantityMax ? q : null;
      d.shortName = str(r.shortName, TASK_TITLE_LIMITS.shortNameMax);
      d.brief = str(r.brief, 2000);
      const tidy = r.briefTidy as { objective?: unknown; bullets?: unknown } | null | undefined;
      if (d.brief && tidy && typeof tidy.objective === "string" && Array.isArray(tidy.bullets)) {
        d.briefTidy = {
          objective: tidy.objective.slice(0, 500),
          bullets: (tidy.bullets as unknown[]).filter((b): b is string => typeof b === "string").slice(0, 12).map((b) => b.slice(0, 300)),
        };
      }
      d.briefChoice = d.brief && (r.briefChoice === "tidy" || r.briefChoice === "plain") ? r.briefChoice : null;
      if (d.briefChoice === "tidy" && !d.briefTidy) d.briefChoice = null;
      d.priority = (["low", "medium", "high", "urgent"] as const).find((p) => p === r.priority) ?? null;
      d.status = (["todo", "in_progress"] as const).find((s) => s === r.status) ?? null;
    }
  }
  return d;
}

/** The task's editable fields now, and the status moves the user may make. */
async function loadBaseline(ctx: VoiceContext, taskId: string): Promise<VoiceBaseline | null> {
  const task = await Task.findById(taskId);
  if (!task) return null;
  const ids = task.assignees.map(String);
  const users = await User.find({ _id: { $in: task.assignees } }).select("name").lean<Array<{ _id: mongoose.Types.ObjectId; name: string }>>();
  const names = new Map(users.map((u) => [String(u._id), u.name]));
  const flags = await taskProjectFlags(task, ctx.user);
  const moves = (["todo", "in_progress"] as const).filter((to) => to !== task.status && canTransition(ctx.user, task, to, flags));
  const key = (d?: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  return {
    startDate: key(task.startDate),
    dueDate: key(task.dueDate),
    assignees: ids.map((id) => ({ id, name: names.get(id) ?? "Someone" })),
    titleParts: task.titleParts ? { unit: task.titleParts.unit, quantity: task.titleParts.quantity, shortName: task.titleParts.shortName } : null,
    title: task.title,
    priority: task.priority,
    status: task.status,
    brief: richTextToPlain(task.description).trim(),
    moves: [...moves],
  };
}

/** Fills the update draft from the task once (later turns change these values). */
function fillFromBaseline(d: VoiceDraft): void {
  const b = d.baseline;
  if (!b || !d.task) return;
  d.baseFor = d.task.id;
  d.startDate = b.startDate;
  d.dueDate = b.dueDate;
  d.assignees = b.assignees.map((a) => ({ ...a }));
  d.unit = b.titleParts?.unit ?? null;
  d.quantity = b.titleParts?.quantity ?? null;
  d.shortName = b.titleParts?.shortName ?? null;
  d.brief = null;
  d.briefTidy = null;
  d.briefChoice = null;
  d.priority = b.priority;
  d.status = null;
}

/** What an update changes: "Before → After" rows, the PATCH body (the edit form's shape) and a status move. */
export function updateChanges(d: VoiceDraft): { rows: Array<[string, string]>; patch: Record<string, unknown>; status: "todo" | "in_progress" | null } {
  const rows: Array<[string, string]> = [];
  const patch: Record<string, unknown> = {};
  const b = d.baseline;
  if (!b || d.action !== "update" || !d.baseFor) return { rows, patch, status: null };
  const day = (k: string | null) => (k ? fmtShortDay(k) : "—");
  if (d.startDate !== b.startDate) {
    rows.push(["Start", `${day(b.startDate)} → ${day(d.startDate)}`]);
    patch.startDate = d.startDate;
  }
  if (d.dueDate !== b.dueDate) {
    rows.push(["Due", `${day(b.dueDate)} → ${day(d.dueDate)}`]);
    patch.dueDate = d.dueDate;
  }
  const added = d.assignees.filter((a) => !b.assignees.some((x) => x.id === a.id));
  const removed = b.assignees.filter((a) => !d.assignees.some((x) => x.id === a.id));
  if (added.length || removed.length) {
    rows.push(["Assignees", [...added.map((a) => `+ ${a.name}`), ...removed.map((a) => `− ${a.name}`)].join(", ")]);
    patch.assignees = d.assignees.map((a) => a.id);
  }
  if (b.titleParts && d.unit && d.quantity && d.shortName) {
    const after = { unit: d.unit, quantity: d.quantity, shortName: d.shortName };
    if (after.unit !== b.titleParts.unit || after.quantity !== b.titleParts.quantity || after.shortName !== b.titleParts.shortName) {
      rows.push(["Name", `${composeTaskTitle(b.titleParts)} → ${composeTaskTitle(after)}`]);
      patch.titleParts = after;
    }
  }
  if (d.brief) {
    rows.push(["Brief", briefShort(d)]);
    patch.description = draftBriefHtml(d);
  }
  if (d.priority && d.priority !== b.priority) {
    rows.push(["Priority", `${capWord(b.priority)} → ${capWord(d.priority)}`]);
    patch.priority = d.priority;
  }
  const status = d.status && d.status !== b.status ? d.status : null;
  if (status) rows.push(["Status", `${capWord(STATUS_LABEL[b.status] ?? b.status)} → ${capWord(STATUS_LABEL[status] ?? status)}`]);
  return { rows, patch, status };
}

// ---------------------------------------------------------------------------
// AI reading (OpenAI, strict JSON schema)
// ---------------------------------------------------------------------------

const nullableString = { type: ["string", "null"] };
const NLU_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "intent", "project", "iteration", "unit", "quantity", "shortName", "brief", "assigneesAdd", "assigneesRemove",
    "dueDate", "startDate", "reworkOf", "reworkSource", "task", "minutes", "start", "end", "note", "finalUrl",
    "priority", "status", "briefAppend",
  ],
  properties: {
    intent: { type: ["string", "null"], enum: ["create", "rework", "close", "log_time", "update", "out_of_scope", "cancel", null] },
    priority: { type: ["string", "null"], enum: ["low", "medium", "high", "urgent", null] },
    status: { type: ["string", "null"], enum: ["todo", "in_progress", null] },
    briefAppend: nullableString,
    project: nullableString,
    iteration: { type: ["string", "null"], enum: ["new", "rework", null] },
    unit: nullableString,
    quantity: { type: ["integer", "null"] },
    shortName: nullableString,
    brief: nullableString,
    assigneesAdd: { type: "array", items: { type: "string" } },
    assigneesRemove: { type: "array", items: { type: "string" } },
    dueDate: nullableString,
    startDate: nullableString,
    reworkOf: nullableString,
    reworkSource: { type: ["string", "null"], enum: ["internal", "external", null] },
    task: nullableString,
    minutes: { type: ["integer", "null"] },
    start: nullableString,
    end: nullableString,
    note: nullableString,
    finalUrl: nullableString,
  },
} as const;

interface NluReply {
  intent: VoiceIntent | null;
  project: string | null;
  iteration: "new" | "rework" | null;
  unit: string | null;
  quantity: number | null;
  shortName: string | null;
  brief: string | null;
  assigneesAdd: string[];
  assigneesRemove: string[];
  dueDate: string | null;
  startDate: string | null;
  reworkOf: string | null;
  reworkSource: "internal" | "external" | null;
  task: string | null;
  minutes: number | null;
  start: string | null;
  end: string | null;
  note: string | null;
  finalUrl: string | null;
  priority: "low" | "medium" | "high" | "urgent" | null;
  status: "todo" | "in_progress" | null;
  briefAppend: string | null;
}

function draftForModel(d: VoiceDraft): Record<string, unknown> {
  return {
    action: d.action,
    asking: d.asking,
    project: d.project?.code ?? null,
    iteration: d.iteration,
    unit: d.unit,
    quantity: d.quantity,
    shortName: d.shortName,
    brief: d.brief,
    assignees: d.assignees.map((a) => a.name),
    startDate: d.startDate,
    dueDate: d.dueDate,
    reworkOf: d.reworkOf?.code ?? null,
    reworkSource: d.reworkSource,
    task: d.task?.code ?? null,
    minutes: d.minutes,
    note: d.note,
    finalUrl: d.finalUrl,
  };
}

async function aiExtract(
  ctx: VoiceContext,
  messages: Array<{ role: "user" | "assistant"; text: string }>,
  draft: VoiceDraft
): Promise<Extracted> {
  const now = zonedParts(new Date());
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: appTimeZone(), weekday: "long" }).format(new Date());
  const projectLines = ctx.projects
    .slice(0, 200)
    .map((p) => `${p.code} — ${p.name} — ${p.brand || "no brand"}${p.units.length ? ` — units: ${p.units.join(", ")}` : ""}`);
  const system = [
    "You read one person's chat with the Projects Utility task assistant (voice transcripts or typed, English or Arabic) and return task fields as JSON.",
    `Today is ${weekday} ${ctx.today}, ${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")} in the app timezone (${appTimeZone()}).`,
    "Actions: create (new task, or a rework of an existing task), close (complete a task), log_time, update (change an existing task: start / due date, assignees, brief, priority, short name, To do ↔ In progress). Anything else (what's due, move time, delete, reassign …) is intent out_of_scope; cancel / start over is intent cancel.",
    "Return ONLY what the LATEST user message says or changes; null (or []) for everything it doesn't mention. Never repeat values already in the draft.",
    `The assistant's last question was for: ${draft.asking ?? "nothing yet"}. A short reply answers that question (a brief, short name, outcome note or link is taken whole).`,
    "Fields: project = a project code from the list (or the name as said); unit = one of the project's units; quantity = whole number; shortName = the short task name without unit or quantity (max 80 chars);",
    "brief = what needs to be done; assigneesAdd / assigneesRemove = people's names as listed (\"me\" for the speaker); dueDate / startDate = YYYY-MM-DD (a weekday means the next one after today);",
    "\"A → B\" or \"from A to B\" days are startDate → dueDate; a single day answering \"when does it start\" is startDate, answering \"when is it due\" is dueDate;",
    "iteration = new or rework (only when said); reworkOf = the original task's code (like MO-6); reworkSource = external when the client asked for it, internal for our own review;",
    "task = the task code (like ENOC-13), number, or title words; minutes = time spent; start / end = \"YYYY-MM-DDTHH:mm\" app time when a time range is said;",
    "update: task = the task's code; assigneesAdd / assigneesRemove for people; brief replaces the brief, briefAppend adds to it; priority low|medium|high|urgent; status todo|in_progress (never completed — that is close);",
    "note = the outcome note (close) or memo (log time) — what was done, without the code or the time; finalUrl = an http(s) link.",
    "The pending draft below is the default target of EVERY edit: \"update / change / add to the brief / due / start / people / name / priority\" changes THIS draft. Use intent update / close / log_time only when the latest message names a task code (like EO26-5); keep intent null for edits of the draft. Never invent a brief: only fill brief when the person gives one.",
    `Current draft: ${JSON.stringify(draftForModel(draft))}`,
    `Projects (code — name — brand — units):\n${projectLines.join("\n") || "(none)"}`,
    `People: ${ctx.people.map((p) => p.name).join(", ").slice(0, 6000)}`,
  ].join("\n");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NLU_TIMEOUT_MS);
  let reply: NluReply;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY!.trim()}` },
      body: JSON.stringify({
        model: process.env.VOICE_NLU_MODEL?.trim() || "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_schema", json_schema: { name: "task_action", strict: true, schema: NLU_SCHEMA } },
        messages: [
          { role: "system", content: system },
          ...messages.map((m) => ({ role: m.role, content: m.text })),
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    reply = JSON.parse(json.choices?.[0]?.message?.content ?? "{}") as NluReply;
  } finally {
    clearTimeout(timer);
  }

  // The model's words → the user's real projects, people, units and task codes.
  const out: Extracted = {};
  if (reply.intent) out.intent = reply.intent;
  if (reply.project) {
    const ids = matchProjects(reply.project, ctx.projects);
    out.projectIds = ids.length ? ids : matchProjects(reply.project, ctx.projects, true);
  }
  if (reply.iteration) out.iteration = reply.iteration;
  if (reply.unit) out.unit = matchUnit(reply.unit, allUnits(ctx))?.unit ?? reply.unit;
  if (reply.quantity) out.quantity = reply.quantity;
  if (reply.shortName) out.shortName = reply.shortName;
  if (reply.brief) out.brief = reply.brief;
  const people = (names: string[]) => {
    const ids: string[] = [];
    const ambiguous: Array<{ said: string; ids: string[] }> = [];
    const sounds: Array<{ said: string; ids: string[] }> = [];
    for (const name of names) {
      if (/^(?:me|myself|I)$/i.test(name.trim())) {
        ids.push(String(ctx.user._id));
        continue;
      }
      const m = matchPeople(name, ctx.people, { me: String(ctx.user._id), anyCase: true });
      ids.push(...m.ids);
      ambiguous.push(...m.ambiguous);
      sounds.push(...m.sounds);
    }
    return { ids: [...new Set(ids)], ambiguous, sounds };
  };
  if (reply.assigneesAdd?.length) {
    const m = people(reply.assigneesAdd);
    if (m.ids.length) out.addPeople = m.ids;
    if (m.ambiguous.length) out.ambiguousPeople = m.ambiguous;
    if (m.sounds.length) out.soundPeople = m.sounds;
  }
  if (reply.assigneesRemove?.length) out.removePeople = people(reply.assigneesRemove).ids;
  if (reply.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(reply.dueDate)) out.dueDate = reply.dueDate;
  if (reply.startDate && /^\d{4}-\d{2}-\d{2}$/.test(reply.startDate)) out.startDate = reply.startDate;
  if (reply.reworkOf) out.reworkOf = findTaskCodes(reply.reworkOf, ctx.codes)[0] ?? reply.reworkOf.trim().toUpperCase();
  if (reply.reworkSource) out.reworkSource = reply.reworkSource;
  if (reply.task) {
    const code = findTaskCodes(reply.task, ctx.codes)[0];
    const number = /^#?(\d{1,7})$/.exec(reply.task.trim());
    if (code) out.taskCode = code;
    else if (number) out.taskNumber = Number(number[1]);
    else out.taskText = reply.task.slice(0, 120);
  }
  if (reply.minutes) out.minutes = reply.minutes;
  const local = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
  if (reply.start && reply.end && local.test(reply.start) && local.test(reply.end)) {
    out.start = reply.start;
    out.end = reply.end;
  }
  if (reply.note) out.note = reply.note;
  if (reply.finalUrl) out.finalUrl = reply.finalUrl;
  if (reply.priority) out.priority = reply.priority;
  if (reply.status) out.status = reply.status;
  if (reply.briefAppend) out.briefAppend = reply.briefAppend;
  return out;
}

// ---------------------------------------------------------------------------
// Applying a change, asking for what's missing
// ---------------------------------------------------------------------------

/** "YYYY-MM-DDTHH:mm" in the app timezone → UTC instant. */
function localToInstant(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  return zonedToUtc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

interface Turn {
  draft: VoiceDraft;
  /** Sentences to say before the next question (what couldn't be used). */
  notes: string[];
  /** A question that must come first (which project / which person / which task). */
  override?: { ask: VoiceField; reply: string; chips: string[] };
  /** Another action was asked for while a draft is pending: ask before leaving it. */
  switching?: boolean;
  /** Reply on its own (cancel, out of scope). */
  final?: string;
}

async function applyExtracted(ctx: VoiceContext, input: VoiceDraft, ex: Extracted, contextTaskId: string | null, said = ""): Promise<Turn> {
  let draft = input;
  const notes: string[] = [];
  let override: Turn["override"];
  if (ex.intent === "cancel") return { draft: emptyDraft(), notes, final: "OK, cleared. What would you like to do — create a task, close a task or log time?" };
  if (ex.intent === "out_of_scope") {
    return {
      draft,
      notes,
      final: "Not yet — use the Tasks page for that. Here I can create a task, close a task or log time.",
    };
  }

  // The pending draft is the target of every edit. Another action only when a task is named
  // ("update EO26-5 …") or a new task is asked for — and even then the person confirms first.
  let family: VoiceAction | null = ex.intent === "rework" ? "create" : (ex.intent as VoiceAction | undefined) ?? null;
  if (family && draft.action && family !== draft.action) {
    const explicit =
      Boolean(ex.taskCode || ex.taskNumber) || (family === "create" && /\b(?:new|another)\s+task\b/i.test(said) && !/\bnot\b|\bthis\b/i.test(said));
    if (!explicit) family = null;
    else return { draft, notes, switching: true };
  }
  if (family) draft.action = family;
  if (!draft.action) {
    if (ex.taskCode || ex.taskNumber) draft.action = ex.minutes || ex.start ? "log_time" : null;
    else if (ex.projectIds?.length || ex.unit || ex.addPeople?.length || ex.reworkOf) draft.action = "create";
  }
  if (ex.intent === "rework") draft.iteration = "rework";

  if (draft.action === "create") {
    if (ex.iteration) draft.iteration = ex.iteration;
    if (draft.iteration !== "rework") draft.reworkOf = null;
    // Rework: the original task decides the project.
    if (ex.reworkOf) {
      const found = await findTask(ctx, { code: ex.reworkOf }, "rework");
      if ("task" in found) {
        draft.reworkOf = found.task;
        draft.iteration = "rework";
      } else notes.push(found.error);
    }
    if (draft.iteration === "rework" && !draft.reworkOf && contextTaskId) {
      draft.reworkOf = await reloadTask(ctx, { id: contextTaskId }, "rework");
    }
    if (draft.iteration === "rework" && draft.reworkOf) {
      const project = ctx.projects.find((p) => p.id === draft.reworkOf!.projectId);
      if (project) draft.project = { id: project.id, name: project.name, code: project.code };
    } else if (ex.projectIds?.length) {
      const matches = ctx.projects.filter((p) => ex.projectIds!.includes(p.id));
      if (matches.length === 1) {
        const p = matches[0]!;
        if (draft.project?.id !== p.id) {
          draft.project = { id: p.id, name: p.name, code: p.code };
          // A unit from another project's scope is asked again.
          if (draft.unit && p.units.length && !p.units.some((u) => u.toLowerCase() === draft.unit!.toLowerCase())) draft.unit = null;
        }
      } else if (matches.length > 1) {
        override = {
          ask: "project",
          reply: "A few projects match — which one?",
          chips: matches.slice(0, 6).map((p) => chip(`${p.code} · ${p.name}`)),
        };
      }
    }
    if (ex.reworkSource && draft.iteration === "rework") draft.reworkSource = ex.reworkSource;
    if (ex.unit) {
      const project = ctx.projects.find((p) => p.id === draft.project?.id);
      const units = project?.units ?? [];
      const known = units.find((u) => u.toLowerCase() === ex.unit!.toLowerCase());
      if (units.length && !known) {
        notes.push(`${ex.unit} isn't in this project's scope.`);
        draft.unit = null;
      } else draft.unit = (known ?? ex.unit).slice(0, TASK_TITLE_LIMITS.unitMax);
    }
    if (ex.quantity) {
      if (ex.quantity >= 1 && ex.quantity <= TASK_TITLE_LIMITS.quantityMax) draft.quantity = ex.quantity;
      else notes.push(`The quantity must be from 1 to ${TASK_TITLE_LIMITS.quantityMax}.`);
    }
    // A scope unit without a number gets the next one (used + 1), as the form fills it.
    if (draft.unit && !draft.quantity && draft.project && draft.iteration !== "rework") {
      const units = ctx.projects.find((p) => p.id === draft.project!.id)?.units ?? [];
      if (units.some((u) => u.toLowerCase() === draft.unit!.toLowerCase())) draft.quantity = await nextNumber(ctx, draft.project.id, draft.unit);
    }
    if (ex.shortName) draft.shortName = ex.shortName.slice(0, TASK_TITLE_LIMITS.shortNameMax);
    if (ex.brief || ex.briefAppend) {
      // A new (or longer) brief is offered tidied again (understand() fills briefTidy).
      draft.brief = (ex.brief ?? [draft.brief, ex.briefAppend].filter(Boolean).join("\n")).slice(0, 2000);
      draft.briefTidy = null;
      draft.briefChoice = null;
    }
    const byId = new Map(ctx.people.map((p) => [p.id, p]));
    for (const id of ex.addPeople ?? []) {
      const person = byId.get(id);
      if (person && !draft.assignees.some((a) => a.id === id)) draft.assignees.push({ id, name: person.name });
    }
    if (ex.removePeople?.length) draft.assignees = draft.assignees.filter((a) => !ex.removePeople!.includes(a.id));
    if (ex.soundPeople?.length && !override) override = confirmPerson(ctx, draft, ex.soundPeople[0]!, "assignees");
    if (ex.ambiguousPeople?.length && !override) {
      const first = ex.ambiguousPeople[0]!;
      // On the project team first.
      const project = ctx.projects.find((p) => p.id === draft.project?.id);
      const onTeam = first.ids.filter((id) => project?.memberIds.includes(id));
      if (onTeam.length === 1) {
        const person = byId.get(onTeam[0]!)!;
        if (!draft.assignees.some((a) => a.id === person.id)) draft.assignees.push({ id: person.id, name: person.name });
      } else {
        override = {
          ask: "assignees",
          reply: `Which ${first.said}?`,
          chips: first.ids.slice(0, 6).map((id) => byId.get(id)?.name ?? "").filter(Boolean),
        };
      }
    }
    if (ex.dueDate) draft.dueDate = ex.dueDate;
    if (ex.startDate) draft.startDate = ex.startDate;
    // A day said on its own answers whichever date is still missing (due first).
    if (ex.anyDate && !ex.dueDate && !ex.startDate) {
      if (!draft.dueDate) draft.dueDate = ex.anyDate;
      else if (!draft.startDate) draft.startDate = ex.anyDate;
      else draft.dueDate = ex.anyDate;
    }
    if (draft.startDate && draft.dueDate && draft.startDate > draft.dueDate) {
      // The date said now is dropped, so the question comes again.
      notes.push(`The due date can't be before the start date (${fmtDay(draft.startDate)} → ${fmtDay(draft.dueDate)}).`);
      if (ex.startDate && !ex.dueDate) draft.startDate = null;
      else draft.dueDate = null;
    }
    // A rework is due in two days unless said (the same default the server uses).
    if (draft.iteration === "rework" && !draft.dueDate) draft.dueDate = addDays(appToday(), 2).toISOString().slice(0, 10);
  }

  if (draft.action === "update") {
    const result = await applyUpdate(ctx, draft, ex, contextTaskId);
    notes.push(...result.notes);
    if (result.override) override = result.override;
  }

  if (draft.action === "close" || draft.action === "log_time") {
    const purpose = draft.action;
    if (ex.taskCode || ex.taskNumber || ex.taskText) {
      const found = await findTask(ctx, { code: ex.taskCode, number: ex.taskNumber, text: ex.taskText }, purpose);
      if ("task" in found) {
        if (draft.task?.id !== found.task.id) {
          draft.finalFile = null;
          draft.finalUrl = null;
        }
        draft.task = found.task;
      } else if (found.choices?.length) override = { ask: "task", reply: found.error, chips: found.choices };
      else notes.push(found.error);
    }
    // "Close this" from a task's page.
    if (!draft.task && contextTaskId && !ex.taskCode && !ex.taskNumber && !ex.taskText) {
      draft.task = await reloadTask(ctx, { id: contextTaskId }, purpose);
    }
    if (ex.minutes) {
      if (ex.minutes >= 1 && ex.minutes <= MAX_SPENT_MINUTES) {
        draft.minutes = ex.minutes;
        draft.start = null;
        draft.end = null;
      } else notes.push("Time spent must be from 1 minute to 23 h 59 m.");
    }
    if (ex.start && ex.end) {
      const start = localToInstant(ex.start);
      const end = localToInstant(ex.end);
      if (!start || !end || end.getTime() <= start.getTime()) notes.push("The end must be after the start.");
      else if (end.getTime() > Date.now() + 60_000) notes.push("The end can't be in the future.");
      else {
        draft.start = start.toISOString();
        draft.end = end.toISOString();
        draft.minutes = null;
      }
    }
    if (ex.note) draft.note = ex.note.slice(0, purpose === "log_time" ? 500 : 2000);
    if (ex.finalUrl && purpose === "close") {
      if (/^https?:\/\/\S+$/i.test(ex.finalUrl) && ex.finalUrl.length <= 2000) {
        draft.finalUrl = ex.finalUrl;
        draft.finalFile = null;
      } else notes.push("The link must start with http:// or https://.");
    }
  }
  return { draft, notes, override };
}

// ---------------------------------------------------------------------------
// Existing tasks of the project, "new task like this", "work on this task"
// ---------------------------------------------------------------------------

export const EXISTING_NONE = "None — new name";
const BRIEF_USE = "Use tidied brief";
const BRIEF_KEEP = "Keep as I said";
const BRIEF_EDIT = "Edit by voice";

export interface VoiceExistingTask {
  id: string;
  code: string;
  title: string;
  status: string;
}

export const EXISTING_CHIP = "Or work on an existing task";
/** The scope chips: "Reel · 3 of 10 left". */
const SCOPE_CHIP = /^\s*(.+?)\s*·\s*\d+\s+of\s+\d+\s+left\s*$/i;

/**
 * Per scope unit: the approved total and what new-work tasks already use — the
 * same sums as GET /api/projects/:id/scope-usage (the form's unit dropdown).
 */
async function scopeUsageOf(ctx: VoiceContext, projectId: string | null): Promise<Array<{ unit: string; total: number; used: number }>> {
  const project = ctx.projects.find((p) => p.id === projectId);
  if (!project || !project.scopeItems.length) return [];
  const totals = scopeTotals(project.scopeItems as never);
  const used = await Task.aggregate<{ _id: string; used: number }>([
    {
      $match: {
        project: new mongoose.Types.ObjectId(project.id),
        iteration: { $ne: "rework" },
        "overScope.status": { $ne: "rejected" },
        "titleParts.unit": { $type: "string" },
      },
    },
    { $group: { _id: { $toLower: "$titleParts.unit" }, used: { $sum: "$titleParts.quantity" } } },
  ]);
  const usedBy = new Map(used.map((u) => [u._id.trim(), u.used]));
  return [...totals.entries()].map(([key, t]) => ({ unit: t.unit, total: t.total, used: usedBy.get(key) ?? 0 }));
}

/** The next number for a unit (used + 1), as the form fills it. */
async function nextNumber(ctx: VoiceContext, projectId: string | null, unit: string): Promise<number> {
  const usage = await scopeUsageOf(ctx, projectId);
  const row = usage.find((u) => u.unit.toLowerCase() === unit.toLowerCase());
  return Math.min(TASK_TITLE_LIMITS.quantityMax, (row?.used ?? 0) + 1);
}
const STOP_WORDS = new Set(["the", "and", "for", "new", "task", "with", "from", "due", "this", "that"]);

/**
 * Up to 8 of the project's tasks — open, or completed in the last 30 days —
 * best match first to what was said (unit / short name words), else newest.
 */
async function existingTasks(ctx: VoiceContext, d: VoiceDraft, said: string): Promise<VoiceExistingTask[]> {
  if (!d.project) return [];
  const rows = await Task.find({
    project: new mongoose.Types.ObjectId(d.project.id),
    // Open tasks only (to do / in progress / in review / rejected).
    status: { $in: OPEN_STATUSES },
  })
    .select("shortCode number title status titleParts updatedAt")
    .sort({ updatedAt: -1 })
    .limit(80)
    .lean<Array<{ _id: mongoose.Types.ObjectId; shortCode?: string | null; number?: number; title: string; status: string; titleParts?: { unit?: string } }>>();
  const words = [d.unit ?? "", d.shortName ?? "", said]
    .join(" ")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  const scored = rows.map((t, index) => {
    const title = t.title.toLowerCase();
    let score = 0;
    if (d.unit && t.titleParts?.unit?.toLowerCase() === d.unit.toLowerCase()) score += 2;
    for (const w of new Set(words)) if (title.includes(w)) score += 1;
    return { t, score, index };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, 8).map(({ t }) => ({
    id: String(t._id),
    code: t.shortCode || (t.number ? `#${t.number}` : "Task"),
    title: t.title,
    status: STATUS_LABEL[t.status] ?? t.status,
  }));
}

/** A task of the draft's project the user can see, by code ("EO26-10"). */
async function projectTaskByCode(ctx: VoiceContext, code: string): Promise<ITask | null> {
  const task = await Task.findOne({ shortCode: new RegExp(`^${escapeRe(code)}$`, "i") });
  if (!task || !(await canViewTaskAsync(ctx.user, task))) return null;
  return task;
}

/** "New task like EO26-10": its unit + short name with the next number, its people and brief as a start. */
async function copyFromTask(ctx: VoiceContext, draft: VoiceDraft, code: string): Promise<{ draft: VoiceDraft; note: string }> {
  const task = await projectTaskByCode(ctx, code);
  const project = task?.project ? ctx.projects.find((p) => p.id === String(task.project)) : undefined;
  if (!task || !project) return { draft, note: `I couldn't use ${code} here.` };
  const next: VoiceDraft = { ...draft, action: "create", iteration: "new", project: { id: project.id, name: project.name, code: project.code } };
  next.existingFor = project.id;
  const parts = task.titleParts;
  if (parts?.unit && parts.shortName) {
    const shortName = parts.shortName.replace(/\s+R\d+$/, "");
    const [top] = await Task.aggregate<{ max: number }>([
      {
        $match: {
          project: new mongoose.Types.ObjectId(project.id),
          "titleParts.unit": { $regex: `^${escapeRe(parts.unit)}$`, $options: "i" },
          "titleParts.shortName": { $regex: `^${escapeRe(shortName)}$`, $options: "i" },
        },
      },
      { $group: { _id: null, max: { $max: "$titleParts.quantity" } } },
    ]);
    next.unit = parts.unit;
    next.shortName = shortName;
    next.quantity = Math.min(TASK_TITLE_LIMITS.quantityMax, Math.max(top?.max ?? parts.quantity, parts.quantity) + 1);
  } else {
    // An older free title ("ENOC | October 2026 | Zoom campaign | ppm plan"): the parts the project name doesn't already say.
    const key = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    const projectParts = new Set(project.name.split("|").map(key));
    const own = task.title.split("|").map((s) => s.trim()).filter((s) => s && !projectParts.has(key(s)));
    next.shortName = (own.join(" | ") || task.title).slice(0, TASK_TITLE_LIMITS.shortNameMax);
  }
  if (next.assignees.length === 0) {
    const byId = new Map(ctx.people.map((p) => [p.id, p]));
    next.assignees = task.assignees.map((id) => byId.get(String(id))).filter((p): p is VocabPerson => Boolean(p)).map((p) => ({ id: p.id, name: p.name }));
  }
  const brief = richTextToPlain(task.description).trim();
  if (brief && !next.brief) {
    // The copied brief is a starting point, kept as it was written.
    next.brief = brief.slice(0, 2000);
    next.briefTidy = null;
    next.briefChoice = "plain";
  }
  const name = next.unit ? composeTaskTitle({ unit: next.unit, quantity: next.quantity ?? 1, shortName: next.shortName ?? "" }) : next.shortName;
  return {
    draft: next,
    note: `New task like ${task.shortCode}: ${name}${next.assignees.length ? `, for ${next.assignees.map((a) => a.name.split(" ")[0]).join(" and ")}` : ""}${brief ? ", with its brief to start from" : ""}.`,
  };
}

/** An open task with the same unit + number + short name in the project (a duplicate). */
async function duplicateOf(d: VoiceDraft): Promise<{ code: string; title: string } | null> {
  if (d.action !== "create" || d.iteration === "rework" || !d.project || !d.unit || !d.quantity || !d.shortName) return null;
  const task = await Task.findOne({
    project: new mongoose.Types.ObjectId(d.project.id),
    status: { $in: OPEN_STATUSES },
    "titleParts.unit": { $regex: `^${escapeRe(d.unit)}$`, $options: "i" },
    "titleParts.quantity": d.quantity,
    "titleParts.shortName": { $regex: `^${escapeRe(d.shortName)}$`, $options: "i" },
  })
    .select("shortCode number title")
    .lean<{ shortCode?: string | null; number?: number; title: string }>();
  return task ? { code: task.shortCode || `#${task.number}`, title: task.title } : null;
}

// ---------------------------------------------------------------------------
// Brief tidy: AI rewrite (OpenAI, same model as the reading), else the rules
// ---------------------------------------------------------------------------

const TIDY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["objective", "bullets"],
  properties: { objective: { type: "string" }, bullets: { type: "array", items: { type: "string" } } },
} as const;

async function tidyBrief(ctx: VoiceContext, text: string, projectName: string | null): Promise<TidyBrief> {
  const rules = () => tidyBriefRules(text, allUnits(ctx));
  if (!voiceConfigured()) return rules();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NLU_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY!.trim()}` },
      body: JSON.stringify({
        model: process.env.VOICE_NLU_MODEL?.trim() || "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_schema", json_schema: { name: "task_brief", strict: true, schema: TIDY_SCHEMA } },
        messages: [
          {
            role: "system",
            content: [
              "Rewrite a spoken task brief from a creative agency into a short structured brief.",
              "objective: one line saying what is to be done. bullets: the deliverables with counts / sizes / durations, language / captions, references / links, deadline notes, and any other instruction — one fact per bullet.",
              "Keep EVERY fact and number from the brief, add nothing that isn't in it, don't guess. Keep the brief's language (English or Arabic). Short plain sentences, no markdown.",
              "Only write bullets for things the brief actually says. NEVER write a bullet about something missing (no \"not specified\", \"not mentioned\", \"none\", \"no captions\", \"no references provided\"). Don't name a language, size or duration the brief doesn't name. A short brief may have no bullets at all.",
              projectName ? `Project: ${projectName}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          },
          { role: "user", content: text.slice(0, 2000) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const out = JSON.parse(json.choices?.[0]?.message?.content ?? "{}") as Partial<TidyBrief>;
    if (typeof out.objective !== "string" || !out.objective.trim() || !Array.isArray(out.bullets)) throw new Error("Unexpected model reply");
    // Bullets about what the brief doesn't say, or naming a language it doesn't name, are dropped.
    const said = text.toLowerCase();
    const invented = (b: string) =>
      /\b(?:not\s+(?:specified|mentioned|provided|given|required)|none|n\/a|no\s+(?:\w+\s+){0,2}(?:provided|mentioned|specified|required|given))\b/i.test(b) ||
      [...b.toLowerCase().matchAll(/\b(english|arabic|french|hindi|urdu|russian|chinese|german|spanish)\b/g)].some((m) => !said.includes(m[1]!));
    return {
      objective: out.objective.trim().slice(0, 500),
      bullets: out.bullets.filter((b) => typeof b === "string" && b.trim() && !invented(b)).slice(0, 12).map((b) => b.trim().slice(0, 300)),
    };
  } catch (err) {
    console.error("[voice] brief tidy failed, using the rules", err instanceof Error ? err.message : err);
    return rules();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Update a task
// ---------------------------------------------------------------------------

/**
 * Applies a message to an UPDATE draft: finds the task (one the user may edit — the
 * PATCH rule), fills the draft from it once, then changes dates, people, name, brief,
 * priority and status. Due before start, a name on an older free-title task, or a
 * status move the user can't make are refused with a note.
 */
async function applyUpdate(
  ctx: VoiceContext,
  draft: VoiceDraft,
  ex: Extracted,
  contextTaskId: string | null
): Promise<{ notes: string[]; override?: Turn["override"] }> {
  const notes: string[] = [];
  let override: Turn["override"];
  if (ex.taskCode || ex.taskNumber || ex.taskText) {
    const found = await findTask(ctx, { code: ex.taskCode, number: ex.taskNumber, text: ex.taskText }, "update");
    if ("task" in found) {
      if (draft.task?.id !== found.task.id) draft.baseFor = null;
      draft.task = found.task;
    } else if (found.choices?.length) override = { ask: "task", reply: found.error, chips: found.choices };
    else notes.push(found.error);
  } else if (!draft.task && contextTaskId) {
    // "Update this" from a task's page / "Work on this task".
    const task = await Task.findById(contextTaskId);
    const problem = task ? await taskProblem(ctx, task, "update") : "I couldn't find that task.";
    if (task && !problem) draft.task = await toRef(task);
    else if (problem) notes.push(problem);
  }
  if (!draft.task) return { notes, override };
  if (draft.baseFor !== draft.task.id) {
    draft.baseline = await loadBaseline(ctx, draft.task.id);
    fillFromBaseline(draft);
  }
  const base = draft.baseline;
  if (!base) return { notes, override };

  // Dates: due on or after start.
  if (ex.startDate) draft.startDate = ex.startDate;
  if (ex.dueDate) draft.dueDate = ex.dueDate;
  if (ex.anyDate && !ex.startDate && !ex.dueDate) draft.dueDate = ex.anyDate;
  if (draft.startDate && draft.dueDate && draft.startDate > draft.dueDate) {
    notes.push(`The due date can't be before the start date (${fmtDay(draft.startDate)} → ${fmtDay(draft.dueDate)}).`);
    if (ex.startDate && !ex.dueDate) draft.startDate = base.startDate;
    else draft.dueDate = base.dueDate;
  }

  // People (anyone on the staff; the server adds project members as the edit form does).
  const byId = new Map(ctx.people.map((p) => [p.id, p]));
  for (const id of ex.addPeople ?? []) {
    const person = byId.get(id);
    if (person && !draft.assignees.some((a) => a.id === id)) draft.assignees.push({ id, name: person.name });
  }
  if (ex.removePeople?.length) {
    const left = draft.assignees.filter((a) => !ex.removePeople!.includes(a.id));
    if (left.length === 0) notes.push("A task needs at least one assignee, so I kept them.");
    else draft.assignees = left;
  }
  if (ex.ambiguousPeople?.length && !override) {
    const first = ex.ambiguousPeople[0]!;
    override = { ask: "changes", reply: `Which ${first.said}?`, chips: first.ids.slice(0, 6).map((id) => `add ${byId.get(id)?.name ?? ""}`) };
  }
  if (ex.soundPeople?.length && !override) override = confirmPerson(ctx, draft, ex.soundPeople[0]!, "changes");

  // Name: only tasks with the controlled name (unit + number + short name).
  if (ex.shortName || ex.unit || ex.quantity) {
    if (!base.titleParts) notes.push(`${draft.task.code} has an older free title — rename it in the task form.`);
    else {
      if (ex.shortName) draft.shortName = ex.shortName.slice(0, TASK_TITLE_LIMITS.shortNameMax);
      if (ex.unit) draft.unit = ex.unit.slice(0, TASK_TITLE_LIMITS.unitMax);
      if (ex.quantity && ex.quantity >= 1 && ex.quantity <= TASK_TITLE_LIMITS.quantityMax) draft.quantity = ex.quantity;
    }
  }

  // Brief: replace, or add on to the current one.
  if (ex.brief || ex.briefAppend) {
    draft.brief = (ex.brief ?? [draft.brief ?? base.brief, ex.briefAppend].filter(Boolean).join("\n")).slice(0, 2000);
    draft.briefTidy = null;
    draft.briefChoice = null;
  }

  if (ex.priority) draft.priority = ex.priority;
  if (ex.status) {
    if (ex.status === base.status) notes.push(`${draft.task.code} is already ${STATUS_LABEL[ex.status]}.`);
    else if (!base.moves.includes(ex.status)) notes.push(`You can't move ${draft.task.code} from ${STATUS_LABEL[base.status]} to ${STATUS_LABEL[ex.status]}.`);
    else draft.status = ex.status;
  }
  return { notes, override };
}

/** Required fields still empty, in the order they are asked. Mirrors the task form and the close dialog. */
export function missingFields(d: VoiceDraft): VoiceField[] {
  const out: VoiceField[] = [];
  if (!d.action) return ["action"];
  if (d.action === "create") {
    // A rework's project is the original task's.
    if (!d.project && d.iteration !== "rework") out.push("project");
    // Like the Add task form, the name starts from one of the project's scope items.
    if (d.project && d.iteration !== "rework" && !d.unit) out.push("unit");
    if (!d.iteration) out.push("iteration");
    if (d.iteration === "rework") {
      if (!d.reworkOf) out.push("reworkOf");
      if (!d.reworkSource) out.push("reworkSource");
      // Brief, assignees and files come from the original task when not said.
    } else {
      if (!d.unit && !out.includes("unit")) out.push("unit");
      if (!d.quantity) out.push("quantity");
      if (!d.shortName) out.push("shortName");
      if (!d.brief) out.push("brief");
      else if (!d.briefChoice) out.push("briefReview");
      if (d.assignees.length === 0) out.push("assignees");
      // Start and due date are both required for new work.
      if (!d.startDate || !d.dueDate) out.push("dates");
    }
    return out;
  }
  if (!d.task) return ["task"];
  if (d.action === "update") {
    if (d.brief && !d.briefChoice) return ["briefReview"];
    return updateChanges(d).rows.length || updateChanges(d).status ? [] : ["changes"];
  }
  if (d.action === "close") {
    if (!d.task.hasFinal && !d.finalUrl && !d.finalFile) out.push("final");
    if (!d.note) out.push("note");
    if (d.task.loggedMinutes <= 0 && !d.minutes && !(d.start && d.end)) out.push("time");
    return out;
  }
  if (!d.minutes && !(d.start && d.end)) out.push("time");
  return out;
}

async function question(
  ctx: VoiceContext,
  d: VoiceDraft,
  field: VoiceField,
  said = ""
): Promise<{ reply: string; chips: string[]; existing?: VoiceExistingTask[] }> {
  switch (field) {
    case "existing": {
      const existing = await existingTasks(ctx, d, said);
      return {
        reply: existing.length
          ? `Open tasks in ${d.project?.code ?? "this project"} — tap one to make a new task like it or to work on it, or carry on with a new name.`
          : `${d.project?.code ?? "This project"} has no open tasks — carry on with a new name.`,
        chips: [EXISTING_NONE],
        existing,
      };
    }
    case "briefReview":
      return {
        reply: d.briefTidy ? `Here's the brief tidied up:\n${briefPreview(d.briefTidy)}` : "Use the brief as you said it?",
        chips: [...(d.briefTidy ? [BRIEF_USE] : []), BRIEF_KEEP, BRIEF_EDIT],
      };
    case "dates": {
      const t = ctx.today;
      const label = (key: string) => (key === t ? `Today ${fmtShortDay(key).slice(4)}` : fmtShortDay(key));
      if (!d.startDate && !d.dueDate) {
        return {
          reply: "When does it start and when is it due?",
          chips: [
            [t, addDayKey(t, 1)],
            [t, addDayKey(t, 2)],
            [addDayKey(t, 1), addDayKey(t, 3)],
            [t, addDayKey(t, 7)],
          ].map(([a, b]) => `${label(a!)} → ${label(b!)}`),
        };
      }
      if (!d.startDate) {
        const options = [t, addDayKey(t, 1)].filter((k) => k <= d.dueDate!);
        return { reply: `When does it start? (due ${fmtDay(d.dueDate!)})`, chips: options.map(label) };
      }
      const from = d.startDate > t ? d.startDate : t;
      return {
        reply: `When is it due? (starts ${fmtDay(d.startDate)})`,
        chips: [addDayKey(from, 1), addDayKey(from, 2), addDayKey(from, 7)].map(label),
      };
    }
    case "action":
      return { reply: "I can create a task, close a task or log time. What would you like to do?", chips: ["New task", "Close a task", "Log time"] };
    case "project":
      return {
        reply: "Which project is it for?",
        chips: ctx.projects.slice(0, 6).map((p) => chip(`${p.code} · ${p.name}`)),
      };
    case "iteration":
      return { reply: "Got it. Is this new work or a rework?", chips: ["New work", "Rework"] };
    case "reworkOf":
      return { reply: "Which task is this a rework of? Say its code, like MO-6.", chips: [] };
    case "reworkSource":
      return { reply: "Whose review asked for this rework?", chips: ["Internal review", "External review"] };
    case "unit": {
      const usage = await scopeUsageOf(ctx, d.project?.id ?? null);
      // No scope on the project: the unit is free text, as in the form.
      if (!usage.length) return { reply: "Which scope unit is it? (e.g. Video, Post, Banner)", chips: [...SCOPE_UNITS].slice(0, 6) };
      return { reply: "Which scope item is this?", chips: usage.map((u) => `${u.unit} · ${Math.max(0, u.total - u.used)} of ${u.total} left`) };
    }
    case "quantity":
      return { reply: `How many ${d.unit ? d.unit.toLowerCase() : "units"}?`, chips: ["1", "2", "3"] };
    case "shortName":
      return { reply: 'What\'s the short name? For example "Launch teaser".', chips: [] };
    case "brief":
      return { reply: `What's the brief? Say what the ${d.unit ? d.unit.toLowerCase() : "task"} needs.`, chips: [] };
    case "assignees": {
      // The project team as chips, so a misheard name is one tap away.
      const project = ctx.projects.find((p) => p.id === d.project?.id);
      const byId = new Map(ctx.people.map((p) => [p.id, p.name]));
      const team = (project?.memberIds ?? []).map((id) => byId.get(id)).filter((n): n is string => Boolean(n)).slice(0, 7);
      return { reply: team.length ? "Who's doing it? Say a name or tap one." : "Who's doing it?", chips: ["Me", ...team] };
    }
    case "changes": {
      const moves = d.baseline?.moves ?? [];
      return {
        reply: `What should change on ${d.task?.code ?? "the task"}? For example "due Friday", "add Vishal", "priority high", "brief: …" or "rename to …".`,
        chips: ["due tomorrow", "priority high", ...(moves.includes("in_progress") ? ["move to in progress"] : moves.includes("todo") ? ["move back to to do"] : [])],
      };
    }
    case "task":
      return {
        reply:
          d.action === "update"
            ? "Which task should change? Say its code, like MO-6."
            : d.action === "close"
            ? "Which task are you closing? Say the task code, like MO-6."
            : "Which task is the time for? Say the task code, like MO-6.",
        chips: await taskChips(ctx, d.action === "close" ? "close" : "log_time"),
      };
    case "final":
      return { reply: "Add the final file or link: take a photo, pick a file, or say a link.", chips: [] };
    case "note":
      return { reply: "What was delivered? Say a short outcome note.", chips: [] };
    case "time":
      return {
        reply:
          d.action === "close"
            ? 'How much time did you spend? For example "2 hours" or "from 10 to 12".'
            : 'How long? For example "45 minutes" or "from 10 to 12" — I\'ll log it ending now.',
        chips: ["30 minutes", "1 hour", "2 hours"],
      };
  }
}

// ---------------------------------------------------------------------------
// Summary card
// ---------------------------------------------------------------------------

const fmtDay = (key: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${key}T00:00:00Z`)
  );
/** "Sat 24 Oct" (chips; parsed back by resolveLooseDay). */
function fmtShortDay(key: string): string {
  const d = new Date(`${key}T00:00:00Z`);
  const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" }).format(d);
  const month = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(d);
  // Another year is said ("Wed 20 Oct 2027").
  const year = key.slice(0, 4) !== appDateKey(new Date()).slice(0, 4) ? ` ${key.slice(0, 4)}` : "";
  return `${weekday} ${d.getUTCDate()} ${month}${year}`;
}
const addDayKey = (key: string, days: number) => addDays(new Date(`${key}T00:00:00Z`), days).toISOString().slice(0, 10);
const fmtClock = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: appTimeZone() }).format(new Date(iso));
export function fmtMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h && r ? `${h}h ${r}m` : h ? `${h}h` : `${r}m`;
}

function timeRow(d: VoiceDraft): string {
  if (d.start && d.end) {
    const mins = Math.round((new Date(d.end).getTime() - new Date(d.start).getTime()) / 60_000);
    const sameDay = appDateKey(new Date(d.start)) === appDateKey(new Date());
    return `${fmtMinutes(mins)}, ${sameDay ? "" : `${fmtDay(appDateKey(new Date(d.start)))} `}${fmtClock(d.start)} → ${fmtClock(d.end)}`;
  }
  if (d.minutes) {
    const end = new Date();
    return `${fmtMinutes(d.minutes)}, ending now (${fmtClock(new Date(end.getTime() - d.minutes * 60_000).toISOString())} → ${fmtClock(end.toISOString())})`;
  }
  return "";
}

/** The brief on the card: the chosen version, first 3 lines + how many more. */
function briefShort(d: VoiceDraft): string {
  const text = d.briefChoice === "tidy" && d.briefTidy ? briefPreview(d.briefTidy) : (d.brief ?? "");
  const lines = text.split("\n").filter((l) => l.trim());
  return lines.length > 3 ? `${lines.slice(0, 3).join("\n")}\n… ${lines.length - 3} more` : lines.join("\n");
}

/** What the app saves as the description: the chosen brief as simple HTML. */
function draftBriefHtml(d: VoiceDraft): string | null {
  if ((d.action !== "create" && d.action !== "update") || !d.brief) return null;
  return d.briefChoice === "tidy" && d.briefTidy ? briefHtml(d.briefTidy) : briefHtml(d.brief);
}

export interface VoiceCard {
  title: string;
  rows: Array<[string, string]>;
  confirm: string;
}

async function summaryCard(ctx: VoiceContext, d: VoiceDraft): Promise<VoiceCard | null> {
  if (d.action === "create") {
    const project = ctx.projects.find((p) => p.id === d.project?.id);
    const rows: Array<[string, string]> = [["Project", d.project?.name ?? ""]];
    if (d.iteration === "rework" && d.reworkOf) {
      const round = (await Task.countDocuments({ reworkOf: d.reworkOf.id })) + 1;
      rows.push(["Type", `Rework of ${d.reworkOf.code} · ${d.reworkSource === "external" ? "External review" : "Internal review"}`]);
      rows.push(["Task name", `${d.reworkOf.title.replace(/\s+R\d+$/, "")} R${round}`]);
      rows.push(["Brief", d.brief ?? `Same as ${d.reworkOf.code}`]);
      rows.push(["Assignees", d.assignees.length ? d.assignees.map((a) => a.name).join(", ") : `Same as ${d.reworkOf.code}`]);
    } else {
      rows.push(["Type", "New work"]);
      rows.push(["Task name", composeTaskTitle({ unit: d.unit ?? "", quantity: d.quantity ?? 1, shortName: d.shortName ?? "" })]);
      rows.push(["Brief", briefShort(d)]);
      rows.push(["Assignees", d.assignees.map((a) => a.name).join(", ")]);
    }
    if (d.startDate || d.iteration !== "rework") rows.push(["Start", d.startDate ? fmtDay(d.startDate) : "—"]);
    rows.push(["Due", d.dueDate ? fmtDay(d.dueDate) : "—"]);
    const duplicate = await duplicateOf(d);
    if (duplicate) rows.push(["Heads-up", `${duplicate.code} ${duplicate.title} already exists`]);
    // Scope use after this task (new work only; reworks don't count) — the same sum the server checks.
    if (d.iteration === "new" && project && project.scopeItems.length && d.unit && d.quantity) {
      const totals = scopeTotals(project.scopeItems as never);
      const key = d.unit.trim().toLowerCase();
      const allowed = totals.get(key)?.total ?? 0;
      const [usage] = await Task.aggregate<{ used: number }>([
        {
          $match: {
            project: new mongoose.Types.ObjectId(project.id),
            iteration: { $ne: "rework" },
            "overScope.status": { $ne: "rejected" },
            "titleParts.unit": { $regex: `^${escapeRe(key)}$`, $options: "i" },
          },
        },
        { $group: { _id: null, used: { $sum: "$titleParts.quantity" } } },
      ]);
      const after = (usage?.used ?? 0) + d.quantity;
      rows.push([
        "Scope",
        after > allowed
          ? `${d.unit} · ${after} / ${allowed} — over the approved scope; it waits for an admin's approval`
          : `${d.unit} · ${after} / ${allowed} used after this`,
      ]);
    }
    return { title: d.iteration === "rework" ? "New rework" : "New task", rows, confirm: "Create task" };
  }
  if (!d.task) return null;
  const taskRow = `${d.task.code} · ${d.task.title}`;
  if (d.action === "update") {
    return { title: "Update task", rows: [["Task", taskRow], ...updateChanges(d).rows], confirm: "Update task" };
  }
  if (d.action === "close") {
    const rows: Array<[string, string]> = [["Task", taskRow]];
    rows.push([
      "Final",
      d.finalFile
        ? `${d.finalFile.name} (${d.finalFile.size >= 1024 * 1024 ? `${(d.finalFile.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(d.finalFile.size / 1024))} KB`})`
        : d.finalUrl ?? "Already recorded on the task",
    ]);
    rows.push(["Note", d.note ?? ""]);
    rows.push(["Time", timeRow(d) || `Already logged: ${fmtMinutes(d.task.loggedMinutes)}`]);
    rows.push(["Review", d.task.direct ? "Not needed — completed straight away" : `Goes to ${d.task.reviewer ?? "the creator"} for review`]);
    return { title: "Close task", rows, confirm: "Close task" };
  }
  const rows: Array<[string, string]> = [["Task", taskRow], ["Time", timeRow(d)]];
  if (d.note) rows.push(["Memo", d.note]);
  return { title: "Log time", rows, confirm: "Log time" };
}

// ---------------------------------------------------------------------------
// One turn of the conversation
// ---------------------------------------------------------------------------

export interface VoiceUnderstandResult {
  reply: string;
  chips: string[];
  draft: VoiceDraft;
  action: "create" | "rework" | "close" | "log_time" | "update" | "none";
  missing: VoiceField[];
  ready: boolean;
  /** The field being asked for ("final" = show the photo / file / link choices). */
  ask: VoiceField | null;
  card: VoiceCard | null;
  /** ask = "existing": the project's tasks to pick from. */
  existing?: VoiceExistingTask[];
  /** True when the AI read the message (false = the rules-based fallback). */
  ai: boolean;
}

const KEEP_AS_IT_WAS = "Keep it as it was";
const KEEP_WORKING = "Keep working on it";
const START_NEW = "Start a new one";
const SOMEONE_ELSE = "Someone else";

/** "the new task Reel 1 – Video Edit Task", "closing EO26-5" … */
function draftLabel(d: VoiceDraft): string {
  if (d.action === "create") {
    const name = d.unit && d.shortName ? composeTaskTitle({ unit: d.unit, quantity: d.quantity ?? 1, shortName: d.shortName }) : null;
    return name ? `the new task ${name}` : d.project ? `the new task in ${d.project.code}` : "the new task";
  }
  const code = d.task?.code ?? "the task";
  return d.action === "close" ? `closing ${code}` : d.action === "log_time" ? `logging time on ${code}` : `updating ${code}`;
}

/** "Nasir" sounds like Nazeer: ask, with up to 3 people (project team first) and "Someone else". */
function confirmPerson(ctx: VoiceContext, d: VoiceDraft, heard: { said: string; ids: string[] }, ask: VoiceField): NonNullable<Turn["override"]> {
  const project = ctx.projects.find((p) => p.id === (d.project?.id ?? d.task?.projectId));
  const byId = new Map(ctx.people.map((p) => [p.id, p.name]));
  const ids = [...heard.ids].sort((a, b) => Number(project?.memberIds.includes(b) ?? false) - Number(project?.memberIds.includes(a) ?? false)).slice(0, 3);
  const names = ids.map((id) => byId.get(id)).filter((n): n is string => Boolean(n));
  const prefix = ask === "changes" ? "add " : "";
  return {
    ask,
    reply: names.length === 1 ? `Did you mean ${names[0]}?` : `"${heard.said}" — did you mean one of these?`,
    chips: [...names.map((n) => prefix + n), SOMEONE_ELSE],
  };
}

/** Projects whose name or brand shares a word with the text ("home service" → the Homes R Us projects). */
function projectCandidates(ctx: VoiceContext, text: string): string[] {
  const stop = new Set(["create", "task", "tasks", "start", "date", "today", "tomorrow", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "with", "that", "this", "from", "doing", "brief", "video", "edit", "post", "reel", "static", "story"]);
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4 && !stop.has(w) && !COMMON_WORDS.has(w));
  const scored = ctx.projects
    .map((p) => {
      const pw = `${p.name} ${p.brand}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4);
      const hits = words.filter((w) => pw.some((x) => x.slice(0, 4) === w.slice(0, 4))).length;
      return { id: p.id, hits };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  const top = scored[0]?.hits ?? 0;
  return scored.filter((x) => x.hits === top).slice(0, 6).map((x) => x.id);
}

/**
 * A tidied brief keeps only what the person said: every number, link, date or
 * duration in a bullet must be in their words, and most of its words too.
 */
function verifyTidy(tidy: TidyBrief, source: string): TidyBrief | null {
  const said = normalizeNumbers(source).toLowerCase();
  const facts = (s: string) => [
    ...normalizeNumbers(s).toLowerCase().matchAll(/https?:\/\/\S+|www\.\S+|\b[a-z0-9-]+\.(?:com|net|org|ae|io|co)\b|\d+(?:[.:x×]\d+)*|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(?:seconds?|minutes?|hours?|days?|weeks?|months?)\b/g),
  ].map((m) => m[0].replace(/[.,;)]+$/, ""));
  // A label ("Size / duration: …") isn't a fact: only what follows it is checked.
  const ok = (line: string) => {
    const body = line.replace(/^[^:]{1,30}:\s*/, "");
    return facts(body).every((f) => said.includes(f.replace(/s$/, ""))) && grounded(body, source);
  };
  const bullets = tidy.bullets.filter(ok);
  const objective = ok(tidy.objective) ? tidy.objective : (source.split(/(?<=[.!?])\s+/)[0] ?? source).trim();
  return bullets.length ? { objective, bullets } : null;
}

/** The chips and other short fixed replies — read by the rules, never sent to the model. */
const QUICK_REPLY =
  /^(?:new task|close a task|log time|close it|update it|keep working on it|start a new one|someone else|new work|rework|internal review|external review|me|keep it as it was|none — new name|\d+ (?:minutes?|hours?)|due tomorrow|priority (?:low|medium|high|urgent)|move to in progress|move back to to do|(?:due|start|add|remove) [\p{L} ]{2,30}|[^→]{2,40}→[^→]{2,40})$/iu;

/** Whether most of a value's words (4+ letters) were in the person's message (guards against invented text). */
function grounded(value: string, said: string): boolean {
  const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4);
  const v = words(value);
  if (v.length === 0) return true;
  const s = new Set(words(said));
  const hits = v.filter((w) => s.has(w) || [...s].some((x) => x.startsWith(w.slice(0, 5)) || w.startsWith(x.slice(0, 5)))).length;
  return hits / v.length >= 0.5;
}
const capWord = (w: string) => (w ? w[0]!.toUpperCase() + w.slice(1) : w);

/** What a change message did to a ready draft, in words ("due moved to Fri 30 Oct", "added Vishal"). */
function changesBetween(a: VoiceDraft, b: VoiceDraft): string[] {
  const out: string[] = [];
  const name = (d: VoiceDraft) => (d.unit && d.quantity && d.shortName ? composeTaskTitle({ unit: d.unit, quantity: d.quantity, shortName: d.shortName }) : "");
  if (b.project && a.project?.id !== b.project.id) out.push(`project ${b.project.code}`);
  if (name(b) && name(a) !== name(b)) out.push(`name ${name(b)}`);
  if (b.reworkOf && a.reworkOf?.id !== b.reworkOf.id) out.push(`rework of ${b.reworkOf.code}`);
  if (b.reworkSource && a.reworkSource !== b.reworkSource) out.push(`${b.reworkSource} review`);
  if (b.startDate && a.startDate !== b.startDate) out.push(`start moved to ${fmtShortDay(b.startDate)}`);
  if (b.dueDate && a.dueDate !== b.dueDate) out.push(`due moved to ${fmtShortDay(b.dueDate)}`);
  const first = (n: string) => n.split(" ")[0];
  const added = b.assignees.filter((x) => !a.assignees.some((y) => y.id === x.id));
  const removed = a.assignees.filter((x) => !b.assignees.some((y) => y.id === x.id));
  if (added.length) out.push(`added ${added.map((x) => first(x.name)).join(" and ")}`);
  if (removed.length) out.push(`removed ${removed.map((x) => first(x.name)).join(" and ")}`);
  if (a.brief !== b.brief || a.briefChoice !== b.briefChoice) out.push("brief updated");
  if (b.task && a.task?.id !== b.task.id) out.push(`task ${b.task.code}`);
  if (a.minutes !== b.minutes || a.start !== b.start || a.end !== b.end) {
    const t = timeRow(b);
    if (t) out.push(`time ${t.split(",")[0]}`);
  }
  if (b.note && a.note !== b.note) out.push(b.action === "log_time" ? "memo updated" : "note updated");
  if (b.finalUrl && a.finalUrl !== b.finalUrl) out.push("link updated");
  if (b.finalFile && a.finalFile?.name !== b.finalFile.name) out.push(`file ${b.finalFile.name}`);
  if (b.priority && a.priority !== b.priority && b.action === "update") out.push(`priority ${b.priority}`);
  if (b.status && a.status !== b.status) out.push(`status ${STATUS_LABEL[b.status]}`);
  return out;
}

/**
 * Likely fixes for the parts that changed nothing — only where the message looks
 * like a date or a people change: a near weekday after "due / start / by"
 * ("due Friday"), a near first name after "add / remove / assign / for / with /
 * and / plus" ("add Vishal"). Ordinary words are never offered as names.
 */
function suggestFixes(ctx: VoiceContext, text: string, d: VoiceDraft): string[] {
  if (d.action !== "create") return [];
  const out: string[] = [];
  const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "tomorrow", "today"];
  const plain = text.toLowerCase().replace(/["“][^"”]*["”]/g, " ");
  for (const m of plain.matchAll(/\b(due|start|starts|by)\s+(?:on\s+)?(\p{L}+)/gu)) {
    const day = days.find((x) => editDistance(m[2]!, x) <= 2);
    if (day) out.push(`${m[1] === "start" || m[1] === "starts" ? "start" : "due"} ${capWord(day)}`);
  }
  const firsts = new Map<string, string>();
  for (const p of ctx.people) {
    const f = p.name.split(" ")[0]!;
    if (f.length >= 3) firsts.set(f.toLowerCase(), f);
  }
  for (const m of plain.matchAll(/\b(add|remove|without|assign(?:ed)?\s+to|for|with|and|plus)\s+(\p{L}+)/gu)) {
    const word = m[2]!;
    if (word.length < 3 || COMMON_WORDS.has(word)) continue;
    // Short words: one letter off at most; longer: two. Same first letter.
    const max = word.length <= 4 ? 1 : 2;
    let best: string | null = null;
    let bestD = max + 1;
    for (const [lower, f] of firsts) {
      if (lower[0] !== word[0]) continue;
      const dist = editDistance(word, lower);
      if (dist < bestD) {
        bestD = dist;
        best = f;
      }
    }
    if (!best) continue;
    const removing = /^(?:remove|without)$/.test(m[1]!);
    const onTask = d.assignees.some((a) => a.name.split(" ")[0] === best);
    if (removing ? onTask : !onTask) out.push(`${removing ? "remove" : "add"} ${best}`);
  }
  return [...new Set(out)].slice(0, 3);
}

/** Parts of a change that were understood but already in the draft ("Vishal is already on it"). */
function alreadySet(d: VoiceDraft, ex: Extracted): string[] {
  const out: string[] = [];
  const on = (ex.addPeople ?? []).map((id) => d.assignees.find((a) => a.id === id)).filter((a): a is { id: string; name: string } => Boolean(a));
  if (on.length) out.push(`${on.map((a) => a.name.split(" ")[0]).join(" and ")} ${on.length === 1 ? "is" : "are"} already on it`);
  if (ex.dueDate && ex.dueDate === d.dueDate) out.push(`it's already due ${fmtShortDay(ex.dueDate)}`);
  if (ex.startDate && ex.startDate === d.startDate) out.push(`it already starts ${fmtShortDay(ex.startDate)}`);
  return out.map((s, i) => (i === 0 ? capWord(s) : s));
}

const USE_AS_BRIEF = "Use as brief";
const ADD_TO_BRIEF = "Add to brief";
const USE_AS_NOTE = "Use as note";
const USE_AS_MEMO = "Use as memo";

/** "Use as brief" / "Add to brief" / "Use as note|memo": the person's previous message is the text. */
function useAsField(draft: VoiceDraft, last: string, messages: Array<{ role: string; text: string }>): VoiceDraft | null {
  const t = last.trim();
  if (![USE_AS_BRIEF, ADD_TO_BRIEF, USE_AS_NOTE, USE_AS_MEMO].includes(t)) return null;
  const users = messages.filter((m) => m.role === "user");
  const previous = users[users.length - 2]?.text.trim();
  if (!previous) return null;
  if (draft.action === "create" && (t === USE_AS_BRIEF || t === ADD_TO_BRIEF)) {
    const brief = (t === ADD_TO_BRIEF && draft.brief ? `${draft.brief}\n${previous}` : previous).slice(0, 2000);
    return { ...draft, brief, briefTidy: null, briefChoice: null };
  }
  if ((draft.action === "close" && t === USE_AS_NOTE) || (draft.action === "log_time" && t === USE_AS_MEMO)) {
    return { ...draft, note: previous.slice(0, draft.action === "log_time" ? 500 : 2000) };
  }
  return null;
}

/** Taps on the existing-task list and the brief choices — handled without reading the words. */
async function choiceTurn(
  ctx: VoiceContext,
  draft: VoiceDraft,
  text: string
): Promise<{ draft: VoiceDraft; notes: string[]; reply?: string; chips?: string[]; existing?: VoiceExistingTask[] } | null> {
  const t = text.trim();
  // A scope chip: that unit, numbered next (unless a number was said before).
  const scope = SCOPE_CHIP.exec(t);
  if (scope && draft.action === "create" && draft.project) {
    const units = ctx.projects.find((p) => p.id === draft.project!.id)?.units ?? [];
    const unit = units.find((u) => u.toLowerCase() === scope[1]!.trim().toLowerCase());
    if (unit) {
      const next = { ...draft, unit, quantity: draft.quantity ?? (await nextNumber(ctx, draft.project.id, unit)) };
      return { draft: next, notes: [] };
    }
  }
  if (t === EXISTING_CHIP && draft.action === "create" && draft.project) {
    const next = { ...draft, existingFor: draft.project.id };
    const q = await question(ctx, next, "existing", "");
    next.asking = "existing";
    return { draft: next, notes: [], reply: q.reply, chips: q.chips, existing: q.existing };
  }
  if (draft.asking === "existing" || /^(?:new task like|work on)\s+\S+$/i.test(t)) {
    const like = /^new task like\s+(\S+)$/i.exec(t);
    if (like) {
      const copied = await copyFromTask(ctx, draft, like[1]!);
      return { draft: copied.draft, notes: [copied.note] };
    }
    const work = /^work on\s+(\S+)$/i.exec(t);
    if (work) {
      const task = await projectTaskByCode(ctx, work[1]!);
      if (!task) return { draft, notes: [`I couldn't find ${work[1]}.`] };
      const next = emptyDraft();
      next.focusTaskId = String(task._id);
      return {
        draft: next,
        notes: [],
        reply: `OK — ${task.shortCode ?? `#${task.number}`} · ${task.title} (${STATUS_LABEL[task.status] ?? task.status}). Close it, log time or update it?`,
        chips: ["Close it", "Log time", "Update it"],
      };
    }
    if (draft.asking === "existing" && draft.project && (t === EXISTING_NONE || /^none\b/i.test(t))) {
      return { draft: { ...draft, existingFor: draft.project.id }, notes: [] };
    }
  }
  if (draft.asking === "briefReview") {
    if (t === BRIEF_USE || /^use (?:the )?tid/i.test(t)) return { draft: { ...draft, briefChoice: draft.briefTidy ? "tidy" : "plain" }, notes: [] };
    if (t === BRIEF_KEEP || /^keep\b/i.test(t)) return { draft: { ...draft, briefChoice: "plain" }, notes: [] };
    if (t === BRIEF_EDIT || /^edit\b/i.test(t)) {
      return {
        draft: { ...draft, brief: null, briefTidy: null, briefChoice: null, asking: "brief" },
        notes: [],
        reply: "Say the brief again — what needs to be done, how many, sizes, languages, links.",
        chips: [],
      };
    }
  }
  return null;
}

export async function understand(
  user: IUser,
  messages: Array<{ role: "user" | "assistant"; text: string }>,
  rawDraft: unknown,
  contextTaskId: string | null
): Promise<VoiceUnderstandResult> {
  if (isGuestUser(user)) throw new Error("Guests can't use the voice assistant");
  const ctx = await loadVoiceContext(user);
  let draft = await sanitizeDraft(ctx, rawDraft);
  const last = [...messages].reverse().find((m) => m.role === "user")?.text ?? "";
  // The card was showing: this message is a change to it.
  const wasReady = draft.action !== null && draft.asking === null && missingFields(draft).length === 0;
  // applyExtracted changes the draft in place: keep a copy to compare with.
  const before = JSON.parse(JSON.stringify(draft)) as VoiceDraft;
  const nameBefore = [draft.unit, draft.quantity, draft.shortName].join("|");
  const done = (next: VoiceDraft, result: Omit<VoiceUnderstandResult, "draft">): VoiceUnderstandResult => {
    next.briefHtml = draftBriefHtml(next);
    const update = next.action === "update" ? updateChanges(next) : null;
    next.updatePatch = update && Object.keys(update.patch).length ? update.patch : null;
    next.updateStatus = update?.status ?? null;
    return { ...result, draft: next };
  };
  const actionOf = (d: VoiceDraft): VoiceUnderstandResult["action"] =>
    d.action === "create" ? (d.iteration === "rework" ? "rework" : "create") : (d.action ?? "none");

  let ex: Extracted = {};
  let ai = false;
  let notes: string[] = [];
  let next: VoiceDraft;
  let override: Turn["override"];
  // "Keep working on it" / "Start a new one" after another action was asked for mid-draft.
  if (last.trim() === KEEP_WORKING && draft.action) {
    const missing = missingFields(draft);
    if (missing.length) {
      const q = await question(ctx, draft, missing[0]!, "");
      draft.asking = missing[0]!;
      return done(draft, { reply: `OK, back to ${draftLabel(draft)}. ${q.reply}`, chips: q.chips, action: actionOf(draft), missing, ready: false, ask: draft.asking, card: null, ai: false });
    }
    draft.asking = null;
    return done(draft, { reply: `OK, back to ${draftLabel(draft)}. Check and confirm.`, chips: [], action: actionOf(draft), missing, ready: true, ask: null, card: await summaryCard(ctx, draft), ai: false });
  }
  if (last.trim() === START_NEW) {
    // The request that was waiting is read again on a fresh draft.
    const users = messages.filter((m) => m.role === "user");
    const previous = users[users.length - 2]?.text ?? "";
    return understand(user, [...messages.slice(0, -1).filter((m) => m.text !== START_NEW), { role: "user", text: previous }], null, contextTaskId);
  }
  // "Use as brief" / "Add to brief" / "Use as note|memo" after an unclear change.
  const usedAs = wasReady ? useAsField(draft, last, messages) : null;
  const choice = usedAs
    ? { draft: usedAs, notes: [`Changed: ${changesBetween(before, usedAs).join(" · ") || "nothing"}.`] }
    : last.trim()
      ? await choiceTurn(ctx, draft, last)
      : null;
  if (choice?.reply) {
    const asking = choice.draft.asking === "brief" || choice.draft.asking === "existing" ? choice.draft.asking : null;
    choice.draft.asking = asking;
    return done(choice.draft, {
      reply: choice.reply,
      chips: choice.chips ?? [],
      ...(choice.existing?.length ? { existing: choice.existing } : {}),
      action: actionOf(choice.draft),
      missing: missingFields(choice.draft),
      ready: false,
      ask: asking,
      card: null,
      ai,
    });
  }
  if (choice) {
    next = choice.draft;
    notes = choice.notes;
  } else {
    // Anything said instead of picking from the list carries on with a new task.
    if (draft.asking === "existing" && draft.project) draft = { ...draft, existingFor: draft.project.id };
    if (last.trim()) {
      // Quick replies (the chips) are read by the rules: nothing for the model to guess about.
      if (voiceConfigured() && !QUICK_REPLY.test(last.trim())) {
        try {
          ex = await aiExtract(ctx, messages, draft);
          ai = true;
        } catch (err) {
          console.error("[voice] AI reading failed, using the rules", err instanceof Error ? err.message : err);
        }
      }
      if (!ai) {
        // FALLBACK: the rules-based parser (no OPENAI_API_KEY, or the model failed).
        ex = parseVoiceText(last, {
          asking: draft.asking,
          action: draft.action,
          today: ctx.today,
          projects: ctx.projects,
          people: ctx.people,
          me: String(user._id),
          units: allUnits(ctx),
          codes: ctx.codes,
          keepShortName: Boolean(draft.shortName),
        });
      }
    }
    // Free text from the model must come from what the person said: a value whose words mostly
    // aren't in the latest message (a repeated brief, or an invented one) is dropped.
    if (ai) {
      for (const field of ["brief", "briefAppend", "note", "shortName"] as const) {
        const value = ex[field];
        if (value && !grounded(value, last)) delete ex[field];
      }
      // A brief only when one was asked for or said as one ("the brief is …") — "the video edit
      // task" is a name hint, not a brief.
      const briefSaid = /\bbrief\b|\binstructions?\b/i.test(last) || draft.asking === "brief" || draft.asking === "briefReview" || draft.asking === "changes";
      if (!briefSaid) {
        delete ex.brief;
        delete ex.briefAppend;
      }
      // "update / change the brief … the brief is X" replaces it, "add to the brief …" adds — the words decide, not the model.
      const edit = fieldEdit(last);
      if (edit?.field === "brief" && (draft.action === "create" || draft.action === "update")) {
        ex.brief = edit.value.charAt(0).toUpperCase() + edit.value.slice(1);
        delete ex.briefAppend;
      } else if (edit?.field === "briefAppend") {
        ex.briefAppend = edit.value;
        delete ex.brief;
      }
      // Several projects fit the words and no code was said: ask, never pick one silently.
      if (ex.projectIds?.length === 1) {
        const picked = ctx.projects.find((p) => p.id === ex.projectIds![0]);
        const named = picked && (new RegExp(`(?:^|[^a-z0-9])${escapeRe(picked.code.toLowerCase())}(?![a-z0-9])`).test(last.toLowerCase()) || last.toLowerCase().includes(picked.name.toLowerCase()));
        if (draft.project && !named) delete ex.projectIds;
        else if (!named) {
          const candidates = projectCandidates(ctx, last);
          if (candidates.length > 1) ex.projectIds = [...new Set([ex.projectIds[0]!, ...candidates])].slice(0, 6);
        }
      }
    }
    // A project already chosen isn't changed by a repeat of the same words.
    if (draft.project && ex.projectIds && ex.projectIds.length > 1 && ex.projectIds.includes(draft.project.id)) delete ex.projectIds;
    // The model sometimes repeats values already in the draft: those aren't changes.
    if (ex.brief && draft.brief && ex.brief.trim() === draft.brief.trim()) delete ex.brief;
    if (ex.shortName && draft.shortName && ex.shortName.trim() === draft.shortName.trim()) delete ex.shortName;
    // "Work on this task" → "close it" / "log time" use that task.
    const taskContext = draft.focusTaskId ?? (contextTaskId && mongoose.isValidObjectId(contextTaskId) ? contextTaskId : null);
    const turn = await applyExtracted(ctx, draft, ex, taskContext, last);
    if (turn.switching) {
      return done(draft, {
        reply: `Keep working on ${draftLabel(draft)}, or start something else?`,
        chips: [KEEP_WORKING, START_NEW],
        action: actionOf(draft),
        missing: missingFields(draft),
        ready: false,
        ask: draft.asking,
        card: null,
        ai,
      });
    }
    if (turn.final) {
      const cleared = turn.draft;
      cleared.asking = null;
      const q = !cleared.action ? await question(ctx, cleared, "action") : null;
      return done(cleared, {
        reply: turn.final,
        chips: q?.chips ?? [],
        action: actionOf(cleared),
        missing: missingFields(cleared),
        ready: false,
        ask: null,
        card: null,
        ai,
      });
    }
    next = turn.draft;
    notes = turn.notes;
    override = turn.override;

    // A change asked for on a ready card: say what changed — or that nothing did (never the same card silently).
    if (wasReady && !override && next.action === before.action) {
      const changes = changesBetween(before, next);
      const fixes = (ex.fixes ?? []).map(([said, read]) => `"${said}" as ${capWord(read)}`);
      if (changes.length) {
        notes.unshift(`Changed: ${changes.join(" · ")}.${fixes.length ? ` (I read ${fixes.join(", ")}.)` : ""}`);
      } else if (/^keep it as it was$/i.test(last.trim())) {
        notes.unshift("No changes.");
      } else if (/\b(?:existing|new task|this task|the one we(?:'re| are) creating)\b/i.test(last)) {
        // "not the existing task" — the draft stays as it is.
        notes.unshift(`OK — this stays ${draftLabel(next)}; nothing else changed. Say what to change, or tap ${next.action === "create" ? "Create task" : "the button"}.`);
      } else if (alreadySet(before, ex).length) {
        // Understood, but it was already so ("add Vishal" when Vishal is on it).
        notes.unshift(`${alreadySet(before, ex).join(" · ")} — nothing to change.`);
      } else {
        const suggestions = suggestFixes(ctx, last, next);
        next.asking = null;
        // Long free text with no command: maybe it's the brief / note / memo.
        if (!suggestions.length && last.trim().split(/\s+/).length >= 5) {
          const field = next.action === "create" ? "brief" : next.action === "close" ? "outcome note" : "memo";
          return done(next, {
            reply: `${notes.length ? `${notes.join(" ")} ` : ""}Is this the new ${field}?`,
            chips:
              next.action === "create"
                ? [USE_AS_BRIEF, ADD_TO_BRIEF, KEEP_AS_IT_WAS]
                : [next.action === "close" ? USE_AS_NOTE : USE_AS_MEMO, KEEP_AS_IT_WAS],
            action: actionOf(next),
            missing: [],
            ready: false,
            ask: null,
            card: null,
            ai,
          });
        }
        return done(next, {
          reply: `${notes.length ? `${notes.join(" ")} ` : ""}I couldn't change anything from "${last.trim().slice(0, 80)}".${
            suggestions.length ? ` Did you mean ${suggestions.map((s) => `"${s}"`).join(" or ")}?` : ""
          } You can say "due Friday", "start tomorrow", "add Vishal" or "remove Izzat".`,
          chips: [...suggestions, KEEP_AS_IT_WAS],
          action: actionOf(next),
          missing: [],
          ready: false,
          ask: null,
          card: null,
          ai,
        });
      }
    }
  }

  // A new brief is offered tidied (AI rewrite, or the rules); nothing to tidy → kept as said.
  if ((next.action === "update" || (next.action === "create" && next.iteration !== "rework")) && next.brief && !next.briefChoice && !next.briefTidy) {
    // Only facts from the person's own words survive; nothing left → no tidy offer.
    const tidy = verifyTidy(await tidyBrief(ctx, next.brief, next.project?.name ?? null), next.brief);
    if (!tidy) next.briefChoice = "plain";
    else next.briefTidy = tidy;
  }
  // Say so before a duplicate is made (when the name becomes complete or changes).
  const nameAfter = [next.unit, next.quantity, next.shortName].join("|");
  if (nameAfter !== nameBefore) {
    const duplicate = await duplicateOf(next);
    if (duplicate) notes.push(`${duplicate.code} ${duplicate.title} already exists — say another number or name, or "work on ${duplicate.code}".`);
  }

  const action = actionOf(next);
  const prefix = notes.length ? `${notes.join(" ")} ` : "";
  if (override) {
    next.asking = override.ask;
    return done(next, { reply: prefix + override.reply, chips: override.chips, action, missing: missingFields(next), ready: false, ask: override.ask, card: null, ai });
  }
  let missing = missingFields(next);
  let q: Awaited<ReturnType<typeof question>> | null = null;
  if (missing[0] === "existing") {
    q = await question(ctx, next, "existing", last);
    // A project without tasks has nothing to pick from.
    if (!q.existing?.length) {
      next.existingFor = next.project?.id ?? null;
      missing = missingFields(next);
      q = null;
    }
  }
  if (missing.length) {
    const ask = missing[0]!;
    q ??= await question(ctx, next, ask, last);
    next.asking = ask;
    // Once the scope item is known, working on an existing task is offered once, as a side option.
    if (next.action === "create" && next.iteration !== "rework" && next.project && next.unit && next.existingFor !== next.project.id && ask !== "existing") {
      q = { ...q, chips: [...q.chips, EXISTING_CHIP] };
      next.existingFor = next.project.id;
    }
    return done(next, {
      reply: prefix + q.reply,
      chips: q.chips,
      action,
      missing,
      ready: false,
      ask,
      card: null,
      ...(q.existing?.length ? { existing: q.existing } : {}),
      ai,
    });
  }
  next.asking = null;
  const card = await summaryCard(ctx, next);
  return done(next, {
    reply: `${prefix}Check and confirm — nothing is saved until you tap ${card?.confirm ?? "confirm"}.`,
    chips: [],
    action,
    missing: [],
    ready: true,
    ask: null,
    card,
    ai,
  });
}

// ---------------------------------------------------------------------------
// Speech-to-text
// ---------------------------------------------------------------------------

/** The user's words for the transcription prompt: brands, codes, units, team first names (≤ ~800 chars). */
export async function speechPrompt(user: IUser): Promise<string> {
  const ctx = await loadVoiceContext(user);
  const byId = new Map(ctx.people.map((p) => [p.id, p.name]));
  const words: string[] = [];
  const add = (w: string) => {
    const t = w.trim();
    if (t && !words.includes(t)) words.push(t);
  };
  const mine = ctx.projects.filter((p) => p.mine);
  for (const p of mine.length ? mine : ctx.projects.slice(0, 20)) {
    if (p.brand) add(p.brand);
    add(p.code);
  }
  for (const u of allUnits(ctx)) add(u);
  // Full names, so speech-to-text spells them as the app does ("Nazeer", not "Nasir").
  for (const p of mine) for (const id of p.memberIds) add(byId.get(id) ?? "");
  let prompt = "";
  for (const w of words) {
    if (prompt.length + w.length + 2 > 800) break;
    prompt += prompt ? `, ${w}` : w;
  }
  return prompt;
}

const EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/aac": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "video/webm": "webm",
  "video/mp4": "mp4",
};

export function audioExtension(mime: string): string | null {
  return EXTENSIONS[mime.split(";")[0]!.trim().toLowerCase()] ?? null;
}

/** Sends the recording to OpenAI speech-to-text; returns the text. Nothing is stored. */
export async function transcribe(audio: Buffer, mime: string, prompt: string): Promise<string> {
  const ext = audioExtension(mime) ?? "webm";
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mime.split(";")[0] }), `voice-note.${ext}`);
  form.append("model", process.env.VOICE_STT_MODEL?.trim() || "gpt-4o-mini-transcribe");
  form.append("response_format", "json");
  if (prompt) form.append("prompt", prompt);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STT_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY!.trim()}` },
      body: form,
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const json = (await res.json()) as { text?: unknown };
    return typeof json.text === "string" ? json.text.trim() : "";
  } finally {
    clearTimeout(timer);
  }
}
