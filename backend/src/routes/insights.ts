import { Router } from "express";
import { askInsight, listInsightLogs, requireLeadership } from "../controllers/insights.js";
import { requireAuth } from "../middlewares/requireAuth.js";

// /api/insights — Leadership Insights (leadership only; /ask is rate limited in server.ts).
const router = Router();
router.use(requireAuth);
router.use(requireLeadership);

router.post("/ask", askInsight);
router.get("/logs", listInsightLogs);

export default router;
