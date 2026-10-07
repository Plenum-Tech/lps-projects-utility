import { Router } from "express";
import { createBrand, deleteBrand, listBrands, updateBrand } from "../controllers/brands.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { requireRole } from "../middlewares/requireRole.js";

// /api/brands — read for everyone, write for admins.
const router = Router();
router.use(requireAuth);

router.get("/", listBrands);
router.post("/", requireRole("admin"), createBrand);
router.patch("/:id", requireRole("admin"), updateBrand);
router.delete("/:id", requireRole("admin"), deleteBrand);

export default router;
