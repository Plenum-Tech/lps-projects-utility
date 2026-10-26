import type { Request, Response } from "express";
import mongoose from "mongoose";
import { logActivity } from "../lib/activityLog.js";
import { MANPOWER_ROLE_KEYS, MANPOWER_ROLES } from "../lib/manpowerRoles.js";
import { refreshScopeUnits, setScopeUnitsCache } from "../lib/scopeUnitSettings.js";
import { SCOPE_UNIT_LIMITS as L, scopeUnitDefs, type ScopeUnitDef } from "../lib/scopeUnits.js";
import { Brand } from "../models/Brand.js";
import { Project } from "../models/Project.js";
import { ScopeUnitSettings } from "../models/ScopeUnitSettings.js";

// ---------------------------------------------------------------------------
// /api/settings/scope-units — GET (any signed-in user: the scope editors offer
// the list) / PUT (admin = admins and leadership): the whole ordered list.
// A unit used by brand or project scope rows can't be removed (hide it);
// a rename keeps the old name as an alias so saved rows stay valid.
// ---------------------------------------------------------------------------

/** Scope rows per unit name (lower-cased), brands and projects together. */
async function rowsPerUnit(): Promise<Map<string, number>> {
  const pipeline = [
    { $unwind: "$scopeItems" },
    { $group: { _id: { $toLower: "$scopeItems.unit" }, n: { $sum: 1 } } },
  ];
  const [brands, projects] = await Promise.all([
    Brand.aggregate<{ _id: string; n: number }>(pipeline),
    Project.aggregate<{ _id: string; n: number }>(pipeline),
  ]);
  const out = new Map<string, number>();
  for (const r of [...brands, ...projects]) if (r._id) out.set(r._id, (out.get(r._id) ?? 0) + r.n);
  return out;
}

const usesOf = (u: ScopeUnitDef, rows: Map<string, number>) =>
  [u.name, ...u.aliases].reduce((n, name) => n + (rows.get(name.toLowerCase()) ?? 0), 0);

async function serialize() {
  const rows = await rowsPerUnit();
  return {
    units: scopeUnitDefs().map((u) => ({ ...u, rowCount: usesOf(u, rows) })),
    roles: MANPOWER_ROLES.map((r) => ({ key: r.key, label: r.label })),
  };
}

/** GET /api/settings/scope-units */
export async function getScopeUnits(_req: Request, res: Response): Promise<void> {
  await refreshScopeUnits();
  res.setHeader("Cache-Control", "private, no-store");
  res.json(await serialize());
}

class FieldError extends Error {}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30) || "unit";

/** The submitted list → definitions (keys kept for existing units, renames remembered as aliases). */
function parseUnits(raw: unknown, before: readonly ScopeUnitDef[]): ScopeUnitDef[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new FieldError("units must be a non-empty list");
  if (raw.length > L.maxUnits) throw new FieldError(`At most ${L.maxUnits} scope units`);
  const byKey = new Map(before.map((u) => [u.key, u]));
  const seenKeys = new Set<string>();
  const seenNames = new Set<string>();
  const out: ScopeUnitDef[] = [];
  for (const [i, item] of (raw as Array<Record<string, unknown>>).entries()) {
    const at = `Unit ${i + 1}`;
    const name = typeof item?.name === "string" ? item.name.replace(/\s+/g, " ").trim() : "";
    if (!name) throw new FieldError(`${at}: enter a name`);
    if (name.length > L.nameMax) throw new FieldError(`${at}: at most ${L.nameMax} characters`);
    if (seenNames.has(name.toLowerCase())) throw new FieldError(`"${name}" is listed twice`);
    seenNames.add(name.toLowerCase());
    const roles = Array.isArray(item.roles) ? [...new Set(item.roles.filter((r): r is string => typeof r === "string"))] : [];
    const unknown = roles.find((r) => !MANPOWER_ROLE_KEYS.includes(r));
    if (unknown) throw new FieldError(`${name}: unknown role "${unknown}"`);
    if (roles.length > L.maxRoles) throw new FieldError(`${name}: at most ${L.maxRoles} roles`);
    const prev = typeof item.key === "string" ? byKey.get(item.key) : undefined;
    let key = prev?.key;
    if (!key || seenKeys.has(key)) {
      const base = slug(name);
      key = base;
      for (let n = 2; seenKeys.has(key) || (byKey.has(key) && byKey.get(key) !== prev); n++) key = `${base}-${n}`;
    }
    seenKeys.add(key);
    const aliases = prev ? [...prev.aliases, ...(prev.name !== name ? [prev.name] : [])] : [];
    out.push({
      key,
      name,
      aliases,
      roles,
      countsTowardTotal: item.countsTowardTotal !== false,
      hidden: item.hidden === true,
    });
  }
  // An alias never shadows a current name; each unit keeps its latest aliases.
  for (const u of out) {
    u.aliases = [...new Map(u.aliases.filter((a) => !seenNames.has(a.toLowerCase())).map((a) => [a.toLowerCase(), a])).values()].slice(-L.maxAliases);
  }
  if (out.every((u) => u.hidden)) throw new FieldError("Keep at least one unit visible");
  return out;
}

/** PUT /api/settings/scope-units — `{ units: [{ key?, name, roles, countsTowardTotal, hidden }] }` in order. */
export async function updateScopeUnits(req: Request, res: Response): Promise<void> {
  await refreshScopeUnits();
  const before = scopeUnitDefs();
  let units: ScopeUnitDef[];
  try {
    units = parseUnits((req.body as Record<string, unknown> | undefined)?.units, before);
  } catch (err) {
    if (err instanceof FieldError) {
      res.status(400).json({ error: err.message, field: "units" });
      return;
    }
    throw err;
  }
  // Removing a unit that scope rows use: refused (hide it instead).
  const kept = new Set(units.map((u) => u.key));
  const removed = before.filter((u) => !kept.has(u.key));
  if (removed.length) {
    const rows = await rowsPerUnit();
    const used = removed.map((u) => ({ u, n: usesOf(u, rows) })).find((x) => x.n > 0);
    if (used) {
      res.status(409).json({ error: `${used.u.name} is used by ${used.n} scope row${used.n === 1 ? "" : "s"} — hide it instead of removing it`, field: "units" });
      return;
    }
  }
  const doc = await ScopeUnitSettings.findOneAndUpdate(
    { key: "scopeUnits" },
    { $set: { units, updatedBy: req.user!._id }, $setOnInsert: { key: "scopeUnits" } },
    { upsert: true, returnDocument: "after" }
  );
  setScopeUnitsCache(units);
  logActivity({
    action: "settings_updated",
    actor: req.user,
    targetType: "scope_units",
    targetId: doc?._id as mongoose.Types.ObjectId | undefined,
    targetName: "Scope units",
    details: { units: units.map((u) => `${u.name}${u.hidden ? " (hidden)" : ""}`) },
    ip: req.ip,
  });
  res.json(await serialize());
}
