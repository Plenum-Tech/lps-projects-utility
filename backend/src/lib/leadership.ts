import type { IUser } from "../models/User.js";
import { projectApproverIds } from "./projectApproval.js";
import { cached, invalidate } from "./refCache.js";

// ---------------------------------------------------------------------------
// Leadership (the approvers in Settings → Projects, Aasim and Rania by default)
// can do everything an admin can, plus approve brands. Their stored role is
// left as it is (a head stays head of their department for leave / time-log
// routing); for the request they are treated as admin. The role change is
// never saved: it is unmarked, so saving req.user doesn't write it.
// ---------------------------------------------------------------------------

const CACHE_KEY = "leadership:ids";
const CACHE_MS = 15_000;

async function leadershipIds(): Promise<Set<string>> {
  return cached(CACHE_KEY, CACHE_MS, async () => new Set((await projectApproverIds()).map(String)));
}

/** Call after the approver list changes. */
export function invalidateLeadership(): void {
  invalidate(CACHE_KEY);
}

const LEADERSHIP = new WeakSet<object>();

/** True when `user` was marked as leadership by applyLeadership. */
export function isLeadershipUser(user: object): boolean {
  return LEADERSHIP.has(user);
}

/** Gives leadership admin powers on this user document (not persisted). Returns whether the user is leadership. */
export async function applyLeadership(user: IUser): Promise<boolean> {
  if (!(await leadershipIds()).has(String(user._id))) return false;
  LEADERSHIP.add(user);
  if (user.role !== "admin") {
    user.role = "admin";
    user.unmarkModified("role");
  }
  return true;
}
