import { Router } from "express";
import { emailStatus, sendTestEmail } from "../controllers/emailAdmin.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { requireRole } from "../middlewares/requireRole.js";

const router = Router();

router.use(requireAuth, requireRole("admin"));

// SMTP status for the task-settings page.
router.get("/email/status", emailStatus);

// Verify SMTP, then send a test email (defaults to the admin's own address).
router.post("/email/test", sendTestEmail);

export default router;
