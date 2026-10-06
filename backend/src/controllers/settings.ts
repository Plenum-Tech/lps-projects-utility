import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import multer from "multer";
import { logActivity } from "../lib/activityLog.js";
import {
  companySettings,
  envAppUrl,
  envTimeZone,
  getOrCreateCompanySettings,
  isValidTimeZone,
  logoApiPath,
  setCompanySettingsCache,
  settingsAppUrl,
  settingsTimeZone,
  toSnapshot,
  type CompanySettingsSnapshot,
} from "../lib/companySettings.js";
import { deleteFromGridFs, openGridFsDownload, uploadToGridFs } from "../lib/gridfs.js";
import { SvgRejectedError, sanitizeSvg } from "../lib/svgSanitize.js";
import {
  COMPANY_ASSETS_BUCKET,
  COMPANY_SETTINGS_LIMITS as LIMITS,
  DATE_FORMATS,
  TIME_FORMATS,
  WEEK_STARTS,
  type ICompanySettings,
  type LogoMimeType,
} from "../models/CompanySettings.js";

// ---------------------------------------------------------------------------
// /api/settings — company/app settings singleton.
//   GET  /public                 unauthenticated, cached 5 min (login page, sidebar)
//   GET  /company, PATCH /company admin
//   PUT  /company/logo           admin, multipart "file" (png/jpg/svg ≤ 1 MB)
//   DELETE /company/logo         admin
//   GET  /company/logo           public image, versioned by ?v=<id>
// ---------------------------------------------------------------------------

/** Absolute logo URL for API responses, built from the request's own origin. */
function absoluteLogoUrl(req: Request, snapshot: CompanySettingsSnapshot): string | null {
  const path = logoApiPath(snapshot);
  return path ? `${req.protocol}://${req.get("host")}/api${path}` : null;
}

function serializeCompany(req: Request, snapshot: CompanySettingsSnapshot) {
  return {
    id: snapshot.id,
    name: snapshot.name,
    email: snapshot.email,
    phone: snapshot.phone,
    website: snapshot.website,
    logo: snapshot.logo
      ? {
          mimeType: snapshot.logo.mimeType,
          size: snapshot.logo.size,
          url: absoluteLogoUrl(req, snapshot),
          path: logoApiPath(snapshot),
        }
      : null,
    address: snapshot.address,
    timezone: snapshot.timezone || envTimeZone(),
    dateFormat: snapshot.dateFormat,
    timeFormat: snapshot.timeFormat,
    weekStart: snapshot.weekStart,
    currency: snapshot.currency,
    appUrl: snapshot.appUrl,
    effective: { timezone: settingsTimeZone(), appUrl: settingsAppUrl() },
    envFallback: { timezone: envTimeZone(), appUrl: envAppUrl() },
    updatedAt: snapshot.updatedAt,
  };
}

/** GET /api/settings/public — no auth. */
export function getPublicSettings(req: Request, res: Response): void {
  const s = companySettings();
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json({
    settings: {
      name: s.name,
      logoUrl: absoluteLogoUrl(req, s),
      logoPath: logoApiPath(s),
      dateFormat: s.dateFormat,
      timeFormat: s.timeFormat,
      weekStart: s.weekStart,
      timezone: settingsTimeZone(),
      currency: s.currency,
    },
  });
}

/** GET /api/settings/company — admin; creates the document with defaults on first use. */
export async function getCompanySettings(req: Request, res: Response): Promise<void> {
  const doc = await getOrCreateCompanySettings();
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ settings: serializeCompany(req, toSnapshot(doc)) });
}

// -- PATCH validation --------------------------------------------------------

class FieldError extends Error {
  constructor(
    readonly field: string,
    message: string
  ) {
    super(message);
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^[0-9+()\-.\s]*$/;
const ADDRESS_FIELDS = {
  line1: LIMITS.addressLineMax,
  line2: LIMITS.addressLineMax,
  city: LIMITS.addressShortMax,
  state: LIMITS.addressShortMax,
  postalCode: LIMITS.postalCodeMax,
  country: LIMITS.addressShortMax,
} as const;

const SUPPORTED_CURRENCIES: Set<string> | null = (() => {
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    return intl.supportedValuesOf ? new Set(intl.supportedValuesOf("currency")) : null;
  } catch {
    return null;
  }
})();

/** "" / null → undefined (clear); otherwise a trimmed string within `max`. */
function optionalText(field: string, value: unknown, max: number): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new FieldError(field, `${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new FieldError(field, `${field} must be at most ${max} characters`);
  return trimmed || undefined;
}

/** http(s) URL without credentials; "" / null → undefined (clear). */
function optionalHttpUrl(field: string, value: unknown): string | undefined {
  const text = optionalText(field, value, LIMITS.urlMax);
  if (text === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new FieldError(field, `${field} must be a valid http(s) URL`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.username || url.password) {
    throw new FieldError(field, `${field} must be a valid http(s) URL`);
  }
  return text;
}

function oneOf<T extends string>(field: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new FieldError(field, `${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

/** Applies the body onto `doc`; returns the list of fields that changed. Throws FieldError. */
function applyPatch(doc: ICompanySettings, body: Record<string, unknown>): string[] {
  const changed: string[] = [];
  const set = <K extends keyof ICompanySettings>(key: K, value: ICompanySettings[K]) => {
    if (JSON.stringify(doc[key] ?? null) !== JSON.stringify(value ?? null)) {
      doc.set(key as string, value);
      changed.push(key as string);
    }
  };

  if ("name" in body) {
    if (typeof body.name !== "string" || !body.name.trim()) throw new FieldError("name", "Company name is required");
    if (body.name.trim().length > LIMITS.nameMax) {
      throw new FieldError("name", `Company name must be at most ${LIMITS.nameMax} characters`);
    }
    set("name", body.name.trim());
  }
  if ("email" in body) {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email || email.length > LIMITS.emailMax || !EMAIL_PATTERN.test(email)) {
      throw new FieldError("email", "Company email must be a valid email address");
    }
    set("email", email);
  }
  if ("phone" in body) {
    const phone = optionalText("phone", body.phone, LIMITS.phoneMax);
    if (phone && !PHONE_PATTERN.test(phone)) {
      throw new FieldError("phone", "phone may only contain digits, spaces and + ( ) - .");
    }
    set("phone", phone);
  }
  if ("website" in body) set("website", optionalHttpUrl("website", body.website));
  if ("appUrl" in body) {
    const appUrl = optionalHttpUrl("appUrl", body.appUrl);
    if (appUrl && /[?#]/.test(appUrl)) throw new FieldError("appUrl", "appUrl must not contain a query or fragment");
    set("appUrl", appUrl?.replace(/\/+$/, ""));
  }
  if ("address" in body) {
    const address = body.address;
    if (address !== null && (typeof address !== "object" || Array.isArray(address))) {
      throw new FieldError("address", "address must be an object");
    }
    const input = (address ?? {}) as Record<string, unknown>;
    const current = JSON.parse(JSON.stringify(doc.address ?? {})) as Record<string, string | undefined>;
    const clean: Record<string, string> = {};
    for (const [key, max] of Object.entries(ADDRESS_FIELDS)) {
      // address: null clears everything; otherwise only the given keys change.
      const value =
        address === null ? undefined : key in input ? optionalText(`address.${key}`, input[key], max) : current[key];
      if (value) clean[key] = value;
    }
    set("address", clean);
  }
  if ("timezone" in body) {
    const tz = typeof body.timezone === "string" ? body.timezone.trim() : "";
    if (!isValidTimeZone(tz)) throw new FieldError("timezone", "timezone must be a valid IANA time zone (e.g. Asia/Kolkata)");
    set("timezone", tz);
  }
  if ("dateFormat" in body) set("dateFormat", oneOf("dateFormat", body.dateFormat, DATE_FORMATS));
  if ("timeFormat" in body) set("timeFormat", oneOf("timeFormat", body.timeFormat, TIME_FORMATS));
  if ("weekStart" in body) set("weekStart", oneOf("weekStart", body.weekStart, WEEK_STARTS));
  if ("currency" in body) {
    const currency = body.currency as Record<string, unknown> | null;
    if (!currency || typeof currency !== "object" || Array.isArray(currency)) {
      throw new FieldError("currency", "currency must be an object { code, symbol }");
    }
    const code =
      "code" in currency ? (typeof currency.code === "string" ? currency.code.trim().toUpperCase() : "") : doc.currency.code;
    if (!/^[A-Z]{3}$/.test(code) || (SUPPORTED_CURRENCIES && !SUPPORTED_CURRENCIES.has(code))) {
      throw new FieldError("currency.code", "currency.code must be an ISO 4217 code (e.g. INR, USD)");
    }
    const symbol =
      "symbol" in currency ? (typeof currency.symbol === "string" ? currency.symbol.trim() : "") : doc.currency.symbol;
    if (!symbol || [...symbol].length > LIMITS.currencySymbolMax) {
      throw new FieldError("currency.symbol", `currency.symbol is required (at most ${LIMITS.currencySymbolMax} characters)`);
    }
    set("currency", { code, symbol });
  }
  return changed;
}

const PATCHABLE = [
  "name", "email", "phone", "website", "address", "timezone",
  "dateFormat", "timeFormat", "weekStart", "currency", "appUrl",
];

/** PATCH /api/settings/company — admin; partial update (unknown keys are ignored). */
export async function updateCompanySettings(req: Request, res: Response): Promise<void> {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body) || !PATCHABLE.some((k) => k in body)) {
    res.status(400).json({ error: `At least one of ${PATCHABLE.join(", ")} is required` });
    return;
  }

  const doc = await getOrCreateCompanySettings();
  let changed: string[];
  try {
    changed = applyPatch(doc, body as Record<string, unknown>);
  } catch (err) {
    if (err instanceof FieldError) {
      res.status(400).json({ error: err.message, field: err.field });
      return;
    }
    throw err;
  }

  if (changed.length > 0) {
    await doc.save();
    logActivity({
      action: "settings_updated",
      actor: req.user,
      targetType: "company_settings",
      targetId: doc._id as mongoose.Types.ObjectId,
      targetName: "Company settings",
      details: { changed },
      ip: req.ip,
    });
  }
  setCompanySettingsCache(doc);
  res.json({ settings: serializeCompany(req, toSnapshot(doc)), changed });
}

// -- Logo -------------------------------------------------------------------

class UnsupportedLogoError extends Error {}

const LOGO_EXTENSIONS: Record<string, LogoMimeType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
};

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LIMITS.logoMaxBytes, files: 1, fields: 5 },
  fileFilter: (_req, file, cb) => {
    const ext = file.originalname.split(".").pop()?.toLowerCase() ?? "";
    const declared = (Object.values(LOGO_EXTENSIONS) as string[]).includes(file.mimetype);
    if (declared || (file.mimetype === "application/octet-stream" && ext in LOGO_EXTENSIONS)) cb(null, true);
    else cb(new UnsupportedLogoError("Logo must be a PNG, JPG or SVG image"));
  },
});

/** multer for the single `file` field: 413 for size/count, 415 for type. */
export function logoUploadMiddleware(req: Request, res: Response, next: NextFunction): void {
  logoUpload.single("file")(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof UnsupportedLogoError) {
      res.status(415).json({ error: err.message });
      return;
    }
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: "Logo must be 1 MB or smaller" });
        return;
      }
      if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
        res.status(400).json({ error: 'Upload a single image using the "file" field' });
        return;
      }
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  });
}

/** Detects the real type from the bytes (the client's Content-Type is not trusted). */
function sniffLogo(buffer: Buffer): LogoMimeType | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  const head = buffer.subarray(0, 4096).toString("utf8").replace(/^﻿/, "").trimStart();
  if (/^(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head) || /<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

/** PUT /api/settings/company/logo — admin; multipart field "file". */
export async function uploadCompanyLogo(req: Request, res: Response): Promise<void> {
  const file = req.file;
  if (!file || file.size === 0) {
    res.status(400).json({ error: 'Attach an image using the "file" field' });
    return;
  }

  const mimeType = sniffLogo(file.buffer);
  if (!mimeType) {
    res.status(415).json({ error: "Logo must be a PNG, JPG or SVG image" });
    return;
  }

  let content = file.buffer;
  if (mimeType === "image/svg+xml") {
    try {
      content = Buffer.from(sanitizeSvg(file.buffer), "utf8");
    } catch (err) {
      if (err instanceof SvgRejectedError) {
        res.status(415).json({ error: `This SVG can't be used as a logo: ${err.message}` });
        return;
      }
      throw err;
    }
    if (content.length > LIMITS.logoMaxBytes) {
      res.status(413).json({ error: "Logo must be 1 MB or smaller" });
      return;
    }
  }

  const ext = mimeType === "image/png" ? "png" : mimeType === "image/jpeg" ? "jpg" : "svg";
  const gridFsId = await uploadToGridFs(
    content,
    `company-logo.${ext}`,
    { kind: "company-logo", mimeType, uploadedBy: req.user!._id },
    COMPANY_ASSETS_BUCKET
  );

  const doc = await getOrCreateCompanySettings();
  const previous = doc.logo?.gridFsId ?? null;
  doc.logo = { gridFsId, mimeType, size: content.length };
  try {
    await doc.save();
  } catch (err) {
    await deleteFromGridFs(gridFsId, COMPANY_ASSETS_BUCKET);
    throw err;
  }
  if (previous) await deleteFromGridFs(previous, COMPANY_ASSETS_BUCKET);
  setCompanySettingsCache(doc);

  logActivity({
    action: "settings_updated",
    actor: req.user,
    targetType: "company_settings",
    targetId: doc._id as mongoose.Types.ObjectId,
    targetName: "Company logo",
    details: { changed: ["logo"], logo: "uploaded", mimeType, size: content.length },
    ip: req.ip,
  });

  res.json({ settings: serializeCompany(req, toSnapshot(doc)) });
}

/** DELETE /api/settings/company/logo — admin. Idempotent. */
export async function deleteCompanyLogo(req: Request, res: Response): Promise<void> {
  const doc = await getOrCreateCompanySettings();
  const previous = doc.logo?.gridFsId ?? null;
  if (previous) {
    doc.logo = null;
    await doc.save();
    await deleteFromGridFs(previous, COMPANY_ASSETS_BUCKET);
    logActivity({
      action: "settings_updated",
      actor: req.user,
      targetType: "company_settings",
      targetId: doc._id as mongoose.Types.ObjectId,
      targetName: "Company logo",
      details: { changed: ["logo"], logo: "removed" },
      ip: req.ip,
    });
  }
  setCompanySettingsCache(doc);
  res.json({ settings: serializeCompany(req, toSnapshot(doc)) });
}

/** GET /api/settings/company/logo[?v=<id>] — public image with strict headers. */
export async function serveCompanyLogo(req: Request, res: Response): Promise<void> {
  const logo = companySettings().logo;
  // Logo responses must never be interpreted as a document.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  // The frontend (another origin) embeds it with <img>; helmet defaults to same-origin.
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

  if (!logo || !mongoose.isValidObjectId(logo.id)) {
    res.setHeader("Cache-Control", "no-store");
    res.status(404).json({ error: "No logo" });
    return;
  }

  const etag = `"logo-${logo.id}"`;
  const versioned = req.query.v === logo.id;
  res.setHeader("ETag", etag);
  // ?v=<current id> is immutable (a new upload gets a new id); otherwise revalidate.
  res.setHeader("Cache-Control", versioned ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate");
  if (req.headers["if-none-match"]?.split(/\s*,\s*/).includes(etag)) {
    res.status(304).end();
    return;
  }

  res.setHeader("Content-Type", logo.mimeType);
  res.setHeader("Content-Length", String(logo.size));
  res.setHeader(
    "Content-Disposition",
    `inline; filename="company-logo.${logo.mimeType === "image/png" ? "png" : logo.mimeType === "image/jpeg" ? "jpg" : "svg"}"`
  );

  const stream = openGridFsDownload(new mongoose.Types.ObjectId(logo.id), COMPANY_ASSETS_BUCKET);
  stream.once("error", () => {
    if (!res.headersSent) {
      res.removeHeader("Content-Type");
      res.removeHeader("Content-Length");
      res.removeHeader("Content-Disposition");
      res.setHeader("Cache-Control", "no-store");
      res.status(404).json({ error: "No logo" });
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}
