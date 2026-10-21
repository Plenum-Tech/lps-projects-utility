import type { Request, Response } from "express";
import mongoose from "mongoose";
import { logActivity } from "../lib/activityLog.js";
import { canCreateBrand } from "../lib/brandAccess.js";
import type { BrandSetup } from "../lib/brandFlow.js";
import { PITCH_STEP_BY_TITLE, PITCH_STEPS, type PitchStepKey } from "../lib/pitches.js";
import { isProjectApprover } from "../lib/projectApproval.js";
import { composeProjectName } from "../lib/projectNaming.js";
import { parseLooseDate } from "../lib/scopeExtract.js";
import { Brand, brandNameKey, type IBrand } from "../models/Brand.js";
import { Project } from "../models/Project.js";
import { STAFF_FILTER, User } from "../models/User.js";
import { parsePitchWorkbook, type PitchSheetRow } from "./brandFlow.js";
import { notifyBrandApprovalRequested } from "./brands.js";
import { createProjectCore } from "./projects.js";

// ---------------------------------------------------------------------------
// Pitch tracker import (Pitch & Growth → Import pitch sheet): every row of the
// "Proactive & Pitches" sheet becomes a Pitch project of its client (brand
// created when new), with the lead's tasks: Client presentation, Milestone 1
// and Milestone 2 meetings and the Client presentation on their dates. Preview first, then create the ticked rows.
// A row whose project already exists is skipped, so the sheet can be re-imported.
// ---------------------------------------------------------------------------

const TYPE = "Pitch";
/** Task title (current and pre-Oct 2026 names) → createProjectCore's pitchDates key. */
const PITCH_KEY: ReadonlyMap<string, PitchStepKey> = PITCH_STEP_BY_TITLE;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_ROWS = 200;

type Person = { _id: string; name: string };

/** "Samer / Bisma" → the users whose name is (or starts with) each part. */
function matchLeads(text: string, people: Person[]): { ids: string[]; missing: string[] } {
  const ids: string[] = [];
  const missing: string[] = [];
  for (const part of text.split(/[/,&+]| and /i).map((p) => p.trim()).filter(Boolean)) {
    const low = part.toLowerCase();
    const first = (u: Person) => u.name.toLowerCase().split(/\s+/)[0]!;
    // Exact name, then the same first name, then a first name starting with it ("Zahad" → Zahadali).
    const tries = [
      people.filter((u) => u.name.toLowerCase() === low),
      people.filter((u) => first(u) === low.split(/\s+/)[0]),
      low.length >= 3 ? people.filter((u) => first(u).startsWith(low)) : [],
    ];
    const pick = tries.find((t) => t.length > 0) ?? [];
    if (pick.length === 1) ids.push(pick[0]!._id);
    else missing.push(part);
  }
  return { ids: [...new Set(ids)], missing };
}

const monthOf = (iso: string) => iso.slice(0, 7);
const currentMonth = () => new Date().toISOString().slice(0, 7);

/** What one sheet row will create. */
function planRow(row: PitchSheetRow, people: Person[], brands: Map<string, { _id: string; name: string; status?: string }>) {
  const brand = brands.get(brandNameKey(row.client)) ?? null;
  const title = (row.campaign || "Pitch").replace(/_/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  const cells = { milestone1: row.milestone1, milestone2: row.milestone2, clientPresentation: row.clientPresentation };
  const tasks = PITCH_STEPS.map((s) => ({ title: s.title, cell: cells[s.key] })).map((t) => ({ title: t.title, dueDate: t.cell.date, text: t.cell.text, monthOnly: t.cell.monthOnly }));
  const dated = tasks.filter((t) => t.dueDate);
  const month = row.clientPresentation.date ? monthOf(row.clientPresentation.date) : dated[0]?.dueDate ? monthOf(dated[0].dueDate) : currentMonth();
  const leads = matchLeads(row.lead, people);
  const warnings: string[] = [];
  if (!row.campaign) warnings.push("No campaign / idea: named “Pitch”.");
  if (!row.lead) warnings.push("No lead in the sheet: pick one.");
  else if (leads.missing.length) warnings.push(`Lead not found: ${leads.missing.join(", ")}.`);
  for (const t of tasks) {
    if (t.monthOnly) warnings.push(`${t.title}: only “${t.text}” given — due the month's last day.`);
    else if (!t.dueDate && t.text) warnings.push(`${t.title}: “${t.text}” isn't a date.`);
  }
  // All three dates are required for a pitch.
  if (tasks.some((t) => !t.dueDate)) warnings.push(`Missing: ${tasks.filter((t) => !t.dueDate).map((t) => t.title).join(", ")} — add the date${tasks.filter((t) => !t.dueDate).length === 1 ? "" : "s"} to create this pitch.`);
  const today = new Date().toISOString().slice(0, 10);
  if (row.clientPresentation.date && row.clientPresentation.date < today) warnings.push("The client presentation date has passed.");
  if (brand?.status === "pending") warnings.push("The brand is waiting for approval.");
  if (brand?.status === "rejected") warnings.push("The brand was not approved.");
  return {
    client: row.client,
    brand: brand ? { _id: brand._id, name: brand.name, status: brand.status ?? "approved" } : null,
    title,
    month,
    projectName: composeProjectName(brand?.name ?? row.client, TYPE, month, title),
    revenue: row.revenue,
    revenueTbc: row.revenueTbc || row.revenue === null,
    status: row.status,
    leadText: row.lead,
    leads: leads.ids,
    tasks: tasks.map(({ title: t, dueDate }) => ({ title: t, dueDate })),
    warnings,
  };
}

/** POST /api/brands/pitch-import/preview — multipart `files` (the tracker .xlsx): what each row creates. */
export async function previewPitchImport(req: Request, res: Response): Promise<void> {
  const file = ((req.files as Express.Multer.File[] | undefined) ?? [])[0];
  if (!file || !/\.xlsx$/i.test(file.originalname)) {
    res.status(400).json({ error: "Upload the pitch tracker as an .xlsx file" });
    return;
  }
  const parsed = await parsePitchWorkbook(file.buffer);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const [users, brandDocs] = await Promise.all([
    User.find(STAFF_FILTER).select("name").lean(),
    Brand.find({}).select("name nameKey status").lean(),
  ]);
  const people = users.map((u) => ({ _id: String(u._id), name: u.name }));
  const brands = new Map(brandDocs.map((b) => [b.nameKey ?? brandNameKey(b.name), { _id: String(b._id), name: b.name, status: b.status }]));
  const rows = parsed.rows.slice(0, MAX_ROWS).map((row) => planRow(row, people, brands));
  const names = rows.map((r) => r.projectName);
  const existing = new Set((await Project.find({ name: { $in: names }, archivedAt: null }).select("name").lean()).map((p) => p.name));
  res.json({
    rows: rows.map((r) => ({ ...r, exists: existing.has(r.projectName) })),
    // New brands from the sheet: brand creators only (approved at once when they are leadership).
    canCreateBrands: canCreateBrand(req.user!),
  });
}

interface ImportRow {
  client: string;
  title: string;
  month: string;
  revenue: number | null;
  revenueTbc: boolean;
  status: string;
  leads: string[];
  tasks: Array<{ title: string; dueDate: string }>;
}

function parseImportRow(raw: Record<string, unknown>): ImportRow | string {
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");
  const client = str(raw.client, 80);
  if (!client || client.includes("_")) return "The client name is missing or contains “_”";
  const title = str(raw.title, 80).replace(/_/g, " ") || "Pitch";
  const month = str(raw.month, 7);
  if (!MONTH.test(month)) return "month must be YYYY-MM";
  const leads = Array.isArray(raw.leads) ? [...new Set(raw.leads.map(String))].filter((id) => mongoose.isValidObjectId(id)).slice(0, 3) : [];
  if (leads.length === 0) return "Pick the lead";
  const tasks: ImportRow["tasks"] = [];
  for (const t of Array.isArray(raw.tasks) ? (raw.tasks as Array<Record<string, unknown>>) : []) {
    const due = parseLooseDate(str(t?.dueDate, 20));
    const name = str(t?.title, 120);
    if (name && due) tasks.push({ title: name, dueDate: due });
  }
  const revenue = Number(raw.revenue);
  const have = new Set(tasks.map((t) => PITCH_KEY.get(t.title)).filter(Boolean));
  const missing = PITCH_STEPS.filter((s) => !have.has(s.key)).map((s) => s.title);
  if (missing.length) return `A pitch needs the Milestone 1 meeting, Milestone 2 meeting and Client presentation dates (missing: ${missing.join(", ")})`;
  return {
    client,
    title,
    month,
    revenue: Number.isFinite(revenue) && revenue > 0 ? Math.round(revenue) : null,
    revenueTbc: raw.revenueTbc === true,
    status: str(raw.status, 500),
    leads,
    tasks: tasks.slice(0, 5),
  };
}

const monthBoundsIso = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return { start: `${month}-01`, end: new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10) };
};

/**
 * POST /api/brands/pitch-import — admins; `{ rows: [...] }` (the previewed rows, as
 * confirmed). Creates brand (brand creators only for new ones; pending unless they are
 * leadership, with the project made on approval), Pitch project and lead tasks.
 */
export async function runPitchImport(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const input = Array.isArray((req.body as { rows?: unknown })?.rows) ? ((req.body as { rows: unknown[] }).rows as Array<Record<string, unknown>>) : [];
  if (input.length === 0 || input.length > MAX_ROWS) {
    res.status(400).json({ error: `Send 1 to ${MAX_ROWS} rows` });
    return;
  }
  const leader = await isProjectApprover(user._id as mongoose.Types.ObjectId);
  const creator = canCreateBrand(user);
  const results: Array<{ client: string; title: string; status: "created" | "skipped" | "failed"; message: string; projectId?: string; tasks?: number }> = [];

  for (const raw of input) {
    const row = parseImportRow(raw);
    const label = { client: String(raw.client ?? ""), title: String(raw.title ?? "") };
    if (typeof row === "string") {
      results.push({ ...label, status: "failed", message: row });
      continue;
    }
    let brand: IBrand | null = await Brand.findOne({ nameKey: brandNameKey(row.client) });
    // The project spans its month and every task date.
    const bounds = monthBoundsIso(row.month);
    const dates = row.tasks.map((t) => t.dueDate).sort();
    const start = dates[0] && dates[0] < bounds.start ? dates[0] : bounds.start;
    const end = dates.at(-1) && dates.at(-1)! > bounds.end ? dates.at(-1)! : bounds.end;
    if (!brand) {
      if (!creator) {
        results.push({ ...label, status: "failed", message: `New brand “${row.client}”: only Nazeer or leadership can create brands — ask them to add it, then import this row again` });
        continue;
      }
      // A creator who isn't leadership: the brand waits for approval, and the
      // Pitch project with its tasks is created when it's approved.
      const setup: BrandSetup | null = leader
        ? null
        : {
            projectType: TYPE,
            month: row.month,
            title: row.title,
            leads: row.leads,
            team: [],
            tasks: [],
            startDate: start,
            endDate: end,
            pitchDates: Object.fromEntries(row.tasks.filter((t) => PITCH_KEY.has(t.title)).map((t) => [PITCH_KEY.get(t.title)!, t.dueDate])) as NonNullable<BrandSetup["pitchDates"]>,
          };
      brand = await Brand.create({
        name: row.client,
        status: leader ? "approved" : "pending",
        requestedBy: user._id,
        ...(leader ? { decidedBy: user._id, decidedAt: new Date() } : {}),
        isPitch: true,
        revenue: row.revenue,
        revenueTbc: row.revenueTbc,
        leads: row.leads.map((id) => new mongoose.Types.ObjectId(id)),
        pendingSetup: setup as unknown as Record<string, unknown> | null,
      });
      if (!leader) {
        await notifyBrandApprovalRequested(brand, user, `It comes with the Pitch project "${row.title}" and its three pitch tasks, created when you approve.`);
        results.push({ ...label, status: "created", message: `New brand ${brand.name} sent to leadership for approval — the Pitch project and its tasks are created when it's approved` });
        continue;
      }
    } else if (brand.status === "pending" || brand.status === "rejected") {
      results.push({ ...label, status: "failed", message: `The brand ${brand.name} is ${brand.status === "pending" ? "waiting for approval" : "not approved"}` });
      continue;
    }

    const name = composeProjectName(brand.name, TYPE, row.month, row.title);
    if (await Project.exists({ name, archivedAt: null })) {
      results.push({ ...label, status: "skipped", message: "Already imported" });
      continue;
    }
    const created = await createProjectCore(
      user,
      {
        naming: { brand: String(brand._id), type: TYPE, month: row.month, title: row.title },
        manager: row.leads[0],
        members: row.leads,
        startDate: start,
        deadline: end,
        summary: [
          `Pitch for ${brand.name}${row.title !== "Pitch" ? ` — ${row.title}` : ""}.`,
          row.revenue ? `Potential revenue: AED ${row.revenue.toLocaleString("en-US")}.` : row.revenueTbc ? "Potential revenue: TBC." : "",
          row.status ? `Status (pitch tracker): ${row.status}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        pitchDates: Object.fromEntries(row.tasks.filter((t) => PITCH_KEY.has(t.title)).map((t) => [PITCH_KEY.get(t.title)!, t.dueDate])),
        pitchLeads: row.leads,
        pitchRevenue: row.revenue,
        pitchRevenueTbc: row.revenueTbc,
      } as never,
      req.ip,
      { activityExtra: { via: "pitch_import" } }
    );
    if ("status" in created) {
      results.push({ ...label, status: "failed", message: (created as { error: string }).error });
      continue;
    }
    const project = created.project;
    // Revenue and tracker status next to the dates createProjectCore stored.
    await Project.updateOne({ _id: project._id }, { $set: { "pitch.revenue": row.revenue, "pitch.revenueTbc": row.revenueTbc, "pitch.status": row.status } });
    const tasks = 3;
    results.push({
      ...label,
      status: "created",
      message: `Created with the ${tasks} pitch tasks`,
      projectId: String(project._id),
      tasks,
    });
  }

  logActivity({
    action: "settings_updated",
    actor: user,
    targetType: "project",
    targetName: "Pitch tracker import",
    details: {
      via: "pitch_import",
      created: results.filter((r) => r.status === "created").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      failed: results.filter((r) => r.status === "failed").length,
    },
    ip: req.ip,
  });
  res.json({ results });
}
