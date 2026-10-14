import { Router } from "express";
import { getPlan, listPlanMonths, listPlanRows, savePlan, suggestTeam } from "../controllers/manpower.js";
import { requireManpowerEditor } from "../lib/manpowerAccess.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { requireRole } from "../middlewares/requireRole.js";

// /api/manpower — heads and admins read the plan; leadership and Nazeer save
// versions (lib/manpowerAccess.ts).
const router = Router();
router.use(requireAuth);

router.get("/", requireRole("admin", "head"), listPlanMonths);
// Project form (everyone): the month's rows and the team of the matched / chosen row.
router.get("/rows", listPlanRows);
router.get("/suggest", suggestTeam);
router.get("/:month", requireRole("admin", "head"), getPlan);
router.post("/:month", requireRole("admin", "head"), requireManpowerEditor, savePlan);

export default router;
