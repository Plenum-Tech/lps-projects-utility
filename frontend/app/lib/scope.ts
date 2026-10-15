import type { ScopeItem } from "@/types";

/** Units offered in scope rows (keep in step with backend lib/scopeUnits.ts). */
export const SCOPE_UNITS = ["Video", "Static", "Story", "Carousel", "Reel", "Others"] as const;

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
