// ---------------------------------------------------------------------------
// Scope: a project's deliverables as structured rows (unit, quantity and the
// language / size multipliers). Tasks name a scope unit; going over a unit's
// approved total flags the task until an admin approves the extra.
// ---------------------------------------------------------------------------

/** Units offered in the scope rows (and the task form for scoped projects). */
export const SCOPE_UNITS = ["Video", "Static", "Story", "Carousel", "Reel", "Others"] as const;

export const SCOPE_LIMITS = { maxRows: 50, maxQuantity: 999, maxMultiplier: 20 } as const;

export interface ScopeItem {
  unit: string;
  quantity: number;
  languages: number;
  sizes: number;
}

export const scopeTotal = (item: ScopeItem) => item.quantity * item.languages * item.sizes;

/** Approved total per unit (lower-cased key). */
export function scopeTotals(items: ScopeItem[] | undefined | null): Map<string, { unit: string; total: number }> {
  const out = new Map<string, { unit: string; total: number }>();
  for (const item of items ?? []) {
    const key = item.unit.trim().toLowerCase();
    const prev = out.get(key);
    out.set(key, { unit: prev?.unit ?? item.unit, total: (prev?.total ?? 0) + scopeTotal(item) });
  }
  return out;
}

/** "12 Video · 6 Static = 18" */
export function scopeText(items: ScopeItem[] | undefined | null): string {
  if (!items?.length) return "—";
  const totals = [...scopeTotals(items).values()];
  const sum = totals.reduce((n, t) => n + t.total, 0);
  return `${totals.map((t) => `${t.total} ${t.unit}`).join(" · ")} = ${sum}`;
}

/** Validates `[{ unit, quantity, languages?, sizes? }]`; returns the rows or an error message. */
export function parseScopeItems(raw: unknown): ScopeItem[] | string {
  if (!Array.isArray(raw)) return "scopeItems must be a list of { unit, quantity, languages, sizes }";
  if (raw.length > SCOPE_LIMITS.maxRows) return `At most ${SCOPE_LIMITS.maxRows} scope rows`;
  const units = new Map(SCOPE_UNITS.map((u) => [u.toLowerCase(), u as string]));
  const rows: ScopeItem[] = [];
  for (const [index, item] of (raw as Array<Record<string, unknown>>).entries()) {
    const at = `Scope row ${index + 1}`;
    const unit = typeof item?.unit === "string" ? units.get(item.unit.trim().toLowerCase()) : undefined;
    if (!unit) return `${at}: choose a unit (${SCOPE_UNITS.join(", ")})`;
    const int = (v: unknown, max: number, fallback: number) => {
      if (v === undefined || v === null || v === "") return fallback;
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= max ? n : NaN;
    };
    const quantity = int(item.quantity, SCOPE_LIMITS.maxQuantity, NaN);
    const languages = int(item.languages, SCOPE_LIMITS.maxMultiplier, 1);
    const sizes = int(item.sizes, SCOPE_LIMITS.maxMultiplier, 1);
    if (Number.isNaN(quantity)) return `${at}: quantity must be a whole number from 1 to ${SCOPE_LIMITS.maxQuantity}`;
    if (Number.isNaN(languages) || Number.isNaN(sizes)) return `${at}: languages and sizes must be from 1 to ${SCOPE_LIMITS.maxMultiplier}`;
    rows.push({ unit, quantity, languages, sizes });
  }
  return rows;
}
