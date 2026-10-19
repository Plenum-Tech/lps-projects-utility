import mongoose from "mongoose";
import { Brand } from "../models/Brand.js";
import { Project, type IProject } from "../models/Project.js";
import { completedStatusIds } from "../models/ProjectStatus.js";
import { Task } from "../models/Task.js";
import { User } from "../models/User.js";
import { notifyUsersAsync } from "./notifications.js";
import { projectLink } from "./projectAccess.js";
import { projectApproverIds } from "./projectApproval.js";

// ---------------------------------------------------------------------------
// Pitch tracker (Brands → Pitches): one row per Pitch project with an automatic
// status read from its three tasks (Client presentation → Milestone 1 →
// Milestone 2), and the hourly missed-date check that emails the leads, the
// manager and leadership once per step per due date
// (`pitch.missedNotified` is the idempotency record).
// ---------------------------------------------------------------------------

/** The pitch's steps; each is a task of that exact title (created with the project). */
export const PITCH_STEPS = [
  { key: "clientPresentation", title: "Client presentation" },
  { key: "milestone1", title: "Milestone 1" },
  { key: "milestone2", title: "Milestone 2" },
] as const;
export type PitchStepKey = (typeof PITCH_STEPS)[number]["key"];

/** "Today" for pitch dates is the Dubai calendar date. */
export const PITCH_TIMEZONE = "Asia/Dubai";
const dubaiKey = new Intl.DateTimeFormat("en-CA", { timeZone: PITCH_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });
export const pitchToday = (now: Date = new Date()) => dubaiKey.format(now);

const PITCH_TYPE = /^pitch$/i;
const DONE_STATUSES = new Set(["completed"]);

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

export type PitchTone = "ok" | "soon" | "missed" | "done";

export interface PitchStatus {
  text: string;
  tone: PitchTone;
  next?: { key: PitchStepKey; title: string; due: string | null };
  missed: Array<{ key: PitchStepKey; title: string; due: string; emailed: boolean }>;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-20" → "20 Oct". */
export function shortDate(key: string): string {
  const [, m, d] = key.split("-").map(Number);
  return `${d} ${MONTHS[m! - 1]}`;
}

const dateKey = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Steps in the order they happen: by due date (the sheet often has Milestone 1
 * before the client presentation), ties and undated steps in the fixed order.
 */
export function orderSteps(steps: PitchStep[]): PitchStep[] {
  const fixed = (s: PitchStep) => PITCH_STEPS.findIndex((p) => p.key === s.key);
  return [...steps].sort((a, b) => {
    if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
    if (a.due && !b.due) return -1;
    if (!a.due && b.due) return 1;
    return fixed(a) - fixed(b);
  });
}

/** The automatic status line from the steps (only steps with a task or a date count). */
export function pitchStatus(allSteps: PitchStep[], today: string): PitchStatus {
  const steps = orderSteps(allSteps.filter((s) => s.taskId || s.due));
  if (steps.length === 0) return { text: "No pitch dates yet", tone: "ok", missed: [] };
  if (steps.every((s) => s.done)) return { text: "All milestones done", tone: "done", missed: [] };

  const nextStep = steps.find((s) => !s.done)!;
  const next = { key: nextStep.key, title: nextStep.title, due: nextStep.due };
  const missed = steps
    .filter((s) => !s.done && s.due && s.due < today)
    .map((s) => ({ key: s.key, title: s.title, due: s.due!, emailed: s.notified }));
  if (missed.length) {
    const text = missed
      .map((m) => `${m.title} missed (due ${shortDate(m.due)}) — ${m.emailed ? "email sent" : "email pending"}`)
      .join("; ");
    return { text, tone: "missed", next, missed };
  }

  const lastDone = [...steps].reverse().find((s) => s.done);
  const when = nextStep.due ? shortDate(nextStep.due) : "no date";
  const text = lastDone ? `${lastDone.title} done — ${nextStep.title} target ${when}` : `${nextStep.title} due ${when}`;
  const soon = nextStep.due !== null && daysBetween(today, nextStep.due) <= 2;
  return { text, tone: soon ? "soon" : "ok", next, missed };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

type LeanPitchProject = Pick<IProject, "name" | "code" | "naming" | "pitch" | "manager" | "brand" | "status"> & {
  _id: mongoose.Types.ObjectId;
};

const PROJECT_FIELDS = "name code naming pitch manager brand status";

/** The three steps of each project, from its tasks (first task of each title) and pitch dates. */
async function stepsByProject(projects: LeanPitchProject[]): Promise<Map<string, PitchStep[]>> {
  const tasks = await Task.find({
    project: { $in: projects.map((p) => p._id) },
    title: { $in: PITCH_STEPS.map((s) => s.title) },
  })
    .select("project title status dueDate assignees createdAt")
    .sort({ createdAt: 1 })
    .lean();
  const byKey = new Map<string, (typeof tasks)[number]>();
  for (const t of tasks) {
    const k = `${String(t.project)}:${t.title}`;
    if (!byKey.has(k)) byKey.set(k, t);
  }
  const out = new Map<string, PitchStep[]>();
  for (const p of projects) {
    out.set(
      String(p._id),
      PITCH_STEPS.map((s) => {
        const task = byKey.get(`${String(p._id)}:${s.title}`);
        const due = dateKey(task?.dueDate ?? null) ?? dateKey(p.pitch?.[s.key] ?? null);
        const notified = Boolean(
          due && (p.pitch?.missedNotified ?? []).some((n) => n.step === s.key && dateKey(n.dueDate) === due)
        );
        return {
          key: s.key,
          title: s.title,
          due,
          done: task ? DONE_STATUSES.has(task.status) : false,
          taskId: task ? String(task._id) : null,
          assignees: task ? task.assignees.map(String) : [],
          notified,
        };
      })
    );
  }
  return out;
}

/** "2026-Q4" → its first and last month ("YYYY-MM"); null when invalid. */
export function quarterMonths(quarter: string): { from: string; to: string; start: string; end: string } | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter);
  if (!m) return null;
  const year = Number(m[1]);
  const q = Number(m[2]);
  const first = (q - 1) * 3 + 1;
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
  revenue: number | null;
  revenueTbc: boolean;
  clientPresentation: string | null;
  milestone1: string | null;
  milestone2: string | null;
  steps: PitchStep[];
  status: PitchStatus;
  /** The tracker's free-text note (pitch.status). */
  note: string;
  leads: Array<{ id: string; name: string }>;
}

/** Pitch rows visible under `visibility` (a projectVisibilityFilter), limited to a quarter. */
export async function loadPitchRows(
  visibility: Record<string, unknown>,
  quarter: string,
  now: Date = new Date()
): Promise<PitchRow[]> {
  const range = quarterMonths(quarter);
  if (!range) return [];
  const projects = (await Project.find({ $and: [visibility, { archivedAt: null, "naming.type": PITCH_TYPE }] })
    .select(PROJECT_FIELDS)
    .lean()) as unknown as LeanPitchProject[];
  if (projects.length === 0) return [];

  const steps = await stepsByProject(projects);
  const today = pitchToday(now);
  const inQuarter = (p: LeanPitchProject) => {
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
  const [brands, users] = await Promise.all([
    Brand.find({ _id: { $in: brandIds } }).select("name organisation").lean(),
    User.find({ _id: { $in: [...userIds] } }).select("name").lean(),
  ]);
  const brandById = new Map(brands.map((b) => [String(b._id), b]));
  const nameById = new Map(users.map((u) => [String(u._id), u.name]));

  const rows = chosen.map((p): PitchRow => {
    const s = steps.get(String(p._id)) ?? [];
    const brand = brandById.get(String(p.brand ?? p.naming?.brand ?? ""));
    const leadIds = [...new Set(s.flatMap((x) => x.assignees))];
    if (leadIds.length === 0 && p.manager) leadIds.push(String(p.manager));
    const due = (k: PitchStepKey) => s.find((x) => x.key === k)?.due ?? null;
    return {
      id: String(p._id),
      name: p.name,
      code: p.code,
      brand: brand ? { id: String(brand._id), name: brand.name, organisation: brand.organisation ?? "" } : null,
      title: p.naming?.title ?? p.name,
      month: p.naming?.month ?? null,
      revenue: p.pitch?.revenueTbc ? null : (p.pitch?.revenue ?? null),
      revenueTbc: Boolean(p.pitch?.revenueTbc) || p.pitch?.revenue == null,
      clientPresentation: due("clientPresentation"),
      milestone1: due("milestone1"),
      milestone2: due("milestone2"),
      steps: s,
      status: pitchStatus(s, today),
      note: p.pitch?.status ?? "",
      leads: leadIds.map((id) => ({ id, name: nameById.get(id) ?? "Unknown" })),
    };
  });

  // Earliest upcoming date first (like the sheet), then by brand.
  const firstDue = (r: PitchRow) => [r.clientPresentation, r.milestone1, r.milestone2].filter(Boolean).sort()[0] ?? "9999";
  return rows.sort(
    (a, b) =>
      (a.brand?.organisation || a.brand?.name || a.name).localeCompare(b.brand?.organisation || b.brand?.name || b.name) ||
      (a.brand?.name ?? "").localeCompare(b.brand?.name ?? "") ||
      firstDue(a).localeCompare(firstDue(b))
  );
}

/** "ENOC - Zoom" (organisation + short brand name) or the brand name. */
export function brandLabel(row: Pick<PitchRow, "brand" | "name">): string {
  if (!row.brand) return row.name.split("_")[0] ?? row.name;
  const { name, organisation } = row.brand;
  if (!organisation || name.toLowerCase() === organisation.toLowerCase()) return name;
  return name.toLowerCase().startsWith(organisation.toLowerCase()) ? name : `${organisation} - ${name}`;
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
      const leads = step.assignees.length ? step.assignees : [...new Set(projectSteps.flatMap((s) => s.assignees))];
      const recipients = [...leads, ...(project.manager ? [String(project.manager)] : []), ...approvers.map(String)];
      const brand = brandNames.get(String(project.brand ?? project.naming?.brand ?? "")) ?? project.name.split("_")[0];
      const title = project.naming?.title ?? project.name;
      const label = `${brand} — ${title}`;
      const due = shortDate(step.due!);
      const projectId = project._id;
      await notifyUsersAsync({
        recipients,
        actor: null,
        type: "pitch_milestone_missed",
        title: "Pitch milestone missed",
        message: `${label}: ${step.title} was due ${due} and isn't done.`,
        link: projectLink(projectId),
        project: projectId,
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
