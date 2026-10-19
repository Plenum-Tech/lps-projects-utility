import type { Request, Response } from "express";
import { brandReadinessMap } from "../lib/brandReadiness.js";

/**
 * GET /api/brands/readiness — every brand's readiness for a NEW non-pitch project
 * (scope, a line in the current month's approved plan, a lead): the project form's brand picker.
 */
export async function brandReadiness(_req: Request, res: Response): Promise<void> {
  const { month, byBrand } = await brandReadinessMap();
  res.json({ month, brands: Object.fromEntries(byBrand) });
}
