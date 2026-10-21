import type { Request } from "express";

// ---------------------------------------------------------------------------
// The only API calls an outside guest (lib/guests.ts) may make. requireAuth
// runs this for every signed-in request, so anything not listed here is 403
// for guests — new endpoints stay closed to them until added on purpose.
// Listing a route only opens the door: the handlers still check the task
// (lib/taskAccess.ts limits guests to tasks they are on) and the time log
// (their own) like for anyone else.
// ---------------------------------------------------------------------------

const ID = "[0-9a-f]{24}";
const TASK = `/api/tasks/${ID}`;

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

const GUEST_ROUTES: Array<[Method, string]> = [
  // Session and own profile (name, password, email preferences).
  ["GET", "/api/auth/me"],
  ["GET", "/api/users/me"],
  ["PATCH", "/api/users/me"],
  ["GET", "/api/users/me/email-preferences"],
  ["PATCH", "/api/users/me/email-preferences"],
  // Own notifications (+ the real-time stream).
  ["GET", "/api/notifications"],
  ["GET", "/api/notifications/unread-count"],
  ["GET", "/api/notifications/stream"],
  ["PATCH", `/api/notifications/${ID}/read`],
  ["POST", "/api/notifications/read-all"],
  // "Log time for: task / project" (the timer needs it).
  ["GET", "/api/project-meta/settings/time"],
  // Their tasks: list / board / calendar (filtered to their tasks in buildListFilter).
  ["GET", "/api/tasks"],
  ["GET", "/api/tasks/calendar"],
  ["GET", "/api/tasks/mine"],
  ["GET", "/api/tasks/subtasks/mine"],
  ["GET", "/api/tasks/missing-time"],
  // One of their tasks (canViewTaskAsync / canReadTaskAsync refuse any other).
  ["GET", TASK],
  ["GET", `${TASK}/reworks`],
  ["GET", `${TASK}/history`],
  ["GET", `${TASK}/logged-time`],
  ["GET", `${TASK}/mentionable-users`],
  ["GET", `${TASK}/notes`],
  ["GET", `${TASK}/comments`],
  ["POST", `${TASK}/comments`],
  ["PATCH", `${TASK}/comments/${ID}`],
  ["DELETE", `${TASK}/comments/${ID}`],
  ["GET", `${TASK}/files`],
  ["POST", `${TASK}/files`],
  ["GET", `${TASK}/files/${ID}`],
  // Actual start / end only (updateTask refuses every other field for guests).
  ["PATCH", TASK],
  // Status moves, submit / complete (assignee transition rules).
  ["PATCH", `${TASK}/status`],
  ["PATCH", `${TASK}/move`],
  ["POST", `${TASK}/submit`],
  ["POST", `${TASK}/outcome-readiness`],
  ["PUT", `${TASK}/pin`],
  ["DELETE", `${TASK}/pin`],
  // Own time on their tasks (listTimeLogs / canLogOn / canModify enforce that).
  ["GET", "/api/timelogs"],
  ["GET", "/api/timelogs/active"],
  ["POST", "/api/timelogs"],
  ["POST", "/api/timelogs/timer/start"],
  ["POST", "/api/timelogs/timer/pause"],
  ["POST", "/api/timelogs/timer/resume"],
  ["POST", "/api/timelogs/timer/stop"],
  ["PATCH", `/api/timelogs/${ID}`],
  ["POST", `/api/timelogs/${ID}/stop`],
  ["DELETE", `/api/timelogs/${ID}`],
];

/** Express routes case-insensitively; so does the match (ids are hex either way). */
const COMPILED = GUEST_ROUTES.map(([method, path]) => ({ method, pattern: new RegExp(`^${path}$`, "i") }));

/**
 * Whether a guest may make this request. Uses the path Express routed on
 * (mount path + route path, still percent-encoded, without the query), so an
 * encoded id simply fails the match; repeated / trailing slashes are folded.
 */
export function guestMayCall(req: Pick<Request, "method" | "baseUrl" | "path">): boolean {
  const method = req.method === "HEAD" ? "GET" : req.method;
  const path = `${req.baseUrl}${req.path}`.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1");
  return COMPILED.some((route) => route.method === method && route.pattern.test(path));
}
