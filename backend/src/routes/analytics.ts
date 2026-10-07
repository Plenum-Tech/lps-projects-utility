import { Router } from "express";
import {
  getBrands,
  getBriefs,
  getDelayed,
  getPeople,
  getPerson,
  getSummary,
  getTeamMap,
  getTeams,
  getWeekly,
} from "../controllers/deliveryAnalytics.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { requireRole } from "../middlewares/requireRole.js";

// /api/analytics/delivery/* — Delivery Pulse. Admins see everything; heads are
// scoped to tasks where any doer is in their department; employees get 403.
const router = Router();
router.use(requireAuth, requireRole("admin", "head"));

router.get("/delivery/summary", getSummary);
router.get("/delivery/weekly", getWeekly);
router.get("/delivery/teams", getTeams);
router.get("/delivery/brands", getBrands);
router.get("/delivery/delayed", getDelayed);
router.get("/delivery/briefs", getBriefs);
router.get("/delivery/people", getPeople);
router.get("/delivery/people/:id", getPerson);
router.get("/delivery/team-map", getTeamMap);

export default router;
