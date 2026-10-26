import "dotenv/config";
import express from "express";
import type { Server } from "node:http";
import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import mongoose from "mongoose";
import morgan from "morgan";
import {
  inviteAcceptRateLimit,
  passwordResetCompleteRateLimit,
  passwordResetRequestRateLimit,
  passwordResetVerifyRateLimit,
  passwordSetupRateLimit,
  strictRateLimit,
  moderateRateLimit,
  insightsRateLimit,
  standardRateLimit,
} from "./middlewares/rateLimit.js";
import { serve } from "inngest/express";
import { connectDB, disconnectDB, pingDB } from "./db/index.js";
import { inngest, functions } from "./inngest/index.js";
import { logEmailTransportStatus } from "./lib/email.js";
import { isDuplicateKeyError } from "./lib/errors.js";
import { appMinutesOfDay } from "./lib/appTime.js";
import { runHrReminders } from "./lib/hrJobs.js";
import { purgeExpiredImportFiles } from "./lib/imports/jobs.js";
import { runProjectDeadlineReminders, runProjectProgressDeadlineMode } from "./lib/projectJobs.js";
import { runPitchMissedReminders } from "./lib/pitches.js";
import { runMonthlyRetainers } from "./lib/retainers.js";
import { isDbReady, runRecurringTasks, runTaskReminders } from "./lib/taskJobs.js";
import { runAutoStopTimers, runDailyTimeLogReport, runTimeTrackerReminder } from "./lib/timeJobs.js";
import activityLogsRouter from "./routes/activityLogs.js";
import adminRouter from "./routes/admin.js";
import attendanceRouter from "./routes/attendance.js";
import announcementsRouter from "./routes/announcements.js";
import trainingsRouter from "./routes/trainings.js";
import authRouter from "./routes/auth.js";
import departmentsRouter from "./routes/departments.js";
import documentsRouter from "./routes/documents.js";
import feedbackRouter from "./routes/feedback.js";
import importsRouter from "./routes/imports.js";
import invitationsRouter from "./routes/invitations.js";
import passwordSetupRouter from "./routes/passwordSetup.js";
import leavePoliciesRouter from "./routes/leavePolicies.js";
import leavesRouter from "./routes/leaves.js";
import meetingsRouter from "./routes/meetings.js";
import notificationsRouter from "./routes/notifications.js";
import performanceReviewsRouter from "./routes/performanceReviews.js";
import projectMetaRouter from "./routes/projectMeta.js";
import projectsRouter from "./routes/projects.js";
import aiInsightsRouter from "./routes/aiInsights.js";
import insightsRouter from "./routes/insights.js";
import dashboardRouter from "./routes/dashboard.js";
import { taskCategoriesRouter, taskLabelsRouter, taskSettingsRouter } from "./routes/taskMeta.js";
import tasksRouter from "./routes/tasks.js";
import timeLogsRouter from "./routes/timelogs.js";
import timeReportsRouter from "./routes/timeReports.js";
import timesheetsRouter from "./routes/timesheets.js";
import usersRouter from "./routes/users.js";
import voiceRouter from "./routes/voice.js";
import settingsRouter from "./routes/settings.js";
import analyticsRouter from "./routes/analytics.js";
import brandsRouter from "./routes/brands.js";
import projectApprovalRouter from "./routes/projectApproval.js";
import manpowerRouter from "./routes/manpower.js";
import integrationsRouter, { pearityApiRouter } from "./routes/integrations.js";
import { companySettingsFreshness } from "./lib/companySettings.js";
import { scopeUnitsFreshness } from "./lib/scopeUnitSettings.js";
import { isProduction, jobsMode, validateEnvironment } from "./lib/env.js";
import { startScheduler, stopScheduler } from "./lib/scheduler.js";
import { flushProgressRecalcs } from "./lib/projectProgress.js";
import { loadSpa } from "./lib/spa.js";
import { closeAllClients } from "./lib/sse.js";

const app = express();
const PORT = process.env.PORT ?? 5000;
app.disable("x-powered-by");
/** True once SIGTERM/SIGINT is received: health turns 503 so the ingress drains this replica. */
let shuttingDown = false;
/** Built SPA (production container); null in local dev, where Vite serves the UI. */
const spa = loadSpa();

// Behind a proxy (Vercel edge network) trust its X-Forwarded-For so req.ip is the
// real client IP — otherwise all users share one rate-limit bucket. When the API is
// exposed directly, trusting that header would let clients spoof their IP and dodge
// the login/invite limits, so it's off unless on Vercel or TRUST_PROXY says otherwise.
// TRUST_PROXY = number of proxy hops (e.g. "1"), or "false".
const trustProxy = process.env.TRUST_PROXY || (process.env.VERCEL ? "1" : "false");
app.set("trust proxy", /^\d+$/.test(trustProxy) ? Number(trustProxy) : false);

// Parse CORS_ORIGIN as a comma-separated allowlist (e.g. "http://localhost:5173,https://app.example.com")
const corsOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// --- Global middleware (order matters: env first, then security/cors/parsing) ---
// One-time link tokens are credentials: mask them in the logged URL so they never reach the logs.
// Covers the emailed pages (invite, set-password, project approval — the SPA fallback logs
// those page loads too) and the API calls those pages make. Case-insensitive like Express routing.
const SECRET_QUERY_PARAM = /([?&](?:api_?key|key|[\w-]*token|secret|password)=)[^&#]*/gi;
const ONE_TIME_TOKEN_PATH =
  /(\/(?:api\/+(?:invitations\/+accept|password-setup|project-approval)|invite|set-password|project-approval)\/+)[^/?#]+/gi;
morgan.token("url", (req) => {
  const url = (req as express.Request).originalUrl || req.url || "";
  // API keys travel only in the Authorization header (never logged); mask key-like query params defensively.
  return url.replace(ONE_TIME_TOKEN_PATH, "$1[redacted]").replace(SECRET_QUERY_PARAM, "$1[redacted]");
});
// Production: one JSON line per request on stdout (ACA -> Log Analytics); probes are not logged.
const jsonLogFormat: morgan.FormatFn = (tokens, req, res) => {
  const t = (name: string, arg?: string) => tokens[name]?.(req, res, arg);
  return JSON.stringify({
    time: t("date", "iso"),
    ip: t("remote-addr"),
    method: t("method"),
    url: t("url"),
    status: Number(t("status")) || null,
    bytes: Number(t("res", "content-length")) || 0,
    ms: Number(t("response-time")) || 0,
    ua: t("user-agent"),
  });
};
app.use(
  isProduction()
    ? morgan(jsonLogFormat, { skip: (req) => (req as express.Request).originalUrl === "/api/health" })
    : morgan("dev"),
); // Request logging

// Secure HTTP headers. Serving the SPA needs a CSP that allows its own bundle,
// the inline bootstrap scripts React Router writes into index.html (by hash),
// inline styles (charts), Google Fonts, data:/blob: images, and API calls to self.
app.use(
  spa
    ? helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", ...spa.inlineScriptHashes],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "blob:"],
            connectSrc: ["'self'"],
            workerSrc: ["'self'", "blob:"],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            // ACA ingress is HTTPS-only already; omitting this keeps local http://127.0.0.1 tests working.
            upgradeInsecureRequests: null,
          },
        },
      })
    : helmet(),
);

// gzip/deflate/brotli for JSON and static files - never for the SSE stream,
// where buffering would hold events back until the buffer fills.
app.use(
  compression({
    filter(req, res) {
      if (req.path === "/api/notifications/stream") return false;
      const type = String(res.getHeader("Content-Type") ?? "");
      if (type.includes("text/event-stream")) return false;
      return compression.filter(req, res);
    },
  }),
);

// Liveness/readiness for the container platform: 200 when the DB answers a
// ping within 1 s, 503 otherwise (or while shutting down). Not rate limited.
app.get("/api/health", async (_req, res) => {
  const dbUp = !shuttingDown && (await pingDB(1_000));
  res.setHeader("Cache-Control", "no-store");
  res.status(dbUp ? 200 : 503).json({
    status: shuttingDown ? "shutting_down" : dbUp ? "ok" : "degraded",
    db: dbUp ? "up" : "down",
    uptime: Math.round(process.uptime()),
    version: process.env.APP_VERSION?.trim() || "dev",
  });
});

// Built frontend (production container): static assets + SPA fallback.
// Pages opened on the platform address (*.azurecontainerapps.io) redirect to
// the app's own domain (APP_URL, e.g. app.lps-me.com). API calls still work there.
const canonicalHost = (() => {
  try {
    return process.env.APP_URL ? new URL(process.env.APP_URL).host : null;
  } catch {
    return null;
  }
})();
app.use((req, res, next) => {
  if (
    canonicalHost &&
    (req.method === "GET" || req.method === "HEAD") &&
    req.hostname.endsWith(".azurecontainerapps.io") &&
    req.hostname !== canonicalHost &&
    !req.path.startsWith("/api")
  ) {
    res.redirect(301, `https://${canonicalHost}${req.originalUrl}`);
    return;
  }
  next();
});

if (spa) app.use(spa.router);
app.use(
  cors({
    origin(origin, callback) {
      // Allow requests with no Origin header (curl, Postman, server-to-server)
      if (!origin || corsOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true, // Required for cookie-based JWT auth (later steps)
  }),
);
app.use(cookieParser(process.env.COOKIE_SECRET)); // Parse cookies, incl. signed cookies
// Parse JSON request bodies. Pasted meeting transcripts (up to 300k characters) get a larger limit.
const jsonBody = express.json({ limit: "1mb" });
const meetingJsonBody = express.json({ limit: "3mb" });
app.use((req, res, next) => (req.path.startsWith("/api/meetings") ? meetingJsonBody : jsonBody)(req, res, next));
app.use(express.urlencoded({ extended: true })); // Parse form request bodies

// Root health check — confirms the API is up and running (when no SPA is served at /)
if (!spa) {
  app.get("/", (_req, res) => {
    res.send("LPS – Projects Utility API is running 🚀");
  });
}

// --- Rate limiting ---
// Strict: auth endpoints (login brute-force protection)
// (login only — /auth/me runs on every page load and falls under the standard limit)
app.use("/api/auth/login", strictRateLimit);
// Strict: public invitation preview/accept (token guessing + password set).
app.use("/api/invitations/accept", inviteAcceptRateLimit);
app.use("/api/password-setup", passwordSetupRateLimit);
app.use("/api/project-approval", passwordSetupRateLimit);
// Strict: public forgot-password steps (code requests, code guessing, password set).
app.use("/api/auth/password-reset/request", passwordResetRequestRateLimit);
app.use("/api/auth/password-reset/verify", passwordResetVerifyRateLimit);
app.use("/api/auth/password-reset/complete", passwordResetCompleteRateLimit);
// Moderate: expensive compute operations
app.use("/api/ai-insights", moderateRateLimit);
app.use("/api/insights/ask", insightsRateLimit);
// Standard: general API endpoints. The SSE stream is long-lived and reconnects on
// its own, so it is exempt — a 429 there would trigger a reconnect loop.
app.use("/api", (req, res, next) =>
  // The Pearity server-to-server API has its own per-key limit (routes/integrations.ts).
  req.path === "/notifications/stream" || req.path.startsWith("/integrations/pearity/v1/")
    ? next()
    : standardRateLimit(req, res, next),
);

// Company settings (timezone, app URL, branding) are cached in memory; re-read
// them at most once a minute so other instances' edits are picked up.
app.use("/api", companySettingsFreshness);
app.use("/api", scopeUnitsFreshness);

// --- API routers ---
app.use("/api/settings", settingsRouter);
app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/invitations", invitationsRouter);
app.use("/api/password-setup", passwordSetupRouter);
app.use("/api/departments", departmentsRouter);
app.use("/api/leaves", leavesRouter);
app.use("/api/leave-policies", leavePoliciesRouter);
app.use("/api/activity-logs", activityLogsRouter);
app.use("/api/announcements", announcementsRouter);
app.use("/api/trainings", trainingsRouter);
app.use("/api/feedback", feedbackRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/attendance", attendanceRouter);
// Work reports (tasks / time / timesheets); the old HR reports were removed.
app.use("/api/reports", timeReportsRouter);
app.use("/api/performance-reviews", performanceReviewsRouter);
app.use("/api/ai-insights", aiInsightsRouter);
// Leadership Insights: questions answered from read-only data tools (lib/insights).
app.use("/api/insights", insightsRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/tasks", tasksRouter);
app.use("/api/task-labels", taskLabelsRouter);
app.use("/api/task-categories", taskCategoriesRouter);
app.use("/api/task-settings", taskSettingsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/project-meta", projectMetaRouter);
app.use("/api/timelogs", timeLogsRouter);
app.use("/api/timesheets", timesheetsRouter);
app.use("/api/documents", documentsRouter);
app.use("/api/meetings", meetingsRouter);
app.use("/api/imports", importsRouter);
app.use("/api/brands", brandsRouter);
app.use("/api/project-approval", projectApprovalRouter);
app.use("/api/manpower", manpowerRouter);
// Voice task assistant: speech-to-text + reading a request into task fields (saving uses the task / time APIs).
app.use("/api/voice", voiceRouter);
app.use("/api/analytics", analyticsRouter);
// Pearity: server-to-server API (Bearer key) first, then the session/admin endpoints.
app.use("/api/integrations/pearity/v1", pearityApiRouter);
app.use("/api/integrations", integrationsRouter);

// --- Inngest serve endpoint ---
app.use("/api/inngest", serve({ client: inngest, functions }));

// 404 for unknown API routes — JSON, not the default HTML page
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Central JSON error handler — converts CORS, mongoose validation, and duplicate-key errors into clean API responses
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (err instanceof mongoose.Error.ValidationError) {
      // Generic message — mongoose error text can embed attempted field values (e.g. passwords)
      res.status(400).json({ error: "Validation failed" });
      return;
    }
    if (isDuplicateKeyError(err)) {
      res.status(409).json({ error: "Duplicate value already exists" });
      return;
    }
    if (err instanceof Error && err.message === "Not allowed by CORS") {
      res.status(403).json({ error: err.message });
      return;
    }
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  },
);

// Start the server only when this file is run directly (not when imported in tests)
if (import.meta.main) {
  // Fail fast on missing/weak secrets in production (warn only in dev).
  validateEnvironment();
  let server: Server | undefined;

  /**
   * JOBS_MODE=in-process → lease-locked scheduler; JOBS_MODE=dev-loop → the legacy
   * loop below. Unset → no jobs. (Dev used to start the loop automatically, which
   * sent reminder emails for every imported task as soon as SMTP was configured.)
   */
  const startJobs = () => {
    const mode = jobsMode();
    if (mode === "in-process") {
      startScheduler();
      return;
    }
    if (process.env.JOBS_MODE?.trim() !== "dev-loop" || isProduction()) {
      console.log(
        `[jobs] scheduled jobs disabled (JOBS_MODE=${process.env.JOBS_MODE?.trim() || "unset"}; set JOBS_MODE=in-process to enable)`
      );
      return;
    }

    // Local dev without the Inngest dev server: run the task jobs hourly in-process.
    // Their idempotency keys make overlapping with the Inngest crons harmless.
    const runJobs = () => {
      if (!isDbReady()) return;
      void runTaskReminders(new Date()).catch((err) => console.error("[jobs] reminders failed:", err));
      void runRecurringTasks(new Date()).catch((err) => console.error("[jobs] recurring failed:", err));
      void runPitchMissedReminders(new Date()).catch((err) => console.error("[jobs] pitch missed dates failed:", err));
      void runMonthlyRetainers(new Date()).catch((err) => console.error("[jobs] monthly retainers failed:", err));
    };
    setInterval(runJobs, 60 * 60 * 1000).unref();

    // Project + time jobs every 15 minutes; the daily ones only after their
    // configured time (08:00 / 19:30 app timezone). All are idempotent.
    const runTimeJobs = () => {
      if (!isDbReady()) return;
      const now = new Date();
      const minutes = appMinutesOfDay(now);
      void runAutoStopTimers(now).catch((err) => console.error("[jobs] auto-stop failed:", err));
      void runTimeTrackerReminder(now).catch((err) => console.error("[jobs] tracker reminder failed:", err));
      void purgeExpiredImportFiles(now).catch((err) => console.error("[jobs] import file cleanup failed:", err));
      if (minutes >= 8 * 60) {
        void runProjectDeadlineReminders(now).catch((err) => console.error("[jobs] deadline reminders failed:", err));
        void runHrReminders(now).catch((err) => console.error("[jobs] HR reminders failed:", err));
      }
      if (minutes >= 19 * 60 + 30) {
        void runDailyTimeLogReport(now).catch((err) => console.error("[jobs] daily report failed:", err));
      }
      if (minutes >= 15 && minutes < 30) {
        void runProjectProgressDeadlineMode(now).catch((err) => console.error("[jobs] deadline progress failed:", err));
      }
    };
    setInterval(runTimeJobs, 15 * 60 * 1000).unref();
  };

  const startServer = async () => {
    try {
      // Establish the MongoDB connection before accepting requests
      await connectDB();
      server = app.listen(PORT, () => {
        console.log(`✅ Express server running on http://localhost:${PORT}${spa ? ` (serving SPA from ${spa.dir})` : ""}`);
      });

      // Log SMTP status once (never blocks or fails startup)
      void logEmailTransportStatus().catch(() => undefined);

      startJobs();
    } catch (error) {
      console.error("❌ Failed to start server:", error);
      process.exit(1);
    }
  };

  // Graceful shutdown (SIGTERM: docker stop / ACA revision swap or scale-in; SIGINT: Ctrl+C):
  // fail health, stop accepting connections, tell SSE clients to reconnect elsewhere,
  // let the scheduler finish, close Mongo — and exit within 20 s no matter what.
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received — draining`);
    setTimeout(() => {
      console.error("[shutdown] timed out after 20s — forcing exit");
      process.exit(1);
    }, 20_000).unref();

    const closeServer = new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
      closeAllClients(3_000);
      server.closeIdleConnections?.();
      // In-flight requests get 10 s to finish, then remaining sockets are dropped.
      setTimeout(() => {
        server?.closeAllConnections?.();
        resolve();
      }, 10_000).unref();
    });

    void Promise.allSettled([closeServer, stopScheduler(10_000)])
      .then(() => flushProgressRecalcs().catch(() => undefined))
      .then(() => disconnectDB().catch(() => undefined))
      .finally(() => {
        console.log("[shutdown] done");
        process.exit(0);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  startServer();
}

export default app;
