import { Router } from "express";
import {
  addItem,
  createMeeting,
  createTasksFromItems,
  deleteMeeting,
  dismissItem,
  downloadMeetingFile,
  extractWithAi,
  getMeeting,
  listMeetings,
  meetingAssignees,
  meetingConfig,
  previewMeeting,
  regenerateHints,
  updateItem,
  updateMeeting,
  uploadTranscriptMiddleware,
} from "../controllers/meetings.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { moderateRateLimit } from "../middlewares/rateLimit.js";

const router = Router();

router.use(requireAuth);

// NOTE: fixed paths before `/:id`.
router.get("/config", meetingConfig);
router.post("/preview", uploadTranscriptMiddleware, previewMeeting);

router.get("/", listMeetings);
router.post("/", uploadTranscriptMiddleware, createMeeting);

router.get("/:id", getMeeting);
router.patch("/:id", updateMeeting);
router.delete("/:id", deleteMeeting);
router.get("/:id/file", downloadMeetingFile);
router.get("/:id/assignees", meetingAssignees);
router.post("/:id/hints", regenerateHints);
// Calls Gemini synchronously (up to 60 s): the stricter limit applies.
router.post("/:id/extract-ai", moderateRateLimit, extractWithAi);
router.post("/:id/items", addItem);
router.patch("/:id/items/:itemId", updateItem);
router.delete("/:id/items/:itemId", dismissItem);
router.post("/:id/tasks", createTasksFromItems);

export default router;
