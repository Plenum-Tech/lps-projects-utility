import type mongoose from "mongoose";

// ---------------------------------------------------------------------------
// Guests: people from outside the company invited to specific tasks
// (POST /api/tasks/:id/guests). A guest is a normal user document with
// `isGuest: true` and the "employee" role, so every role check treats them as
// the least privileged user; on top of that:
// - middlewares/guestAccess.ts lets them call only the task / time / profile /
//   notification endpoints they need (deny by default), and
// - the task helpers (lib/taskAccess.ts) limit them to tasks they are on.
// ---------------------------------------------------------------------------

/** Staff email domains: such addresses are added as employees, never as guests. */
export const COMPANY_EMAIL_DOMAINS = ["lps-me.com", "plenum-tech.com"] as const;

/** True for an address on a company domain (or one of its subdomains). */
export function isCompanyEmail(email: string): boolean {
  const domain = email.trim().toLowerCase().split("@").pop() ?? "";
  return COMPANY_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** True when `user` is an outside guest. Lean shapes without the field count as staff. */
export function isGuestUser(user: unknown): boolean {
  return Boolean(user && (user as { isGuest?: unknown }).isGuest === true);
}

/** Mongo filter of the tasks a guest may open: assigned to them, or one of its subtasks is. */
export function guestTaskFilter(userId: mongoose.Types.ObjectId | string): Record<string, unknown> {
  return { $or: [{ assignees: userId }, { "subtasks.assignee": userId }] };
}

/**
 * For guest responses: drops `email` from every populated person (`{ _id, name, email }`)
 * inside a JSON value, so guests see the people on their task by name only.
 */
export function withoutPeopleEmails<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => withoutPeopleEmails(item)) as T;
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  if ((value as { _bsontype?: unknown })._bsontype) return value; // ObjectId
  const out: Record<string, unknown> = {};
  const isPerson = "name" in value && "email" in value;
  for (const [key, child] of Object.entries(value)) {
    if (isPerson && key === "email") continue;
    out[key] = withoutPeopleEmails(child);
  }
  return out as T;
}
