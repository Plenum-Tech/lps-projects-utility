import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { logActivity } from "../lib/activityLog.js";
import { linkProjectsToRows } from "../lib/manpower/match.js";
import { canEditManpower } from "../lib/manpowerAccess.js";
import { changesSinceSent, ExceptionBatch, isLeadershipActor, requestChange, sendForApproval } from "../lib/changeRequests.js";
import { markPlanNoticeBase, planNoticeInfo, sendPlanNotice } from "../lib/manpowerNotice.js";
import { rowPeopleKey } from "../lib/manpowerSync.js";
import { applyPlanDelta, combineNotes, deltaIsEmpty, planDelta, withoutConflicts } from "../lib/manpowerMerge.js";
import { ChangeRequest } from "../models/ChangeRequest.js";
import { scopeTotals, type ScopeItem } from "../lib/scopeUnits.js";
import { updateProjectCore } from "./projects.js";
import type { IUser } from "../models/User.js";
import { projectMonth } from "../lib/projectExpiry.js";
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
  APPROVED_PLAN,
} from "../models/ManpowerPlan.js";
import { Project } from "../models/Project.js";
import { STAFF_FILTER, User } from "../models/User.js";

// /api/manpower — the manpower plan (replaces the planning Excel). Heads and
// admins read it; leadership and Nazeer save (lib/manpowerAccess.ts), and
// every save writes a new version.

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

type Invalid = { status: number; error: string };
const bad = (error: string, status = 400): Invalid => ({ status, error });

/** GET /api/manpower — months with a plan, newest first, and the roles. */
export async function listPlanMonths(req: Request, res: Response): Promise<void> {
  const approved = { $not: { $in: ["$status", ["pending", "rejected", "superseded"]] } };
  const rows = await ManpowerPlan.aggregate<{
    _id: string;
    latest: number | null;
    any: number;
    pending: number | null;
    versions: number;
    updatedAt: Date;
  }>([
    {
      $group: {
        _id: "$month",
        latest: { $max: { $cond: [approved, "$version", null] } },
        any: { $max: "$version" },
        pending: { $max: { $cond: [{ $eq: ["$status", "pending"] }, "$version", null] } },
        versions: { $sum: 1 },
        updatedAt: { $max: "$createdAt" },
      },
    },
    { $sort: { _id: -1 } },
  ]);
  res.json({
    canEdit: canEditManpower(req.user!),
    roles: MANPOWER_ROLES,
    limits: MANPOWER_LIMITS,
    months: rows.map((r) => ({
      month: r._id,
      latestVersion: r.latest ?? r.any,
      pendingVersion: r.pending ?? null,
      versions: r.versions,
      updatedAt: r.updatedAt,
    })),
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

type ProjectLink = { _id: string; code: string; name: string };

/**
 * The month's projects linked to each row ({ rowKey: [{ _id, code, name }] }),
 * plus the month's projects that match no row (to link from the plan page).
 */
async function rowLinks(
  plan: IManpowerPlan
): Promise<{ links: Record<string, ProjectLink[]>; unlinked: ProjectLink[]; scope: Record<string, Array<{ unit: string; total: number }>> }> {
  const [projects, brands] = await Promise.all([
    Project.find({ archivedAt: null }).select("name code brand naming deadline manpowerRow scopeItems").lean(),
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
      manpowerRow: p.manpowerRow ?? null,
    })),
    new Map(brands.map((b) => [String(b._id), b.name]))
  );
  const byId = new Map(projects.map((p) => [String(p._id), p]));
  const out: Record<string, ProjectLink[]> = {};
  for (const [projectId, rowKey] of links) {
    const p = byId.get(projectId)!;
    (out[rowKey] ??= []).push({ _id: projectId, code: p.code, name: p.name });
  }
  for (const list of Object.values(out)) list.sort((a, b) => a.name.localeCompare(b.name));
  // Each line's scope: the linked projects' scope rows added up per unit.
  const scope: Record<string, Array<{ unit: string; total: number }>> = {};
  for (const [projectId, rowKey] of links) {
    const items = (byId.get(projectId)?.scopeItems ?? []) as ScopeItem[];
    if (!items.length) continue;
    const merged = new Map((scope[rowKey] ?? []).map((t) => [t.unit.toLowerCase(), { ...t }]));
    for (const t of scopeTotals(items).values()) {
      const key = t.unit.toLowerCase();
      merged.set(key, { unit: merged.get(key)?.unit ?? t.unit, total: (merged.get(key)?.total ?? 0) + t.total });
    }
    scope[rowKey] = [...merged.values()];
  }
  const unlinked = projects
    .filter((p) => !links.has(String(p._id)) && projectMonth({ name: p.name, naming: p.naming as never, deadline: p.deadline ?? null }) === plan.month)
    .map((p) => ({ _id: String(p._id), code: p.code, name: p.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { links: out, unlinked, scope };
}

/**
 * GET /api/manpower/rows?month=YYYY-MM — the rows of the month's latest plan
 * (for the project form's "Manpower plan row" picker). Everyone.
 */
export async function listPlanRows(req: Request, res: Response): Promise<void> {
  const month = typeof req.query.month === "string" ? req.query.month : "";
  if (!MONTH.test(month)) {
    res.status(400).json({ error: "month must be YYYY-MM" });
    return;
  }
  const plan = await ManpowerPlan.findOne({ month, ...APPROVED_PLAN }).sort({ version: -1 }).populate("rows.brand", "name").select("version rows.key rows.name rows.type rows.brand rows.section").lean();
  if (!plan) {
    res.json({ month, version: null, rows: [] });
    return;
  }
  res.json({
    month,
    version: plan.version,
    rows: plan.rows.map((r) => {
      const brand = r.brand as unknown as { _id: mongoose.Types.ObjectId; name: string } | null;
      return { key: r.key, name: r.name, type: r.type ?? null, section: r.section, brand: brand ? { _id: String(brand._id), name: brand.name } : null };
    }),
  });
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
    .select("version note source status createdAt createdBy rows.key")
    .populate("createdBy", "name")
    .lean();
  if (versions.length === 0) {
    res.status(404).json({ error: "No plan for this month yet" });
    return;
  }
  // Default: the latest approved version (a pending one only when nothing is approved yet).
  const live = (v: { status?: string }) => !v.status || v.status === "approved";
  const latestApproved = versions.find(live) ?? null;
  const pendingVersion = versions.find((v) => v.status === "pending")?.version ?? null;
  const wanted = req.query.version !== undefined ? Number(req.query.version) : (latestApproved ?? versions[0]!).version;
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

  const [{ links, unlinked, scope }, leaveDays, allUsers] = await Promise.all([
    rowLinks(plan),
    leaveDaysByUser(month),
    User.find(STAFF_FILTER).select("name designation role").sort({ name: 1 }).lean(),
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
    pendingRequest: pendingVersion != null ? await pendingRequestInfo(month, pendingVersion) : null,
    // Leadership: the live changes not emailed yet ("Send email").
    planNotice: (await isLeadershipActor(req.user!)) ? await planNoticeInfo(month) : null,
    // The version edits start from (the latest approved one).
    latestVersion: latestApproved?.version ?? null,
    pendingVersion,
    // The viewer's plan saves are approved at once (leadership); else they wait for approval.
    savesApproved: await isLeadershipActor(req.user!),
    status: plan.status ?? "approved",
    versions: versions.map((v) => ({
      version: v.version,
      note: v.note,
      source: v.source,
      status: v.status ?? "approved",
      createdAt: v.createdAt,
      createdBy: v.createdBy ? { _id: String((v.createdBy as { _id: unknown })._id), name: (v.createdBy as { name?: string }).name ?? "" } : null,
      rowCount: v.rows?.length ?? 0,
    })),
    plan: plan.toJSON(),
    links,
    scope,
    unlinkedProjects: unlinked,
    people: personRows,
    available,
  });
}

/**
 * The month's pending plan change request, for the "not sent yet" banner: sent or
 * not, the lines it holds, how many are new since it was sent, who saved last.
 */
export async function pendingRequestInfo(month: string, version: number) {
  const [request, plan] = await Promise.all([
    ChangeRequest.findOne({ kind: "manpower_plan", status: "pending", month }).sort({ createdAt: -1 }).populate("sentBy", "name"),
    ManpowerPlan.findOne({ month, version }).select("createdAt createdBy").populate("createdBy", "name").lean(),
  ]);
  if (!request) return null;
  const savedBy = plan?.createdBy as unknown as { _id: mongoose.Types.ObjectId; name?: string } | null;
  const sentBy = request.sentBy as unknown as { _id: mongoose.Types.ObjectId; name?: string } | null;
  return {
    _id: String(request._id),
    sent: !request.draft,
    changes: request.changes.length,
    unsent: changesSinceSent(request),
    sentAt: request.sentAt ?? null,
    sentBy: sentBy?._id ? { _id: String(sentBy._id), name: sentBy.name ?? "" } : null,
    savedAt: plan?.createdAt ?? request.updatedAt,
    savedBy: savedBy?._id ? { _id: String(savedBy._id), name: savedBy.name ?? "" } : null,
  };
}

/**
 * POST /api/manpower/:month/send — `{ note? }`: sends the month's saved, waiting plan
 * changes to leadership (one email with every change). Again after more saves: "Send update".
 */
export async function sendPlan(req: Request, res: Response): Promise<void> {
  const month = param(req, "month") ?? "";
  if (!MONTH.test(month)) {
    res.status(400).json({ error: "month must be YYYY-MM" });
    return;
  }
  const body = (req.body ?? {}) as { note?: unknown };
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
  const request = await ChangeRequest.findOne({ kind: "manpower_plan", status: "pending", month }).sort({ createdAt: -1 });
  if (!request) {
    res.status(404).json({ error: "There are no saved plan changes waiting for this month" });
    return;
  }
  const user = req.user!;
  if (!canEditManpower(user) && String(request.requestedBy) !== String(user._id) && !(await isLeadershipActor(user))) {
    res.status(403).json({ error: "Only the plan editors, leadership or the person who saved these changes can send them" });
    return;
  }
  if (!request.draft && changesSinceSent(request) === 0) {
    res.status(409).json({ error: "Nothing new to send — leadership already has these changes" });
    return;
  }
  const update = Boolean(request.sentAt);
  await sendForApproval(request, user, note, req.ip);
  res.json({
    month,
    changeRequestId: String(request._id),
    message: update ? "Update sent to leadership for approval" : `Sent to leadership for approval (${request.changes.length} change${request.changes.length === 1 ? "" : "s"})`,
  });
}

/**
 * POST /api/manpower/:month/notify — `{ note? }`, leadership: emails the plan's changes since the
 * last email (approvers: all of them; each affected person: their own lines). Again later: an update.
 */
export async function notifyPlan(req: Request, res: Response): Promise<void> {
  const month = param(req, "month") ?? "";
  if (!MONTH.test(month)) {
    res.status(400).json({ error: "month must be YYYY-MM" });
    return;
  }
  if (!(await isLeadershipActor(req.user!))) {
    res.status(403).json({ error: "Only leadership can email the plan's changes" });
    return;
  }
  const body = (req.body ?? {}) as { note?: unknown };
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
  const sent = await sendPlanNotice(month, req.user!, note, req.ip);
  if (!sent) {
    res.status(409).json({ error: "Nothing new to email — everyone already has these changes" });
    return;
  }
  res.json({
    month,
    ...sent,
    message: `Emailed ${sent.changes} change${sent.changes === 1 ? "" : "s"} to leadership${sent.people ? ` and ${sent.people} ${sent.people === 1 ? "person" : "people"} affected` : ""}`,
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
/** Every difference between two versions' rows, as lines for the approval email. */
export async function planChanges(before: IManpowerRow[], after: IManpowerRow[]): Promise<Array<{ label: string; before: string; after: string }>> {
  const ids = new Set<string>();
  const brandIds = new Set<string>();
  for (const r of [...before, ...after]) {
    if (r.brand) brandIds.add(String(r.brand));
    for (const c of r.cells) for (const u of c.users ?? []) ids.add(String(u));
  }
  const [users, brands] = await Promise.all([
    User.find({ _id: { $in: [...ids] } }).select("name").lean(),
    Brand.find({ _id: { $in: [...brandIds] } }).select("name").lean(),
  ]);
  const name = new Map(users.map((u) => [String(u._id), u.name]));
  const brandName = new Map(brands.map((b) => [String(b._id), b.name]));
  const role = new Map(MANPOWER_ROLES.map((r) => [r.key as string, r.label as string]));
  const cellText = (row: IManpowerRow | undefined, key: string) => {
    const cell = row?.cells.find((c) => c.role === key);
    if (!cell) return "—";
    if (cell.notNeeded) return "not needed";
    const people = [...(cell.users ?? []).map((u) => name.get(String(u)) ?? "?"), ...(cell.placeholders ?? [])];
    return people.join(", ") || "—";
  };
  const people = (row: IManpowerRow) =>
    row.cells
      .filter((c) => (c.users ?? []).length || (c.placeholders ?? []).length)
      .map((c) => `${role.get(c.role) ?? c.role}: ${cellText(row, c.role)}`)
      .join("; ") || "no people";
  const lineName = (row: IManpowerRow) => (row.brand ? `${row.name} (${brandName.get(String(row.brand)) ?? "brand"})` : row.name);
  const old = new Map(before.map((r) => [r.key, r]));
  const now = new Map(after.map((r) => [r.key, r]));
  const out: Array<{ label: string; before: string; after: string }> = [];
  for (const r of after) {
    const prev = old.get(r.key);
    if (!prev) {
      out.push({ label: `Added line: ${lineName(r)}`, before: "—", after: people(r) });
      continue;
    }
    if (prev.name !== r.name || String(prev.brand ?? "") !== String(r.brand ?? "") || (prev.type ?? "") !== (r.type ?? "")) {
      out.push({ label: "Line renamed", before: `${lineName(prev)}${prev.type ? ` · ${prev.type}` : ""}`, after: `${lineName(r)}${r.type ? ` · ${r.type}` : ""}` });
    }
    for (const key of new Set([...prev.cells, ...r.cells].map((c) => c.role))) {
      const b = cellText(prev, key);
      const a = cellText(r, key);
      if (b !== a) out.push({ label: `${r.name} · ${role.get(key) ?? key}`, before: b, after: a });
    }
  }
  for (const r of before) if (!now.has(r.key)) out.push({ label: `Removed line: ${lineName(r)}`, before: people(r), after: "—" });
  return out;
}

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
  // The base check: edits start from the latest approved version, or from the version waiting
  // for approval (a non-leader editing further from what is already pending, so their earlier
  // changes show). Any other base means someone saved in between: 409, reload. The save is
  // turned into a delta against its base and laid onto the right version (writePlanVersion).
  const [latest, pending] = await Promise.all([
    ManpowerPlan.findOne({ month, ...APPROVED_PLAN }).sort({ version: -1 }).select("version maxProjectsPerPerson rows").lean(),
    ManpowerPlan.findOne({ month, status: "pending" }).sort({ version: -1 }).select("version maxProjectsPerPerson rows").lean(),
  ]);
  const base = body.baseVersion === null || body.baseVersion === undefined ? null : Number(body.baseVersion);
  const fromPending = Boolean(pending) && base === pending!.version;
  if (!fromPending && (latest?.version ?? null) !== base) {
    res.status(409).json({
      error: latest
        ? `Someone saved version ${latest.version} while you were editing. Reload to see it, then make your change again.`
        : "This month has no plan yet. Reload and start again.",
      latestVersion: latest?.version ?? null,
    });
    return;
  }
  let maxProjects = (fromPending ? pending!.maxProjectsPerPerson : latest?.maxProjectsPerPerson) ?? MANPOWER_LIMITS.defaultMaxProjectsPerPerson;
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
    const saved = await writePlanVersion({
      month,
      before: ((fromPending ? pending!.rows : latest?.rows) ?? []) as IManpowerRow[],
      latestVersion: latest?.version ?? null,
      baseVersion: base,
      rows,
      note,
      maxProjectsPerPerson: maxProjects,
      source,
      actor: req.user!,
      ip: req.ip,
    });
    res.status(201).json({ month, version: saved.version, ...(saved.pendingApproval ? { pendingApproval: saved.pendingApproval } : {}) });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      res.status(409).json({ error: "Someone saved this month at the same moment. Reload and try again." });
      return;
    }
    throw err;
  }
}

/**
 * Writes the next version of a month's plan (the save path shared by the plan
 * page, Brands → Allocation, brand splits / moves / renames and project team
 * edits). Leadership's saves are live at once (and update the linked projects'
 * teams); anyone else's wait for leadership approval. Throws a duplicate-key
 * error (11000) on a racing save.
 *
 * One pending version per month, and pending work is never dropped:
 *  - a non-leader's save is a delta against the rows it was made on (`before`),
 *    laid onto the version already pending (if any): the changes add up and the
 *    request shows everything waiting against the approved plan;
 *  - a leadership save is laid onto the latest approved version (only its own
 *    delta, when it was made on the pending version), then the pending version
 *    is rebased on the new approved one (rebasePendingPlan).
 * When the save was made on the very version it lands on, its rows are used as
 * they are (order, everything).
 * Nobody is told about a save: a non-leader's pending changes wait (quietly) until
 * someone sends them for approval (sendPlan); leadership's live changes reach the
 * linked projects' teams quietly, and "Send email" (notifyPlan) tells people later.
 */
export async function writePlanVersion(params: {
  month: string;
  /** Rows the save was made on (`baseVersion`'s rows; [] for a new month). */
  before: IManpowerRow[];
  /** The latest approved version (null: none yet). */
  latestVersion: number | null;
  /** The version `before` is (defaults to `latestVersion`: callers that build on the approved plan). */
  baseVersion?: number | null;
  rows: IManpowerRow[];
  note: string;
  maxProjectsPerPerson: number;
  source: "edit" | "copy";
  actor: IUser;
  ip?: string;
}): Promise<{ version: number; pendingApproval?: string }> {
  const { month, before, actor, ip } = params;
  // Brand-linked lines are named after their brand (new, relinked or renamed lines).
  const { nameLinesAfterBrands } = await import("../lib/manpowerLineNames.js");
  const saved = await nameLinesAfterBrands(params.rows, before);
  const [approved, pending, highest] = await Promise.all([
    ManpowerPlan.findOne({ month, ...APPROVED_PLAN }).sort({ version: -1 }).select("version rows").lean(),
    ManpowerPlan.findOne({ month, status: "pending" }).sort({ version: -1 }).select("version rows note").lean(),
    ManpowerPlan.findOne({ month }).sort({ version: -1 }).select("version").lean(),
  ]);
  const approvedRows = (approved?.rows ?? []) as IManpowerRow[];
  const approvedVersion = approved?.version ?? null;
  const baseVersion = params.baseVersion === undefined ? params.latestVersion : params.baseVersion;
  const needsApproval = !(await isLeadershipActor(actor));
  // Where the save lands: the pending version for a non-leader (changes add up), else the approved plan.
  const onto = needsApproval && pending ? { version: pending.version, rows: pending.rows as IManpowerRow[] } : { version: approvedVersion, rows: approvedRows };
  const merged = baseVersion === onto.version ? saved : applyPlanDelta(onto.rows, planDelta(before, saved));
  // A brand's same-named lines become one (the line just edited, else the latest edited, is kept).
  const { dropDuplicateLinesOnSave } = await import("../lib/manpowerDedupe.js");
  const { rows, repin } = await dropDuplicateLinesOnSave(month, onto.rows, merged);
  const addsUp = needsApproval && Boolean(pending);
  // Leadership: where the changes not emailed yet start (before this version exists).
  if (!needsApproval) await markPlanNoticeBase(month);
  const plan = await ManpowerPlan.create({
    month,
    version: (highest?.version ?? 0) + 1,
    rows,
    note: addsUp ? combineNotes(pending!.note ?? "", params.note, MANPOWER_LIMITS.versionNoteMax) : params.note,
    maxProjectsPerPerson: params.maxProjectsPerPerson,
    source: params.source,
    status: needsApproval ? "pending" : "approved",
    // A pending version records the approved version its changes are made on (for rebasing).
    baseVersion: needsApproval ? approvedVersion : null,
    createdBy: actor._id,
  });
  let pendingApproval: string | undefined;
  if (!needsApproval) {
    // Projects pinned to a dropped duplicate line follow the brand's kept line.
    for (const [from, to] of repin) await Project.updateMany({ manpowerRow: from }, { $set: { manpowerRow: to } });
    await syncPlanToProjects(month, approvedRows, rows, actor, ip, { notify: false });
    // The work waiting for approval is carried onto the new approved version.
    if (pending) await rebasePendingPlan(month, { version: plan.version, rows }, actor, ip, approvedRows);
  } else {
    // One pending version per month: this one (which includes the earlier pending changes) replaces it.
    await ManpowerPlan.updateMany({ month, status: "pending", version: { $ne: plan.version } }, { $set: { status: "superseded" } });
    const changes = await planChanges(approvedRows, rows);
    // Saved quietly: leadership is told when someone sends it ("Send for approval").
    const request = await requestChange({
      kind: "manpower_plan",
      actor,
      title: `Manpower plan ${month} — version ${plan.version}`,
      changes: changes.length ? changes : [{ label: "Plan", before: "—", after: "Saved with no line changes" }],
      payload: { month, version: plan.version },
      month,
      version: plan.version,
      ip,
      send: false,
    });
    pendingApproval = request.draft
      ? `Saved — not sent for approval yet. Use "Send for approval" on the Manpower plan when you're ready (version ${plan.version}).`
      : `Saved — not sent yet. Leadership still sees what you sent; use "Send update" to send the new changes (version ${plan.version}).`;
  }
  logActivity({
    action: "settings_updated",
    actor,
    targetType: "manpower_plan",
    targetId: plan._id as mongoose.Types.ObjectId,
    targetName: `Manpower plan ${month} v${plan.version}`,
    details: { month, version: plan.version, rows: rows.length, source: params.source },
    ip,
  });
  return { version: plan.version, ...(pendingApproval ? { pendingApproval } : {}) };
}

/**
 * After leadership writes approved version `approved`, the month's pending version
 * (if any) is rebased on it: a new pending version = the approved rows + the
 * pending version's own changes (its delta against the approved version it was
 * made on). Where both changed the same cell / line field, leadership's direct
 * edit wins. The old pending version is superseded and the pending change request
 * moves to the new one (its lines recomputed), so there is still exactly one.
 * When nothing of the pending changes is left, the request is closed as superseded.
 * `previousApproved`: the approved rows before `approved` (used when the pending
 * version has no recorded base). Returns the new pending version number, or null.
 */
export async function rebasePendingPlan(
  month: string,
  approved: { version: number; rows: IManpowerRow[] },
  actor: IUser,
  ip?: string,
  previousApproved: IManpowerRow[] = []
): Promise<number | null> {
  const pending = await ManpowerPlan.findOne({ month, status: "pending", version: { $lt: approved.version } }).sort({ version: -1 });
  if (!pending) return null;
  const baseDoc = pending.baseVersion != null ? await ManpowerPlan.findOne({ month, version: pending.baseVersion }).select("rows").lean() : null;
  const baseRows = (baseDoc?.rows ?? previousApproved) as IManpowerRow[];
  const approvedRows = approved.rows;
  const own = withoutConflicts(planDelta(baseRows, pending.rows as IManpowerRow[]), planDelta(baseRows, approvedRows));
  const request = await ChangeRequest.findOne({ kind: "manpower_plan", status: "pending", month }).sort({ createdAt: -1 });
  if (deltaIsEmpty(own)) {
    await ManpowerPlan.updateMany({ month, status: "pending", version: { $lt: approved.version } }, { $set: { status: "superseded" } });
    if (request) {
      request.status = "superseded";
      request.decidedAt = new Date();
      await request.save();
    }
    return null;
  }
  const { dropDuplicateLinesOnSave } = await import("../lib/manpowerDedupe.js");
  const { rows } = await dropDuplicateLinesOnSave(month, approvedRows, applyPlanDelta(approvedRows, own));
  const highest = await ManpowerPlan.findOne({ month }).sort({ version: -1 }).select("version").lean();
  const next = await ManpowerPlan.create({
    month,
    version: (highest?.version ?? approved.version) + 1,
    rows,
    note: pending.note,
    maxProjectsPerPerson: pending.maxProjectsPerPerson,
    source: pending.source,
    status: "pending",
    baseVersion: approved.version,
    createdBy: pending.createdBy,
  });
  await ManpowerPlan.updateMany({ month, status: "pending", version: { $ne: next.version } }, { $set: { status: "superseded" } });
  if (request) {
    const changes = await planChanges(approvedRows, next.rows as IManpowerRow[]);
    request.version = next.version;
    request.payload = { ...(request.payload ?? {}), month, version: next.version };
    request.title = /version \d+/.test(request.title) ? request.title.replace(/version \d+/, `version ${next.version}`) : `Manpower plan ${month} — version ${next.version}`;
    request.changes = (changes.length ? changes : [{ label: "Plan", before: "—", after: "Saved with no line changes" }]).slice(0, 300);
    request.markModified("payload");
    await request.save();
  }
  logActivity({
    action: "settings_updated",
    actor,
    targetType: "manpower_plan",
    targetId: next._id as mongoose.Types.ObjectId,
    targetName: `Manpower plan ${month} v${next.version}`,
    details: { month, version: next.version, rebasedFrom: pending.version, onto: approved.version, status: "pending" },
    ip,
  });
  return next.version;
}

/**
 * GET /api/manpower/suggest?brand=&month=&type=&title= — the plan row a new or
 * edited project matches (latest version of its month), as a team by role, so
 * the project's team step can be filled from the plan.
 */
export async function suggestTeam(req: Request, res: Response): Promise<void> {
  const { brand, month, type, title, row: chosen } = req.query as Record<string, string | undefined>;
  if (!month || !MONTH.test(month) || (!chosen && (!brand || isInvalidObjectId(brand)))) {
    res.status(400).json({ error: "brand (or row) and month (YYYY-MM) are required" });
    return;
  }
  const plan = await ManpowerPlan.findOne({ month, ...APPROVED_PLAN }).sort({ version: -1 }).populate("rows.cells.users", "name");
  const empty = { row: null, team: [] as Array<{ role: string; users: Array<{ _id: string; name: string }> }> };
  if (!plan) {
    res.json(empty);
    return;
  }
  // A row chosen on the project wins over the automatic match.
  const picked = chosen ? plan.rows.find((r) => r.key === chosen) : undefined;
  if (picked) {
    res.json({
      row: { key: picked.key, name: picked.name, version: plan.version, month },
      team: picked.cells
        .filter((c) => c.users.length > 0)
        .map((c) => ({
          role: c.role,
          users: (c.users as unknown as Array<{ _id: mongoose.Types.ObjectId; name: string }>).map((u) => ({ _id: String(u._id), name: u.name })),
        })),
    });
    return;
  }
  if (!brand || isInvalidObjectId(brand)) {
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

/**
 * Plan → projects: after an approved plan change, the projects linked to each
 * changed line get that line's people as their team (plan roles; "Others"
 * stays as it is on the project). `notify: false`: nobody is told (no "added to
 * a project" messages, no "changed from the manpower plan" note to the approvers).
 */
export async function syncPlanToProjects(
  month: string,
  before: IManpowerRow[],
  after: IManpowerRow[],
  actor: IUser,
  ip?: string,
  options: { notify?: boolean } = {}
): Promise<number> {
  // Default (approvals): the approvers and added people are told. A leadership save only on request.
  const notify = options.notify !== false;
  try {
    const old = new Map(before.map((r) => [r.key, rowPeopleKey(r.cells)]));
    const changed = new Map(after.filter((r) => old.get(r.key) !== rowPeopleKey(r.cells)).map((r) => [r.key, r]));
    if (changed.size === 0) return 0;
    const [projects, brands] = await Promise.all([
      Project.find({ archivedAt: null }).select("name brand naming deadline manpowerRow team"),
      Brand.find({}).select("name").lean(),
    ]);
    const links = linkProjectsToRows(
      month,
      after.map((r) => ({ key: r.key, brand: r.brand ? String(r.brand) : null, type: r.type, name: r.name })),
      projects.map((p) => ({
        _id: String(p._id),
        name: p.name,
        brand: p.brand ? String(p.brand) : p.naming?.brand ? String(p.naming.brand) : null,
        naming: p.naming ? { type: p.naming.type, month: p.naming.month, title: p.naming.title } : null,
        deadline: p.deadline ?? null,
        manpowerRow: p.manpowerRow ?? null,
      })),
      new Map(brands.map((b) => [String(b._id), b.name]))
    );
    let updated = 0;
    // Teams changed from the plan: the approvers get one message for this sync.
    const exceptions = new ExceptionBatch("plan_sync", actor);
    // The month's first approved version: projects made before the plan existed are pinned to their line.
    const firstVersion = before.length === 0;
    for (const light of projects) {
      const rowKey = links.get(String(light._id));
      if (firstVersion && rowKey && !light.manpowerRow) {
        await Project.updateOne({ _id: light._id }, { $set: { manpowerRow: rowKey } });
      }
      const row = rowKey ? changed.get(rowKey) : undefined;
      if (!row) continue;
      const project = await Project.findById(light._id);
      if (!project) continue;
      const others = (project.team ?? []).filter((t) => !MANPOWER_ROLE_KEYS.includes(t.role));
      const team = [
        ...row.cells.filter((c) => (c.users ?? []).length).map((c) => ({ role: c.role, users: c.users.map(String) })),
        ...others.map((t) => ({ role: t.role, users: t.users.map(String) })),
      ];
      const result = await updateProjectCore(actor, project, { team } as never, ip, { skipApproval: true, skipPlanSync: true, exceptions, silent: !notify });
      if (!("error" in result)) updated += 1;
    }
    if (notify) await exceptions.flush();
    return updated;
  } catch (err) {
    console.error("[manpower] plan → projects sync failed", month, err);
    return 0;
  }
}
