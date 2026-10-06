/**
 * Product identity. The company name from Settings → Company is shown as a
 * subtitle when an admin has set one; until then the product name is used.
 */
export const PRODUCT_NAME = "LPS – Projects Utility";
export const PRODUCT_SHORT_NAME = "LPS";
export const PRODUCT_TAGLINE = "Projects Utility";
export const PRODUCT_COMPANY = "Plenum Tech";
export const PRODUCT_DESCRIPTION =
  "LPS – Projects Utility by Plenum Tech: projects, tasks, time and people in one place.";

/** Default logo (wide: mark + "LPS"). Replace with a high-res asset when available. */
export const DEFAULT_LOGO_SRC = "/brand/lps-logo.png";

/** Names that mean "no company name set" (current and earlier defaults). */
const DEFAULT_COMPANY_NAMES = new Set([PRODUCT_NAME, "EMS"]);

/** The admin-set company name, or null while it is still a default. */
export function customCompanyName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  return trimmed && !DEFAULT_COMPANY_NAMES.has(trimmed) ? trimmed : null;
}
