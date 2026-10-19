import type { Request, Response } from "express";
import mongoose from "mongoose";
import { openGridFsDownload } from "../lib/gridfs.js";
import { isInvalidObjectId, param } from "../lib/projectAccess.js";
import { extractScope, type ExtractedLead, type ScopeExtraction } from "../lib/scopeExtract.js";
import { computeScopeMatch, parseAgreement, parseMatchRows, type MatchRow, type ScopeAgreement } from "../lib/scopeMatch.js";
import { scopeVersionsOf } from "../lib/scopeVersions.js";
import { Brand, type IBrand } from "../models/Brand.js";
import { User } from "../models/User.js";

// ---------------------------------------------------------------------------
// Brand scope vs its agreement: the similarity score (POST /api/brands/scope-match),
// the agreement a brand's scope is compared with (stored, or read lazily from its
// files), the scope version history (GET /api/brands/:id/scope-versions) and the
// lead names read from a document matched to users.
// ---------------------------------------------------------------------------

const AGREEMENT_TEXT_MAX = 12_000;

/** What gets stored as the brand's agreement from an extraction (rows + text + file names). */
export function agreementFromExtraction(extraction: Pick<ScopeExtraction, "scope" | "texts">): NonNullable<IBrand["scopeAgreement"]> {
  return {
    rows: extraction.scope.map((r) => ({ unit: r.unit, what: r.what, quantity: r.quantity, languageList: r.languageList, sizes: r.sizes })),
    text: extraction.texts.map((t) => t.text).join("\n").slice(0, AGREEMENT_TEXT_MAX),
    sources: extraction.texts.map((t) => t.source).slice(0, 20),
    at: new Date(),
  };
}

/** A stored agreement from a client-sent extraction (`{ scope | rows, texts | text }`), or null. */
export function storedAgreementFrom(raw: unknown): NonNullable<IBrand["scopeAgreement"]> | null {
  const parsed = parseAgreement(raw);
  if (!parsed) return null;
  const o = raw as Record<string, unknown>;
  const sources = Array.isArray(o.texts) ? (o.texts as Array<Record<string, unknown>>).map((t) => String(t?.source ?? "")).filter(Boolean).slice(0, 20) : [];
  return { rows: parsed.rows as unknown as Array<Record<string, unknown>>, text: parsed.text, sources, at: new Date() };
}

async function readGridFs(id: mongoose.Types.ObjectId): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = openGridFsDownload(id);
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.once("error", reject);
    stream.once("end", () => resolve());
  });
  return Buffer.concat(chunks);
}

/**
 * The agreement a brand's scope is compared with: the stored one, else read now from
 * the brand's documents (and stored). Null when there's nothing readable.
 */
export async function agreementForBrand(brand: IBrand): Promise<ScopeAgreement | null> {
  const stored = brand.scopeAgreement;
  if (stored && ((stored.rows ?? []).length || stored.text)) return { rows: parseMatchRows(stored.rows), text: stored.text ?? "" };
  const files = (brand.scopeFiles ?? []).slice(0, 10);
  if (!files.length) return null;
  try {
    const inputs = [];
    for (const f of files) inputs.push({ originalname: f.filename, mimetype: f.mimeType || "application/octet-stream", buffer: await readGridFs(f.gridFsId) });
    const extraction = await extractScope(inputs, "");
    const agreement = agreementFromExtraction(extraction);
    if (!agreement.rows.length && !agreement.text.trim()) return null;
    await Brand.updateOne({ _id: brand._id }, { $set: { scopeAgreement: agreement } });
    brand.scopeAgreement = agreement;
    return { rows: parseMatchRows(agreement.rows), text: agreement.text };
  } catch (err) {
    console.error("[scope-match] couldn't read the brand's documents", String(brand._id), err);
    return null;
  }
}

/**
 * POST /api/brands/scope-match — admins; `{ rows, extraction }` (the flow's read result) or
 * `{ rows, brandId }` (the brand's stored agreement / documents). Advice only.
 */
export async function scopeMatch(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const rows = parseMatchRows(body.rows);
  let agreement = parseAgreement(body.extraction);
  if (!agreement && typeof body.brandId === "string") {
    if (isInvalidObjectId(body.brandId)) {
      res.status(400).json({ error: "brandId is not valid" });
      return;
    }
    const brand = await Brand.findById(body.brandId);
    if (!brand) {
      res.status(404).json({ error: "Brand not found" });
      return;
    }
    agreement = await agreementForBrand(brand);
  }
  if (!agreement) {
    res.json({ match: null, reason: "No agreement to compare with — upload the agreement (PDF, image, Word or Excel)." });
    return;
  }
  res.json({ match: await computeScopeMatch(agreement, rows) });
}

/** The match of `rows` against the brand's agreement (or the given one); null when there's none. */
export async function brandScopeMatch(brand: IBrand, rows: MatchRow[], agreement?: ScopeAgreement | null) {
  const base = agreement ?? (await agreementForBrand(brand));
  if (!base) return null;
  return computeScopeMatch(base, rows);
}

/** GET /api/brands/:id/scope-versions — anyone who can see the brand: its scope history, newest first. */
export async function listScopeVersions(req: Request, res: Response): Promise<void> {
  const id = param(req, "id");
  const brand = id && !isInvalidObjectId(id) ? await Brand.findById(id) : null;
  const user = req.user!;
  const visible =
    brand && (user.role === "admin" || !brand.status || brand.status === "approved" || String(brand.requestedBy ?? "") === String(user._id));
  if (!brand || !visible) {
    res.status(404).json({ error: "Brand not found" });
    return;
  }
  res.json({ versions: await scopeVersionsOf(brand) });
}

export interface LeadMatch {
  name: string;
  source: string;
  user: { _id: string; name: string; email: string } | null;
}

/**
 * Lead names read from the documents matched to users (case-insensitive: full name, e-mail,
 * e-mail name, or a unique first name). "Prepared by" names are kept only when they match.
 */
export async function matchLeadUsers(leads: ExtractedLead[]): Promise<LeadMatch[]> {
  if (!leads.length) return [];
  const users = await User.find({}).select("name email").lean();
  const out: LeadMatch[] = [];
  for (const lead of leads) {
    const n = lead.name.trim().toLowerCase().replace(/\s+/g, " ");
    const byName = users.filter((u) => u.name.trim().toLowerCase().replace(/\s+/g, " ") === n);
    const byEmail = users.filter((u) => u.email.toLowerCase() === n || u.email.toLowerCase().split("@")[0]!.replace(/[._-]+/g, " ") === n);
    const byFirst = !n.includes(" ") && n.length >= 3 ? users.filter((u) => u.name.trim().toLowerCase().split(/\s+/)[0] === n) : [];
    const byStart = n.includes(" ") ? users.filter((u) => u.name.trim().toLowerCase().startsWith(`${n} `)) : [];
    const hit = byName.length === 1 ? byName[0] : byEmail.length === 1 ? byEmail[0] : byFirst.length === 1 ? byFirst[0] : byStart.length === 1 ? byStart[0] : undefined;
    if (!hit && lead.weak) continue;
    if (hit && out.some((o) => o.user?._id === String(hit._id))) continue;
    out.push({ name: lead.name, source: lead.source, user: hit ? { _id: String(hit._id), name: hit.name, email: hit.email } : null });
  }
  return out;
}
