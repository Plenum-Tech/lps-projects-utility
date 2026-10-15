import { Router } from "express";
import {
  taskExport,
  taskSummary,
  timeBreakdown,
  timeExport,
  timeExportXlsx,
  timesheetExport,
  timesheetReport,
  timeSummary,
} from "../controllers/timeReports.js";
import { pearityExport, pearityReport } from "../controllers/pearityReport.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { requireTimeReportAccess } from "../lib/reportAccess.js";

/**
 * Work reports under /api/reports. Task Report and Pearity stats: everyone (view-only). Time Log
 * Report and timesheets: admins, heads (their department) and Finance.
 */
const router = Router();
const everyone = [requireAuth];
const guard = [requireAuth, requireTimeReportAccess];

router.get("/tasks/summary", ...everyone, taskSummary);
router.get("/tasks/export", ...everyone, taskExport);
// Pearity stats: view-only, everyone (like the Task Report and Delivery Pulse).
router.get("/pearity", ...everyone, pearityReport);
router.get("/pearity/export", ...everyone, pearityExport);
router.get("/time/summary", ...guard, timeSummary);
router.get("/time/export", ...guard, timeExport);
router.get("/time/export.xlsx", ...guard, timeExportXlsx);
router.get("/time/breakdown", ...guard, timeBreakdown);
router.get("/timesheets", ...guard, timesheetReport);
router.get("/timesheets/export", ...guard, timesheetExport);

export default router;
