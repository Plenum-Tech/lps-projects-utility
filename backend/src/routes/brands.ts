import { Router } from "express";
import { createBrandFlow, extractBrandScope, readPitchSheet } from "../controllers/brandFlow.js";
import { previewPitchImport, runPitchImport } from "../controllers/pitchImport.js";
import { exportPitches, listPitches, updatePitch } from "../controllers/pitches.js";
import { brandReadiness } from "../controllers/brandReadiness.js";
import { createBrand, decideBrand, deleteBrand, listBrands, moveProjects, previewMoveProjects, renameBrand, updateBrand } from "../controllers/brands.js";
import { brandDetail, brandOverview, deleteBrandFile, downloadBrandFile, splitBrand, uploadBrandFiles } from "../controllers/brandDashboard.js";
import { requireBrandCreator, requireBrandManager, requireBrandRenamer } from "../lib/brandAccess.js";
import { uploadTaskFilesMiddleware } from "../controllers/taskFiles.js";
import { scopeExtractRateLimit, scopeMatchRateLimit } from "../middlewares/rateLimit.js";
import { listScopeVersions, scopeMatch } from "../controllers/brandScope.js";
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
// New projects: which brands are ready (scope, current plan line, lead) — the project form's picker.
router.get("/readiness", brandReadiness);
// Pitch & Growth (/pitches): every visible Pitch project of a quarter with its automatic status, and the .xlsx.
router.get("/pitches", listPitches);
router.get("/pitches/export", exportPitches);
router.patch("/pitches/:id", updatePitch);
router.post("/", requireBrandCreator, createBrand);
// Brand flow (Brands → New brand): read the scope from files, read the pitch
// tracker, then create the brand with its project, lead tasks and team.
router.post("/scope-extract", requireRole("admin"), scopeExtractRateLimit, uploadTaskFilesMiddleware, extractBrandScope);
// Similarity of scope rows to the agreement (advice only), as the rows are edited.
router.post("/scope-match", requireRole("admin"), scopeMatchRateLimit, scopeMatch);
router.post("/pitch-sheet", requireRole("admin"), uploadTaskFilesMiddleware, readPitchSheet);
router.post("/flow", requireBrandCreator, uploadTaskFilesMiddleware, createBrandFlow);
// Pitch tracker import: preview the sheet's rows, then create the ticked ones.
router.post("/pitch-import/preview", requireRole("admin"), uploadTaskFilesMiddleware, previewPitchImport);
router.post("/pitch-import", requireRole("admin"), runPitchImport);
router.post("/:id/approval", decideBrand);
router.get("/:id/detail", brandDetail);
// The brand's scope history: every version with what changed against the one before.
router.get("/:id/scope-versions", listScopeVersions);
router.post("/:id/split", requireBrandCreator, splitBrand);
// Rename (admins only, applied at once) and moving projects to another brand (leadership; others → approval).
router.post("/:id/rename", requireBrandRenamer, renameBrand);
router.post("/:id/move-projects/preview", previewMoveProjects);
router.post("/:id/move-projects", moveProjects);
// The brand's scope documents: everyone downloads; creators and leadership add / remove.
router.get("/:id/files/:fileId", downloadBrandFile);
router.post("/:id/files", requireBrandManager, uploadTaskFilesMiddleware, uploadBrandFiles);
router.delete("/:id/files/:fileId", requireBrandManager, deleteBrandFile);
router.patch("/:id", requireRole("admin"), updateBrand);
router.delete("/:id", requireRole("admin"), deleteBrand);

export default router;
