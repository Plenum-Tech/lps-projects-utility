/**
 * Feature switches, read from Vite env at build time. A disabled feature is
 * hidden from navigation and its routes redirect to the dashboard; the code
 * stays in place so it can be turned back on.
 *
 * - `VITE_FEATURE_AI_INSIGHTS=true` — AI Insights (needs GEMINI_API_KEY and
 *   Inngest on the backend). Off by default.
 */
export const FEATURES = {
  aiInsights: import.meta.env.VITE_FEATURE_AI_INSIGHTS === "true",
} as const;

export type FeatureName = keyof typeof FEATURES;
