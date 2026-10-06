import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import {
  CompanySettings,
  type CompanyAddress,
  type DateFormat,
  type ICompanySettings,
  type LogoMimeType,
  type TimeFormat,
  type WeekStart,
} from "../models/CompanySettings.js";

// ---------------------------------------------------------------------------
// Cached company settings. Readers (appTimeZone(), appUrl(), email templates,
// jobs) are synchronous, so the singleton is held in memory:
//   - loaded right after connectDB() (server start, runJobs and other scripts),
//   - refreshed after every settings write in this process,
//   - re-read at most every REFRESH_MS by `companySettingsFreshness` (other
//     serverless instances / processes pick up changes within that window).
// With no document (or before the first load) every getter falls back to env.
// ---------------------------------------------------------------------------

const REFRESH_MS = 60_000;
const DEFAULT_TIMEZONE = "Asia/Kolkata";
const DEFAULT_APP_URL = "http://localhost:5173";

export interface CompanySettingsSnapshot {
  exists: boolean;
  id: string | null;
  name: string;
  email: string;
  phone: string;
  website: string;
  logo: { id: string; mimeType: LogoMimeType; size: number } | null;
  address: Required<CompanyAddress>;
  /** Stored timezone ("" when there is no document → env fallback). */
  timezone: string;
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  weekStart: WeekStart;
  currency: { code: string; symbol: string };
  /** Stored app URL ("" → APP_URL env fallback). */
  appUrl: string;
  updatedAt: string | null;
}

let cached: CompanySettingsSnapshot | null = null;
let loadedAt = 0;
let inflight: Promise<void> | null = null;
/** Bumped on every write so an older in-flight read can't overwrite a newer cache. */
let generation = 0;

/** Env timezone fallback (APP_TIMEZONE || Asia/Kolkata). */
export function envTimeZone(): string {
  const tz = process.env.APP_TIMEZONE?.trim();
  return tz && isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE;
}

/** Env frontend URL fallback (APP_URL || http://localhost:5173), no trailing slash. */
export function envAppUrl(): string {
  return (process.env.APP_URL?.trim() || DEFAULT_APP_URL).replace(/\/+$/, "");
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function emptyAddress(): Required<CompanyAddress> {
  return { line1: "", line2: "", city: "", state: "", postalCode: "", country: "" };
}

/** Defaults used when no settings document exists (identical to pre-settings behaviour). */
export function defaultSnapshot(): CompanySettingsSnapshot {
  return {
    exists: false,
    id: null,
    name: "EMS",
    email: "",
    phone: "",
    website: "",
    logo: null,
    address: emptyAddress(),
    timezone: "",
    dateFormat: "DD-MM-YYYY",
    timeFormat: "12h",
    weekStart: "monday",
    currency: { code: "INR", symbol: "₹" },
    appUrl: "",
    updatedAt: null,
  };
}

export function toSnapshot(doc: ICompanySettings): CompanySettingsSnapshot {
  const base = defaultSnapshot();
  const address = { ...emptyAddress() };
  for (const key of Object.keys(address) as (keyof CompanyAddress)[]) {
    address[key] = doc.address?.[key] ?? "";
  }
  return {
    exists: true,
    id: String(doc._id),
    name: doc.name || base.name,
    email: doc.email ?? "",
    phone: doc.phone ?? "",
    website: doc.website ?? "",
    logo: doc.logo?.gridFsId
      ? { id: String(doc.logo.gridFsId), mimeType: doc.logo.mimeType, size: doc.logo.size }
      : null,
    address,
    timezone: doc.timezone && isValidTimeZone(doc.timezone) ? doc.timezone : "",
    dateFormat: doc.dateFormat ?? base.dateFormat,
    timeFormat: doc.timeFormat ?? base.timeFormat,
    weekStart: doc.weekStart ?? base.weekStart,
    currency: {
      code: doc.currency?.code || base.currency.code,
      symbol: doc.currency?.symbol || base.currency.symbol,
    },
    appUrl: doc.appUrl ?? "",
    updatedAt: doc.updatedAt ? doc.updatedAt.toISOString() : null,
  };
}

/** Current settings (env-backed defaults until loaded / when no document exists). Never throws. */
export function companySettings(): CompanySettingsSnapshot {
  return cached ?? defaultSnapshot();
}

/** Effective app timezone: settings → APP_TIMEZONE → Asia/Kolkata. */
export function settingsTimeZone(): string {
  return cached?.timezone || envTimeZone();
}

/** Effective frontend base URL (no trailing slash): settings → APP_URL → localhost:5173. */
export function settingsAppUrl(): string {
  return (cached?.appUrl || envAppUrl()).replace(/\/+$/, "");
}

/** Replaces the cache with a freshly saved document (call after every write). */
export function setCompanySettingsCache(doc: ICompanySettings | null): void {
  generation += 1;
  cached = doc ? toSnapshot(doc) : defaultSnapshot();
  loadedAt = Date.now();
}

/**
 * Re-reads the singleton from MongoDB (single-flight). Does not create it.
 * Never throws: on failure the previous cache (or env fallback) stays in place.
 */
export function refreshCompanySettings(): Promise<void> {
  if (mongoose.connection.readyState !== 1) return Promise.resolve();
  if (inflight) return inflight;
  const startGeneration = generation;
  inflight = CompanySettings.findOne({ key: "company" })
    .then((doc) => {
      if (generation === startGeneration) setCompanySettingsCache(doc);
    })
    .catch((err: unknown) => {
      console.error("[settings] Failed to load company settings:", err instanceof Error ? err.message : err);
      loadedAt = Date.now(); // back off for one interval instead of hammering a failing DB
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Express middleware: makes sure the cache is at most REFRESH_MS old before handling the request. */
export function companySettingsFreshness(_req: Request, _res: Response, next: NextFunction): void {
  if (Date.now() - loadedAt < REFRESH_MS || mongoose.connection.readyState !== 1) {
    next();
    return;
  }
  void refreshCompanySettings().finally(() => next());
}

/** Returns the singleton, creating it with the current (env-backed) defaults on first use. */
export async function getOrCreateCompanySettings(): Promise<ICompanySettings> {
  const existing = await CompanySettings.findOne({ key: "company" });
  if (existing) return existing;
  const defaults = defaultSnapshot();
  const created = await CompanySettings.findOneAndUpdate(
    { key: "company" },
    {
      $setOnInsert: {
        key: "company",
        name: defaults.name,
        email: defaults.email,
        address: {},
        timezone: envTimeZone(),
        dateFormat: defaults.dateFormat,
        timeFormat: defaults.timeFormat,
        weekStart: defaults.weekStart,
        currency: defaults.currency,
        logo: null,
      },
    },
    { upsert: true, returnDocument: "after" }
  );
  setCompanySettingsCache(created);
  return created!;
}

/** API path (relative to the API base, e.g. http://host/api) of the logo, versioned by file id. */
export function logoApiPath(snapshot: CompanySettingsSnapshot = companySettings()): string | null {
  return snapshot.logo ? `/settings/company/logo?v=${snapshot.logo.id}` : null;
}

/**
 * Absolute public API origin for links that leave the browser (email logo).
 * API_PUBLIC_URL (e.g. https://api.example.com) → localhost:PORT outside production → null.
 */
export function apiPublicOrigin(): string | null {
  const explicit = process.env.API_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "").replace(/\/api$/, "");
  if (process.env.NODE_ENV !== "production") return `http://localhost:${process.env.PORT ?? 5000}`;
  return null;
}
