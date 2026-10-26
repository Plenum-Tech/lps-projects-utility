import { Router } from "express";
import {
  deleteCompanyLogo,
  getCompanySettings,
  getPublicSettings,
  logoUploadMiddleware,
  serveCompanyLogo,
  updateCompanySettings,
  uploadCompanyLogo,
} from "../controllers/settings.js";
import { getDeliverySettingsHandler, updateDeliverySettings } from "../controllers/deliverySettings.js";
import { getScopeUnits, updateScopeUnits } from "../controllers/scopeUnitSettings.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { requireRole } from "../middlewares/requireRole.js";

// /api/settings — public reads first (no auth), then admin-only company settings.
// Rate limiting: the global /api standard limiter covers the public endpoints too.
const router = Router();

router.get("/public", getPublicSettings);
router.get("/company/logo", serveCompanyLogo);

router.get("/company", requireAuth, requireRole("admin"), getCompanySettings);
router.patch("/company", requireAuth, requireRole("admin"), updateCompanySettings);
router.put("/company/logo", requireAuth, requireRole("admin"), logoUploadMiddleware, uploadCompanyLogo);
router.delete("/company/logo", requireAuth, requireRole("admin"), deleteCompanyLogo);

// Delivery Pulse settings (traffic managers, teams, rework, brief rules, brand team map).
router.get("/delivery", requireAuth, requireRole("admin"), getDeliverySettingsHandler);
router.patch("/delivery", requireAuth, requireRole("admin"), updateDeliverySettings);

// Scope units: read by every signed-in user (the scope editors), edited by admins / leadership.
router.get("/scope-units", requireAuth, getScopeUnits);
router.put("/scope-units", requireAuth, requireRole("admin"), updateScopeUnits);

export default router;
