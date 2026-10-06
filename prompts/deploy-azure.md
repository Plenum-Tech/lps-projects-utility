# Production Container (single image) for Azure Container Apps

## Goal

Build one Docker image that runs the whole EMS application (API and web UI) on **Azure Container Apps**, pulled from **Azure Container Registry**. It must handle **150 simultaneous users** without performance problems. MongoDB is **external**, configured through `MONGO_URI`; see "Database" below. Scheduled jobs run **inside the container**.

## Architecture (one process, one port)

```
Browser ──HTTPS──▶ Azure Container Apps ingress (TLS, custom domain)
                     │  (proxy, X-Forwarded-For)
                     ▼
               ems container :8080  (Bun + Express)
                 ├── /api/*            Express API (existing)
                 ├── /api/notifications/stream   SSE (long-lived)
                 ├── /assets/*         built frontend, immutable cache (1y)
                 └── /* (SPA)          index.html fallback (no-cache)
                     │
                     ▼
               MongoDB (Atlas / Cosmos vCore / self-managed) via MONGO_URI
```

- **Frontend in SPA mode** (`ssr: false`): the React app is built to static files that Express serves. The UI and API share an origin, so there is **no CORS and no cross-site cookies**.
  - The 3 server `loader`s (the AI Insights redirects and the `/admin/tasks` redirect) become `clientLoader`s.
  - `VITE_API_URL` is set to `/api` at build time.
- **Auth cookie**: with one origin, the production cookie becomes `SameSite=Lax; Secure; HttpOnly` instead of `None`.
- **One container image, one process**: no nginx or supervisor needed.

## Dockerfile (repo root), multi-stage

1. `deps-frontend`: `oven/bun:1.2` runs `bun install --frozen-lockfile` in `frontend/`.
2. `build-frontend`: `bun run build` with `VITE_API_URL=/api`, giving `frontend/build/client`.
3. `deps-backend`: `bun install --frozen-lockfile --production` in `backend/`.
4. `runtime`: `oven/bun:1.2-slim` (pinned digest).
   - Copies the backend source, production `node_modules` and the frontend `build/client` into `/app/public`.
   - Runs as the **non-root** `bun` user, with `ENV NODE_ENV=production PORT=8080`.
   - `EXPOSE 8080`.
   - `HEALTHCHECK` on `/api/health`.
   - `CMD ["bun","src/server.ts"]`. Bun runs TypeScript directly, so the backend needs no compile step. `bun build --target=bun` to a single file is optional if it measurably cuts startup time.
- `.dockerignore`: `node_modules`, `.env*` (**secrets are never baked into the image**), `build`, `.git`, `.claude`, `prompts`, logs, test files.
- Target size: under 250 MB.

## Backend production hardening

| Area | Change |
|---|---|
| Static serving | `express.static(public)` with `immutable, max-age=31536000` for hashed assets, `no-cache` for `index.html`; SPA fallback for non-`/api` GETs only |
| Compression | `compression` middleware (gzip/brotli for JSON + assets). **Excluded for SSE** (`text/event-stream`), so the stream isn't buffered. |
| Health | `GET /api/health`: returns 200 with `{ status, db: "up"/"down", uptime, version }`. A DB ping with a 1-second timeout returns 503 when the DB is down; it's used for the ACA readiness and liveness probes. |
| Graceful shutdown | On SIGTERM: stop accepting connections, close SSE streams with a `retry:` hint, stop the scheduler, close Mongo, then exit within 20 seconds (ACA revisions / scale-in) |
| Mongo pool | `maxPoolSize` from env (default 50), `serverSelectionTimeoutMS`, `socketTimeoutMS`, `retryWrites`; `autoIndex` stays on, with a warning to build indexes once on first deploy |
| Jobs | New `JOBS_MODE=in-process` (default in the container): one scheduler running reminders, recurring tasks, time, project and HR jobs on their cron schedules in `APP_TIMEZONE`. A **Mongo lease lock** (one doc with an expiry) ensures only one replica runs a job at a time; the existing idempotency keys make reruns harmless. `inngest` mode still works for anyone who prefers Inngest Cloud. |
| SSE | Heartbeat every 25 seconds (below the ACA idle timeout); `X-Accel-Buffering: no`; per-user connection cap (5). Fan-out stays in memory, **correct for one replica**. Multiple replicas would need Redis pub/sub, which is documented as a future step and not built now. |
| Rate limiting | In-memory, so correct for one replica. `TRUST_PROXY=1` behind ACA ingress. |
| Security | `helmet` tuned for the SPA: CSP allowing its own origin for scripts, styles and fonts, images from self and data, and connect to self. `x-powered-by` off; request body limits unchanged. |
| Logging | Morgan JSON-ish combined format to stdout (ACA → Log Analytics); no tokens or secrets in logs (already masked for invites) |
| Env validation | On boot: fail fast with a clear message if `MONGO_URI`, `JWT_SECRET` or `COOKIE_SECRET` is missing, or if the secrets are shorter than 32 characters |

## Capacity target: 150 concurrent users

**Sizing**: **1 replica, 1 vCPU / 2 GiB** in ACA is the starting point; 2 vCPU / 4 GiB gives headroom. `minReplicas=1` and `maxReplicas=1` for now, so there are no cold starts and in-memory SSE and rate limits stay correct.

**Load test (k6), checked before handing over**:
- 150 virtual users, a 10-minute run plus ramp-up.
- Each user logs in, holds an SSE stream, loads the dashboard, tasks table and board, opens a task detail, adds a comment, updates a status, loads projects, logs time, and polls notifications, with think time.
- Data set: 150 users, 30 projects, 5,000 tasks, 20,000 comments, 10,000 time logs.
- **Pass criteria**:
  - p95 under 500 ms and p99 under 1.5 s for API reads; p95 under 800 ms for writes.
  - Error rate under 0.5%.
  - 150 SSE streams stay connected.
  - Container CPU below 70% and memory below 1.5 GiB.
- Slow endpoints found by the test are fixed with indexes, query `lean()`/projection, or caching. The run is done locally against the built image with a local Mongo, so it measures the app, not the network.

## Deliverables

- `Dockerfile`, `.dockerignore`, `docker-compose.yml` (app plus local mongo, for testing the image locally).
- `deploy/azure/`:
  - `containerapp.bicep`: environment, Log Analytics, the Container App with ingress, probes, secrets and env vars, plus an ACR pull identity.
  - `deploy.ps1`: `az acr build` / `docker push`, then create or update the app.
- `deploy/k6/load-test.js` plus a seed script for the load data set (`bun run seed:load`, which refuses to run against a DB named `ems`).
- `DEPLOY-AZURE.md`:
  - prerequisites
  - the **exact commands** to build, tag and push to ACR (`az acr login`, `docker build`, `docker push`, or `az acr build`)
  - creating or updating the Container App
  - the env and secrets table (which values are secrets)
  - custom domain and TLS
  - first-deploy migrations (`migrate:*` via `az containerapp exec`)
  - backups
  - scaling notes
  - rollback (revisions)
  - troubleshooting

## Environment / secrets (set in ACA, never in the image)

| Variable | Kind | Notes |
|---|---|---|
| `MONGO_URI` | **secret** | direct (non-SRV) form if SRV DNS is blocked |
| `JWT_SECRET`, `COOKIE_SECRET` | **secret** | ≥32 random characters |
| `SMTP_USER`, `SMTP_PASS` | **secret** | Microsoft 365 mailbox |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `FROM_NAME`, `FROM_EMAIL` | env | |
| `APP_URL`, `API_PUBLIC_URL` | env | both are the public HTTPS URL (same origin) |
| `APP_TIMEZONE` | env | fallback; the setting lives in App Settings |
| `CORS_ORIGIN` | env | the public URL (same origin, so effectively unused) |
| `TRUST_PROXY` | env | `1` |
| `JOBS_MODE` | env | `in-process` |
| `MONGO_MAX_POOL` | env | `50` |
| `EMAIL_REDIRECT_TO` | env | **must be empty in production** |
| `AI_REVIEW_DRAFTS`, `MEETING_AI_EXTRACTION`, `GEMINI_API_KEY` | env / secret | off by default |

## Database

The image works with any MongoDB reachable through `MONGO_URI`. **Running MongoDB inside the same container is not supported by this design** (see the chat answer for why). The recommended choice is MongoDB Atlas (M10+ in an Azure region next to the app) or Azure Cosmos DB for MongoDB vCore. A self-managed Mongo container alongside the app is possible, with caveats.

## Done when

- `docker build` succeeds and the image runs locally with `docker compose up`: login, dashboard, tasks, SSE live updates, file upload/download, emails (redirected) and the scheduled jobs firing.
- The k6 run meets the pass criteria above, with results summarised in `DEPLOY-AZURE.md`.
- The image runs as non-root with no secrets in any layer (checked with `docker history` and by inspecting the filesystem).
- Following `DEPLOY-AZURE.md` gives a working Container App with no other knowledge required.
