import { Router } from "express";
import {
  acceptInvitation,
  createInvitations,
  listInvitations,
  previewInvitation,
  resendInvitation,
  revokeInvitation,
} from "../controllers/invitations.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { requireRole } from "../middlewares/requireRole.js";

const router = Router();

// Public: the invite link itself is the credential (rate-limited in server.ts).
// Registered before `/:id` routes so "accept" is never parsed as an id.
router.get("/accept/:token", previewInvitation);
router.post("/accept/:token", acceptInvitation);

// Admin only.
router.get("/", requireAuth, requireRole("admin"), listInvitations);
router.post("/", requireAuth, requireRole("admin"), createInvitations);
router.post("/:id/resend", requireAuth, requireRole("admin"), resendInvitation);
router.delete("/:id", requireAuth, requireRole("admin"), revokeInvitation);

export default router;
