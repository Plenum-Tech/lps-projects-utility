import { Router } from "express";
import {
  adjustBalance,
  cancelLeave,
  createLeave,
  decideLeave,
  listBalances,
  listLeaves,
  myBalance,
  myLeaves,
} from "../controllers/leaves.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { requireRole } from "../middlewares/requireRole.js";

const router = Router();

router.use(requireAuth);

// Any authenticated user (admins may apply too).
router.post("/", createLeave);
router.get("/mine", myLeaves);
router.get("/balance", myBalance);
router.patch("/:id/cancel", cancelLeave);

// Admin-only: balance management.
router.get("/balances", requireRole("admin"), listBalances);
router.patch("/balances/:userId", requireRole("admin"), adjustBalance);

// Admins (everyone) and department heads (employees of their own department
// only — scoped again in the controller): review and decide requests.
router.get("/", requireRole("admin", "head"), listLeaves);
router.patch("/:id/decide", requireRole("admin", "head"), decideLeave);

export default router;
