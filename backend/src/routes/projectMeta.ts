import { Router } from "express";
import {
  createCategory,
  createStatus,
  deleteCategory,
  deleteStatus,
  getSettings,
  getTimeSettings,
  listCategories,
  listProjectTypes,
  listStatuses,
  reorderStatuses,
  setDefaultStatus,
  updateCategory,
  updateSettings,
  updateStatus,
} from "../controllers/projectMeta.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { requireRole } from "../middlewares/requireRole.js";

// /api/project-meta — read for everyone, write (and settings) for admins.
const router = Router();
router.use(requireAuth);

router.get("/statuses", listStatuses);
router.post("/statuses", requireRole("admin"), createStatus);
// Fixed path before "/statuses/:id".
router.put("/statuses/order", requireRole("admin"), reorderStatuses);
router.patch("/statuses/:id", requireRole("admin"), updateStatus);
router.post("/statuses/:id/default", requireRole("admin"), setDefaultStatus);
router.delete("/statuses/:id", requireRole("admin"), deleteStatus);

router.get("/categories", listCategories);
router.post("/categories", requireRole("admin"), createCategory);
router.patch("/categories/:id", requireRole("admin"), updateCategory);
router.delete("/categories/:id", requireRole("admin"), deleteCategory);

// Project name Types (read: everyone; edit via PATCH /settings { projectTypes }).
router.get("/types", listProjectTypes);

// Any signed-in user: the public subset (where time may be logged).
router.get("/settings/time", getTimeSettings);
router.get("/settings", requireRole("admin"), getSettings);
router.patch("/settings", requireRole("admin"), updateSettings);

export default router;
