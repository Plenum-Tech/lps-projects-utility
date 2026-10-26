import mongoose from "mongoose";
import { Brand } from "../models/Brand.js";
import { ChangeRequest } from "../models/ChangeRequest.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";

// ---------------------------------------------------------------------------
// Settings → Scope units: a renamed unit is renamed in the data that uses it, in
// one pass per collection (bulk writes; case-insensitive exact match):
//   - brands: scope rows and the agreement's rows,
//   - projects: scope rows,
//   - tasks: the controlled name's unit, the title's leading unit word
//     ("Reel 3 – BTS" → "Animation 3 – BTS") and a pending over-scope flag,
//   - pending scope change requests (brand_edit / project_change payload rows).
// History stays as it was: scope versions, task history, activity logs and
// decided change requests. The old name is also kept as an alias (Settings),
// so anything missed still validates.
// ---------------------------------------------------------------------------

export interface ScopeUnitRenameCounts {
  brandRows: number;
  agreementRows: number;
  projectRows: number;
  tasks: number;
  requests: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Rows with a renamed unit get the new name; returns the new list and how many changed (null = none). */
function renameRows<T>(rows: T[] | undefined | null, map: Map<string, string>): { rows: T[]; n: number } | null {
  if (!Array.isArray(rows)) return null;
  let n = 0;
  const out = rows.map((r) => {
    const unit = (r as { unit?: unknown })?.unit;
    const to = typeof unit === "string" ? map.get(unit.trim().toLowerCase()) : undefined;
    if (!to || to === unit) return r;
    n++;
    return { ...r, unit: to };
  });
  return n ? { rows: out, n } : null;
}

/**
 * Renames units in the data. `renames`: each unit's old names (its previous name and earlier
 * aliases) → its new name. All renames are applied together (a swap of two names works).
 */
export async function renameScopeUnits(renames: Array<{ from: string[]; to: string }>): Promise<ScopeUnitRenameCounts> {
  const counts: ScopeUnitRenameCounts = { brandRows: 0, agreementRows: 0, projectRows: 0, tasks: 0, requests: 0 };
  const map = new Map<string, string>();
  for (const r of renames) for (const f of r.from) if (f.trim()) map.set(f.trim().toLowerCase(), r.to);
  if (!map.size) return counts;
  const rx = { $regex: `^(?:${[...map.keys()].map(escapeRe).join("|")})$`, $options: "i" };

  // Brands: scope rows + the agreement's rows.
  const brands = await Brand.find({ $or: [{ "scopeItems.unit": rx }, { "scopeAgreement.rows.unit": rx }] })
    .select("scopeItems scopeAgreement")
    .lean();
  const brandOps: mongoose.AnyBulkWriteOperation[] = [];
  for (const b of brands) {
    const set: Record<string, unknown> = {};
    const items = renameRows(b.scopeItems, map);
    if (items) {
      set.scopeItems = items.rows;
      counts.brandRows += items.n;
    }
    const agreement = renameRows(b.scopeAgreement?.rows, map);
    if (agreement) {
      set["scopeAgreement.rows"] = agreement.rows;
      counts.agreementRows += agreement.n;
    }
    if (Object.keys(set).length) brandOps.push({ updateOne: { filter: { _id: b._id }, update: { $set: set } } });
  }
  if (brandOps.length) await Brand.bulkWrite(brandOps as Parameters<typeof Brand.bulkWrite>[0]);

  // Projects: scope rows.
  const projects = await Project.find({ "scopeItems.unit": rx }).select("scopeItems").lean();
  const projectOps: mongoose.AnyBulkWriteOperation[] = [];
  for (const p of projects) {
    const items = renameRows(p.scopeItems, map);
    if (!items) continue;
    counts.projectRows += items.n;
    projectOps.push({ updateOne: { filter: { _id: p._id }, update: { $set: { scopeItems: items.rows } } } });
  }
  if (projectOps.length) await Project.bulkWrite(projectOps as Parameters<typeof Project.bulkWrite>[0]);

  // Tasks: the controlled name's unit and the title's leading unit word; a pending over-scope flag.
  const tasks = await Task.find({ $or: [{ "titleParts.unit": rx }, { "overScope.status": "pending", "overScope.unit": rx }] })
    .select("title titleParts overScope")
    .lean();
  const lead = new RegExp(`^(${[...map.keys()].map(escapeRe).join("|")})(?=\\s)`, "i");
  const taskOps: mongoose.AnyBulkWriteOperation[] = [];
  for (const t of tasks) {
    const set: Record<string, unknown> = {};
    const partTo = t.titleParts?.unit ? map.get(t.titleParts.unit.trim().toLowerCase()) : undefined;
    if (partTo && partTo !== t.titleParts!.unit) {
      set["titleParts.unit"] = partTo;
      const m = lead.exec(t.title ?? "");
      if (m) set.title = `${map.get(m[1]!.toLowerCase())}${t.title.slice(m[0].length)}`.slice(0, 200);
    }
    const flagTo = t.overScope?.status === "pending" && t.overScope.unit ? map.get(t.overScope.unit.trim().toLowerCase()) : undefined;
    if (flagTo && flagTo !== t.overScope!.unit) set["overScope.unit"] = flagTo;
    if (Object.keys(set).length) taskOps.push({ updateOne: { filter: { _id: t._id }, update: { $set: set } } });
  }
  if (taskOps.length) await Task.bulkWrite(taskOps as Parameters<typeof Task.bulkWrite>[0]);
  counts.tasks = taskOps.length;

  // Scope change requests still waiting (drafts included): the proposed rows.
  const requests = await ChangeRequest.find({
    status: "pending",
    kind: { $in: ["brand_edit", "project_change"] },
    $or: [{ "payload.scopeItems.unit": rx }, { "payload.scopeAgreement.rows.unit": rx }],
  })
    .select("payload")
    .lean();
  const requestOps: mongoose.AnyBulkWriteOperation[] = [];
  for (const r of requests) {
    const payload = (r.payload ?? {}) as Record<string, unknown>;
    const set: Record<string, unknown> = {};
    const items = renameRows(payload.scopeItems as unknown[] | undefined, map);
    if (items) set["payload.scopeItems"] = items.rows;
    const agreement = renameRows((payload.scopeAgreement as { rows?: unknown[] } | undefined)?.rows, map);
    if (agreement) set["payload.scopeAgreement.rows"] = agreement.rows;
    if (Object.keys(set).length) requestOps.push({ updateOne: { filter: { _id: r._id }, update: { $set: set } } });
  }
  if (requestOps.length) await ChangeRequest.bulkWrite(requestOps as Parameters<typeof ChangeRequest.bulkWrite>[0]);
  counts.requests = requestOps.length;
  return counts;
}
