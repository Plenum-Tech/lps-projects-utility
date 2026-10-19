// ---------------------------------------------------------------------------
// Which manpower plan roles a brand's scope needs (Brands → allocation colours,
// the brand page and the New brand flow's team step).
// ---------------------------------------------------------------------------

type ScopeRowLike = { unit: string; quantity: number; languageList?: string[] };

/** The role that delivers a scope unit (scope item → who delivers it). */
export const UNIT_ROLE: Record<string, string> = {
  Video: "videographer",
  Reel: "editor",
  Static: "designer",
  Story: "designer",
  Carousel: "designer",
  Others: "socialMedia",
};

/** The roles a scope needs, with the reason shown to the user. */
export function rolesFromScope(rows: ScopeRowLike[], notes: string[] = [], text = ""): Array<{ key: string; why: string }> {
  if (rows.length === 0) return [];
  const qty = (unit: string) => rows.filter((r) => r.unit === unit).reduce((n, r) => n + r.quantity, 0);
  const total = rows.reduce((n, r) => n + r.quantity, 0);
  const langs = new Set(rows.flatMap((r) => r.languageList ?? []));
  const all = `${notes.join(" ")} ${text}`.toLowerCase();
  const out: Array<{ key: string; why: string }> = [
    { key: "programLead", why: "Account management" },
    { key: "pm", why: "Runs the project day to day" },
    { key: "creativeLead", why: "Creative direction" },
  ];
  if (total) out.push({ key: "socialMedia", why: `${total} pieces, content calendar` });
  const design = [qty("Static") && `${qty("Static")} statics`, qty("Story") && `${qty("Story")} stories`, qty("Carousel") && `${qty("Carousel")} carousels`].filter(Boolean);
  if (design.length) out.push({ key: "designer", why: design.join(", ") }, { key: "artDirector", why: "Art direction for the designs" });
  const video = [qty("Reel") && `${qty("Reel")} reels`, qty("Video") && `${qty("Video")} videos`].filter(Boolean);
  if (video.length) out.push({ key: "editor", why: video.join(", ") });
  if (/video shoot|filming|film shoot|shoot day/.test(all) || qty("Video")) out.push({ key: "videographer", why: /shoot/.test(all) ? "Video shoots" : `${qty("Video")} videos` });
  if (/shoot/.test(all)) out.push({ key: "producer", why: "Shoot days" });
  if (/animat|motion/.test(all)) out.push({ key: "animator", why: "Motion / animation" });
  if (langs.has("English")) out.push({ key: "englishCopy", why: "Copy in English" });
  if (langs.has("Arabic")) out.push({ key: "arabicCopy", why: "Copy in Arabic" });
  if (/community manag/.test(all)) out.push({ key: "communityManager", why: "Community management" }, { key: "cmLead", why: "Leads community management" });
  return out;
}

/** Set of role keys the scope needs (empty scope = nothing is "needed": flagged, never blocked). */
export function neededRoles(rows: ScopeRowLike[], notes: string[] = []): Set<string> {
  return new Set(rolesFromScope(rows, notes).map((r) => r.key));
}
