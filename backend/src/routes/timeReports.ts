import { Router } from "express";
import {
  taskExport,
  taskSummary,
  timeExport,
  timesheetExport,
  timesheetReport,
  timeSummary,
} from "../controllers/timeReports.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { requireRole } from "../middlewares/requireRole.js";

/**
 * Work reports under /api/reports (head + admin; heads see their department).
 * Mounted BEFORE the admin-only HR reports router: guards are per route (not
 * router.use) so unmatched paths fall through to the HR router untouched.
 */
const router = Router();
const guard = [requireAuth, requireRole("head", "admin")];

router.get("/tasks/summary", ...guard, taskSummary);
router.get("/tasks/export", ...guard, taskExport);
router.get("/time/summary", ...guard, timeSummary);
router.get("/time/export", ...guard, timeExport);
router.get("/timesheets", ...guard, timesheetReport);
router.get("/timesheets/export", ...guard, timesheetExport);

export default router;
