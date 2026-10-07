import { Router } from "express";
import {
  createUser,
  deleteUser,
  getEmailPreferences,
  getMe,
  listUsers,
  updateEmailPreferences,
  updateMe,
  updateUser,
} from "../controllers/users.js";
import { createPasswordLink, createPasswordLinks } from "../controllers/passwordSetup.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { requireRole } from "../middlewares/requireRole.js";

const router = Router();

// Any authenticated user can update their own profile (name + password).
// NOTE: must be registered before `/:id` so "me" isn't parsed as an ObjectId.
router.get("/me", requireAuth, getMe);
router.patch("/me", requireAuth, updateMe);
router.get("/me/email-preferences", requireAuth, getEmailPreferences);
router.patch("/me/email-preferences", requireAuth, updateEmailPreferences);

// Admin-only: list users (e.g. for department assignment) and create users — no public registration endpoint
router.get("/", requireAuth, requireRole("admin"), listUsers);
router.post("/", requireAuth, requireRole("admin"), createUser);
// Set-password links (imported users without a usable password; also works as an admin reset).
router.post("/password-links", requireAuth, requireRole("admin"), createPasswordLinks);
router.post("/:id/password-link", requireAuth, requireRole("admin"), createPasswordLink);
router.patch("/:id", requireAuth, requireRole("admin"), updateUser);
router.delete("/:id", requireAuth, requireRole("admin"), deleteUser);

export default router;
