import { Router } from "express";
import { login, logout, me } from "../controllers/auth.js";
import { completePasswordReset, requestPasswordReset, verifyPasswordReset } from "../controllers/passwordReset.js";
import { ssoCallback, ssoConfig, ssoStart } from "../controllers/sso.js";
import { requireAuth } from "../middlewares/requireAuth.js";

const router = Router();

router.post("/login", login);
router.post("/logout", logout);
router.get("/me", requireAuth, me);
// Entra SSO (optional): password login stays; invite-only — no JIT user create.
router.get("/sso/config", ssoConfig);
router.get("/sso/entra/start", ssoStart);
router.post("/sso/entra/callback", ssoCallback);
// Public forgot-password flow (IP rate-limited in server.ts; codes/tokens only in POST bodies).
router.post("/password-reset/request", requestPasswordReset);
router.post("/password-reset/verify", verifyPasswordReset);
router.post("/password-reset/complete", completePasswordReset);

export default router;
