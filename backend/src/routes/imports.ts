import { Router } from "express";
import {
  downloadErrors,
  downloadTemplate,
  getImport,
  importUploadMiddleware,
  listImports,
  previewImport,
  runImport,
  undoImportHandler,
  validateImport,
} from "../controllers/imports.js";
import { requireAuth } from "../middlewares/requireAuth.js";

// /api/imports — Projects & Tasks import (.xlsx / .csv). Role checks live in the
// controller (projects: admin/head; tasks: admin/head/project managers).
const router = Router();
router.use(requireAuth);

router.get("/", listImports);
router.get("/templates/:type", downloadTemplate);
router.post("/:type/preview", importUploadMiddleware, previewImport);
router.post("/:jobId/validate", validateImport);
router.post("/:jobId/run", runImport);
router.post("/:jobId/undo", undoImportHandler);
router.get("/:jobId/errors.xlsx", downloadErrors);
router.get("/:jobId", getImport);

export default router;
