import mongoose from "mongoose";
import { Brand } from "../models/Brand.js";
import { Project, type IProject } from "../models/Project.js";
import { completedStatusIds } from "../models/ProjectStatus.js";
import { Task } from "../models/Task.js";
import { TaskLabel } from "../models/TaskLabel.js";
import { User, type IUser } from "../models/User.js";
import { canCreateBrand } from "./brandAccess.js";
import { notifyUsersAsync } from "./notifications.js";
import { canViewRates, projectLink } from "./projectAccess.js";
import { projectApproverIds } from "./projectApproval.js";

// ---------------------------------------------------------------------------
// Pitch plan (Brands → Pitch plan): one row per Pitch project with an automatic
// status read from its three tasks (Milestone 1 meeting → Milestone 2 meeting →
// Client presentation, ordered by date), and the hourly missed-date check that
// emails the leads, the manager and leadership once per step per due date
// (`pitch.missedNotified` is the idempotency record).
// ---------------------------------------------------------------------------

/**
 * The pitch's steps, in their tie-break order; each is a task of that title
 * (created with the project). `aliases` are the titles used before Oct 2026.
 */
export const PITCH_STEPS = [
  { key: "milestone1", title: "Milestone 1 meeting", aliases: ["Milestone 1"], internal: true },
  { key: "milestone2", title: "Milestone 2 meeting", aliases: ["Milestone 2"], internal: true },
  { key: "clientPresentation", title: "Client presentation", aliases: [], internal: false },
] as const;
export type PitchStepKey = (typeof PITCH_STEPS)[number]["key"];

/** Every task title (current and old) → its step. */
export const PITCH_STEP_BY_TITLE: ReadonlyMap<string, PitchStepKey> = new Map(
  PITCH_STEPS.flatMap((s) => [[s.title, s.key] as const, ...s.aliases.map((a) => [a, s.key] as const)])
);
const ALL_TITLES = [...PITCH_STEP_BY_TITLE.keys()];

/** The label the milestone meeting tasks carry (created on first use). */
export const INTERNAL_MEETING_LABEL = "Internal meeting";

export async function internalMeetingLabelId(): Promise<mongoose.Types.ObjectId> {
  const label = await TaskLabel.findOneAndUpdate(
    { name: INTERNAL_MEETING_LABEL },
    { $setOnInsert: { name: INTERNAL_MEETING_LABEL, color: "chart-3", description: "Internal pitch meeting (Milestone 1 / 2)" } },
    { upsert: true, returnDocument: "after" }
  );
  return label!._id as mongoose.Types.ObjectId;
}

/** "Today" for pitch dates is the Dubai calendar date. */
export const PITCH_TIMEZONE = "Asia/Dubai";
const dubaiKey = new Intl.DateTimeFormat("en-CA", { timeZone: PITCH_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });
export const pitchToday = (now: Date = new Date()) => dubaiKey.format(now);

export interface PitchStep {
  key: PitchStepKey;
  title: string;
  /** "YYYY-MM-DD" (task due date, else the project's pitch date); null = not scheduled. */
  due: string | null;
  done: boolean;
  taskId: string | null;
  assignees: string[];
  /** A missed-date email went out for this due date. */
  notified: boolean;
}

export type PitchTone = "ok" | "soon" | "missed" | "done" | "none";

export interface PitchStatus {
  text: string;
  tone: PitchTone;
  next?: { key: PitchStepKey; title: string; due: string | null };
  missed: Array<{ key: PitchStepKey; title: string; due: string; emailed: boolean }>;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-20" → "20 Oct 2026" (the one date format of the Pitch plan, its Excel and emails). */
export function pitchDate(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return `${d} ${MONTHS[m! - 1]} ${y}`;
}

const dateKey = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Steps in the order they happen: by due date; ties and undated steps in M1 → M2 → CP order. */
export function orderSteps(steps: PitchStep[]): PitchStep[] {
  const fixed = (s: PitchStep) => PITCH_STEPS.findIndex((p) => p.key === s.key);
  return [...steps].sort((a, b) => {
    if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
    if (a.due && !b.due) return -1;
    if (!a.due && b.due) return 1;
    return fixed(a) - fixed(b);
  });
}

const doneLabel = (s: PitchStep) => (s.key === "clientPresentation" ? `Presented${s.due ? ` ${pitchDate(s.due)}` : ""}` : `${s.title} held`);

/** The automatic status line from the steps (only steps with a task or a date count). */
export function pitchStatus(allSteps: PitchStep[], today: string): PitchStatus {
  const steps = orderSteps(allSteps.filter((s) => s.taskId || s.due));
  if (!steps.some((s) => s.due) && !steps.some((s) => s.done)) {
    return { text: "No pitch dates yet — add them to start tracking", tone: "none", missed: [] };
  }
  if (steps.every((s) => s.done)) {
    const cp = steps.find((s) => s.key === "clientPresentation");
    return { text: cp ? `${doneLabel(cp)} — all milestones done` : "All milestones done", tone: "done", missed: [] };
  }

  const nextStep = steps.find((s) => !s.done)!;
  const next = { key: nextStep.key, title: nextStep.title, due: nextStep.due };
  const missed = steps
    .filter((s) => !s.done && s.due && s.due < today)
    .map((s) => ({ key: s.key, title: s.title, due: s.due!, emailed: s.notified }));
  if (missed.length) {
    const text = missed.map((m) => `${m.title} missed (${pitchDate(m.due)}) — ${m.emailed ? "email sent" : "email pending"}`).join("; ");
    return { text, tone: "missed", next, missed };
  }

  const lastDone = [...steps].reverse().find((s) => s.done);
  const when = nextStep.due ? pitchDate(nextStep.due) : "— no date yet";
  const text = `${lastDone ? `${doneLabel(lastDone)} — ` : ""}${nextStep.title} ${when}`;
  const soon = nextStep.due !== null && daysBetween(today, nextStep.due) <= 2;
  return { text, tone: soon ? "soon" : "ok", next, missed };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

type LeanPitchProject = Pick<
  IProject,
  "name" | "code" | "naming" | "pitch" | "manager" | "brand" | "status" | "deadline" | "members" | "createdBy" | "departments"
> & { _id: mongoose.Types.ObjectId };

const PROJECT_FIELDS = "name code naming pitch manager brand status deadline members createdBy departments";
const PITCH_TYPE = /^pitch$/i;
const OPEN_STATUSES = ["todo", "in_progress", "in_review"];

/** The three steps of each project, from its tasks (first task of each step) and pitch dates. */
export async function stepsByProject(projects: Array<Pick<LeanPitchProject, "_id" | "pitch">>): Promise<Map<string, PitchStep[]>> {
  const tasks = await Task.find({ project: { $in: projects.map((p) => p._id) }, title: { $in: ALL_TITLES } })
    .select("project title status dueDate assignees createdAt")
    .sort({ createdAt: 1 })
    .lean();
  const byKey = new Map<string, (typeof tasks)[number]>();
  for (const t of tasks) {
    const step = PITCH_STEP_BY_TITLE.get(t.title);
    const k = `${String(t.project)}:${step}`;
    if (step && !byKey.has(k)) byKey.set(k, t);
  }
  const out = new Map<string, PitchStep[]>();
  for (const p of projects) {
    out.set(
      String(p._id),
      PITCH_STEPS.map((s) => {
        const task = byKey.get(`${String(p._id)}:${s.key}`);
        const due = dateKey(task?.dueDate ?? null) ?? dateKey(p.pitch?.[s.key] ?? null);
        const notified = Boolean(due && (p.pitch?.missedNotified ?? []).some((n) => n.step === s.key && dateKey(n.dueDate) === due));
        return {
          key: s.key,
          title: s.title,
          due,
          done: task ? task.status === "completed" : false,
          taskId: task ? String(task._id) : null,
          assignees: task ? task.assignees.map(String) : [],
          notified,
        };
      })
    );
  }
  return out;
}

/** "2026-Q4" → its first and last month ("YYYY-MM") and days; null when invalid. */
export function quarterMonths(quarter: string): { from: string; to: string; start: string; end: string } | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter);
  if (!m) return null;
  const year = Number(m[1]);
  const first = (Number(m[2]) - 1) * 3 + 1;
  const pad = (n: number) => String(n).padStart(2, "0");
  const from = `${year}-${pad(first)}`;
  const to = `${year}-${pad(first + 2)}`;
  return { from, to, start: `${from}-01`, end: `${to}-31` };
}

export function currentQuarter(now: Date = new Date()): string {
  const [y, m] = pitchToday(now).split("-").map(Number);
  return `${y}-Q${Math.floor((m! - 1) / 3) + 1}`;
}

export interface PitchRow {
  id: string;
  name: string;
  code: string;
  brand: { id: string; name: string; organisation: string } | null;
  /** Campaign / idea (naming.title). */
  title: string;
  month: string | null;
  /** "YYYY-MM" group of the plan, or null = "Dates not set". */
  group: string | null;
  revenue: number | null;
  revenueTbc: boolean;
  /** The viewer can't see this project's money (same rule as the budget). */
  revenueHidden: boolean;
  clientPresentation: string | null;
  milestone1: string | null;
  milestone2: string | null;
  /** The project deadline ("End date"). */
  deadline: string | null;
  steps: PitchStep[];
  status: PitchStatus;
  onTime: "on_time" | "late" | "na";
  openTasks: number;
  /** The tracker's free-text memo (pitch.status). */
  note: string;
  leads: Array<{ id: string; name: string }>;
  managerId: string | null;
  /** Leadership, brand creators (Nazeer), the pitch's lead or manager. */
  canEdit: boolean;
}

/** Leadership, brand creators and the pitch's own lead / manager edit it in the plan. */
export function canEditPitch(
  user: Pick<IUser, "_id" | "email">,
  project: Pick<LeanPitchProject, "manager">,
  steps: PitchStep[],
  approvers: Set<string>
): boolean {
  const id = String(user._id);
  return (
    approvers.has(id) ||
    canCreateBrand(user) ||
    String(project.manager ?? "") === id ||
    steps.some((s) => s.assignees.includes(id))
  );
}

/** The pitch's leads: its tasks' assignees, else the manager. */
export function pitchLeadIds(project: Pick<LeanPitchProject, "manager">, steps: PitchStep[]): string[] {
  const ids = [...new Set(steps.flatMap((s) => s.assignees))];
  if (ids.length === 0 && project.manager) ids.push(String(project.manager));
  return ids;
}

/** Pitch rows visible under `visibility` (a projectVisibilityFilter), limited to a quarter. */
export async function loadPitchRows(
  user: IUser,
  visibility: Record<string, unknown>,
  quarter: string,
  now: Date = new Date(),
  onlyId?: mongoose.Types.ObjectId
): Promise<PitchRow[]> {
  const range = quarterMonths(quarter);
  if (!range) return [];
  const filter: Record<string, unknown>[] = [visibility, { archivedAt: null, "naming.type": PITCH_TYPE }];
  if (onlyId) filter.push({ _id: onlyId });
  const projects = (await Project.find({ $and: filter }).select(PROJECT_FIELDS).lean()) as unknown as LeanPitchProject[];
  if (projects.length === 0) return [];

  const steps = await stepsByProject(projects);
  const today = pitchToday(now);
  const inQuarter = (p: LeanPitchProject) => {
    if (onlyId) return true;
    const month = p.naming?.month ?? null;
    if (month && month >= range.from && month <= range.to) return true;
    return (steps.get(String(p._id)) ?? []).some((s) => s.due !== null && s.due >= range.start && s.due <= range.end);
  };
  const chosen = projects.filter(inQuarter);

  const brandIds = [...new Set(chosen.map((p) => String(p.brand ?? p.naming?.brand ?? "")).filter(Boolean))];
  const userIds = new Set<string>();
  for (const p of chosen) {
    for (const s of steps.get(String(p._id)) ?? []) s.assignees.forEach((id) => userIds.add(id));
    if (p.manager) userIds.add(String(p.manager));
  }
  const [brands, users, open, approverIds] = await Promise.all([
    Brand.find({ _id: { $in: brandIds } }).select("name organisation").lean(),
    User.find({ _id: { $in: [...userIds] } }).select("name").lean(),
    Task.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>([
      { $match: { project: { $in: chosen.map((p) => p._id) }, status: { $in: OPEN_STATUSES } } },
      { $group: { _id: "$project", n: { $sum: 1 } } },
    ]),
    projectApproverIds(),
  ]);
  const brandById = new Map(brands.map((b) => [String(b._id), b]));
  const nameById = new Map(users.map((u) => [String(u._id), u.name]));
  const openById = new Map(open.map((o) => [String(o._id), o.n]));
  const approvers = new Set(approverIds.map(String));

  const rows = chosen.map((p): PitchRow => {
    const s = steps.get(String(p._id)) ?? [];
    const brand = brandById.get(String(p.brand ?? p.naming?.brand ?? ""));
    const due = (k: PitchStepKey) => s.find((x) => x.key === k)?.due ?? null;
    const status = pitchStatus(s, today);
    const hidden = !canViewRates(user, p as unknown as IProject);
    const dated = s.some((x) => x.due);
    return {
      id: String(p._id),
      name: p.name,
      code: p.code,
      brand: brand ? { id: String(brand._id), name: brand.name, organisation: brand.organisation ?? "" } : null,
      title: p.naming?.title ?? p.name,
      month: p.naming?.month ?? null,
      group: dated ? (p.naming?.month ?? s.map((x) => x.due).filter(Boolean).sort()[0]!.slice(0, 7)) : null,
      revenue: hidden || p.pitch?.revenueTbc ? null : (p.pitch?.revenue ?? null),
      revenueTbc: !hidden && (Boolean(p.pitch?.revenueTbc) || p.pitch?.revenue == null),
      revenueHidden: hidden,
      clientPresentation: due("clientPresentation"),
      milestone1: due("milestone1"),
      milestone2: due("milestone2"),
      deadline: dateKey(p.deadline ?? null),
      steps: s,
      status,
      onTime: status.tone === "none" ? "na" : status.tone === "missed" ? "late" : "on_time",
      openTasks: openById.get(String(p._id)) ?? 0,
      note: p.pitch?.status ?? "",
      leads: pitchLeadIds(p, s).map((id) => ({ id, name: nameById.get(id) ?? "Unknown" })),
      managerId: p.manager ? String(p.manager) : null,
      canEdit: canEditPitch(user, p, s, approvers),
    };
  });

  // By month ("Dates not set" last), then client, then the first date.
  const firstDue = (r: PitchRow) => [r.milestone1, r.milestone2, r.clientPresentation].filter(Boolean).sort()[0] ?? "9999";
  const client = (r: PitchRow) => brandLabel(r).toLowerCase();
  return rows.sort(
    (a, b) =>
      (a.group ?? "9999").localeCompare(b.group ?? "9999") || client(a).localeCompare(client(b)) || firstDue(a).localeCompare(firstDue(b))
  );
}

/** "ENOC › Zoom" (organisation › short brand name) or the brand name. */
export function brandLabel(row: Pick<PitchRow, "brand" | "name">): string {
  if (!row.brand) return row.name.split("_")[0] ?? row.name;
  const { name, organisation } = row.brand;
  if (!organisation || name.toLowerCase() === organisation.toLowerCase()) return name;
  const short = name.toLowerCase().startsWith(organisation.toLowerCase())
    ? name.slice(organisation.length).replace(/^\s*[-–:|]\s*/, "").trim() || name
    : name;
  return `${organisation} › ${short}`;
}

// ---------------------------------------------------------------------------
// Missed-date check (scheduler: hourly)
// ---------------------------------------------------------------------------

export interface PitchMissedResult {
  date: string;
  checked: number;
  missed: number;
  notified: number;
}

/**
 * Emails (and notifies in-app) the leads, the manager and leadership about each
 * pitch step past its due date and not done — once per step per due date. The
 * record is claimed atomically on the project before sending, so overlapping
 * runs never double-send; a changed due date can be emailed again.
 */
export async function runPitchMissedReminders(
  now: Date = new Date(),
  options: { projectIds?: mongoose.Types.ObjectId[] } = {}
): Promise<PitchMissedResult> {
  const today = pitchToday(now);
  const filter: Record<string, unknown> = {
    archivedAt: null,
    "naming.type": PITCH_TYPE,
    status: { $nin: await completedStatusIds() },
  };
  if (options.projectIds) filter._id = { $in: options.projectIds };
  const projects = (await Project.find(filter).select(PROJECT_FIELDS).lean()) as unknown as LeanPitchProject[];
  const result: PitchMissedResult = { date: today, checked: projects.length, missed: 0, notified: 0 };
  if (projects.length === 0) return result;

  const steps = await stepsByProject(projects);
  let approvers: mongoose.Types.ObjectId[] | null = null;
  let brandNames: Map<string, string> | null = null;

  for (const project of projects) {
    const projectSteps = steps.get(String(project._id)) ?? [];
    const late = projectSteps.filter((s) => !s.done && s.due && s.due < today && !s.notified);
    result.missed += projectSteps.filter((s) => !s.done && s.due && s.due < today).length;
    if (late.length === 0) continue;

    // Imported pitches may have no pitch sub-document yet: give them one so the record can be pushed.
    if (!project.pitch) {
      await Project.updateOne(
        { _id: project._id, pitch: null },
        { $set: { pitch: { revenue: null, revenueTbc: false, status: "", missedNotified: [] } } }
      );
    }

    for (const step of late) {
      const dueDate = new Date(`${step.due}T00:00:00.000Z`);
      const claimed = await Project.updateOne(
        { _id: project._id, "pitch.missedNotified": { $not: { $elemMatch: { step: step.key, dueDate } } } },
        { $push: { "pitch.missedNotified": { step: step.key, dueDate, at: now } } }
      );
      if (claimed.modifiedCount !== 1) continue;

      approvers ??= await projectApproverIds();
      if (!brandNames) {
        const ids = projects.map((p) => String(p.brand ?? p.naming?.brand ?? "")).filter(Boolean);
        const brands = await Brand.find({ _id: { $in: ids } }).select("name").lean();
        brandNames = new Map(brands.map((b) => [String(b._id), b.name]));
      }
      const leads = step.assignees.length ? step.assignees : pitchLeadIds(project, projectSteps);
      const recipients = [...leads, ...(project.manager ? [String(project.manager)] : []), ...approvers.map(String)];
      const brand = brandNames.get(String(project.brand ?? project.naming?.brand ?? "")) ?? project.name.split("_")[0];
      const label = `${brand} — ${project.naming?.title ?? project.name}`;
      const due = pitchDate(step.due!);
      await notifyUsersAsync({
        recipients,
        actor: null,
        type: "pitch_milestone_missed",
        title: "Pitch milestone missed",
        message: `${label}: ${step.title} was due ${due} and isn't done.`,
        link: projectLink(project._id),
        project: project._id,
        email: {
          subject: `Pitch milestone missed: ${label} · ${step.title} (due ${due})`,
          heading: "Pitch Milestone Missed",
          intro: `${step.title} for this pitch was due on ${due} and hasn't been marked done.`,
          cardTitle: label,
          rows: [
            ["Step", step.title],
            ["Due", due],
            ["Project", `${project.code} · ${project.name}`],
          ],
          buttonLabel: "Open Project",
        },
      }).catch((err) => console.error("[pitches] missed-date notification failed:", err));
      result.notified++;
    }
  }
  return result;
}
