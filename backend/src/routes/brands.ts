import { Router } from "express";
import { createBrand, decideBrand, deleteBrand, listBrands, updateBrand } from "../controllers/brands.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { requireRole } from "../middlewares/requireRole.js";

// /api/brands — read for everyone; anyone may propose a brand (leadership
// approves it); edit / delete for admins.
const router = Router();
router.use(requireAuth);

router.get("/", listBrands);
router.post("/", createBrand);
router.post("/:id/approval", decideBrand);
router.patch("/:id", requireRole("admin"), updateBrand);
router.delete("/:id", requireRole("admin"), deleteBrand);

export default router;
