import type { Request } from "express";

export interface Pagination {
  /** Applied page size — `null` when the caller wants ALL matching rows (no limit). */
  limit: number | null;
  offset: number;
}

const MAX_LIMIT = 200;

/**
 * Parses `?limit=&offset=` query params (mirrors the activity-log pagination pattern).
 *
 * - `limit` present → clamped to `[1, MAX_LIMIT]`.
 * - `limit` absent/invalid → `null`, meaning "return all rows" — comboboxes and the
 *   Manage Members dialog rely on this to keep fetching full lists.
 */
export function parsePagination(req: Request): Pagination {
  const rawLimit = Number(req.query.limit);
  const rawOffset = Number(req.query.offset);

  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
      : null;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

  return { limit, offset };
}

/**
 * Builds a case-insensitive substring regex from `?search=`, escaping regex-special
 * characters so user input can never break the pattern. `null` when empty/absent.
 */
export function searchRegex(search: unknown): RegExp | null {
  if (typeof search !== "string") return null;
  const value = search.trim();
  if (!value) return null;
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

/**
 * Anchored, case-insensitive exact match for `name` (regex-escaped) — the
 * portable equivalent of a strength-2 (case-insensitive) ICU match on `{ field: name }`.
 */
export function exactNameRegex(name: string): RegExp {
  return new RegExp(`^${name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
}
