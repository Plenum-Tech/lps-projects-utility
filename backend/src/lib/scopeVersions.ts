import mongoose from "mongoose";
import type { IBrand, IBrandScopeItem } from "../models/Brand.js";
import { BrandScopeVersion, type IBrandScopeVersion, type ScopeVersionSource } from "../models/BrandScopeVersion.js";
import { User } from "../models/User.js";
import { diffScope, sameScope, type ScopeDiff } from "./scopeMatch.js";

// ---------------------------------------------------------------------------
// Brand scope versions (models/BrandScopeVersion.ts): a version is written
// whenever a brand's scope rows change — create, upload, direct edit or an
// approved change request. Older brands get version 1 from their current scope
// the first time it's needed (lazy backfill). Never throws: history is advice.
// ---------------------------------------------------------------------------

const items = (rows: IBrandScopeItem[] | undefined) =>
  (rows ?? []).map((r) => ({
    unit: r.unit,
    quantity: r.quantity,
    languages: r.languages ?? 1,
    ...(r.languageList?.length ? { languageList: [...r.languageList] } : {}),
    sizes: r.sizes ?? 1,
    what: r.what ?? "",
    source: r.source ?? "",
  }));

function snapshot(brand: IBrand) {
  return {
    items: items(brand.scopeItems),
    files: (brand.scopeFiles ?? []).map((f) => ({ filename: f.filename, gridFsId: f.gridFsId })),
    platforms: [...(brand.platforms ?? [])],
    notes: [...(brand.scopeNotes ?? [])],
    scopeText: brand.scopeText ?? "",
  };
}

/** "Other scope" before / after, when it changed (whitespace-only differences don't count). */
export function scopeTextDiff(from: string | undefined | null, to: string | undefined | null): { from: string; to: string } | null {
  const norm = (s: string | undefined | null) => (s ?? "").replace(/\s+/g, " ").trim();
  return norm(from) === norm(to) ? null : { from: (from ?? "").trim(), to: (to ?? "").trim() };
}

/** Version 1 for a brand that has a scope but no history yet (its scope as it is now). */
export async function ensureBaseVersion(brand: IBrand): Promise<void> {
  try {
    if (!(brand.scopeItems ?? []).length && !(brand.scopeText ?? "").trim()) return;
    const brandId = brand._id as mongoose.Types.ObjectId;
    if (await BrandScopeVersion.exists({ brand: brandId })) return;
    await BrandScopeVersion.create({
      brand: brandId,
      version: 1,
      ...snapshot(brand),
      source: "create",
      by: brand.requestedBy ?? null,
      scopeMatch: brand.scopeMatch ? { score: brand.scopeMatch.score } : null,
      at: brand.createdAt ?? new Date(),
    });
  } catch (err) {
    // A duplicate key = another request wrote it first.
    if ((err as { code?: number })?.code !== 11000) console.error("[scope-versions] base version failed", String(brand._id), err);
  }
}

/**
 * Writes the brand's current scope as a new version when it differs from the latest one.
 * Call ensureBaseVersion(brand) BEFORE changing the scope so the old scope is version 1.
 */
export async function recordScopeVersion(
  brand: IBrand,
  source: ScopeVersionSource,
  by: mongoose.Types.ObjectId | null,
  approvedBy: mongoose.Types.ObjectId | null = null
): Promise<IBrandScopeVersion | null> {
  try {
    const brandId = brand._id as mongoose.Types.ObjectId;
    const latest = await BrandScopeVersion.findOne({ brand: brandId }).sort({ version: -1 });
    const snap = snapshot(brand);
    if (latest && sameScope(latest.items, snap.items) && !scopeTextDiff(latest.scopeText, snap.scopeText)) return null;
    if (!latest && snap.items.length === 0 && !snap.scopeText.trim()) return null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const top = attempt === 0 ? latest : await BrandScopeVersion.findOne({ brand: brandId }).sort({ version: -1 });
      try {
        return await BrandScopeVersion.create({
          brand: brandId,
          version: (top?.version ?? 0) + 1,
          ...snap,
          source,
          by,
          approvedBy,
          scopeMatch: brand.scopeMatch ? { score: brand.scopeMatch.score } : null,
          at: new Date(),
        });
      } catch (err) {
        if ((err as { code?: number })?.code !== 11000) throw err;
      }
    }
  } catch (err) {
    console.error("[scope-versions] record failed", String(brand._id), err);
  }
  return null;
}

export interface ScopeVersionView {
  version: number;
  source: ScopeVersionSource;
  by: { _id: string; name: string } | null;
  approvedBy: { _id: string; name: string } | null;
  at: Date;
  items: ReturnType<typeof items>;
  files: string[];
  platforms: string[];
  notes: string[];
  /** The "other scope" text (not itemised as rows). */
  scopeText: string;
  scopeMatch: { score: number } | null;
  /** Against the version before (version 1: everything added). */
  diff: ScopeDiff;
  /** The "other scope" text before / after, when it changed against the version before. */
  textDiff: { from: string; to: string } | null;
}

/** The brand's versions, newest first, each with its diff against the one before. */
export async function scopeVersionsOf(brand: IBrand): Promise<ScopeVersionView[]> {
  await ensureBaseVersion(brand);
  const list = await BrandScopeVersion.find({ brand: brand._id }).sort({ version: 1 }).limit(200).lean();
  const ids = [...new Set(list.flatMap((v) => [v.by, v.approvedBy]).filter(Boolean).map(String))];
  const names = new Map((await User.find({ _id: { $in: ids } }).select("name").lean()).map((u) => [String(u._id), u.name]));
  const person = (id: unknown) => (id ? { _id: String(id), name: names.get(String(id)) ?? "Unknown" } : null);
  const out: ScopeVersionView[] = [];
  let previous: typeof list[number] | null = null;
  for (const v of list) {
    out.push({
      version: v.version,
      source: v.source,
      by: person(v.by),
      approvedBy: person(v.approvedBy),
      at: v.at,
      items: items(v.items),
      files: (v.files ?? []).map((f) => f.filename),
      platforms: v.platforms ?? [],
      notes: v.notes ?? [],
      scopeText: v.scopeText ?? "",
      scopeMatch: (v.scopeMatch as { score: number } | null) ?? null,
      diff: diffScope(previous?.items ?? [], v.items ?? []),
      textDiff: scopeTextDiff(previous?.scopeText, v.scopeText),
    });
    previous = v;
  }
  return out.reverse();
}
