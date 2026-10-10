import { Router } from "express";
import { getPlan, listPlanMonths, savePlan, suggestTeam } from "../controllers/manpower.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { requireRole } from "../middlewares/requireRole.js";

// /api/manpower — heads and admins read the plan; only admins save versions.
const router = Router();
router.use(requireAuth);

router.get("/", requireRole("admin", "head"), listPlanMonths);
router.get("/suggest", requireRole("admin", "head"), suggestTeam);
router.get("/:month", requireRole("admin", "head"), getPlan);
router.post("/:month", requireRole("admin"), savePlan);

export default router;
