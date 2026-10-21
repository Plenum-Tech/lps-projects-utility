import { Router } from "express";
import { missingTimeTasks } from "../lib/missingTime.js";
import {
  approvalsCount,
  assignableUsers,
  bulkTasks,
  calendarTasks,
  createTask,
  createdTasks,
  deleteTask,
  duplicateTask,
  exportTasks,
  getTask,
  listReworkTasks,
  listHistory,
  overScopeTasks,
  decideOverScope,
  loggedTimeSummary,
  listTasks,
  mentionableUsers,
  moveTask,
  myTasks,
  pinTask,
  remindTask,
  reviewTask,
  submitTask,
  unpinTask,
  updateStatus,
  updateTask,
} from "../controllers/tasks.js";
import { addComment, deleteComment, listComments, updateComment } from "../controllers/taskComments.js";
import {
  deleteFile,
  downloadFile,
  listFiles,
  uploadFiles,
  uploadSubtaskFiles,
  uploadTaskFilesMiddleware,
} from "../controllers/taskFiles.js";
import { addNote, deleteNote, listNotes, updateNote } from "../controllers/taskNotes.js";
import {
  addSubtask,
  deleteSubtask,
  mySubtasks,
  sendDeferredSubtaskNotifications,
  subtaskAssignableUsers,
  updateSubtask,
} from "../controllers/taskSubtasks.js";
import { generateTaskPearity, getTaskPearity } from "../controllers/pearity.js";
import { checkOutcomeReadiness } from "../controllers/outcomeReadiness.js";
import { inviteTaskGuest } from "../controllers/taskGuests.js";
import { outcomeReadinessRateLimit } from "../middlewares/rateLimit.js";
import { requireAuth } from "../middlewares/requireAuth.js";
import { requireRole } from "../middlewares/requireRole.js";

const router = Router();

router.use(requireAuth);

// NOTE: fixed paths must be registered before `/:id` so they aren't parsed as ObjectIds.

// Any authenticated user: their own assigned tasks (kept for compatibility).
router.get("/mine", myTasks);

// Any authenticated user: open subtasks assigned to them on tasks they aren't assigned to.
router.get("/subtasks/mine", mySubtasks);

// Head/admin: tasks they created (kept for compatibility).
router.get("/created", requireRole("head", "admin"), createdTasks);
// My completed tasks (since the move to Utility) with no time logged.
// Admins: tasks over their project's approved scope, and the decision.
router.get("/over-scope", overScopeTasks);
router.post("/:id/scope-approval", decideOverScope);
router.get("/missing-time", async (req, res) => {
  res.json(await missingTimeTasks(req.user!._id as never));
});

// People pickers (task assignees, project team, report filters, the Tasks
// "Employee" filter): any signed-in user.
router.get("/assignable-users", assignableUsers);

// Any authenticated user: lean month/week calendar rows (?from&to + list filters, max 500).
router.get("/calendar", calendarTasks);

// Any authenticated user: CSV of the list filters (or ?ids=), max 5000 rows.
router.get("/export", exportTasks);

// Any authenticated user: "Waiting approval" badge — { count, isReviewer }.
router.get("/approvals/count", approvalsCount);

// Bulk status / assign (head/admin) / delete — per-item permission checks, { updated, skipped }.
router.post("/bulk", bulkTasks);

// Any authenticated user: role-scoped list (?view=board for kanban columns);
// `?assignee=` lists that person's tasks company-wide.
router.get("/", listTasks);

// Head/admin (any task) or a project manager (tasks in their project): create a task.
router.post("/", createTask);

// Any authenticated user: task detail (`access: "read"` — view only — without
// view access). Comments, files, history, reworks, logged time and the Pearity
// tag are readable the same way; notes and every write still need view access.
router.get("/:id", getTask);
router.get("/:id/reworks", listReworkTasks);

// Creator/admin: update task details (creators may be project managers with the employee role).
router.patch("/:id", updateTask);

// Creator/admin/assignee: change status (assignees follow the transition rules).
router.patch("/:id/status", updateStatus);

// Board drag: { status, position }.
router.patch("/:id/move", moveTask);

// Assignee: submit completed work.
router.post("/:id/submit", submitTask);

// Anyone who can view it: score a draft outcome note / link against the brief and scope (advice only, nothing saved).
router.post("/:id/outcome-readiness", outcomeReadinessRateLimit, checkOutcomeReadiness);

// Creator/admin: review a submission.
router.post("/:id/review", reviewTask);

// Creator / project manager / admin: invite an outside person (guest) or a colleague by email.
router.post("/:id/guests", inviteTaskGuest);

// Creator/admin: manual reminder to assignees (once per hour).
router.post("/:id/remind", remindTask);

// Creator/admin: delete a task (cascades comments, files, history, notifications).
router.delete("/:id", deleteTask);

// Anyone who can view it and may create tasks there: copy the task (new number/short code).
router.post("/:id/duplicate", duplicateTask);

// Pin / unpin for the caller.
router.put("/:id/pin", pinTask);
router.delete("/:id/pin", unpinTask);

// Subtasks.
router.post("/:id/subtasks", addSubtask);
router.patch("/:id/subtasks/:subId", updateSubtask);
router.delete("/:id/subtasks/:subId", deleteSubtask);
// Notifications held back by `deferNotifications` (sent after the form's uploads).
router.post("/:id/subtasks/:subId/notify", sendDeferredSubtaskNotifications);
// Subtask attachments (same storage/limits as task files).
router.post("/:id/subtasks/:subId/files", uploadTaskFilesMiddleware, uploadSubtaskFiles);
// Options for the subtask "Assigned to" picker.
router.get("/:id/subtask-assignees", subtaskAssignableUsers);

// Comments.
router.get("/:id/comments", listComments);
router.post("/:id/comments", addComment);
router.patch("/:id/comments/:commentId", updateComment);
router.delete("/:id/comments/:commentId", deleteComment);

// Notes (pinned first; private notes only for their author and admins).
router.get("/:id/notes", listNotes);
router.post("/:id/notes", addNote);
router.patch("/:id/notes/:noteId", updateNote);
router.delete("/:id/notes/:noteId", deleteNote);

// Users who can be @mentioned on this task.
router.get("/:id/mentionable-users", mentionableUsers);

// Files (multipart field "files"; stored in GridFS).
router.get("/:id/files", listFiles);
router.post("/:id/files", uploadTaskFilesMiddleware, uploadFiles);
router.get("/:id/files/:fileId", downloadFile);
router.delete("/:id/files/:fileId", deleteFile);

// History timeline, newest first.
router.get("/:id/history", listHistory);
router.get("/:id/logged-time", loggedTimeSummary);

// Pearity tag: details + "Generated by" (viewers), and Generate (create once / reuse + usage).
router.get("/:id/pearity", getTaskPearity);
router.post("/:id/pearity/generate", generateTaskPearity);

export default router;
