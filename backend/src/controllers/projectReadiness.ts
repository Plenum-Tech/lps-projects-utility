import type { Request, Response } from "express";
import { currentAppMonth, projectRunsIn } from "../lib/projectExpiry.js";
import { readinessOf, readinessSettings, READINESS_WEIGHTS, isPitchProject } from "../lib/projectReadiness.js";
import { Brand } from "../models/Brand.js";
import { Project } from "../models/Project.js";
import { User } from "../models/User.js";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * GET /api/reports/project-readiness?month=YYYY-MM — leadership: every project and pitch running
 * in the month with its readiness score, lowest first, and the program manager to speak to.
 */
export async function projectReadinessReport(req: Request, res: Response): Promise<void> {
  const month = typeof req.query.month === "string" && MONTH_RE.test(req.query.month) ? req.query.month : currentAppMonth();
  const settings = await readinessSettings();
  const all = await Project.find({ archivedAt: null }).select("name code brand naming deadline startDate scopeItems pitch manager activeThrough createdAt");
  const projects = all.filter((p) => projectRunsIn(p, month));
  const scores = await readinessOf(projects, settings);

  const [brands, managers] = await Promise.all([
    Brand.find({ _id: { $in: projects.flatMap((p) => (p.brand ? [p.brand] : [])) } }).select("name organisation").lean(),
    User.find({ _id: { $in: projects.flatMap((p) => (p.manager ? [p.manager] : [])) } }).select("name").lean(),
  ]);
  const brandName = new Map(brands.map((b) => [String(b._id), b.organisation && b.organisation.toLowerCase() !== b.name.toLowerCase() ? `${b.organisation} › ${b.name}` : b.name]));
  const managerName = new Map(managers.map((u) => [String(u._id), u.name]));

  const rows = projects
    .map((p) => {
      const r = scores.get(String(p._id))!;
      return {
        _id: String(p._id),
        name: p.name,
        code: p.code,
        type: isPitchProject(p) ? "Pitch" : (p.naming?.type ?? "Project"),
        brand: p.brand ? (brandName.get(String(p.brand)) ?? "") : "",
        manager: p.manager ? { _id: String(p.manager), name: managerName.get(String(p.manager)) ?? "Unknown" } : null,
        ...r,
      };
    })
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));

  // Per program manager: their projects' average and how many are red (who to speak to).
  const byManager = new Map<string, { name: string; projects: number; sum: number; red: number }>();
  for (const r of rows) {
    const id = r.manager?._id ?? "none";
    const m = byManager.get(id) ?? { name: r.manager?.name ?? "No manager", projects: 0, sum: 0, red: 0 };
    m.projects++;
    m.sum += r.score;
    if (r.band === "red") m.red++;
    byManager.set(id, m);
  }
  const count = (band: string) => rows.filter((r) => r.band === band).length;
  res.json({
    month,
    settings,
    weights: READINESS_WEIGHTS,
    totals: {
      projects: rows.length,
      average: rows.length ? Math.round(rows.reduce((n, r) => n + r.score, 0) / rows.length) : null,
      green: count("green"),
      amber: count("amber"),
      red: count("red"),
    },
    managers: [...byManager.values()]
      .map((m) => ({ name: m.name, projects: m.projects, average: Math.round(m.sum / m.projects), red: m.red }))
      .sort((a, b) => a.average - b.average),
    projects: rows,
  });
}
