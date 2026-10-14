import { Router } from "express";
import { createBrand, decideBrand, deleteBrand, listBrands, updateBrand } from "../controllers/brands.js";
import { createCampaign, listCampaigns } from "../controllers/campaigns.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { requireRole } from "../middlewares/requireRole.js";

// /api/brands — read for everyone; admins create brands (leadership approves
// them unless the admin is in leadership); edit / delete for admins.
const router = Router();
router.use(requireAuth);

router.get("/", listBrands);
router.post("/", requireRole("admin"), createBrand);
router.post("/:id/approval", decideBrand);
// Campaigns live under the brand: everyone reads; anyone may propose one (leadership approves).
router.get("/:id/campaigns", listCampaigns);
router.post("/:id/campaigns", createCampaign);
router.patch("/:id", requireRole("admin"), updateBrand);
router.delete("/:id", requireRole("admin"), deleteBrand);

export default router;
