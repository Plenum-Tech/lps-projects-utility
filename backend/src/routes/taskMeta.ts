import { Router } from "express";
import {
  createCategory,
  createLabel,
  deleteCategory,
  deleteLabel,
  getSettings,
  listCategories,
  listLabels,
  updateCategory,
  updateLabel,
  updateSettings,
} from "../controllers/taskMeta.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { requireRole } from "../middlewares/requireRole.js";

// /api/task-labels — read for everyone, write for admins.
export const taskLabelsRouter = Router();
taskLabelsRouter.use(requireAuth);
taskLabelsRouter.get("/", listLabels);
taskLabelsRouter.post("/", requireRole("admin"), createLabel);
taskLabelsRouter.patch("/:id", requireRole("admin"), updateLabel);
taskLabelsRouter.delete("/:id", requireRole("admin"), deleteLabel);

// /api/task-categories — read for everyone, write for admins.
export const taskCategoriesRouter = Router();
taskCategoriesRouter.use(requireAuth);
taskCategoriesRouter.get("/", listCategories);
taskCategoriesRouter.post("/", requireRole("admin"), createCategory);
taskCategoriesRouter.patch("/:id", requireRole("admin"), updateCategory);
taskCategoriesRouter.delete("/:id", requireRole("admin"), deleteCategory);

// /api/task-settings — admin only.
export const taskSettingsRouter = Router();
taskSettingsRouter.use(requireAuth, requireRole("admin"));
taskSettingsRouter.get("/", getSettings);
taskSettingsRouter.patch("/", updateSettings);
