# Deploying LPS – Projects Utility to Azure Container Apps

One Docker image — `lps-projects-utility` — runs the whole application: the
Express API **and** the React SPA, served by a single Bun process on port
**8080**. It runs on **Azure Container Apps (ACA)**, is pulled from **Azure
Container Registry (ACR)**, and talks to an **external MongoDB** through
`MONGO_URI`. Scheduled jobs run inside the container.

```
Browser ──HTTPS──▶ ACA ingress (TLS, custom domain, X-Forwarded-For)
                     ▼
               app container :8080 (Bun + Express, non-root)
                 ├── /api/*                       REST API
                 ├── /api/notifications/stream    SSE (25 s heartbeat)
                 ├── /api/health                  probes (DB ping, 1 s timeout)
                 ├── /assets/*                    hashed bundle, cached 1 year
                 └── /*                           SPA index.html (no-cache)
                     ▼
               MongoDB (Atlas M10+ / Cosmos DB for MongoDB vCore) via MONGO_URI
```

UI and API share one origin, so there is no CORS and the session cookie is
`HttpOnly; Secure; SameSite=Lax`.

---

## 1. Prerequisites

| What | Notes |
|---|---|
| Azure subscription | Rights to create resource groups, and **Owner** or **User Access Administrator** on the registry (the Bicep template grants the app's identity `AcrPull`). |
| Azure CLI ≥ 2.60 | `az upgrade`; extension: `az extension add -n containerapp --upgrade`. Bicep is installed on first use (`az bicep install`). |
| Docker Desktop | Only for local builds/tests (`az acr build` builds in the cloud instead). |
| MongoDB | **MongoDB Atlas M10+** in the same Azure region (recommended) or **Azure Cosmos DB for MongoDB vCore** (see §10 caveats). Shared/M0 tiers are not suitable for 150 users. |
| Microsoft 365 mailbox | SMTP AUTH enabled for the sending mailbox (`SMTP_USER`/`SMTP_PASS`). |
| DNS access | For the custom domain (CNAME + TXT records). |

Names used below — replace them:

```powershell
$RG   = "rg-lps-prod"            # resource group
$LOC  = "centralindia"           # region (same as the database)
$ACR  = "lpsacr"                 # registry name → lpsacr.azurecr.io (globally unique, lowercase)
$APP  = "lps-projects-utility"   # container app
$TAG  = git rev-parse --short HEAD
```

---

## 2. Build, tag and push the image to ACR

```powershell
az login
az account set --subscription "<subscription name or id>"
az group create -n $RG -l $LOC
az acr create -n $ACR -g $RG --sku Basic --admin-enabled false   # once
```

**Option A — build in Azure (no local Docker needed):**

```powershell
az acr build --registry $ACR --image "lps-projects-utility:$TAG" --build-arg APP_VERSION=$TAG .
```

**Option B — build locally and push:**

```powershell
az acr login --name $ACR
docker build -t "$ACR.azurecr.io/lps-projects-utility:$TAG" --build-arg APP_VERSION=$TAG .
docker push "$ACR.azurecr.io/lps-projects-utility:$TAG"
```

Run either from the **repository root** (the Dockerfile builds `frontend/` and
`backend/`). Use immutable tags (the git SHA); avoid deploying `latest`.

Build facts: multi-stage (Bun 1.2.19 installs from `bun.lock`; the React Router
SPA build runs on Node 22; `bun build` bundles the backend and the CLI scripts
into `dist/`), runtime `oven/bun:1.2.19-alpine` pinned by digest, **~200 MB**
uncompressed / ~53 MB compressed, runs as the non-root `bun` user, contains no
`.env` files or secrets (`.dockerignore` excludes `**/.env*`).

---

## 3. Create or update the Container App

### One command (recommended)

```powershell
$env:LPS_MONGO_URI     = "<mongodb+srv://… or mongodb://…>"
$env:LPS_JWT_SECRET    = "<64 random chars>"     # e.g. [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:LPS_COOKIE_SECRET = "<64 random chars>"
$env:LPS_SMTP_USER     = "noreply@plenum-tech.com"
$env:LPS_SMTP_PASS     = "<mailbox / app password>"

./deploy/azure/deploy.ps1 -ResourceGroup $RG -AcrName $ACR -Location $LOC `
  -AppUrl "https://lps.plenum-tech.com" -FromEmail "noreply@plenum-tech.com" -Cpu 2.0
```

`deploy.ps1` checks you are logged in, creates the registry if missing, builds
(`-BuildMode acr` default, `docker` for a local build, `none` to redeploy an
existing `-Tag`), then deploys `deploy/azure/containerapp.bicep`. Secrets are
passed through a temporary parameters file that is deleted afterwards; missing
required secrets are prompted for. Re-running it updates the app in place
(a new revision).

### What the Bicep template creates

| Resource | Purpose |
|---|---|
| Log Analytics workspace `<app>-logs` | Container stdout/stderr (JSON request logs) |
| Container Apps environment `<app>-env` | Consumption environment |
| User-assigned identity `<app>-acr-pull` + `AcrPull` role on the registry | Image pulls without registry passwords |
| Container App `<app>` | External HTTPS ingress → 8080, `allowInsecure: false`, single revision mode, 1 replica, secrets, env vars, probes |

Probes (all `GET /api/health` on 8080, which returns 503 when the DB ping fails
or while shutting down): **startup** every 5 s up to ~2 min (first boot builds
indexes), **readiness** every 10 s, **liveness** every 30 s × 5 failures.

### Manual equivalent (Azure CLI)

```powershell
az containerapp env create -n "$APP-env" -g $RG -l $LOC
az identity create -n "$APP-acr-pull" -g $RG
$idId  = az identity show -n "$APP-acr-pull" -g $RG --query id -o tsv
$idPid = az identity show -n "$APP-acr-pull" -g $RG --query principalId -o tsv
az role assignment create --assignee-object-id $idPid --assignee-principal-type ServicePrincipal `
  --role AcrPull --scope (az acr show -n $ACR --query id -o tsv)

az containerapp create -n $APP -g $RG --environment "$APP-env" `
  --image "$ACR.azurecr.io/lps-projects-utility:$TAG" `
  --registry-server "$ACR.azurecr.io" --registry-identity $idId --user-assigned $idId `
  --ingress external --target-port 8080 --transport auto `
  --cpu 2.0 --memory 4Gi --min-replicas 1 --max-replicas 1 `
  --secrets mongo-uri="$env:LPS_MONGO_URI" jwt-secret="$env:LPS_JWT_SECRET" `
            cookie-secret="$env:LPS_COOKIE_SECRET" smtp-user="$env:LPS_SMTP_USER" smtp-pass="$env:LPS_SMTP_PASS" `
  --env-vars MONGO_URI=secretref:mongo-uri JWT_SECRET=secretref:jwt-secret COOKIE_SECRET=secretref:cookie-secret `
             SMTP_USER=secretref:smtp-user SMTP_PASS=secretref:smtp-pass `
             SMTP_HOST=smtp.office365.com SMTP_PORT=587 SMTP_SECURE=false FROM_EMAIL=noreply@plenum-tech.com `
             APP_URL=https://lps.plenum-tech.com API_PUBLIC_URL=https://lps.plenum-tech.com `
             CORS_ORIGIN=https://lps.plenum-tech.com APP_TIMEZONE=Asia/Kolkata TRUST_PROXY=1 `
             JOBS_MODE=in-process MONGO_MAX_POOL=50 APP_VERSION=$TAG
# Probes are easiest via the Bicep template (or `az containerapp update --yaml`).

# Deploy a new image later:
az containerapp update -n $APP -g $RG --image "$ACR.azurecr.io/lps-projects-utility:$TAG" --set-env-vars APP_VERSION=$TAG
# Rotate a secret (then restart so the env picks it up):
az containerapp secret set -n $APP -g $RG --secrets jwt-secret="<new value>"
az containerapp revision restart -n $APP -g $RG --revision (az containerapp revision list -n $APP -g $RG --query "[0].name" -o tsv)
```

Smoke test: `curl https://<fqdn>/api/health` → `{"status":"ok","db":"up",…,"version":"<tag>"}`.

---

## 4. Environment variables and secrets

Set in ACA only — **never in the image**. "secret" = Container App secret
referenced with `secretref:`.

| Variable | Kind | Value / notes |
|---|---|---|
| `MONGO_URI` | **secret** | Atlas: `mongodb+srv://user:pass@cluster…/lps?retryWrites=true&w=majority`. Use the direct (non-SRV) `mongodb://host1,host2,host3/…?replicaSet=…&tls=true` form if SRV DNS is blocked. Cosmos vCore: the portal string (keeps `retrywrites=false`). The DB name in the path is the app database. |
| `JWT_SECRET` | **secret** | ≥ 32 random characters (boot fails otherwise) |
| `COOKIE_SECRET` | **secret** | ≥ 32 random characters, different from `JWT_SECRET` |
| `SMTP_USER`, `SMTP_PASS` | **secret** | Microsoft 365 mailbox (SMTP AUTH enabled) |
| `GEMINI_API_KEY` | **secret** | Only if AI features are enabled |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | env | `smtp.office365.com`, `587`, `false` |
| `FROM_NAME`, `FROM_EMAIL` | env | `FROM_EMAIL` = `SMTP_USER` unless "Send As" is granted |
| `APP_URL`, `API_PUBLIC_URL` | env | Both the public HTTPS URL (same origin), e.g. `https://lps.plenum-tech.com` |
| `CORS_ORIGIN` | env | The public URL (same origin, so effectively unused) |
| `APP_TIMEZONE` | env | Fallback only (`Asia/Kolkata`); Settings → App Settings wins |
| `TRUST_PROXY` | env | `1` (ACA ingress is one proxy hop → real client IPs for rate limits) |
| `JOBS_MODE` | env | `in-process` (image default). `inngest` = Inngest Cloud crons; `off` = no jobs |
| `MONGO_MAX_POOL` | env | `50` (also `MONGO_MIN_POOL`, `MONGO_SERVER_SELECTION_TIMEOUT_MS`, `MONGO_SOCKET_TIMEOUT_MS`, `MONGO_RETRY_WRITES`, `MONGO_AUTO_INDEX`) |
| `EMAIL_REDIRECT_TO` | env | **Must be empty in production** (a warning is logged if set) |
| `AI_REVIEW_DRAFTS`, `MEETING_AI_EXTRACTION` | env | `false` by default |
| `CROSS_SITE_COOKIES` | env | Leave unset. `true` only if UI and API are on different sites (cookie becomes `SameSite=None`) |
| `NODE_ENV`, `PORT`, `STATIC_DIR` | image | `production`, `8080`, `/app/public` — do not override |
| `BUN_JSC_*` | image | JavaScriptCore threading tuned for small CPU quotas (see §9) |

The app refuses to start in production when `MONGO_URI`, `JWT_SECRET` or
`COOKIE_SECRET` is missing or a secret is shorter than 32 characters (the
revision then fails its startup probe; the log says which variable).

---

## 5. Custom domain and TLS

```powershell
$FQDN = az containerapp show -n $APP -g $RG --query properties.configuration.ingress.fqdn -o tsv
$VERIFY = az containerapp show -n $APP -g $RG --query properties.customDomainVerificationId -o tsv
```

At your DNS provider create:

| Type | Name | Value |
|---|---|---|
| CNAME | `lps` | `$FQDN` |
| TXT | `asuid.lps` | `$VERIFY` |

Then add the hostname with a free managed certificate (auto-renewed):

```powershell
az containerapp hostname add  -n $APP -g $RG --hostname lps.plenum-tech.com
az containerapp hostname bind -n $APP -g $RG --hostname lps.plenum-tech.com `
  --environment "$APP-env" --validation-method CNAME
```

Finally set `APP_URL` / `API_PUBLIC_URL` / `CORS_ORIGIN` to
`https://lps.plenum-tech.com` (redeploy with `deploy.ps1 -AppUrl …` or
`az containerapp update --set-env-vars …`) and, in the app, **Settings → App
Settings → App URL** (used in email links).

---

## 6. First deploy: database setup and migrations

All migrations are idempotent and safe while the app runs. Run them once on a
new or upgraded database, in this order:

```powershell
az containerapp exec -n $APP -g $RG --command "bun run migrate:tasks"
az containerapp exec -n $APP -g $RG --command "bun run migrate:projects"
az containerapp exec -n $APP -g $RG --command "bun run migrate:tables"
az containerapp exec -n $APP -g $RG --command "bun run migrate:hr"
# First admin (empty database only) — set ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME first:
az containerapp update -n $APP -g $RG --set-env-vars ADMIN_EMAIL=admin@plenum-tech.com ADMIN_NAME="LPS Admin" ADMIN_PASSWORD=secretref:admin-password
az containerapp exec -n $APP -g $RG --command "bun run seed"
```

(`az containerapp secret set … --secrets admin-password=<pw>` before the
update; remove the three `ADMIN_*` variables afterwards.)

Indexes: the app builds missing indexes in the background on boot
(`autoIndex`). On a large existing database let the first revision run for a
few minutes before load; once built you may set `MONGO_AUTO_INDEX=false`.

The same scripts work locally against the container (`docker compose exec app
bun run migrate:projects`). Jobs can also be triggered by hand:
`bun run jobs:reminders | jobs:recurring | jobs:time | jobs:projects | jobs:hr`.

---

## 7. Scheduled jobs

`JOBS_MODE=in-process` runs the same jobs and times as the Inngest crons, in the
app timezone:

| Job | Schedule |
|---|---|
| auto-stop timers, time-tracker reminder | every 15 min |
| project progress (deadline mode) | 00:15 daily |
| recurring tasks | 00:30 daily |
| task reminders, project deadline reminders, HR reminders | 08:00 daily |
| daily time-log report | 19:30 daily |

A Mongo lease lock (`joblocks` collection, one document per job with the last
slot, owner and lease expiry) guarantees each slot runs on **one** replica,
even during revision overlaps; failures retry up to 3× a minute apart. A daily
job missed during downtime runs later the same day. Inspect:
`db.joblocks.find()`.

AI features (AI insights, AI review drafts) are event-driven via **Inngest** and
are off by default. To use them, create an Inngest Cloud app, set
`INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` (secrets), sync
`https://<host>/api/inngest`, and either keep `JOBS_MODE=in-process` (crons then
also fire from Inngest — harmless, the jobs are idempotent) or set
`JOBS_MODE=inngest`.

---

## 8. Backups

* **Atlas (M10+)**: Cloud Backup is on by default — set the snapshot policy
  (e.g. hourly 2 d, daily 7 d, weekly 4 w, monthly 12 m) and enable
  **continuous cloud backup** for point-in-time restore. Test a restore into a
  separate cluster quarterly.
* **Cosmos DB for MongoDB vCore**: automatic backups (35-day PITR) — restore
  creates a new cluster; point the app's `MONGO_URI` secret at it.
* **Logical export** (any provider, also for moving between providers):
  `mongodump --uri "<MONGO_URI>" --gzip --archive=lps-$(Get-Date -f yyyyMMdd).gz`
  / `mongorestore --uri … --gzip --archive=… --drop`. Files (task/project
  attachments, employee documents, company logo) live in GridFS inside the same
  database, so a database backup includes them.
* The container is stateless — nothing in it needs backing up.

---

## 9. Scaling and capacity

**Start with 1 replica, 1 vCPU / 2 GiB; use 2 vCPU / 4 GiB for headroom**
(`-Cpu 2.0` / `--cpu 2.0 --memory 4Gi`), `minReplicas = maxReplicas = 1`:

* SSE fan-out and the rate limiter are **in memory** — correct for one replica.
  More replicas need Redis pub/sub for SSE (and a shared rate-limit store);
  not built yet. The job scheduler is already multi-replica safe.
* `minReplicas = 1` avoids cold starts and keeps SSE streams up.
* 1 vCPU handled 150 users at a realistic pace with every criterion met (CPU
  ~67 %). Under a sustained burst pace (every user acting every 2–5 s) the
  JavaScript event loop saturates; 2 vCPU lowers latency but one process
  cannot use more than ~1 core for request handling — watch the ACA CPU metric
  and plan Redis + replicas if it stays above ~70 %.
* Memory stays around 0.3 GiB under load; 2–4 GiB is ample.
* The image disables JavaScriptCore's concurrent JIT/GC helper threads
  (`BUN_JSC_useConcurrentJIT=false`, `BUN_JSC_useConcurrentGC=false`,
  `BUN_JSC_numberOfGCMarkers=1`): a container sees every host core but may use
  only its quota, and the helper threads made the cgroup throttle the process.
  Measured on 1 vCPU: ~2.4× less CPU per request. Override them via env vars
  only if you test something better.
* Keep the database in the same region; for Atlas use an M10+ with ≥ 2 vCPU.
  `MONGO_MAX_POOL=50` is plenty for one replica.
* ACA ingress closes idle HTTP connections after ~4 min; the SSE stream sends a
  heartbeat every 25 s, and browsers reconnect automatically (5 s `retry`).

### Load test results (150 users)

Measured on 2026-10-07 against the built image (`docker compose`, app limited
to the ACA sizing with `--cpus` / `--memory`, MongoDB 7 in a separate
unrestricted container — so this measures the app, not the network). Host:
Docker Desktop (WSL 2) on Windows, 12 cores.

**Scenario** (`deploy/k6/load-test.js` + `deploy/k6/sse-hold.ts`): 150 users,
2 min ramp-up + 10 min hold. Each user signs in once, holds an SSE stream, and
loops: app shell → dashboard (3 calls) → task table → board → task detail
(5 calls) → comment → status change → projects + project detail → manual time
entry → notifications. ~23 API calls per loop. Data set (`bun run seed:load`):
150 users, 30 projects, 5,000 tasks, 20,000 comments, 10,000 time logs,
3,000 notifications.

| Run | Pause between steps | vCPU / RAM | Throughput | Reads p95 / p99 | Writes p95 | Errors | SSE (150) | App CPU (hold, median) | App memory (max) |
|---|---|---|---|---|---|---|---|---|---|
| Before fixes¹ | 2–5 s | 1 / 2 GiB | collapsed | 6.8 s / 9.0 s | 13.2 s | 0.03 % | 150 held | 100 % (throttled) | 0.23 GiB |
| After fixes | 2–5 s (aggressive) | 1 / 2 GiB | 70.5 req/s | 0.78 s / 1.47 s | 1.71 s | 0 % | 150 held, 0 drops | 100 % | 0.29 GiB |
| After fixes | 2–5 s (aggressive) | 2 / 4 GiB | 75.0 req/s | 0.49 s / 1.32 s | 1.29 s | 0 % | 150 held, 0 drops | 48 % of 2 vCPU | 0.29 GiB |
| After fixes | 5–12 s (`THINK_SCALE=2.5`) | 1 / 2 GiB | 33.3 req/s | **0.11 s / 0.21 s** | **0.20 s** | **0 %** | **150 held, 0 drops** | **67 %** (p90 84 %) | **0.28 GiB** |

¹ Server-side timings from the request log (the k6 summary of that run was
invalid because the test machine went to sleep mid-run).

**Against the pass criteria:** at a realistic pace (5–12 s between actions,
~33 req/s, i.e. every one of the 150 users clicking every few seconds) every
criterion passes on 1 vCPU. At the aggressive 2–5 s pace (~70–75 req/s, about
5× typical traffic for 150 users) there are no errors and all SSE streams stay
up, but latency targets are missed: the single JavaScript event loop is
saturated at ~13 ms CPU per request, so a second vCPU lowers latency (reads
p95 0.49 s, p99 1.32 s, CPU 48 %) but writes p95 stays at 1.29 s. Beyond that
pace the next step is more processes/replicas, which needs Redis for SSE
(future work, see §9).

**Fixes made from the profiling** (`docker stats`, cgroup `cpu.stat`, Mongo
profiler, a Node `--cpu-prof` run of the same bundle):

| Fix | Effect |
|---|---|
| JavaScriptCore threading for small CPU quotas (`BUN_JSC_useConcurrentJIT=false`, `useConcurrentGC=false`, `numberOfGCMarkers=1` in the image) | Bun saw 12 host cores and ran ~15 helper threads in a 1-CPU quota: 70 % of scheduler periods were throttled. Now 5 threads, no throttling, **~2.4× less CPU per request**; median latency under load 3.7 s → 0.44 s. |
| Task list / board read with `.lean()` (+ schema defaults/transform applied by hand, output verified byte-identical) and one serialization pass for all board columns | Fewer mongoose hydrations; 15 → 3 count aggregations per board |
| In-process caches with write-invalidation (`lib/refCache.ts`): signed-in user (10 s, BSON copy per request), archived project ids, completed project statuses, managed projects, department members/heads, admins, the dashboard HR-dates list, task SSE audience | ~10 → ~6 DB round trips per request on hot paths |
| Debounced project-progress recalculation (1 s per project, flushed on shutdown and in job scripts) | One recalculation per burst instead of per change |
| Index `tasks {status: 1, position: 1}` | Board-column re-normalisation no longer scans a whole status |
| Reused `Intl.DateTimeFormat` instances and a cached JWT `KeyObject` | Removed per-request ICU formatter and key construction |

Net: CPU per request under load **18 → 13.5 ms** after the threading fix
(and far lower than the throttled baseline). The same bundle on Node 24 used
~16 % less CPU in a comparable run — an option if more headroom is needed
without adding replicas (the image currently follows the spec: Bun).

---

## 10. Database notes

**MongoDB Atlas (recommended):** M10+ in the same Azure region. Network access:
ACA consumption environments have no fixed outbound IP — use Atlas **Private
Endpoint** (Azure Private Link) with a VNet-integrated Container Apps
environment, or a workload-profiles environment with a NAT gateway and allowlist
its static IP. Avoid `0.0.0.0/0`.

**Azure Cosmos DB for MongoDB vCore:** works through `MONGO_URI` (keep the
portal's `tls=true&authMechanism=SCRAM-SHA-256&retrywrites=false`). Verify
these features the app uses on your tier before going live:

| Feature used | Where | Caveat |
|---|---|---|
| Partial unique indexes (`partialFilterExpression` with `$type` / `null`) | `users.employeeId`, `tasks.number`, `timelogs` one-running-timer, `invitations` pending | Check the boot log for index build errors; if unsupported, the uniqueness guarantees (one running timer per user, unique task numbers/employee IDs) are not enforced by the database. |
| Collation (`locale: en, numericOrdering`) on aggregate sorts | task and project list sorting | vCore collation support is limited — sorting by code/title may error; test the Tasks and Projects tables with each sort. |
| `$lookup` with pipeline + `$expr` | tasks list sorted by "logged hours" | Supported on recent vCore versions; test that sort. |
| GridFS | attachments, employee documents, company logo | Supported (plain collections); large files count toward storage. |
| Transactions / change streams | not used | — |
| Retryable writes | driver default | vCore: keep `retrywrites=false` in the URI (the app does not override it unless `MONGO_RETRY_WRITES` is set). |

Running MongoDB inside the app container is not supported; a self-managed Mongo
container next to the app is possible but you own replication, backups and
upgrades.

---

## 11. Rollback (revisions)

The app runs in single-revision mode; every deploy creates a new revision.

```powershell
az containerapp revision list -n $APP -g $RG -o table
# Roll back by redeploying the previous image tag:
./deploy/azure/deploy.ps1 -ResourceGroup $RG -AcrName $ACR -AppUrl https://lps.plenum-tech.com -Tag <previous-sha> -BuildMode none
# or
az containerapp update -n $APP -g $RG --image "$ACR.azurecr.io/lps-projects-utility:<previous-sha>"
```

For zero-downtime switches use multiple-revision mode
(`az containerapp revision set-mode --mode multiple`), deploy, test the new
revision's URL, then `az containerapp ingress traffic set --revision-weight
<new>=100`. Migrations are additive/idempotent, so an older image runs on a
migrated database. On SIGTERM the app fails its health check, closes SSE
streams with a `retry` hint, lets the scheduler finish and closes Mongo within
20 s.

---

## 12. Troubleshooting

| Symptom | Check |
|---|---|
| Revision never becomes ready | `az containerapp logs show -n $APP -g $RG --tail 100` — "Invalid environment" (missing/short secret), "Failed to start server" (Mongo unreachable: network access / IP allowlist / SRV DNS → try the non-SRV URI). |
| `/api/health` 503 `db: down` | Database reachable? Atlas paused / IP list / Private Endpoint DNS. |
| Image pull errors | The identity has `AcrPull` on the registry; registry server name matches; the tag exists (`az acr repository show-tags -n $ACR --repository lps-projects-utility`). |
| Login works but the next request is 401 | Site opened over plain HTTP (the cookie is `Secure`) or UI/API on different hosts → use the single HTTPS URL; `CROSS_SITE_COOKIES=true` only for a split deployment. |
| Live updates stop | Browser dev tools → `/api/notifications/stream` should stay open with `:heartbeat` lines every 25 s; check proxies that buffer `text/event-stream`. |
| Everyone shares one rate limit / 429s | `TRUST_PROXY=1` must be set behind the ACA ingress. |
| No emails | `[email]` lines in the log; `535 5.7.139` = SMTP AUTH disabled for the mailbox; `EMAIL_REDIRECT_TO` must be empty. |
| Jobs ran twice / not at all | `db.joblocks.find()` shows the last slot and owner per job; `JOBS_MODE` must be `in-process`; times follow Settings → App Settings timezone. |
| Blank page / CSP errors in the console | The CSP allows self, Google Fonts and the inline bootstrap scripts by hash (computed at startup from `index.html`). A CDN or extra external resource must be added to the CSP in `backend/src/server.ts`. |
| Slow responses | Log Analytics: `ContainerAppConsoleLogs_CL \| where Log_s startswith "{" \| extend r=parse_json(Log_s) \| summarize p95=percentile(todouble(r.ms),95) by tostring(r.url)`; ACA metrics for CPU — move to 2 vCPU if it stays above ~70 %. |

---

## 13. Local testing of the production image

```powershell
docker compose up -d --build                      # app http://127.0.0.1:8080 + Mongo on 127.0.0.1:27018
docker compose exec app bun run seed              # admin@lps.test / ADMIN_PASSWORD from docker-compose.yml
docker compose logs -f app
docker compose down -v                            # remove the local data
```

`APP_PORT`, `MONGO_PORT`, `APP_CPUS`, `APP_MEMORY` override the defaults (e.g.
`$env:APP_PORT=8088`). Open it via `http://127.0.0.1:<port>` (the session cookie
is `Secure`; browsers allow that on 127.0.0.1/localhost only).

### Re-running the load test

```powershell
docker compose exec app bun run seed:load -- --reset   # refuses a database named "ems"
# SSE holder (150 streams) + k6 (150 VUs) — start the holder first:
bun deploy/k6/sse-hold.ts --base http://127.0.0.1:8080 --users 150 --minutes 13
docker run --rm -i --network <project>_default -v "${PWD}/deploy/k6:/k6" grafana/k6 run `
  -e BASE_URL=http://app:8080 -e RUN_ID=1 /k6/load-test.js
```

Seeded logins: `load-user-001@lps.test` … `load-user-150@lps.test`, password
`LOAD_PASSWORD` (default in `backend/src/scripts/seedLoad.ts`). Use a fresh
`RUN_ID` (1–17) per run against the same data so time entries don't overlap.
