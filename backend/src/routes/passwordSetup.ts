import { Router } from "express";
import { completePasswordSetup, previewPasswordSetup } from "../controllers/passwordSetup.js";

const router = Router();

// Public: the set-password link itself is the credential (rate-limited in server.ts).
router.get("/:token", previewPasswordSetup);
router.post("/:token", completePasswordSetup);

export default router;
