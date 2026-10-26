import type { Request, Response } from "express";
import ExcelJS from "exceljs";
import mongoose from "mongoose";
import { appTimeOn } from "../lib/appTime.js";
import {
  brandLabel,
  canActOnPitchStep,
  canEditPitch,
  currentQuarter,
  internalMeetingLabelId,
  loadPitchRows,
  PITCH_STEPS,
  pitchDate,
  pitchLeadIds,
  pitchToday,
  quarterMonths,
  stepsByProject,
  type PitchRow,
  type PitchStep,
  type PitchStepKey,
} from "../lib/pitches.js";
import { pushTaskUpdate, recordTaskHistory } from "../lib/taskAccess.js";
import { getViewableProjectOr404, projectVisibilityFilter } from "../lib/projectAccess.js";
import { projectApproverIds } from "../lib/projectApproval.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";
import { TaskFile } from "../models/TaskFile.js";
import { updateProjectCore } from "./projects.js";
import { applyStatusChange, createTaskCore } from "./tasks.js";
import { createTimeLogCore } from "./timelogs.js";

// ---------------------------------------------------------------------------
// Brands → Pitch plan:
//   GET   /api/brands/pitches?quarter=2026-Q4   rows + automatic status
//   GET   /api/brands/pitches/export            the plan as .xlsx
//   PATCH /api/brands/pitches/:id               in-place edits of one pitch
// Only the projects the user may see (same rule as the projects list). Task
// changes (due date, assignees) go through the task API from the page, so the task
// rules apply as usual; a step's outcome (held / not held / rescheduled) has its own
// endpoint (POST /api/brands/pitches/:id/steps/:step/outcome).
// ---------------------------------------------------------------------------

function quarterOf(req: Request): string | null {
  const raw = typeof req.query.quarter === "string" && req.query.quarter ? req.query.quarter : currentQuarter();
  return quarterMonths(raw) ? raw : null;
}

/** "2026-Q4" → "Q4 2026". */
const quarterLabel = (q: string) => `${q.slice(5)} ${q.slice(0, 4)}`;

function totals(rows: PitchRow[]) {
  return {
    count: rows.length,
    revenue: rows.reduce((sum, r) => sum + (r.revenue ?? 0), 0),
    tbc: rows.filter((r) => r.revenue === null && !r.revenueHidden).length,
  };
}

/** GET /api/brands/pitches */
export async function listPitches(req: Request, res: Response): Promise<void> {
  const quarter = quarterOf(req);
  if (!quarter) {
    res.status(400).json({ error: "quarter must be YYYY-Q1..Q4" });
    return;
  }
  const rows = await loadPitchRows(req.user!, projectVisibilityFilter(req.user!), quarter);
  res.json({ quarter, label: quarterLabel(quarter), today: pitchToday(), rows, totals: totals(rows) });
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const groupLabel = (group: string | null) => (group ? `${MONTH_NAMES[Number(group.slice(5, 7)) - 1]} ${group.slice(0, 4)}` : "Dates not set");

const fmtRevenue = (r: PitchRow) => (r.revenueHidden ? "" : r.revenue === null ? "TBC" : `AED ${r.revenue.toLocaleString("en-US")}`);
const fmtDate = (d: string | null) => (d ? pitchDate(d) : "");
const stepCell = (r: PitchRow, key: PitchStepKey) => {
  const s = r.steps.find((x) => x.key === key);
  if (!s?.due) return "";
  const state =
    s.outcome === "not_held"
      ? " (not held)"
      : s.done
        ? " (held)"
        : r.status.missed.some((m) => m.key === key)
          ? " (missed)"
          : s.outcome === "rescheduled" && s.rescheduledFrom
            ? ` (rescheduled from ${pitchDate(s.rescheduledFrom)})`
            : "";
  return `${pitchDate(s.due)}${state}${s.outcomeNote ? `\n${s.outcomeNote}` : ""}`;
};
const ON_TIME = { on_time: "On time", late: "Late", na: "—" } as const;

/** GET /api/brands/pitches/export — title row, headers, month sections, one row per pitch, totals. */
export async function exportPitches(req: Request, res: Response): Promise<void> {
  const quarter = quarterOf(req);
  if (!quarter) {
    res.status(400).json({ error: "quarter must be YYYY-Q1..Q4" });
    return;
  }
  const rows = await loadPitchRows(req.user!, projectVisibilityFilter(req.user!), quarter);
  const label = quarterLabel(quarter);
  const headers = [
    "Client Name",
    "Campaign/Idea",
    "Potential revenue",
    "Milestone 1 meeting",
    "Milestone 2 meeting",
    "Client presentation",
    "End date",
    "Lead",
    "Open tasks",
    "On time",
    "Status",
  ];

  const wb = new ExcelJS.Workbook();
  wb.creator = req.user!.name;
  wb.created = new Date();
  const sheet = wb.addWorksheet(`Pitch plan ${label}`);
  sheet.columns = [28, 34, 18, 20, 20, 20, 14, 24, 11, 10, 60].map((width) => ({ width }));

  sheet.mergeCells(1, 1, 1, headers.length);
  const title = sheet.getCell("A1");
  title.value = `PITCHES/PROACTIVE PROJECTS  ${label}`;
  title.font = { bold: true, size: 14 };
  title.alignment = { horizontal: "center", vertical: "middle" };
  sheet.getRow(1).height = 24;

  const header = sheet.addRow(headers);
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE6F4EA" } };
    cell.border = { bottom: { style: "thin" } };
    cell.alignment = { vertical: "middle", wrapText: true };
  });

  const fill = (argb: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
  const toneFill: Record<string, string> = { missed: "FFFDE2E1", soon: "FFFFF4D6", ok: "FFE6F4EA", done: "FFE6F4EA", none: "FFF1F5F9" };
  let group: string | null | undefined;
  for (const r of rows) {
    if (r.group !== group) {
      group = r.group;
      const n = rows.filter((x) => x.group === group).length;
      const section = sheet.addRow([`${groupLabel(group)} · ${n}`]);
      section.font = { bold: true, color: { argb: "FF64748B" } };
      section.eachCell({ includeEmpty: true }, (cell) => (cell.fill = fill("FFEEF2F7")));
      for (let c = 1; c <= headers.length; c++) section.getCell(c).fill = fill("FFEEF2F7");
    }
    const row = sheet.addRow([
      brandLabel(r),
      r.title,
      fmtRevenue(r),
      stepCell(r, "milestone1"),
      stepCell(r, "milestone2"),
      stepCell(r, "clientPresentation"),
      fmtDate(r.deadline),
      r.leads.map((l) => l.name).join(", ") || "No lead",
      r.openTasks,
      ON_TIME[r.onTime],
      r.note ? `${r.status.text}\n${r.note}` : r.status.text,
    ]);
    row.alignment = { vertical: "top", wrapText: true };
    row.getCell(11).fill = fill(toneFill[r.status.tone] ?? "FFFFFFFF");
    if (r.leads.length === 0) row.getCell(8).fill = fill(toneFill.missed!);
  }

  const t = totals(rows);
  const total = sheet.addRow([
    `${t.count} pitch${t.count === 1 ? "" : "es"}`,
    "",
    `AED ${t.revenue.toLocaleString("en-US")}`,
    t.tbc ? `${t.tbc} TBC not counted` : "",
  ]);
  total.font = { bold: true };
  total.eachCell((cell) => (cell.border = { top: { style: "thin" } }));

  const q = `${quarter.slice(5)}_${quarter.slice(0, 4)}`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="Pitch_plan_${q}.xlsx"; filename*=UTF-8''${encodeURIComponent(`Proactive & Pitches Status_${q}.xlsx`)}`
  );
  res.setHeader("X-Export-Rows", String(rows.length));
  await wb.xlsx.write(res);
  res.end();
}

// ---------------------------------------------------------------------------
// In-place edits
// ---------------------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STEP_KEYS = new Set<string>(PITCH_STEPS.map((s) => s.key));

/**
 * PATCH /api/brands/pitches/:id — one of:
 *   { step, date }            the pitch's date (task due date: PATCH /api/tasks/:id first);
 *                             a missing step task is created on its date
 *   { revenue, revenueTbc }   potential revenue
 *   { leads: [ids] }          the project manager becomes the first lead (project-edit rules);
 *                             the page reassigns the pitch tasks through the task API
 *   { deadline }              the project's end date (project-edit rules)
 * Leadership, brand creators and the pitch's lead / manager only.
 */
export async function updatePitch(req: Request, res: Response): Promise<void> {
  const project = await getViewableProjectOr404(req, res);
  if (!project) return;
  const user = req.user!;
  if (!/^pitch$/i.test(project.naming?.type ?? "")) {
    res.status(400).json({ error: "This project isn't a pitch" });
    return;
  }
  if (project.archivedAt) {
    res.status(409).json({ error: "This project is archived and read-only. Restore it first." });
    return;
  }
  const steps = (await stepsByProject([project]).then((m) => m.get(String(project._id)))) ?? [];
  const approvers = new Set((await projectApproverIds()).map(String));
  if (!canEditPitch(user, project, steps, approvers)) {
    res.status(403).json({ error: "Only leadership, Nazeer and the pitch's lead or manager can edit it here" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const pitchBase = project.pitch
    ? {}
    : { pitch: { revenue: null, revenueTbc: false, status: "", missedNotified: [] } };
  let message: string | undefined;

  if (typeof body.step === "string") {
    if (!STEP_KEYS.has(body.step)) return void res.status(400).json({ error: "step must be milestone1, milestone2 or clientPresentation" });
    const key = body.step as PitchStepKey;
    const raw = body.date;
    if (raw !== null && (typeof raw !== "string" || !DATE.test(raw))) return void res.status(400).json({ error: "date must be YYYY-MM-DD or null" });
    const date = raw ? new Date(`${raw}T00:00:00.000Z`) : null;
    if (pitchBase.pitch) await Project.updateOne({ _id: project._id, pitch: null }, { $set: pitchBase });
    await Project.updateOne({ _id: project._id }, { $set: { [`pitch.${key}`]: date } });
    const step = steps.find((s) => s.key === key);
    if (date && step && !step.taskId) {
      const def = PITCH_STEPS.find((s) => s.key === key)!;
      const leads = pitchLeadIds(project, steps);
      const created = await createTaskCore(
        user,
        {
          project: String(project._id),
          title: def.title,
          assignees: leads.length ? leads : [String(user._id)],
          dueDate: raw,
          priority: "high",
          description: `<p>${def.title} for the pitch ${project.name}.</p>`,
          ...(def.internal ? { labels: [String(await internalMeetingLabelId())] } : {}),
        },
        req.ip,
        { via: "pitch_plan" },
        { allowClosedProject: true, allowNoScope: true }
      );
      if (!("taskId" in created)) return void res.status(created.status).json({ error: created.error });
      message = `${def.title} task created`;
    }
  } else if ("revenue" in body || "revenueTbc" in body) {
    const tbc = body.revenueTbc === true;
    const revenue = body.revenue === null || body.revenue === "" || body.revenue === undefined ? null : Number(body.revenue);
    if (revenue !== null && (!Number.isFinite(revenue) || revenue < 0 || revenue > 1e12)) {
      return void res.status(400).json({ error: "revenue must be a positive number" });
    }
    if (pitchBase.pitch) await Project.updateOne({ _id: project._id, pitch: null }, { $set: pitchBase });
    await Project.updateOne(
      { _id: project._id },
      { $set: { "pitch.revenue": tbc ? null : revenue === null ? null : Math.round(revenue), "pitch.revenueTbc": tbc || revenue === null } }
    );
  } else if (Array.isArray(body.leads)) {
    const leads = [...new Set(body.leads.map(String))].filter((id) => mongoose.isValidObjectId(id)).slice(0, 3);
    if (leads.length === 0) return void res.status(400).json({ error: "Pick the lead" });
    if (String(project.manager ?? "") !== leads[0]) {
      const result = await updateProjectCore(user, project, { manager: leads[0] }, req.ip);
      if ("status" in result && "error" in result) return void res.status(result.status).json({ error: result.error });
      message = (result as { pendingApproval?: string }).pendingApproval;
    }
  } else if ("deadline" in body) {
    const raw = body.deadline;
    if (raw !== null && (typeof raw !== "string" || !DATE.test(raw))) return void res.status(400).json({ error: "deadline must be YYYY-MM-DD or null" });
    const result = await updateProjectCore(user, project, { deadline: raw }, req.ip);
    if ("status" in result && "error" in result) return void res.status(result.status).json({ error: result.error });
    message = (result as { pendingApproval?: string }).pendingApproval;
  } else {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }

  const [row] = await loadPitchRows(user, projectVisibilityFilter(user), currentQuarter(), new Date(), project._id as mongoose.Types.ObjectId);
  res.json({ row: row ?? null, ...(message ? { message } : {}) });
}

// ---------------------------------------------------------------------------
// Step outcomes
// ---------------------------------------------------------------------------

const OUTCOMES = ["held", "not_held", "rescheduled", "reopen"] as const;
type OutcomeAction = (typeof OUTCOMES)[number];
const OUTCOME_LABEL: Record<OutcomeAction, string> = { held: "held", not_held: "not held", rescheduled: "rescheduled", reopen: "reopened" };
const HTTP_LINK = /^https?:\/\/\S+$/i;

/**
 * POST /api/brands/pitches/:id/steps/:step/outcome — what happened to a pitch step:
 *   { outcome: "held", notes, link?, fileId?, minutes? }  closes the step task with the notes as its
 *       outcome note (no final file / time log required); `fileId` = a file already uploaded to the
 *       task; `minutes` = the meeting's length, logged for the caller under the usual time-log rules,
 *       ending at the meeting (6 pm on a past date, else now)
 *   { outcome: "not_held", notes }                         closes it as not held (`notes` = the reason)
 *   { outcome: "rescheduled", date, notes? }               keeps it open, moves its due date (and the pitch date)
 *   { outcome: "reopen" }                                  back to in progress, outcome cleared
 * Stored on the task (pitchOutcome) and in its history. Whoever edits the pitch, the project's
 * managers and the task's creator. Other tasks keep the normal closing rules.
 */
export async function recordPitchOutcome(req: Request, res: Response): Promise<void> {
  const project = await getViewableProjectOr404(req, res);
  if (!project) return;
  const user = req.user!;
  if (!/^pitch$/i.test(project.naming?.type ?? "")) return void res.status(400).json({ error: "This project isn't a pitch" });
  if (project.archivedAt) return void res.status(409).json({ error: "This project is archived and read-only. Restore it first." });
  const key = String(req.params.step ?? "");
  if (!STEP_KEYS.has(key)) return void res.status(400).json({ error: "step must be milestone1, milestone2 or clientPresentation" });
  const steps: PitchStep[] = (await stepsByProject([project]).then((m) => m.get(String(project._id)))) ?? [];
  const step = steps.find((s) => s.key === key)!;
  if (!step.taskId) return void res.status(400).json({ error: "Add the date first: it creates the step's task." });
  const approvers = new Set((await projectApproverIds()).map(String));
  if (!canActOnPitchStep(user, project, steps, step, approvers)) {
    return void res.status(403).json({ error: "Only the pitch's lead or manager, leadership or the task's creator can record this" });
  }
  const task = await Task.findById(step.taskId);
  if (!task) return void res.status(404).json({ error: "Task not found" });

  const body = (req.body ?? {}) as Record<string, unknown>;
  const outcome = String(body.outcome ?? "") as OutcomeAction;
  if (!OUTCOMES.includes(outcome)) return void res.status(400).json({ error: "outcome must be held, not_held, rescheduled or reopen" });
  const notes = typeof body.notes === "string" ? body.notes.trim() : "";
  if (notes.length > 2000) return void res.status(400).json({ error: "Notes must be 2000 characters or fewer" });
  const now = new Date();
  const taskId = task._id as mongoose.Types.ObjectId;
  const by = user._id as mongoose.Types.ObjectId;
  const oldDue = task.dueDate ? task.dueDate.toISOString().slice(0, 10) : null;
  let newDue: string | null = null;

  if (outcome === "held" || outcome === "not_held") {
    if (!notes) {
      return void res.status(400).json({ error: outcome === "held" ? "Write the notes: what was discussed, the client's feedback" : "Write why it wasn't held" });
    }
    let finalFile: { fileId: mongoose.Types.ObjectId | null; url: string | null; addedAt: Date } | null = null;
    let minutes = 0;
    if (outcome === "held") {
      const link = typeof body.link === "string" ? body.link.trim() : "";
      const fileId = typeof body.fileId === "string" ? body.fileId : "";
      if (link && (!HTTP_LINK.test(link) || link.length > 2000)) {
        return void res.status(400).json({ error: "The link must start with http:// or https://" });
      }
      if (fileId) {
        if (!mongoose.isValidObjectId(fileId) || !(await TaskFile.exists({ _id: fileId, task: taskId }))) {
          return void res.status(400).json({ error: "The file must be uploaded to this task" });
        }
        finalFile = { fileId: new mongoose.Types.ObjectId(fileId), url: null, addedAt: now };
      } else if (link) {
        finalFile = { fileId: null, url: link, addedAt: now };
      }
      if (body.minutes !== undefined && body.minutes !== null && body.minutes !== "" && body.minutes !== 0) {
        minutes = Number(body.minutes);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 12 * 60) {
          return void res.status(400).json({ error: "The meeting length must be between 1 minute and 12 hours" });
        }
      }
    }
    // The time first: when it's refused (overlap, manual entries off…) nothing is written.
    if (minutes > 0) {
      const end = oldDue && oldDue < pitchToday(now) ? appTimeOn(oldDue, "18:00") : now;
      const logged = await createTimeLogCore(user, {
        task: String(taskId),
        project: String(project._id),
        startTime: new Date(end.getTime() - minutes * 60_000).toISOString(),
        endTime: end.toISOString(),
        memo: `${task.title} (pitch meeting)`,
        completion: true,
      });
      if ("error" in logged) return void res.status(logged.status).json({ error: logged.error });
    }
    task.submissionNotes = outcome === "held" ? notes : `Not held: ${notes}`;
    if (finalFile) task.finalFile = finalFile;
    task.pitchOutcome = { outcome, note: notes, at: now, by, from: null };
    if (task.status === "completed") {
      await task.save();
      pushTaskUpdate(task, "updated", { actorId: String(user._id) });
    } else {
      const result = await applyStatusChange(user, task, "completed", undefined, req.ip, { authorized: true });
      if ("error" in result) return void res.status(result.status).json({ error: result.error });
    }
  } else if (outcome === "rescheduled") {
    const raw = body.date;
    if (typeof raw !== "string" || !DATE.test(raw)) return void res.status(400).json({ error: "Pick the new date" });
    if (task.status === "completed") return void res.status(400).json({ error: "This step is closed. Reopen it first." });
    if (raw === oldDue) return void res.status(400).json({ error: "That's the current date. Pick a new one." });
    newDue = raw;
    const date = new Date(`${raw}T00:00:00.000Z`);
    task.dueDate = date;
    task.pitchOutcome = { outcome: "rescheduled", note: notes, at: now, by, from: oldDue ? new Date(`${oldDue}T00:00:00.000Z`) : null };
    await task.save();
    if (!project.pitch) {
      await Project.updateOne({ _id: project._id, pitch: null }, { $set: { pitch: { revenue: null, revenueTbc: false, status: "", missedNotified: [] } } });
    }
    await Project.updateOne({ _id: project._id }, { $set: { [`pitch.${key}`]: date } });
    pushTaskUpdate(task, "updated", { actorId: String(user._id) });
  } else {
    if (task.status !== "completed") return void res.status(400).json({ error: "This step is still open" });
    task.pitchOutcome = null;
    const result = await applyStatusChange(user, task, "in_progress", undefined, req.ip, { authorized: true });
    if ("error" in result) return void res.status(result.status).json({ error: result.error });
  }

  recordTaskHistory(taskId, user, "pitch_outcome", {
    outcome,
    ...(notes ? { notes } : {}),
    ...(newDue ? { from: oldDue, to: newDue } : {}),
  });
  const [row] = await loadPitchRows(user, projectVisibilityFilter(user), currentQuarter(), new Date(), project._id as mongoose.Types.ObjectId);
  res.json({ row: row ?? null, message: `${step.title} ${OUTCOME_LABEL[outcome]}` });
}
