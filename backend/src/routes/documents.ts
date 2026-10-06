import { Router } from "express";
import {
  createDocument,
  deleteDocument,
  downloadDocumentFile,
  getDocument,
  listDocuments,
  updateDocument,
  uploadDocumentFileMiddleware,
} from "../controllers/documents.js";
import { requireAuth } from "../middlewares/requireAuth.js";

const router = Router();

router.use(requireAuth);

// Role-scoped in the controller: owner / department head (read-only) / admin.
router.get("/", listDocuments);
router.post("/", uploadDocumentFileMiddleware, createDocument);
router.get("/:id", getDocument);
router.get("/:id/file", downloadDocumentFile);
router.patch("/:id", uploadDocumentFileMiddleware, updateDocument);
router.delete("/:id", deleteDocument);

export default router;
