import type { ScopeItem, ScopeUnitDef } from "@/types";

/**
 * Scope units until Settings → Scope units loads (keep in step with backend
 * lib/scopeUnits.ts DEFAULT_SCOPE_UNITS). The live list comes from useScopeUnits().
 */
export const DEFAULT_SCOPE_UNITS: ScopeUnitDef[] = [
  { key: "video", name: "Video", aliases: [], roles: ["videographer", "editor"], countsTowardTotal: true, hidden: false },
  { key: "static", name: "Static", aliases: [], roles: ["designer"], countsTowardTotal: true, hidden: false },
  { key: "story", name: "Story", aliases: [], roles: ["designer"], countsTowardTotal: true, hidden: false },
  { key: "carousel", name: "Carousel", aliases: [], roles: ["designer"], countsTowardTotal: true, hidden: false },
  { key: "reel", name: "Reel", aliases: [], roles: ["editor"], countsTowardTotal: true, hidden: false },
  { key: "animation", name: "Animation", aliases: [], roles: ["animator"], countsTowardTotal: true, hidden: false },
  { key: "others", name: "Others", aliases: [], roles: ["socialMedia"], countsTowardTotal: true, hidden: false },
];

/** The unit a stored name belongs to (by name, else an earlier name), case-insensitive. */
export function findScopeUnit(units: readonly ScopeUnitDef[], name: string): ScopeUnitDef | undefined {
  const k = name.trim().toLowerCase();
  return units.find((u) => u.name.toLowerCase() === k) ?? units.find((u) => u.aliases.some((a) => a.toLowerCase() === k));
}

/**
 * Unit options for a scope row editor: the visible units, plus any unit the rows already use that
 * isn't offered any more (hidden, renamed or removed) — those rows still show and save.
 */
export function scopeUnitOptions(units: readonly ScopeUnitDef[], used: Iterable<string> = []): Array<{ value: string; label: string }> {
  const out = units.filter((u) => !u.hidden).map((u) => ({ value: u.name, label: u.name }));
  const seen = new Set(out.map((o) => o.value.toLowerCase()));
  for (const name of used) {
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ value: name, label: `${name} (not offered)` });
  }
  return out;
}

/** The first visible unit (new rows start with it), preferring `preferred`. */
export function defaultScopeUnit(units: readonly ScopeUnitDef[], preferred: string): string {
  const visible = units.filter((u) => !u.hidden);
  return visible.find((u) => u.name.toLowerCase() === preferred.toLowerCase())?.name ?? visible[0]?.name ?? preferred;
}

/** Languages offered in scope rows (keep in step with backend lib/scopeUnits.ts). */
export const SCOPE_LANGUAGES = ["English", "Arabic", "French", "Hindi", "Urdu", "Russian", "Chinese", "German", "Spanish", "Others"] as const;

/** "× 2 (English, Arabic)" */
export function languagesText(item: ScopeItem): string {
  return item.languageList?.length ? `${item.languages} (${item.languageList.join(", ")})` : String(item.languages);
}

export const scopeTotal = (item: ScopeItem) => item.quantity * item.languages * item.sizes;

/** Approved total per unit, in row order. */
export function scopeTotals(items: ScopeItem[] | undefined | null): Array<{ unit: string; total: number }> {
  const out = new Map<string, { unit: string; total: number }>();
  for (const item of items ?? []) {
    const key = item.unit.toLowerCase();
    out.set(key, { unit: out.get(key)?.unit ?? item.unit, total: (out.get(key)?.total ?? 0) + scopeTotal(item) });
  }
  return [...out.values()];
}
