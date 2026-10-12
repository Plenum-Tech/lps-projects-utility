import { Router } from "express";
import {
  getBrands,
  getBriefs,
  getDelayed,
  getPeople,
  getPerson,
  getSummary,
  getBrandStructure,
  getTeamMap,
  getTraffic,
  getTeams,
  getWeekly,
} from "../controllers/deliveryAnalytics.js";
import { requireAuth } from "../middlewares/requireAuth.js";

// /api/analytics/delivery/* — Delivery Pulse: view-only, everyone sees everything.
const router = Router();
router.use(requireAuth);

router.get("/delivery/summary", getSummary);
router.get("/delivery/weekly", getWeekly);
router.get("/delivery/teams", getTeams);
router.get("/delivery/brands", getBrands);
router.get("/delivery/delayed", getDelayed);
router.get("/delivery/briefs", getBriefs);
router.get("/delivery/people", getPeople);
router.get("/delivery/people/:id", getPerson);
router.get("/delivery/team-map", getTeamMap);
router.get("/delivery/traffic", getTraffic);
router.get("/delivery/brand-structure", getBrandStructure);

export default router;
