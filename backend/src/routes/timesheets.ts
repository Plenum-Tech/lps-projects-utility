import { Router } from "express";
import {
  approveTimesheet,
  getTimesheet,
  getWeek,
  listPending,
  rejectTimesheet,
  saveEntries,
  submitTimesheet,
} from "../controllers/timesheets.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { requireRole } from "../middlewares/requireRole.js";

// /api/timesheets — weekly timesheets.
const router = Router();
router.use(requireAuth);

// Fixed paths before "/:id".
router.get("/week", getWeek);
router.get("/pending", requireRole("head", "admin"), listPending);

router.get("/:id", getTimesheet);
router.put("/:id/entries", saveEntries);
router.post("/:id/submit", submitTimesheet);
router.post("/:id/approve", requireRole("head", "admin"), approveTimesheet);
router.post("/:id/reject", requireRole("head", "admin"), rejectTimesheet);

export default router;
