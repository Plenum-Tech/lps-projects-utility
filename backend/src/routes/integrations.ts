import { Router } from "express";
import {
  createPearityKey,
  getPearitySettings,
  listPearityKeys,
  pearityStatus,
  revokePearityKey,
  updatePearitySettings,
} from "../controllers/pearity.js";
import {
  apiCreateTag,
  apiCreateTagByNo,
  apiGetTag,
  apiGetTagByNo,
  apiGetTask,
  apiGetTaskByNo,
  apiListTags,
  apiListTasks,
  apiNotFound,
  pearityApiAuth,
  pearityAudit,
  requireScope,
} from "../controllers/pearityApi.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { requireRole } from "../middlewares/requireRole.js";

// /api/integrations/pearity/v1 — server-to-server API (Bearer API key, no cookies).
// Exempt from the global per-IP limit in server.ts; limited per key (600/min) instead.
export const pearityApiRouter = Router();

pearityApiRouter.use(pearityAudit, pearityApiAuth);

pearityApiRouter.get("/tasks", requireScope("pearity:read"), apiListTasks);
// Lookup by the human task number ("GenAI Hub-65", "#56") — registered before /tasks/:taskId.
pearityApiRouter.get("/tasks/by-no", requireScope("pearity:read"), apiGetTaskByNo);
pearityApiRouter.post("/tasks/by-no/tag", requireScope("pearity:tags"), apiCreateTagByNo);
pearityApiRouter.get("/tasks/:taskId", requireScope("pearity:read"), apiGetTask);
pearityApiRouter.post("/tasks/:taskId/tag", requireScope("pearity:tags"), apiCreateTag);
pearityApiRouter.get("/tags", requireScope("pearity:read"), apiListTags);
pearityApiRouter.get("/tags/by-no/:tagNo", requireScope("pearity:read"), apiGetTagByNo);
pearityApiRouter.get("/tags/:tagId", requireScope("pearity:read"), apiGetTag);
pearityApiRouter.use(apiNotFound);

// /api/integrations — session endpoints (status for everyone, settings + keys for admins).
const router = Router();

router.use(requireAuth);

// Any signed-in user: is the Generate button shown?
router.get("/pearity/status", pearityStatus);

router.get("/pearity/settings", requireRole("admin"), getPearitySettings);
router.patch("/pearity/settings", requireRole("admin"), updatePearitySettings);
router.get("/pearity/keys", requireRole("admin"), listPearityKeys);
router.post("/pearity/keys", requireRole("admin"), createPearityKey);
router.post("/pearity/keys/:keyId/revoke", requireRole("admin"), revokePearityKey);

export default router;
