import { Router } from "express";
import {
  askInsight,
  createBoard,
  deleteBoard,
  getBoard,
  insightHeadline,
  insightOptions,
  listBoards,
  listInsightLogs,
  requireLeadership,
  runInsightTool,
  sendBoardReport,
  tickInsightReports,
  updateBoard,
} from "../controllers/insights.js";
import { requireAuth } from "../middlewares/requireAuth.js";

// /api/insights — Leadership Insights: every route is leadership only (/ask is rate limited in server.ts).
const router = Router();
router.use(requireAuth);
router.use(requireLeadership);

router.post("/ask", askInsight);
router.post("/tool", runInsightTool);
router.get("/options", insightOptions);
router.get("/headline", insightHeadline);
router.get("/boards", listBoards);
router.post("/boards", createBoard);
router.get("/boards/:id", getBoard);
router.put("/boards/:id", updateBoard);
router.delete("/boards/:id", deleteBoard);
router.post("/boards/:id/report", sendBoardReport);
router.post("/reports/tick", tickInsightReports);
router.get("/logs", listInsightLogs);

export default router;
