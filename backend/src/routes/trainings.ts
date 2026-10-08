import { Router } from "express";
import {
  completeTraining,
  createTraining,
  deleteTraining,
  downloadSource,
  getSlide,
  getTraining,
  listMyTrainings,
  listTrainings,
  recordProgress,
  remindTraining,
  trainingProgress,
  updateTraining,
  uploadTrainingFileMiddleware,
} from "../controllers/trainings.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { requireRole } from "../middlewares/requireRole.js";

const router = Router();

router.use(requireAuth);

// Everyone: the trainings assigned to them, reading progress and completion.
router.get("/mine", listMyTrainings);
router.get("/:id", getTraining);
router.get("/:id/slides/:n", getSlide);
router.get("/:id/source", downloadSource);
router.post("/:id/progress", recordProgress);
router.post("/:id/complete", completeTraining);

// Admins manage trainings and see everyone's progress.
router.get("/", requireRole("admin"), listTrainings);
router.post(
  "/",
  requireRole("admin"),
  uploadTrainingFileMiddleware,
  createTraining,
);
router.patch(
  "/:id",
  requireRole("admin"),
  uploadTrainingFileMiddleware,
  updateTraining,
);
router.delete("/:id", requireRole("admin"), deleteTraining);
router.get("/:id/progress", requireRole("admin"), trainingProgress);
router.post("/:id/remind", requireRole("admin"), remindTraining);

export default router;
