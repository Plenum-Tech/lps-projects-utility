import { Router } from "express";
import { createBrandFlow, extractBrandScope, readPitchSheet } from "../controllers/brandFlow.js";
import { previewPitchImport, runPitchImport } from "../controllers/pitchImport.js";
import { exportPitches, listPitches, updatePitch } from "../controllers/pitches.js";
import { createBrand, decideBrand, deleteBrand, listBrands, updateBrand } from "../controllers/brands.js";
import { brandDetail, brandOverview, deleteBrandFile, downloadBrandFile, splitBrand, uploadBrandFiles } from "../controllers/brandDashboard.js";
import { requireBrandCreator, requireBrandManager } from "../lib/brandAccess.js";
import { uploadTaskFilesMiddleware } from "../controllers/taskFiles.js";
import { scopeExtractRateLimit } from "../middlewares/rateLimit.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { requireRole } from "../middlewares/requireRole.js";

// /api/brands — read for everyone; brand creators (Nazeer, lib/brandAccess.ts)
// create and split brands, leadership approves them (unless the creator is
// leadership); edit / delete for admins.
const router = Router();
router.use(requireAuth);

router.get("/", listBrands);
// Brands section: overview + allocation in one call, the brand page.
router.get("/overview", brandOverview);
// Pitch plan tab: every visible Pitch project of a quarter with its automatic status, and the .xlsx.
router.get("/pitches", listPitches);
router.get("/pitches/export", exportPitches);
router.patch("/pitches/:id", updatePitch);
router.post("/", requireBrandCreator, createBrand);
// Brand flow (Brands → New brand): read the scope from files, read the pitch
// tracker, then create the brand with its project, lead tasks and team.
router.post("/scope-extract", requireRole("admin"), scopeExtractRateLimit, uploadTaskFilesMiddleware, extractBrandScope);
router.post("/pitch-sheet", requireRole("admin"), uploadTaskFilesMiddleware, readPitchSheet);
router.post("/flow", requireBrandCreator, uploadTaskFilesMiddleware, createBrandFlow);
// Pitch tracker import: preview the sheet's rows, then create the ticked ones.
router.post("/pitch-import/preview", requireRole("admin"), uploadTaskFilesMiddleware, previewPitchImport);
router.post("/pitch-import", requireRole("admin"), runPitchImport);
router.post("/:id/approval", decideBrand);
router.get("/:id/detail", brandDetail);
router.post("/:id/split", requireBrandCreator, splitBrand);
// The brand's scope documents: everyone downloads; creators and leadership add / remove.
router.get("/:id/files/:fileId", downloadBrandFile);
router.post("/:id/files", requireBrandManager, uploadTaskFilesMiddleware, uploadBrandFiles);
router.delete("/:id/files/:fileId", requireBrandManager, deleteBrandFile);
router.patch("/:id", requireRole("admin"), updateBrand);
router.delete("/:id", requireRole("admin"), deleteBrand);

export default router;
