// ---------------------------------------------------------------------------
// Boot-time environment validation.
//
// Production (NODE_ENV=production, e.g. the Azure Container Apps image) fails
// fast with one clear message listing every problem, instead of booting and
// failing on the first login. Outside production the same checks only warn, so
// a local .env with short dev secrets keeps working.
// ---------------------------------------------------------------------------

const MIN_SECRET_LENGTH = 32;
const REQUIRED = ["MONGO_URI", "JWT_SECRET", "COOKIE_SECRET"] as const;
const SECRETS = ["JWT_SECRET", "COOKIE_SECRET"] as const;
const JOBS_MODES = ["in-process", "inngest", "off", "dev-loop"] as const;

export type JobsMode = (typeof JOBS_MODES)[number];

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Scheduled-job runner:
 *   in-process → built-in scheduler with a Mongo lease lock (the container default)
 *   inngest    → Inngest crons call /api/inngest (Inngest Cloud / dev server)
 *   off        → no scheduled jobs in this process
 *   dev-loop   → the legacy dev-only hourly/15-min loop (no lease lock)
 * Unset: no scheduled jobs (reminder emails only run when explicitly enabled).
 */
export function jobsMode(): JobsMode | null {
  const raw = process.env.JOBS_MODE?.trim().toLowerCase();
  if (!raw) return null;
  return (JOBS_MODES as readonly string[]).includes(raw) ? (raw as JobsMode) : null;
}

/** Returns the list of problems (empty when the environment is valid). */
export function environmentProblems(): string[] {
  const problems: string[] = [];
  for (const key of REQUIRED) {
    if (!process.env[key]?.trim()) problems.push(`${key} is not set`);
  }
  for (const key of SECRETS) {
    const value = process.env[key]?.trim();
    if (value && value.length < MIN_SECRET_LENGTH) {
      problems.push(`${key} must be at least ${MIN_SECRET_LENGTH} characters (got ${value.length})`);
    }
  }
  const mode = process.env.JOBS_MODE?.trim();
  if (mode && !jobsMode()) {
    problems.push(`JOBS_MODE must be one of ${JOBS_MODES.join(", ")} (got "${mode}")`);
  }
  if (isProduction() && process.env.EMAIL_REDIRECT_TO?.trim()) {
    // Not fatal (useful on a staging deployment) but loud: all mail goes to one inbox.
    console.warn("⚠️  EMAIL_REDIRECT_TO is set — every email is redirected. Leave it empty in production.");
  }
  return problems;
}

/** Validates the environment; exits the process in production when it's invalid. */
export function validateEnvironment(): void {
  const problems = environmentProblems();
  if (problems.length === 0) return;
  const message = `Invalid environment:\n  - ${problems.join("\n  - ")}`;
  if (isProduction()) {
    console.error(`❌ ${message}\nSet these as Container App secrets/env vars (see DEPLOY-AZURE.md).`);
    process.exit(1);
  }
  console.warn(`⚠️  ${message}\n(Only a warning outside production.)`);
}
