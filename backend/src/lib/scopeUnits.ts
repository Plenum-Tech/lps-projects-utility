// ---------------------------------------------------------------------------
// Scope: a project's deliverables as structured rows (unit, quantity and the
// language / size multipliers). Tasks name a scope unit; going over a unit's
// approved total flags the task until an admin approves the extra.
// ---------------------------------------------------------------------------

/**
 * A scope unit as configured in Settings → Scope units (models/ScopeUnitSettings.ts).
 * `key` is stable (renames keep it); scope rows store the unit's `name`. `aliases`
 * are earlier names, so rows saved under an old name stay valid and keep their roles.
 */
export interface ScopeUnitDef {
  key: string;
  name: string;
  aliases: string[];
  /** Manpower plan roles that deliver it (the first is the main one). */
  roles: string[];
  /** Counted in the "rows add up to" check against the agreement total. */
  countsTowardTotal: boolean;
  /** Hidden units aren't offered for new rows; existing rows keep them. */
  hidden: boolean;
}

/** The units until an admin edits the list (no settings document = these). */
export const DEFAULT_SCOPE_UNITS: readonly ScopeUnitDef[] = [
  { key: "video", name: "Video", aliases: [], roles: ["videographer", "editor"], countsTowardTotal: true, hidden: false },
  { key: "static", name: "Static", aliases: [], roles: ["designer"], countsTowardTotal: true, hidden: false },
  { key: "story", name: "Story", aliases: [], roles: ["designer"], countsTowardTotal: true, hidden: false },
  { key: "carousel", name: "Carousel", aliases: [], roles: ["designer"], countsTowardTotal: true, hidden: false },
  { key: "reel", name: "Reel", aliases: [], roles: ["editor"], countsTowardTotal: true, hidden: false },
  { key: "animation", name: "Animation", aliases: [], roles: ["animator"], countsTowardTotal: true, hidden: false },
  { key: "others", name: "Others", aliases: [], roles: ["socialMedia"], countsTowardTotal: true, hidden: false },
];

export const SCOPE_UNIT_LIMITS = { maxUnits: 40, nameMax: 30, maxRoles: 4, maxAliases: 10 } as const;

// Held in memory (lib/scopeUnitSettings.ts loads / refreshes it) so the sync
// validators and the extractor read the configured list.
let current: readonly ScopeUnitDef[] = DEFAULT_SCOPE_UNITS;

/** Replaces the in-memory list (lib/scopeUnitSettings.ts). */
export function setScopeUnitDefs(units: readonly ScopeUnitDef[] | null): void {
  current = units && units.length ? units : DEFAULT_SCOPE_UNITS;
}

/** Every configured unit, in order (hidden ones too). */
export function scopeUnitDefs(): readonly ScopeUnitDef[] {
  return current;
}

/** Names offered for new rows (visible units, in order). */
export function scopeUnitNames(): string[] {
  return current.filter((u) => !u.hidden).map((u) => u.name);
}

/** The unit a stored name belongs to (by name or an earlier name), case-insensitive. */
export function scopeUnitOf(name: string): ScopeUnitDef | undefined {
  const k = name.trim().toLowerCase();
  return current.find((u) => u.name.toLowerCase() === k) ?? current.find((u) => u.aliases.some((a) => a.toLowerCase() === k));
}

export const SCOPE_LIMITS = { maxRows: 50, maxQuantity: 999, maxMultiplier: 20 } as const;

export interface ScopeItem {
  unit: string;
  quantity: number;
  /** Multiplier: the number of languages (= languageList.length when the languages are named). */
  languages: number;
  /** The languages ("English", "Arabic" …), when picked. */
  languageList?: string[];
  sizes: number;
}

/** Languages offered in scope rows. */
export const SCOPE_LANGUAGES = ["English", "Arabic", "French", "Hindi", "Urdu", "Russian", "Chinese", "German", "Spanish", "Others"] as const;

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

/**
 * Validates `[{ unit, quantity, languages?, sizes? }]`; returns the rows or an error message.
 * A unit must be a configured one (hidden units and earlier names too — the stored spelling is
 * kept) or one of `keep`: the units already on the record, so rows whose unit was since removed
 * from Settings still save.
 */
export function parseScopeItems(raw: unknown, keep: Iterable<string> = []): ScopeItem[] | string {
  if (!Array.isArray(raw)) return "scopeItems must be a list of { unit, quantity, languages, sizes }";
  if (raw.length > SCOPE_LIMITS.maxRows) return `At most ${SCOPE_LIMITS.maxRows} scope rows`;
  const units = new Map<string, string>();
  for (const name of keep) if (name?.trim()) units.set(name.trim().toLowerCase(), name.trim());
  for (const u of scopeUnitDefs()) {
    for (const a of u.aliases) if (!units.has(a.toLowerCase())) units.set(a.toLowerCase(), a);
    units.set(u.name.toLowerCase(), u.name);
  }
  const rows: ScopeItem[] = [];
  for (const [index, item] of (raw as Array<Record<string, unknown>>).entries()) {
    const at = `Scope row ${index + 1}`;
    const unit = typeof item?.unit === "string" ? units.get(item.unit.trim().toLowerCase()) : undefined;
    if (!unit) return `${at}: choose a unit (${scopeUnitNames().join(", ")})`;
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
    // Named languages decide the multiplier.
    let languageList: string[] | undefined;
    if (Array.isArray(item.languageList) && item.languageList.length > 0) {
      const known = new Map(SCOPE_LANGUAGES.map((l) => [l.toLowerCase(), l as string]));
      languageList = [];
      for (const raw of item.languageList as unknown[]) {
        const name = typeof raw === "string" ? known.get(raw.trim().toLowerCase()) : undefined;
        if (!name) return `${at}: choose languages from ${SCOPE_LANGUAGES.join(", ")}`;
        if (!languageList.includes(name)) languageList.push(name);
      }
    }
    rows.push(
      languageList
        ? { unit, quantity, languages: languageList.length, languageList, sizes }
        : { unit, quantity, languages, sizes }
    );
  }
  return rows;
}
