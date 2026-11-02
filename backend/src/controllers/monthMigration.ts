import type { Request, Response } from "express";
import { isMonth, migrationCandidates, nextMonth, runMonthMigration } from "../lib/monthMigration.js";

/** `from` (default: last month) and `to` (default: the month after `from`). */
function months(raw: { from?: unknown; to?: unknown }): { from: string; to: string } | { error: string } {
  const today = new Date().toISOString().slice(0, 7);
  const [y, m] = today.split("-").map(Number);
  const lastMonth = `${m === 1 ? y! - 1 : y}-${String(m === 1 ? 12 : m! - 1).padStart(2, "0")}`;
  const from = raw.from === undefined || raw.from === "" ? lastMonth : raw.from;
  if (!isMonth(from)) return { error: "from must be YYYY-MM" };
  const to = raw.to === undefined || raw.to === "" ? nextMonth(from) : raw.to;
  if (!isMonth(to)) return { error: "to must be YYYY-MM" };
  if (to <= from) return { error: "The new month must be after the old one" };
  return { from, to };
}

/** GET /api/brands/month-migration?from=&to= — brand creators / leadership: what would roll over. */
export async function previewMonthMigration(req: Request, res: Response): Promise<void> {
  const m = months(req.query);
  if ("error" in m) {
    res.status(400).json({ error: m.error });
    return;
  }
  res.json(await migrationCandidates(m.from, m.to));
}

/** POST /api/brands/month-migration { from, to, brandIds } — copies plan lines + projects, no approval. */
export async function runMigration(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { from?: unknown; to?: unknown; brandIds?: unknown };
  const m = months(body);
  if ("error" in m) {
    res.status(400).json({ error: m.error });
    return;
  }
  const ids = body.brandIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 300 || ids.some((id) => typeof id !== "string")) {
    res.status(400).json({ error: "Pick at least one brand" });
    return;
  }
  res.json(await runMonthMigration({ ...m, brandIds: ids as string[], actor: req.user!, ip: req.ip }));
}
