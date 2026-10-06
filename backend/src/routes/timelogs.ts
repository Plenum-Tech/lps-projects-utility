import { Router } from "express";
import {
  activeTimer,
  approveTimeLog,
  bulkApprove,
  createTimeLog,
  deleteTimeLog,
  listTimeLogs,
  pauseTimer,
  rejectTimeLog,
  resumeTimer,
  startTimer,
  stopMyTimer,
  stopTimerById,
  updateTimeLog,
} from "../controllers/timelogs.js";
import { requireAuth } from "../middlewares/requireAuth.js";

// /api/timelogs — permissions enforced in the controller.
const router = Router();
router.use(requireAuth);

// Fixed paths before "/:id".
router.get("/", listTimeLogs);
router.get("/active", activeTimer);
router.post("/timer/start", startTimer);
router.post("/timer/pause", pauseTimer);
router.post("/timer/resume", resumeTimer);
router.post("/timer/stop", stopMyTimer);
router.post("/bulk-approve", bulkApprove);
router.post("/", createTimeLog);

router.patch("/:id", updateTimeLog);
router.delete("/:id", deleteTimeLog);
router.post("/:id/stop", stopTimerById);
router.post("/:id/approve", approveTimeLog);
router.post("/:id/reject", rejectTimeLog);

export default router;
