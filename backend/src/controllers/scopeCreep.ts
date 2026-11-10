import type { Request, Response } from "express";
import mongoose from "mongoose";
import { Brand } from "../models/Brand.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";
import { User } from "../models/User.js";
import { currentAppMonth, projectMonth } from "../lib/projectExpiry.js";
import { scopeTotals, scopeUnitOf, type ScopeItem } from "../lib/scopeUnits.js";

// ---------------------------------------------------------------------------
// Scope creep report (leadership): per brand, per month, how far the work went
// beyond what was agreed.
//
//   Extra units          deliverables numbered beyond the project's scope total for
//                        their unit (Video 16 when the scope is 15 Video), or on a
//                        unit the project has no scope for (a free-text unit only when
//                        it carries an over-scope request). Approved and waiting extras
//                        count; rejected over-scope tasks don't. Requests approved under
//                        the old task-count rule on a deliverable within the scope
//                        (Video 1 of 1, several tasks) are not extra.
//   Iterations beyond 2  rework tasks on one deliverable after the second (4 reworks
//                        on Video 4 → +2), split by who asked: client / internal.
//   Creep %              (extra units + iterations beyond 2) ÷ scope units.
//
// A project's month: naming month, else the month in its name, else its deadline
// (lib/projectExpiry). Projects without a scope are listed but don't count.
// ---------------------------------------------------------------------------

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
/** Months shown in the brand × month trend (the report month and the ones before it). */
const TREND_MONTHS = 6;
/** Repeat offender: creep above this in each of the last REPEAT_MONTHS months. */
const REPEAT_PCT = 5;
const REPEAT_MONTHS = 3;
/** Reworks on one deliverable that are part of the deal. */
const FREE_ITERATIONS = 2;

function addMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const pct = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

type Source = "client" | "internal" | "notSet";
const sourceOf = (s: string | null | undefined): Source => (s === "external" ? "client" : s === "internal" ? "internal" : "notSet");

interface ExtraRow {
  deliverable: string;
  unit: string;
  n: number;
  tasks: number;
  taskId: string;
  /** approved / pending (waiting) / unflagged (created beyond scope without an over-scope request). */
  status: "approved" | "pending" | "unflagged";
  decidedBy: string | null;
  decidedAt: Date | null;
}

interface IterationRow {
  deliverable: string;
  reworks: number;
  beyond: number;
  /** Who asked for the rounds after the second. */
  client: number;
  internal: number;
  notSet: number;
  taskId: string;
}

interface ProjectRow {
  _id: string;
  name: string;
  code: string;
  month: string;
  hasScope: boolean;
  scope: Array<{ unit: string; total: number; used: number }>;
  scopeUnits: number;
  used: number;
  extras: ExtraRow[];
  iterations: IterationRow[];
  extra: number;
  iter: number;
  creepPct: number | null;
}

type ProjectDoc = {
  _id: mongoose.Types.ObjectId;
  name: string;
  code?: string;
  brand?: mongoose.Types.ObjectId | null;
  naming?: { month?: string | null } | null;
  deadline?: Date | null;
  scopeItems?: ScopeItem[];
};

/** Projects of the months from..to, with their month. */
async function projectsOf(from: string, to: string) {
  const docs = await Project.find({
    // Projects imported without a naming month carry it in the name or deadline.
    $or: [{ "naming.month": { $gte: from, $lte: to } }, { "naming.month": null }],
    archivedAt: null,
    brand: { $ne: null },
  })
    .select("name code brand naming deadline scopeItems")
    .lean<ProjectDoc[]>();
  return docs
    .map((p) => ({ ...p, month: projectMonth(p as never) }))
    .filter((p): p is ProjectDoc & { month: string } => !!p.month && p.month >= from && p.month <= to);
}

const unitKey = (u: string) => u.trim().toLowerCase();

/** The creep figures of each project (scope, deliverables used, extras, iterations). */
async function projectRows(projects: Array<ProjectDoc & { month: string }>): Promise<ProjectRow[]> {
  const ids = projects.map((p) => p._id);
  if (ids.length === 0) return [];
  const [newWork, reworks] = await Promise.all([
    // New work per deliverable (Video 3): its tasks and over-scope flags.
    Task.aggregate<{
      _id: { project: mongoose.Types.ObjectId; unit: string; n: number };
      label: string;
      tasks: number;
      taskId: mongoose.Types.ObjectId;
      flags: Array<{ status: string; decidedBy: mongoose.Types.ObjectId | null; decidedAt: Date | null } | null>;
    }>([
      {
        $match: {
          project: { $in: ids },
          iteration: { $ne: "rework" },
          status: { $ne: "rejected" },
          "overScope.status": { $ne: "rejected" },
          "titleParts.unit": { $type: "string" },
          "titleParts.quantity": { $type: "number" },
        },
      },
      { $sort: { createdAt: 1 } },
      {
        $group: {
          _id: { project: "$project", unit: { $toLower: { $trim: { input: "$titleParts.unit" } } }, n: "$titleParts.quantity" },
          label: { $first: "$titleParts.unit" },
          tasks: { $sum: 1 },
          taskId: { $first: "$_id" },
          flags: { $push: "$overScope" },
        },
      },
    ]),
    // Rework tasks per deliverable, oldest first (rounds 3+ are beyond the deal).
    Task.aggregate<{
      _id: { project: mongoose.Types.ObjectId; unit: string; n: number };
      label: string;
      sources: Array<string | null>;
      taskId: mongoose.Types.ObjectId;
    }>([
      {
        $match: {
          project: { $in: ids },
          iteration: "rework",
          status: { $ne: "rejected" },
          "titleParts.unit": { $type: "string" },
          "titleParts.quantity": { $type: "number" },
        },
      },
      { $sort: { createdAt: 1 } },
      {
        $group: {
          _id: { project: "$project", unit: { $toLower: { $trim: { input: "$titleParts.unit" } } }, n: "$titleParts.quantity" },
          label: { $first: "$titleParts.unit" },
          sources: { $push: { $ifNull: ["$reworkSource", null] } },
          taskId: { $last: "$_id" },
        },
      },
    ]),
  ]);

  const deciders = new Set<string>();
  for (const d of newWork) for (const f of d.flags) if (f?.decidedBy) deciders.add(String(f.decidedBy));
  const names = new Map(
    (await User.find({ _id: { $in: [...deciders] } }).select("name").lean()).map((u) => [String(u._id), u.name as string])
  );

  const newBy = new Map<string, typeof newWork>();
  for (const d of newWork) {
    const k = String(d._id.project);
    newBy.set(k, [...(newBy.get(k) ?? []), d]);
  }
  const reworkBy = new Map<string, typeof reworks>();
  for (const r of reworks) {
    const k = String(r._id.project);
    reworkBy.set(k, [...(reworkBy.get(k) ?? []), r]);
  }

  return projects.map((p) => {
    const totals = scopeTotals(p.scopeItems);
    const hasScope = totals.size > 0;
    const deliverables = newBy.get(String(p._id)) ?? [];
    const usedBy = new Map<string, number>();
    const extras: ExtraRow[] = [];
    for (const d of deliverables) {
      const key = d._id.unit;
      usedBy.set(key, (usedBy.get(key) ?? 0) + 1);
      const total = totals.get(key)?.total;
      const flags = d.flags.filter((f): f is NonNullable<typeof f> => !!f);
      // Beyond the unit's total, or on a unit the project has no scope for: a known
      // scope unit, or a free-text (legacy) one an admin approved / is asked to approve.
      const beyond = total !== undefined ? d._id.n > total : !!scopeUnitOf(key) || flags.length > 0;
      if (!hasScope || !beyond) continue;
      const approved = flags.find((f) => f.status === "approved");
      const status: ExtraRow["status"] = approved ? "approved" : flags.some((f) => f.status === "pending") ? "pending" : "unflagged";
      const unit = totals.get(key)?.unit ?? scopeUnitOf(key)?.name ?? d.label;
      extras.push({
        deliverable: `${unit} ${d._id.n}`,
        unit,
        n: d._id.n,
        tasks: d.tasks,
        taskId: String(d.taskId),
        status,
        decidedBy: approved?.decidedBy ? (names.get(String(approved.decidedBy)) ?? null) : null,
        decidedAt: approved?.decidedAt ?? null,
      });
    }
    extras.sort((a, b) => a.unit.localeCompare(b.unit) || a.n - b.n);

    const iterations: IterationRow[] = [];
    for (const r of reworkBy.get(String(p._id)) ?? []) {
      if (r.sources.length <= FREE_ITERATIONS) continue;
      const after = r.sources.slice(FREE_ITERATIONS).map(sourceOf);
      const unit = totals.get(r._id.unit)?.unit ?? scopeUnitOf(r._id.unit)?.name ?? r.label;
      iterations.push({
        deliverable: `${unit} ${r._id.n}`,
        reworks: r.sources.length,
        beyond: after.length,
        client: after.filter((s) => s === "client").length,
        internal: after.filter((s) => s === "internal").length,
        notSet: after.filter((s) => s === "notSet").length,
        taskId: String(r.taskId),
      });
    }
    iterations.sort((a, b) => b.beyond - a.beyond || a.deliverable.localeCompare(b.deliverable));

    const scope = [...totals.entries()].map(([key, t]) => ({ unit: t.unit, total: t.total, used: usedBy.get(key) ?? 0 }));
    const scopeUnits = scope.reduce((n, s) => n + s.total, 0);
    const used = scope.reduce((n, s) => n + s.used, 0) + extras.filter((x) => !totals.has(unitKey(x.unit))).length;
    const extra = extras.length;
    const iter = hasScope ? iterations.reduce((n, i) => n + i.beyond, 0) : 0;
    return {
      _id: String(p._id),
      name: p.name,
      code: p.code ?? "",
      month: p.month,
      hasScope,
      scope,
      scopeUnits,
      used,
      extras,
      iterations: hasScope ? iterations : [],
      extra,
      iter,
      creepPct: hasScope ? pct(extra + iter, scopeUnits) : null,
    };
  });
}

interface BrandAcc {
  scopeUnits: number;
  used: number;
  extra: number;
  iter: number;
}
const brandCreep = (b: BrandAcc | undefined) => (b ? pct(b.extra + b.iter, b.scopeUnits) : null);

/** GET /api/reports/scope-creep?month=YYYY-MM — leadership only. */
export async function scopeCreepReport(req: Request, res: Response): Promise<void> {
  const month = typeof req.query.month === "string" && MONTH_RE.test(req.query.month) ? req.query.month : currentAppMonth();
  const first = addMonths(month, -(TREND_MONTHS - 1));
  const months = Array.from({ length: TREND_MONTHS }, (_, i) => addMonths(first, i));

  const projects = await projectsOf(first, month);
  const rows = await projectRows(projects);
  const brandOf = new Map(projects.map((p) => [String(p._id), String(p.brand)]));

  // Per month, per brand: the scoped projects' figures (trend and repeat offenders).
  const byMonth = new Map<string, Map<string, BrandAcc>>(months.map((m) => [m, new Map()]));
  for (const r of rows) {
    if (!r.hasScope) continue;
    const brands = byMonth.get(r.month)!;
    const key = brandOf.get(r._id)!;
    const acc = brands.get(key) ?? { scopeUnits: 0, used: 0, extra: 0, iter: 0 };
    acc.scopeUnits += r.scopeUnits;
    acc.used += r.used;
    acc.extra += r.extra;
    acc.iter += r.iter;
    brands.set(key, acc);
  }
  const monthTotal = (m: string) => {
    let units = 0;
    let over = 0;
    for (const b of byMonth.get(m)?.values() ?? []) {
      units += b.scopeUnits;
      over += b.extra + b.iter;
    }
    return { units, over, pct: pct(over, units) };
  };

  const current = rows.filter((r) => r.month === month);
  const brandIds = [...new Set(current.map((r) => brandOf.get(r._id)!))];
  const trendIds = new Set(brandIds);
  for (const m of months) for (const [id, b] of byMonth.get(m)!) if (b.extra + b.iter > 0) trendIds.add(id);
  const brandDocs = await Brand.find({ _id: { $in: [...trendIds] } })
    .select("name organisation")
    .lean();
  const brandInfo = new Map(brandDocs.map((b) => [String(b._id), { name: b.name as string, organisation: (b.organisation as string) ?? "" }]));

  const heat = (id: string) => months.map((m) => brandCreep(byMonth.get(m)!.get(id)));
  const brands = brandIds
    .map((id) => {
      const projectList = current
        .filter((r) => brandOf.get(r._id) === id)
        .sort((a, b) => (b.extra + b.iter) - (a.extra + a.iter) || a.name.localeCompare(b.name));
      const acc = byMonth.get(month)!.get(id) ?? { scopeUnits: 0, used: 0, extra: 0, iter: 0 };
      return {
        _id: id,
        name: brandInfo.get(id)?.name ?? "Unknown brand",
        organisation: brandInfo.get(id)?.organisation ?? "",
        projects: projectList,
        ...acc,
        creepPct: brandCreep(acc),
        heat: heat(id),
      };
    })
    .sort((a, b) => (b.extra + b.iter) - (a.extra + a.iter) || (b.creepPct ?? -1) - (a.creepPct ?? -1) || a.name.localeCompare(b.name));

  // Trend rows: brands with creep in any of the months, this month's ranking first.
  const rank = new Map(brands.map((b, i) => [b._id, i]));
  const trend = [...trendIds]
    .map((id) => ({ _id: id, name: brandInfo.get(id)?.name ?? "Unknown brand", organisation: brandInfo.get(id)?.organisation ?? "", heat: heat(id) }))
    .filter((t) => t.heat.some((v) => v !== null && v > 0))
    .sort((a, b) => (rank.get(a._id) ?? 1e6) - (rank.get(b._id) ?? 1e6) || a.name.localeCompare(b.name));

  const repeatOffenders = [...trendIds]
    .filter((id) => months.slice(-REPEAT_MONTHS).every((m) => (brandCreep(byMonth.get(m)!.get(id)) ?? 0) > REPEAT_PCT))
    .map((id) => brandInfo.get(id)?.name ?? "Unknown brand")
    .sort();

  const extras = current.flatMap((r) => (r.hasScope ? r.extras : []));
  const iterations = current.flatMap((r) => (r.hasScope ? r.iterations : []));
  const now = monthTotal(month);
  // The month before is only in the trend when TREND_MONTHS > 1.
  const before = monthTotal(addMonths(month, -1));

  res.json({
    month,
    months,
    rules: { freeIterations: FREE_ITERATIONS, repeatPct: REPEAT_PCT, repeatMonths: REPEAT_MONTHS },
    totals: {
      creepPct: now.pct,
      prevCreepPct: before.pct,
      scopeUnits: now.units,
      extra: {
        total: extras.length,
        approved: extras.filter((x) => x.status === "approved").length,
        pending: extras.filter((x) => x.status === "pending").length,
        unflagged: extras.filter((x) => x.status === "unflagged").length,
      },
      iter: {
        total: iterations.reduce((n, i) => n + i.beyond, 0),
        client: iterations.reduce((n, i) => n + i.client, 0),
        internal: iterations.reduce((n, i) => n + i.internal, 0),
        notSet: iterations.reduce((n, i) => n + i.notSet, 0),
      },
      brands: brands.length,
      brandsWithCreep: brands.filter((b) => b.extra + b.iter > 0).length,
      projectsWithoutScope: current.filter((r) => !r.hasScope).length,
    },
    repeatOffenders,
    brands,
    trend,
  });
}
