import { Router } from "express";
import {
  getDashboardAnalytics,
  getEmployeeDashboard,
  getMyCalendar,
  getMyDashboard,
  getMyWeekTimelogs,
} from "../controllers/dashboard.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { requireRole } from "../middlewares/requireRole.js";

const router = Router();

router.use(requireAuth);

// Employee: personal dashboard (no role restriction).
router.get("/my", getEmployeeDashboard);

// Every role: "My dashboard" (one aggregated call) + its calendar and week time logs.
router.get("/me", getMyDashboard);
router.get("/me/calendar", getMyCalendar);
router.get("/me/timelogs", getMyWeekTimelogs);

// Admin/head: org-wide analytics.
router.get("/analytics", requireRole("admin", "head"), getDashboardAnalytics);

export default router;
