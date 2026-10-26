// ---------------------------------------------------------------------------
// Which manpower plan roles a brand's scope needs (Brands → allocation colours,
// the brand page and the New brand flow's team step). The unit → role mapping
// comes from Settings → Scope units (each unit's delivering roles).
// ---------------------------------------------------------------------------

import { DEFAULT_SCOPE_UNITS, findScopeUnit } from "@/lib/scope";
import type { ScopeUnitDef } from "@/types";

type ScopeRowLike = { unit: string; quantity: number; languageList?: string[] };

/** The main role that delivers a scope unit (its first role; Social Media when it has none / is unknown). */
export function unitRole(unit: string, units: readonly ScopeUnitDef[] = DEFAULT_SCOPE_UNITS): string {
  return findScopeUnit(units, unit)?.roles[0] ?? "socialMedia";
}

/** "8 statics", "4 stories", "2 animations". */
const countText = (n: number, unit: string) => {
  const l = unit.toLowerCase();
  return `${n} ${n === 1 ? l : l.endsWith("y") && !/[aeiou]y$/.test(l) ? `${l.slice(0, -1)}ies` : l.endsWith("s") ? l : `${l}s`}`;
};

/** The roles a scope needs, with the reason shown to the user. */
export function rolesFromScope(
  rows: ScopeRowLike[],
  notes: string[] = [],
  text = "",
  units: readonly ScopeUnitDef[] = DEFAULT_SCOPE_UNITS,
): Array<{ key: string; why: string }> {
  if (rows.length === 0) return [];
  const total = rows.reduce((n, r) => n + r.quantity, 0);
  const langs = new Set(rows.flatMap((r) => r.languageList ?? []));
  const all = `${notes.join(" ")} ${text}`.toLowerCase();
  const out: Array<{ key: string; why: string }> = [
    { key: "programLead", why: "Account management" },
    { key: "pm", why: "Runs the project day to day" },
    { key: "creativeLead", why: "Creative direction" },
  ];
  if (total) out.push({ key: "socialMedia", why: `${total} pieces, content calendar` });
  // Each unit's delivering roles (Settings → Scope units), with the counts behind them.
  const qty = new Map<ScopeUnitDef, number>();
  for (const r of rows) {
    const u = findScopeUnit(units, r.unit);
    if (u) qty.set(u, (qty.get(u) ?? 0) + r.quantity);
  }
  const reasons = new Map<string, string[]>();
  for (const u of units) {
    const n = qty.get(u);
    if (!n) continue;
    for (const role of u.roles) reasons.set(role, [...(reasons.get(role) ?? []), countText(n, u.name)]);
  }
  for (const [key, why] of reasons) if (!out.some((r) => r.key === key)) out.push({ key, why: why.join(", ") });
  const has = (key: string) => out.some((r) => r.key === key);
  if (has("designer") && !has("artDirector")) out.push({ key: "artDirector", why: "Art direction for the designs" });
  if (/video shoot|filming|film shoot|shoot day/.test(all) && !has("videographer")) out.push({ key: "videographer", why: "Video shoots" });
  if (/shoot/.test(all) && !has("producer")) out.push({ key: "producer", why: "Shoot days" });
  if (/animat|motion/.test(all) && !has("animator")) out.push({ key: "animator", why: "Motion / animation" });
  if (langs.has("English") && !has("englishCopy")) out.push({ key: "englishCopy", why: "Copy in English" });
  if (langs.has("Arabic") && !has("arabicCopy")) out.push({ key: "arabicCopy", why: "Copy in Arabic" });
  if (/community manag/.test(all) && !has("communityManager")) out.push({ key: "communityManager", why: "Community management" }, { key: "cmLead", why: "Leads community management" });
  return out;
}

/** Set of role keys the scope needs (empty scope = nothing is "needed": flagged, never blocked). */
export function neededRoles(rows: ScopeRowLike[], notes: string[] = [], units: readonly ScopeUnitDef[] = DEFAULT_SCOPE_UNITS): Set<string> {
  return new Set(rolesFromScope(rows, notes, "", units).map((r) => r.key));
}
