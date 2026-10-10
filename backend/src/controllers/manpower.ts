import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { logActivity } from "../lib/activityLog.js";
import { linkProjectsToRows } from "../lib/manpower/match.js";
import { MANPOWER_LIMITS, MANPOWER_ROLE_KEYS, MANPOWER_ROLES } from "../lib/manpowerRoles.js";
import { isInvalidObjectId, param } from "../lib/projectAccess.js";
import { Brand } from "../models/Brand.js";
import { Leave } from "../models/Leave.js";
import {
  MANPOWER_SECTIONS,
  ManpowerPlan,
  type IManpowerPlan,
  type IManpowerRow,
  type ManpowerSection,
} from "../models/ManpowerPlan.js";
import { Project } from "../models/Project.js";
import { User } from "../models/User.js";

// /api/manpower — the manpower plan (replaces the planning Excel). Heads and
// admins read it; only admins save, and every save writes a new version.

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

type Invalid = { status: number; error: string };
const bad = (error: string, status = 400): Invalid => ({ status, error });

/** GET /api/manpower — months with a plan, newest first, and the roles. */
export async function listPlanMonths(_req: Request, res: Response): Promise<void> {
  const rows = await ManpowerPlan.aggregate<{ _id: string; latest: number; versions: number; updatedAt: Date }>([
    { $group: { _id: "$month", latest: { $max: "$version" }, versions: { $sum: 1 }, updatedAt: { $max: "$createdAt" } } },
    { $sort: { _id: -1 } },
  ]);
  res.json({
    roles: MANPOWER_ROLES,
    limits: MANPOWER_LIMITS,
    months: rows.map((r) => ({ month: r._id, latestVersion: r.latest, versions: r.versions, updatedAt: r.updatedAt })),
  });
}

/** Calendar days of approved leave inside the month, per user. */
async function leaveDaysByUser(month: string): Promise<Map<string, number>> {
  const [y, m] = month.split("-").map(Number);
  const start = Date.UTC(y!, m! - 1, 1);
  const end = Date.UTC(y!, m!, 0); // last day, midnight
  const leaves = await Leave.find({
    status: "approved",
    startDate: { $lte: new Date(end + 86_399_999) },
    endDate: { $gte: new Date(start) },
  })
    .select("user startDate endDate")
    .lean();
  const days = new Map<string, number>();
  const dayOf = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  for (const l of leaves) {
    const from = Math.max(dayOf(l.startDate), start);
    const to = Math.min(dayOf(l.endDate), end);
    if (to < from) continue;
    const n = Math.round((to - from) / 86_400_000) + 1;
    days.set(String(l.user), (days.get(String(l.user)) ?? 0) + n);
  }
  return days;
}

/** Id of a ref that may be populated ({ _id, … }) or a bare ObjectId. */
function refId(ref: unknown): string | null {
  if (!ref) return null;
  const id = (ref as { _id?: unknown })._id ?? ref;
  return String(id);
}

/** The month's projects linked to each row: { rowKey: [{ _id, code, name }] }. */
async function rowLinks(plan: IManpowerPlan): Promise<Record<string, Array<{ _id: string; code: string; name: string }>>> {
  const [projects, brands] = await Promise.all([
    Project.find({}).select("name code brand naming deadline").lean(),
    Brand.find({}).select("name").lean(),
  ]);
  const links = linkProjectsToRows(
    plan.month,
    plan.rows.map((r) => ({ key: r.key, brand: refId(r.brand), type: r.type, name: r.name })),
    projects.map((p) => ({
      _id: String(p._id),
      name: p.name,
      brand: p.brand ? String(p.brand) : p.naming?.brand ? String(p.naming.brand) : null,
      naming: p.naming ? { type: p.naming.type, month: p.naming.month, title: p.naming.title } : null,
      deadline: p.deadline ?? null,
    })),
    new Map(brands.map((b) => [String(b._id), b.name]))
  );
  const byId = new Map(projects.map((p) => [String(p._id), p]));
  const out: Record<string, Array<{ _id: string; code: string; name: string }>> = {};
  for (const [projectId, rowKey] of links) {
    const p = byId.get(projectId)!;
    (out[rowKey] ??= []).push({ _id: projectId, code: p.code, name: p.name });
  }
  for (const list of Object.values(out)) list.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * GET /api/manpower/:month?version=N — one version (latest by default) with the
 * versions list, linked projects per row, and per-person allocation (rows,
 * roles, leave days, over-allocation) plus the people with nothing planned.
 */
export async function getPlan(req: Request, res: Response): Promise<void> {
  const month = param(req, "month") ?? "";
  if (!MONTH.test(month)) {
    res.status(400).json({ error: "month must be YYYY-MM" });
    return;
  }
  const versions = await ManpowerPlan.find({ month })
    .sort({ version: -1 })
    .select("version note source createdAt createdBy rows.key")
    .populate("createdBy", "name")
    .lean();
  if (versions.length === 0) {
    res.status(404).json({ error: "No plan for this month yet" });
    return;
  }
  const wanted = req.query.version !== undefined ? Number(req.query.version) : versions[0]!.version;
  if (!Number.isInteger(wanted) || !versions.some((v) => v.version === wanted)) {
    res.status(404).json({ error: `Version ${String(req.query.version)} not found` });
    return;
  }
  const plan = await ManpowerPlan.findOne({ month, version: wanted })
    .populate("rows.cells.users", "name designation department")
    .populate("rows.brand", "name shortName color active")
    .populate("createdBy", "name");
  if (!plan) {
    res.status(404).json({ error: "Version not found" });
    return;
  }

  const [links, leaveDays, allUsers] = await Promise.all([
    rowLinks(plan),
    leaveDaysByUser(month),
    User.find({}).select("name designation role").sort({ name: 1 }).lean(),
  ]);

  // Per-person allocation.
  type Alloc = { rows: Map<string, { key: string; name: string; section: ManpowerSection; roles: string[] }> };
  const people = new Map<string, Alloc>();
  for (const row of plan.rows) {
    for (const cell of row.cells) {
      for (const u of cell.users as unknown as Array<{ _id: mongoose.Types.ObjectId }>) {
        if (!u?._id) continue;
        const id = String(u._id);
        const alloc = people.get(id) ?? { rows: new Map() };
        people.set(id, alloc);
        const entry = alloc.rows.get(row.key) ?? { key: row.key, name: row.name, section: row.section, roles: [] };
        if (!entry.roles.includes(cell.role)) entry.roles.push(cell.role);
        alloc.rows.set(row.key, entry);
      }
    }
  }
  const userById = new Map(allUsers.map((u) => [String(u._id), u]));
  const personRows = [...people]
    .map(([id, alloc]) => {
      const rows = [...alloc.rows.values()];
      const active = rows.filter((r) => r.section === "active").length;
      const u = userById.get(id);
      return {
        user: { _id: id, name: u?.name ?? "Unknown", designation: (u as { designation?: string } | undefined)?.designation ?? "" },
        rows,
        activeRows: active,
        pitchRows: rows.length - active,
        leaveDays: leaveDays.get(id) ?? 0,
        overAllocated: active > plan.maxProjectsPerPerson,
      };
    })
    .sort((a, b) => b.activeRows - a.activeRows || a.user.name.localeCompare(b.user.name));
  const available = allUsers
    .filter((u) => !people.has(String(u._id)) && u.role !== "admin")
    .map((u) => ({
      _id: String(u._id),
      name: u.name,
      designation: (u as { designation?: string }).designation ?? "",
      leaveDays: leaveDays.get(String(u._id)) ?? 0,
    }));

  res.json({
    month,
    version: plan.version,
    latestVersion: versions[0]!.version,
    versions: versions.map((v) => ({
      version: v.version,
      note: v.note,
      source: v.source,
      createdAt: v.createdAt,
      createdBy: v.createdBy ? { _id: String((v.createdBy as { _id: unknown })._id), name: (v.createdBy as { name?: string }).name ?? "" } : null,
      rowCount: v.rows?.length ?? 0,
    })),
    plan: plan.toJSON(),
    links,
    people: personRows,
    available,
  });
}

interface RowInput {
  key?: unknown;
  section?: unknown;
  brand?: unknown;
  type?: unknown;
  name?: unknown;
  cells?: unknown;
}

async function parseRows(raw: unknown): Promise<IManpowerRow[] | Invalid> {
  if (!Array.isArray(raw)) return bad("rows must be an array");
  if (raw.length > MANPOWER_LIMITS.maxRows) return bad(`At most ${MANPOWER_LIMITS.maxRows} rows`);
  const brandIds = new Set<string>();
  const userIds = new Set<string>();
  const rows: IManpowerRow[] = [];
  const keys = new Set<string>();
  for (const [i, item] of (raw as RowInput[]).entries()) {
    const at = `Row ${i + 1}`;
    if (!item || typeof item !== "object") return bad(`${at}: invalid row`);
    const name = typeof item.name === "string" ? item.name.replace(/\s+/g, " ").trim() : "";
    if (!name) return bad(`${at}: name is required`);
    if (name.length > MANPOWER_LIMITS.nameMax) return bad(`${at}: name is too long`);
    const section = (item.section ?? "active") as ManpowerSection;
    if (!MANPOWER_SECTIONS.includes(section)) return bad(`${at}: section must be active or pitch`);
    let brand: mongoose.Types.ObjectId | null = null;
    if (item.brand !== null && item.brand !== undefined && item.brand !== "") {
      if (typeof item.brand !== "string" || isInvalidObjectId(item.brand)) return bad(`${at}: invalid brand`);
      brand = new mongoose.Types.ObjectId(item.brand);
      brandIds.add(item.brand);
    }
    let type: string | null = null;
    if (item.type !== null && item.type !== undefined && item.type !== "") {
      if (typeof item.type !== "string" || item.type.trim().length > 30) return bad(`${at}: invalid type`);
      type = item.type.trim();
    }
    let key = typeof item.key === "string" && /^[A-Za-z0-9-]{1,64}$/.test(item.key) ? item.key : randomUUID();
    if (keys.has(key)) key = randomUUID();
    keys.add(key);
    if (!Array.isArray(item.cells)) return bad(`${at}: cells must be an array`);
    const cells: IManpowerRow["cells"] = [];
    const roles = new Set<string>();
    for (const c of item.cells as Array<Record<string, unknown>>) {
      if (!c || typeof c !== "object" || typeof c.role !== "string" || !MANPOWER_ROLE_KEYS.includes(c.role)) {
        return bad(`${at}: invalid role`);
      }
      if (roles.has(c.role)) return bad(`${at}: role ${c.role} appears twice`);
      roles.add(c.role);
      const users = Array.isArray(c.users) ? c.users : [];
      if (users.length > MANPOWER_LIMITS.maxUsersPerCell) return bad(`${at}: too many people in one role`);
      for (const u of users) {
        if (typeof u !== "string" || isInvalidObjectId(u)) return bad(`${at}: invalid person`);
        userIds.add(u);
      }
      const placeholders = Array.isArray(c.placeholders) ? c.placeholders : [];
      if (placeholders.length > MANPOWER_LIMITS.maxPlaceholdersPerCell) return bad(`${at}: too many open slots in one role`);
      const cleanPlaceholders: string[] = [];
      for (const p of placeholders) {
        if (typeof p !== "string") return bad(`${at}: invalid open slot`);
        const t = p.trim();
        if (!t) continue;
        if (t.length > MANPOWER_LIMITS.placeholderMax) return bad(`${at}: open slot text is too long`);
        cleanPlaceholders.push(t);
      }
      const note = typeof c.note === "string" ? c.note.trim() : "";
      if (note.length > MANPOWER_LIMITS.noteMax) return bad(`${at}: note is too long`);
      const notNeeded = c.notNeeded === true;
      if (!notNeeded && users.length === 0 && cleanPlaceholders.length === 0 && !note) continue; // empty cell
      cells.push({
        role: c.role,
        users: notNeeded ? [] : [...new Set(users as string[])].map((u) => new mongoose.Types.ObjectId(u)),
        placeholders: notNeeded ? [] : cleanPlaceholders,
        notNeeded,
        note,
      });
    }
    rows.push({ key, section, brand, type, name, cells });
  }
  const [brandCount, userCount] = await Promise.all([
    brandIds.size ? Brand.countDocuments({ _id: { $in: [...brandIds] } }) : 0,
    userIds.size ? User.countDocuments({ _id: { $in: [...userIds] } }) : 0,
  ]);
  if (brandCount !== brandIds.size) return bad("A brand on the plan no longer exists", 404);
  if (userCount !== userIds.size) return bad("A person on the plan no longer exists", 404);
  return rows;
}

/**
 * POST /api/manpower/:month — admins save the plan as the next version.
 * `baseVersion` is the version the editor started from (null for a new month);
 * a newer save in between returns 409 so nobody overwrites someone else.
 */
export async function savePlan(req: Request, res: Response): Promise<void> {
  const month = param(req, "month") ?? "";
  if (!MONTH.test(month)) {
    res.status(400).json({ error: "month must be YYYY-MM" });
    return;
  }
  const body = (req.body ?? {}) as {
    baseVersion?: unknown;
    rows?: unknown;
    note?: unknown;
    maxProjectsPerPerson?: unknown;
    source?: unknown;
  };
  const rows = await parseRows(body.rows);
  if (!Array.isArray(rows)) {
    res.status(rows.status).json({ error: rows.error });
    return;
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > MANPOWER_LIMITS.versionNoteMax) {
    res.status(400).json({ error: "Version note is too long" });
    return;
  }
  const latest = await ManpowerPlan.findOne({ month }).sort({ version: -1 }).select("version maxProjectsPerPerson").lean();
  const base = body.baseVersion === null || body.baseVersion === undefined ? null : Number(body.baseVersion);
  if ((latest?.version ?? null) !== base) {
    res.status(409).json({
      error: latest
        ? `Someone saved version ${latest.version} while you were editing. Reload to see it, then make your change again.`
        : "This month has no plan yet. Reload and start again.",
      latestVersion: latest?.version ?? null,
    });
    return;
  }
  let maxProjects = latest?.maxProjectsPerPerson ?? MANPOWER_LIMITS.defaultMaxProjectsPerPerson;
  if (body.maxProjectsPerPerson !== undefined) {
    const n = Number(body.maxProjectsPerPerson);
    if (!Number.isInteger(n) || n < 1 || n > MANPOWER_LIMITS.maxProjectsPerPersonMax) {
      res.status(400).json({ error: `maxProjectsPerPerson must be a whole number from 1 to ${MANPOWER_LIMITS.maxProjectsPerPersonMax}` });
      return;
    }
    maxProjects = n;
  }
  const source = body.source === "copy" ? "copy" : "edit";
  try {
    const plan = await ManpowerPlan.create({
      month,
      version: (latest?.version ?? 0) + 1,
      rows,
      note,
      maxProjectsPerPerson: maxProjects,
      source,
      createdBy: req.user!._id,
    });
    logActivity({
      action: "settings_updated",
      actor: req.user,
      targetType: "manpower_plan",
      targetId: plan._id as mongoose.Types.ObjectId,
      targetName: `Manpower plan ${month} v${plan.version}`,
      details: { month, version: plan.version, rows: rows.length, source },
      ip: req.ip,
    });
    res.status(201).json({ month, version: plan.version });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      res.status(409).json({ error: "Someone saved this month at the same moment. Reload and try again." });
      return;
    }
    throw err;
  }
}

/**
 * GET /api/manpower/suggest?brand=&month=&type=&title= — the plan row a new or
 * edited project matches (latest version of its month), as a team by role, so
 * the project's team step can be filled from the plan.
 */
export async function suggestTeam(req: Request, res: Response): Promise<void> {
  const { brand, month, type, title } = req.query as Record<string, string | undefined>;
  if (!brand || isInvalidObjectId(brand) || !month || !MONTH.test(month)) {
    res.status(400).json({ error: "brand and month (YYYY-MM) are required" });
    return;
  }
  const plan = await ManpowerPlan.findOne({ month }).sort({ version: -1 }).populate("rows.cells.users", "name");
  const empty = { row: null, team: [] as Array<{ role: string; users: Array<{ _id: string; name: string }> }> };
  if (!plan) {
    res.json(empty);
    return;
  }
  const brandDoc = await Brand.findById(brand).select("name").lean();
  const composed = [brandDoc?.name ?? "", type ?? "", title ?? ""].join(" ");
  const links = linkProjectsToRows(
    month,
    plan.rows.map((r) => ({ key: r.key, brand: r.brand ? String(r.brand) : null, type: r.type, name: r.name })),
    [{ _id: "candidate", name: composed, brand, naming: { type: type ?? "", month, title: title ?? "" }, deadline: null }],
    new Map([[brand, brandDoc?.name ?? ""]])
  );
  const key = links.get("candidate");
  const row = key ? plan.rows.find((r) => r.key === key) : undefined;
  if (!row) {
    res.json(empty);
    return;
  }
  res.json({
    row: { key: row.key, name: row.name, version: plan.version, month },
    team: row.cells
      .filter((c) => c.users.length > 0)
      .map((c) => ({
        role: c.role,
        users: (c.users as unknown as Array<{ _id: mongoose.Types.ObjectId; name: string }>).map((u) => ({ _id: String(u._id), name: u.name })),
      })),
  });
}
