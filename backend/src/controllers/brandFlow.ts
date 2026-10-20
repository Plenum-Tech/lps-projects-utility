import type { Request, Response } from "express";
import ExcelJS from "exceljs";
import mongoose from "mongoose";
import { logActivity } from "../lib/activityLog.js";
import { isDuplicateKeyError } from "../lib/errors.js";
import { deleteFromGridFs, uploadToGridFs } from "../lib/gridfs.js";
import type { BrandSetup } from "../lib/brandFlow.js";
import { TEAM_ROLE_KEYS } from "../lib/manpowerRoles.js";
import { isProjectApprover } from "../lib/projectApproval.js";
import { extractScope, parseLooseDate } from "../lib/scopeExtract.js";
import { Brand, brandNameKey, BRAND_LIMITS, type IBrand } from "../models/Brand.js";
import type { IProject } from "../models/Project.js";
import { User, type IUser } from "../models/User.js";
import { FieldError, notifyBrandApprovalRequested, parseBrandScope, parseName, parseOrganisation, parseScopeText, parseScopeTotal, sendFieldError, serialize } from "./brands.js";
import { createProjectCore } from "./projects.js";
import { createTaskCore } from "./tasks.js";
import { brandScopeMatch, matchLeadUsers, storedAgreementFrom } from "./brandScope.js";
import { parseMatchRows, storedScopeMatch } from "../lib/scopeMatch.js";
import { recordScopeVersion } from "../lib/scopeVersions.js";
import { BrandScopeVersion } from "../models/BrandScopeVersion.js";

// ---------------------------------------------------------------------------
// Brand flow (Brands → New brand): 1. brand (+ revenue for a pitch),
// 2. scope read from images / PDFs / text, 3. lead + team, then create: the
// brand, its project (scope locked to the brand), the lead's presentation /
// milestone tasks and the team (→ manpower plan line). Admins (leadership
// included); a non-leadership admin's brand and its setup wait for approval.
// ---------------------------------------------------------------------------

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_TASKS = 5;
const MAX_LEADS = 5;

/** POST /api/brands/scope-extract — multipart `files` (+ field `text`): the scope read from them. */
export async function extractBrandScope(req: Request, res: Response): Promise<void> {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  if (files.length === 0 && !text.trim()) {
    res.status(400).json({ error: "Add at least one image or PDF, or type the scope" });
    return;
  }
  const result = await extractScope(files, text);
  // Lead names read from the documents, matched to users (the flow pre-selects them).
  res.json({ ...result, leadMatches: await matchLeadUsers(result.leads ?? []) });
}

/** An agreement document: PDF, image, Word (.docx / .doc) or Excel (.xlsx / .xls). */
export function isAgreementFile(f: { originalname: string; mimetype: string }): boolean {
  return (
    f.mimetype === "application/pdf" ||
    f.mimetype.startsWith("image/") ||
    f.mimetype.includes("wordprocessingml") ||
    f.mimetype === "application/msword" ||
    f.mimetype.includes("spreadsheetml") ||
    f.mimetype === "application/vnd.ms-excel" ||
    /\.(pdf|png|jpe?g|webp|gif|heic|docx?|xlsx?)$/i.test(f.originalname)
  );
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const v = value as { text?: unknown; result?: unknown; richText?: Array<{ text: string }> };
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join("");
    if (v.result !== undefined) return cellText(v.result as ExcelJS.CellValue);
    if (typeof v.text === "string") return v.text;
  }
  return String(value).trim();
}

/** "2026-10-20" / "21st Oct" → date; "November" → that month's last day (marked as month only). */
function sheetDate(raw: string, year: number): { date: string | null; monthOnly: boolean; text: string } {
  const text = raw.trim();
  if (!text || text === "-") return { date: null, monthOnly: false, text: "" };
  const exact = parseLooseDate(text, year);
  if (exact) return { date: exact, monthOnly: false, text };
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const m = months.indexOf(text.toLowerCase().slice(0, 3));
  if (m >= 0 && /^[a-z]+\.?$/i.test(text)) {
    // A month already past means next year's ("April" in an October tracker).
    const thisYear = new Date(Date.UTC(year, m + 1, 0));
    const last = thisYear.getTime() < Date.now() - 31 * 86_400_000 ? new Date(Date.UTC(year + 1, m + 1, 0)) : thisYear;
    return { date: last.toISOString().slice(0, 10), monthOnly: true, text };
  }
  return { date: null, monthOnly: false, text };
}

/** One row of the pitch tracker. */
export interface PitchSheetRow {
  client: string;
  campaign: string;
  revenue: number | null;
  revenueTbc: boolean;
  clientPresentation: ReturnType<typeof sheetDate>;
  milestone1: ReturnType<typeof sheetDate>;
  milestone2: ReturnType<typeof sheetDate>;
  status: string;
  lead: string;
}

/** Reads the pitch tracker (.xlsx): the first sheet with a "Client Name" column. */
export async function parsePitchWorkbook(buffer: Buffer): Promise<{ rows: PitchSheetRow[] } | { error: string }> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    return { error: "That file couldn't be read as an Excel workbook" };
  }
  const year = new Date().getFullYear();
  const rows: PitchSheetRow[] = [];
  for (const sheet of workbook.worksheets) {
    let columns: Record<string, number> | null = null;
    sheet.eachRow((row) => {
      const cells = (row.values as ExcelJS.CellValue[]).map(cellText);
      if (!columns) {
        const at = (re: RegExp) => cells.findIndex((c) => re.test(c));
        const client = at(/client\s*name|^client$|^brand$/i);
        if (client < 0) return;
        columns = {
          client,
          campaign: at(/campaign|idea|project/i),
          revenue: at(/revenue/i),
          pres: at(/client\s*pres/i),
          m1: at(/milestone\s*1/i),
          m2: at(/milestone\s*2/i),
          status: at(/status/i),
          lead: at(/^lead/i),
        };
        return;
      }
      const c = columns;
      const get = (k: string) => (c[k]! >= 0 ? (cells[c[k]!] ?? "").trim() : "");
      const client = get("client");
      if (!client) return;
      const revenueText = get("revenue");
      const revenueNumber = Number(revenueText.replace(/[^\d.]/g, ""));
      rows.push({
        client,
        campaign: get("campaign"),
        revenue: revenueText && Number.isFinite(revenueNumber) && revenueNumber > 0 ? revenueNumber : null,
        revenueTbc: /tbc|tbd/i.test(revenueText),
        clientPresentation: sheetDate(get("pres"), year),
        milestone1: sheetDate(get("m1"), year),
        milestone2: sheetDate(get("m2"), year),
        status: get("status"),
        lead: get("lead"),
      });
    });
    if (rows.length) break;
  }
  return rows.length ? { rows } : { error: 'No rows found: the sheet needs a "Client Name" column' };
}

/**
 * POST /api/brands/pitch-sheet — multipart `files` (one .xlsx: the pitch tracker).
 * Rows: client, campaign, revenue, client presentation, milestones, status, lead.
 */
export async function readPitchSheet(req: Request, res: Response): Promise<void> {
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
  res.json({ rows: parsed.rows.slice(0, 200) });
}

const bad = (error: string) => ({ error });

/** Creates the brand flow's project, the lead's tasks and (through the team) the plan line. */
export async function runBrandSetup(
  brand: IBrand,
  setup: BrandSetup,
  actor: IUser,
  ip: string | undefined
): Promise<{ error: string } | { project: IProject; tasks: number; warnings: string[] }> {
  const created = await createProjectCore(
    actor,
    {
      naming: { brand: String(brand._id), type: setup.projectType, month: setup.month, title: setup.title },
      manager: setup.leads[0],
      members: setup.leads,
      team: setup.team,
      ...(setup.summary ? { summary: setup.summary } : {}),
      // The period read from the files (else the month's first / last day).
      ...(setup.startDate ? { startDate: setup.startDate } : {}),
      ...(setup.endDate ? { deadline: setup.endDate } : {}),
      // Pitch: the project creates the Milestone 1 meeting / Milestone 2 meeting / Client presentation tasks.
      ...(setup.pitchDates
        ? { pitchDates: setup.pitchDates, pitchLeads: setup.leads, pitchRevenue: brand.revenue ?? null, pitchRevenueTbc: Boolean(brand.revenueTbc) }
        : {}),
    } as never,
    ip,
    { activityExtra: { via: "brand_flow" }, allowBrandWithoutScope: true }
  );
  if ("status" in created) return bad((created as { error: string }).error);
  const project = created.project;
  const warnings: string[] = [];
  let tasks = setup.pitchDates ? 3 : 0;
  for (const task of setup.tasks) {
    const result = await createTaskCore(
      actor,
      {
        project: String(project._id),
        title: task.title,
        assignees: setup.leads,
        dueDate: task.dueDate,
        priority: "high",
        description: `<p>${task.title} for ${brand.name} (${project.name}). The brief and scope are in the project's files and scope.</p>`,
      },
      ip,
      { via: "brand_flow" },
      { allowClosedProject: true, allowNoScope: true }
    );
    if ("taskId" in result) tasks++;
    else warnings.push(`${task.title}: ${result.error}`);
  }
  return { project, tasks, warnings };
}

function parseSetup(raw: Record<string, unknown>): BrandSetup {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const projectType = str(raw.projectType);
  if (!projectType) throw new FieldError("projectType", "Choose the project type");
  const month = str(raw.month);
  if (!MONTH.test(month)) throw new FieldError("month", "month must be YYYY-MM");
  const title = str(raw.title).replace(/\s+/g, " ");
  if (!title) throw new FieldError("title", "Enter the project name");
  if (title.length > 80) throw new FieldError("title", "The project name must be 80 characters or fewer");
  const ids = (v: unknown, field: string) => {
    if (!Array.isArray(v)) throw new FieldError(field, `${field} must be a list of user IDs`);
    const out = [...new Set(v.map(String))];
    if (out.some((id) => !mongoose.isValidObjectId(id))) throw new FieldError(field, `${field} must contain valid user IDs`);
    return out;
  };
  const leads = ids(raw.leads, "leads");
  if (leads.length === 0) throw new FieldError("leads", "Pick the lead");
  if (leads.length > MAX_LEADS) throw new FieldError("leads", `At most ${MAX_LEADS} leads`);
  const team: BrandSetup["team"] = [];
  for (const entry of Array.isArray(raw.team) ? (raw.team as Array<Record<string, unknown>>) : []) {
    const role = str(entry?.role);
    if (!TEAM_ROLE_KEYS.includes(role)) throw new FieldError("team", "team has an unknown role");
    const users = ids(entry.users, "team");
    if (users.length && !team.some((t) => t.role === role)) team.push({ role, users });
  }
  const tasks: BrandSetup["tasks"] = [];
  for (const t of Array.isArray(raw.tasks) ? (raw.tasks as Array<Record<string, unknown>>) : []) {
    const taskTitle = str(t?.title).slice(0, 120);
    const dueDate = parseLooseDate(str(t?.dueDate));
    if (!taskTitle || !dueDate) throw new FieldError("tasks", "Each lead task needs a name and a due date");
    tasks.push({ title: taskTitle, dueDate });
  }
  if (tasks.length > MAX_TASKS) throw new FieldError("tasks", `At most ${MAX_TASKS} lead tasks`);
  let pitchDates: BrandSetup["pitchDates"];
  if (raw.pitchDates && typeof raw.pitchDates === "object") {
    const d = raw.pitchDates as Record<string, unknown>;
    const day = (v: unknown) => parseLooseDate(str(v));
    const [cp, m1, m2] = [day(d.clientPresentation), day(d.milestone1), day(d.milestone2)];
    if (cp && m1 && m2) pitchDates = { clientPresentation: cp, milestone1: m1, milestone2: m2 };
  }
  const summary = str(raw.summary).slice(0, 4000);
  const date = (v: unknown, field: "startDate" | "endDate") => {
    const s = str(v);
    if (!s) return undefined;
    const d = parseLooseDate(s);
    if (!d) throw new FieldError(field, `The ${field === "startDate" ? "start" : "end"} date isn't a valid date`);
    return d;
  };
  const startDate = date(raw.startDate, "startDate");
  const endDate = date(raw.endDate, "endDate");
  if (startDate && endDate && endDate < startDate) throw new FieldError("endDate", "The end date must be on or after the start date");
  return {
    projectType,
    month,
    title,
    leads,
    team,
    tasks,
    ...(summary ? { summary } : {}),
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
    ...(pitchDates ? { pitchDates } : {}),
  };
}

/**
 * POST /api/brands/flow — brand creators (lib/brandAccess.ts). multipart: `files` (the brief / SOW the scope was
 * read from) + `data` (JSON: name, organisation, isPitch, revenue, revenueTbc, scopeItems,
 * platforms, notes, scopeText ("Other scope"), projectType, month, title, leads, team, tasks, summary).
 */
export async function createBrandFlow(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(typeof req.body?.data === "string" ? req.body.data : "{}") as Record<string, unknown>;
  } catch {
    res.status(400).json({ error: "data must be JSON" });
    return;
  }
  const files = ((req.files as Express.Multer.File[] | undefined) ?? []).slice(0, BRAND_LIMITS.maxScopeFiles);

  let name: string;
  let setup: BrandSetup;
  let scopeItems: ReturnType<typeof parseBrandScope>;
  let organisation: string;
  let scopeText: string;
  let scopeTotal: ReturnType<typeof parseScopeTotal>;
  try {
    name = parseName(data.name);
    organisation = parseOrganisation(data.organisation);
    if (name.includes("_")) throw new FieldError("name", "Brand names can't contain “_”");
    scopeItems = parseBrandScope(Array.isArray(data.scopeItems) ? data.scopeItems : []);
    if (scopeItems.length === 0) throw new FieldError("scopeItems", "Add at least one scope row");
    // "Other scope": the agreement's scope text not itemised as rows.
    scopeText = parseScopeText(data.scopeText ?? data.otherScope);
    // The agreement's stated total ("96 content pieces per month"): a check for the rows.
    scopeTotal = parseScopeTotal(data.scopeTotal ?? data.statedTotal);
    setup = parseSetup(data);
  } catch (err) {
    if (!sendFieldError(res, err)) throw err;
    return;
  }
  const isPitch = data.isPitch === true;
  // The scope comes from the agreement: a brand (not a pitch — it has no agreement yet) needs the
  // uploaded agreement itself. Typed text alone isn't enough.
  if (!isPitch && !files.some(isAgreementFile)) {
    res.status(400).json({ error: "Upload the agreement (PDF, image, Word or Excel) — typed text alone isn't enough", field: "files" });
    return;
  }
  const revenueTbc = isPitch && data.revenueTbc === true;
  const revenueNum = Number(data.revenue);
  const revenue = isPitch && !revenueTbc && Number.isFinite(revenueNum) && revenueNum > 0 ? Math.round(revenueNum) : null;
  if (isPitch && !revenueTbc && revenue === null) {
    res.status(400).json({ error: "Enter the potential revenue, or mark it TBC", field: "revenue" });
    return;
  }
  if (isPitch) {
    setup.projectType = "Pitch";
    if (!setup.pitchDates) {
      res.status(400).json({ error: "A pitch needs the Client presentation, Milestone 1 and Milestone 2 dates", field: "pitchDates" });
      return;
    }
    setup.tasks = [];
  } else delete setup.pitchDates;
  const list = (v: unknown, max: number, len: number) =>
    (Array.isArray(v) ? v : []).map((x) => String(x).trim().slice(0, len)).filter(Boolean).slice(0, max);

  // Every person named must exist (they are stored until approval for pending brands).
  const people = [...new Set([...setup.leads, ...setup.team.flatMap((t) => t.users)])];
  const found = await User.countDocuments({ _id: { $in: people } });
  if (found !== people.length) {
    res.status(400).json({ error: "Someone picked in the team or as lead no longer exists" });
    return;
  }
  if (await Brand.exists({ nameKey: brandNameKey(name) })) {
    res.status(409).json({ error: `A brand named "${name}" already exists`, field: "name" });
    return;
  }

  const leader = await isProjectApprover(user._id as mongoose.Types.ObjectId);
  // What the agreement says (the flow's read result) and how close the rows are to it — advice only.
  const agreement = storedAgreementFrom(data.agreement);
  const match = agreement
    ? await brandScopeMatch({} as IBrand, scopeItems, { rows: parseMatchRows(agreement.rows), text: agreement.text }, scopeText)
    : null;
  const stored: Array<{ gridFsId: mongoose.Types.ObjectId; filename: string; mimeType: string; size: number }> = [];
  let brand: IBrand;
  try {
    for (const file of files) {
      const filename = file.originalname.slice(0, 255) || "file";
      stored.push({
        gridFsId: await uploadToGridFs(file.buffer, filename, { brandFlow: true, contentType: file.mimetype, uploadedBy: user._id }),
        filename,
        mimeType: file.mimetype,
        size: file.size,
      });
    }
    brand = await Brand.create({
      name,
      organisation,
      status: leader ? "approved" : "pending",
      requestedBy: user._id,
      ...(leader ? { decidedBy: user._id, decidedAt: new Date() } : {}),
      isPitch,
      revenue,
      revenueTbc,
      scopeItems,
      platforms: list(data.platforms, BRAND_LIMITS.maxPlatforms, 40),
      scopeNotes: list(data.notes, BRAND_LIMITS.maxNotes, BRAND_LIMITS.noteMax),
      scopeText,
      scopeTotal,
      scopeFiles: stored,
      leads: setup.leads.map((id) => new mongoose.Types.ObjectId(id)),
      scopeAgreement: agreement,
      scopeMatch: match ? storedScopeMatch(match) : null,
      pendingSetup: leader ? null : (setup as unknown as Record<string, unknown>),
    });
  } catch (err) {
    for (const f of stored) await deleteFromGridFs(f.gridFsId);
    if (isDuplicateKeyError(err)) {
      res.status(409).json({ error: `A brand named "${name}" already exists`, field: "name" });
      return;
    }
    throw err;
  }

  logActivity({
    action: "settings_updated",
    actor: user,
    targetType: "brand",
    targetId: brand._id as mongoose.Types.ObjectId,
    targetName: brand.name,
    details: { brand: "created", via: "brand_flow", isPitch, scopeRows: scopeItems.length, files: stored.length, ...(match ? { scopeMatch: match.score } : {}) },
    ip: req.ip,
  });
  await recordScopeVersion(brand, "create", user._id as mongoose.Types.ObjectId);

  if (!leader) {
    await notifyBrandApprovalRequested(brand, user, `It comes with the project "${setup.title}", lead tasks and a team, created when you approve.`);
    res.status(201).json({
      brand: serialize(brand, 0),
      pendingApproval: `${brand.name} was sent to leadership for approval. The project, lead tasks and team are created when it's approved.`,
    });
    return;
  }

  const result = await runBrandSetup(brand, setup, user, req.ip);
  if ("error" in result) {
    // Nothing half-made: the brand and its files go again, so the flow can be retried.
    await Brand.deleteOne({ _id: brand._id });
    await BrandScopeVersion.deleteMany({ brand: brand._id });
    for (const f of stored) await deleteFromGridFs(f.gridFsId);
    res.status(400).json({ error: result.error });
    return;
  }
  res.status(201).json({
    brand: serialize(brand, 1),
    project: { _id: String(result.project._id), name: result.project.name, code: result.project.code },
    tasks: result.tasks,
    warnings: result.warnings,
  });
}
