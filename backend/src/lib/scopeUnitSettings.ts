import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { ScopeUnitSettings } from "../models/ScopeUnitSettings.js";
import { setScopeUnitDefs, type ScopeUnitDef } from "./scopeUnits.js";

// ---------------------------------------------------------------------------
// Settings → Scope units, cached in memory (lib/scopeUnits.ts holds the list the
// sync validators / extractor read). Loaded after connectDB(), refreshed after
// every write here and re-read at most every REFRESH_MS by `scopeUnitsFreshness`
// (other instances' edits are picked up within that window).
// ---------------------------------------------------------------------------

const REFRESH_MS = 60_000;
let loadedAt = 0;
let inflight: Promise<void> | null = null;
let generation = 0;

/** Stored entries → definitions (empty / missing document = the defaults). */
export function toDefs(units: ScopeUnitDef[] | undefined | null): ScopeUnitDef[] | null {
  if (!units?.length) return null;
  return units.map((u) => ({
    key: u.key,
    name: u.name,
    aliases: [...(u.aliases ?? [])],
    roles: [...(u.roles ?? [])],
    countsTowardTotal: u.countsTowardTotal !== false,
    hidden: Boolean(u.hidden),
  }));
}

/** Replaces the cache with a freshly saved list (call after every write). */
export function setScopeUnitsCache(units: ScopeUnitDef[] | null): void {
  generation += 1;
  setScopeUnitDefs(units);
  loadedAt = Date.now();
}

/** Re-reads the singleton (single-flight). Never throws: on failure the previous list stays. */
export function refreshScopeUnits(): Promise<void> {
  if (mongoose.connection.readyState !== 1) return Promise.resolve();
  if (inflight) return inflight;
  const startGeneration = generation;
  inflight = ScopeUnitSettings.findOne({ key: "scopeUnits" })
    .lean()
    .then((doc) => {
      if (generation === startGeneration) setScopeUnitsCache(toDefs(doc?.units as ScopeUnitDef[] | undefined));
    })
    .catch((err: unknown) => {
      console.error("[settings] Failed to load scope units:", err instanceof Error ? err.message : err);
      loadedAt = Date.now();
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Express middleware: the cached list is at most REFRESH_MS old before the request runs. */
export function scopeUnitsFreshness(_req: Request, _res: Response, next: NextFunction): void {
  if (Date.now() - loadedAt < REFRESH_MS || mongoose.connection.readyState !== 1) {
    next();
    return;
  }
  void refreshScopeUnits().finally(() => next());
}
