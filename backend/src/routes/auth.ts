import { Router } from "express";
import { login, logout, me } from "../controllers/auth.js";
import { completePasswordReset, requestPasswordReset, verifyPasswordReset } from "../controllers/passwordReset.js";
import { requireAuth } from "../middlewares/requireAuth.js";

const router = Router();

router.post("/login", login);
router.post("/logout", logout);
router.get("/me", requireAuth, me);
// Public forgot-password flow (IP rate-limited in server.ts; codes/tokens only in POST bodies).
router.post("/password-reset/request", requestPasswordReset);
router.post("/password-reset/verify", verifyPasswordReset);
router.post("/password-reset/complete", completePasswordReset);

export default router;
