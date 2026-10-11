import { Router } from "express";
import { decideByToken, getApprovalByToken } from "../controllers/projectApproval.js";

// /api/project-approval/:token — public (the emailed link); the token is the credential.
const router = Router();
router.get("/:token", getApprovalByToken);
router.post("/:token", decideByToken);

export default router;
