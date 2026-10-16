import { Router } from "express";
import { createBrandFlow, extractBrandScope, readPitchSheet } from "../controllers/brandFlow.js";
import { createBrand, decideBrand, deleteBrand, listBrands, updateBrand } from "../controllers/brands.js";
import { uploadTaskFilesMiddleware } from "../controllers/taskFiles.js";
import { scopeExtractRateLimit } from "../middlewares/rateLimit.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { requireRole } from "../middlewares/requireRole.js";

// /api/brands — read for everyone; admins create brands (leadership approves
// them unless the admin is in leadership); edit / delete for admins.
const router = Router();
router.use(requireAuth);

router.get("/", listBrands);
router.post("/", requireRole("admin"), createBrand);
// Brand flow (Brands → New brand): read the scope from files, read the pitch
// tracker, then create the brand with its project, lead tasks and team.
router.post("/scope-extract", requireRole("admin"), scopeExtractRateLimit, uploadTaskFilesMiddleware, extractBrandScope);
router.post("/pitch-sheet", requireRole("admin"), uploadTaskFilesMiddleware, readPitchSheet);
router.post("/flow", requireRole("admin"), uploadTaskFilesMiddleware, createBrandFlow);
router.post("/:id/approval", decideBrand);
router.patch("/:id", requireRole("admin"), updateBrand);
router.delete("/:id", requireRole("admin"), deleteBrand);

export default router;
