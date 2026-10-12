import { Router } from "express";
import { generateProjectPearity } from "../controllers/pearity.js";
import { decideInApp, listApprovals, requestAgain } from "../controllers/projectApproval.js";
import {
  deleteProjectFile,
  downloadProjectFile,
  listProjectFiles,
  uploadProjectFiles,
} from "../controllers/projectFiles.js";
import {
  createMilestone,
  deleteMilestone,
  listMilestones,
  updateMilestone,
  updateMilestoneStatus,
} from "../controllers/projectMilestones.js";
import { createNote, deleteNote, listNotes, updateNote } from "../controllers/projectNotes.js";
import { listUnbrandedProjects,
  addMembers,
  archiveProject,
  bulkProjects,
  createProject,
  deleteProject,
  duplicateProject,
  exportProjects,
  getNamingSuggestion,
  getProject,
  listAssignableMembers,
  listProjectActivity,
  listProjects,
  listProjectTasks,
  pinProject,
  removeMember,
  restoreProject,
  unpinProject,
  updateMember,
  updateProject,
  updateProjectStatus,
} from "../controllers/projects.js";
import { uploadTaskFilesMiddleware } from "../controllers/taskFiles.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { requireRole } from "../middlewares/requireRole.js";

// /api/projects — fine-grained permissions are enforced in the controllers
// (lib/projectAccess.ts); route guards only cover role-only actions.
const router = Router();

router.use(requireAuth);

router.get("/", listProjects);
router.post("/", createProject);
// CSV of the list filters (or ?ids=), max 5000 rows.
router.get("/export", exportProjects);
// Bulk status / archive / restore / delete (admin) — per-item permission checks.
router.post("/bulk", bulkProjects);

router.get("/approvals", listApprovals);
router.get("/unbranded", listUnbrandedProjects);
router.get("/:id", getProject);
router.get("/:id/naming-suggestion", getNamingSuggestion);
router.patch("/:id", updateProject);
router.delete("/:id", requireRole("admin"), deleteProject);
router.patch("/:id/status", updateProjectStatus);
router.post("/:id/approval", decideInApp);
router.post("/:id/pearity/generate", generateProjectPearity);
router.post("/:id/approval/request", requestAgain);
router.post("/:id/archive", archiveProject);
router.post("/:id/restore", restoreProject);
router.post("/:id/duplicate", duplicateProject);

// Members
router.get("/:id/members/assignable", listAssignableMembers);
router.post("/:id/members", addMembers);
router.patch("/:id/members/:userId", updateMember);
router.delete("/:id/members/:userId", removeMember);

// Pin
router.put("/:id/pin", pinProject);
router.delete("/:id/pin", unpinProject);

// Milestones
router.get("/:id/milestones", listMilestones);
router.post("/:id/milestones", createMilestone);
router.patch("/:id/milestones/:mid", updateMilestone);
router.delete("/:id/milestones/:mid", deleteMilestone);
router.patch("/:id/milestones/:mid/status", updateMilestoneStatus);

// Notes
router.get("/:id/notes", listNotes);
router.post("/:id/notes", createNote);
router.patch("/:id/notes/:nid", updateNote);
router.delete("/:id/notes/:nid", deleteNote);

// Files (multipart field "files"; GridFS)
router.get("/:id/files", listProjectFiles);
router.post("/:id/files", uploadTaskFilesMiddleware, uploadProjectFiles);
router.get("/:id/files/:fid", downloadProjectFile);
router.delete("/:id/files/:fid", deleteProjectFile);

// Activity + tasks
router.get("/:id/activity", listProjectActivity);
router.get("/:id/tasks", listProjectTasks);

export default router;
