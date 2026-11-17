import type { IUser } from "../models/User.js";

// ---------------------------------------------------------------------------
// Task managers are a stored role (`task_manager`). For each request they get
// every admin power (role elevated to admin, not persisted) plus the right to
// change any task's due date (WeakSet marker — plain admins still cannot).
// ---------------------------------------------------------------------------

const TASK_MANAGER = new WeakSet<object>();

/** True when `user` was marked as a task manager by applyTaskManager. */
export function isTaskManagerUser(user: object): boolean {
  return TASK_MANAGER.has(user);
}

/**
 * Elevates a stored `task_manager` to admin powers on this request (not
 * persisted). Returns whether the user is a task manager.
 */
export function applyTaskManager(user: IUser): boolean {
  if (user.role !== "task_manager") return false;
  TASK_MANAGER.add(user);
  user.role = "admin";
  user.unmarkModified("role");
  return true;
}
