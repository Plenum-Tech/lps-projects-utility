# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# LPS – Projects Utility: one production image (Express API + SPA frontend,
# one Bun process on :8080) for Azure Container Apps. See DEPLOY-AZURE.md.
#
#   docker build -t lps-projects-utility:local --build-arg APP_VERSION=$(git rev-parse --short HEAD) .
#
# No secrets are baked in: .env* files are excluded by .dockerignore and all
# configuration (MONGO_URI, JWT_SECRET, …) is injected at runtime.
# ---------------------------------------------------------------------------

ARG BUN_IMAGE=oven/bun:1.2.19@sha256:31f25ad4c661322a3dc9d9d98fbf34989502b1ea588a2ca629da98c8e5a2d116
# Runtime base: Debian slim. LibreOffice (HR trainings) crashes at startup on
# Alpine/musl, and the Debian build adds ~600 MB; the image is ~870 MB.
ARG BUN_RUNTIME_IMAGE=oven/bun:1.2.19-slim
# The React Router build (it pre-renders index.html with react-dom/server) runs on
# Node — the toolchain it supports; Bun is copied in only to install from bun.lock.
ARG NODE_IMAGE=node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e

FROM ${BUN_IMAGE} AS bun

# 1. Frontend dependencies (incl. dev deps for the build)
FROM ${NODE_IMAGE} AS deps-frontend
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /src/frontend
COPY frontend/package.json frontend/bun.lock ./
RUN bun install --frozen-lockfile

# 2. Frontend build: SPA mode → frontend/build/client (API on the same origin at /api)
FROM deps-frontend AS build-frontend
ARG VITE_API_URL=/api
ARG VITE_FEATURE_AI_INSIGHTS=false
ENV VITE_API_URL=${VITE_API_URL} \
    VITE_FEATURE_AI_INSIGHTS=${VITE_FEATURE_AI_INSIGHTS}
COPY frontend/ ./
RUN bun run build && test -f build/client/index.html


# 3. Backend production dependencies
FROM ${BUN_IMAGE} AS deps-backend
WORKDIR /src/backend
COPY backend/package.json backend/bun.lock ./
RUN bun install --frozen-lockfile --production

# 4. Backend bundle: the server and the CLI scripts (migrations, seeds, jobs) are
#    bundled by `bun build` into dist/, so the runtime image needs no node_modules
#    (they would add ~230 MB of mostly unused transitive dependencies).
#    dist/package.json keeps `bun run migrate:*` / `seed*` / `jobs:*` working.
FROM deps-backend AS build-backend
# `bun build` inlines process.env.NODE_ENV at build time: this is the production image.
ENV NODE_ENV=production
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN bun build --target=bun --sourcemap=linked --root src --outdir dist src/server.ts \
 && bun build --target=bun --minify-syntax --minify-whitespace --root src --outdir dist \
      src/seed.ts src/scripts/*.ts \
 && bun -e 'const p = await Bun.file("package.json").json(); const scripts = Object.fromEntries(Object.entries(p.scripts).filter(([, c]) => c.startsWith("bun src/")).map(([n, c]) => [n, c.replace(/src\/(\S+)\.ts/, "dist/$1.js")])); await Bun.write("dist/package.json", JSON.stringify({ name: p.name, private: true, type: "module", scripts }, null, 2));' \
 && test -f dist/server.js

# 5. Runtime
FROM ${BUN_RUNTIME_IMAGE} AS runtime
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    PORT=8080 \
    JOBS_MODE=in-process \
    TRUST_PROXY=1 \
    STATIC_DIR=/app/public \
    APP_VERSION=${APP_VERSION}
# JavaScriptCore threading for a CPU-quota'd container (ACA 1 vCPU sees all host
# cores but may only use one): with concurrent JIT/GC on, a dozen helper threads
# fight over the quota and the cgroup throttles the process. Measured on a
# 1-CPU container: ~2.4x less CPU per request and no throttling with these off.
# Load-tested with these settings on 1 and 2 vCPU (DEPLOY-AZURE.md).
ENV BUN_JSC_useConcurrentJIT=false \
    BUN_JSC_useConcurrentGC=false \
    BUN_JSC_numberOfGCMarkers=1
# HR trainings: LibreOffice (pptx -> pdf) and poppler (pdf -> one PNG per slide),
# with metric-compatible fonts for Calibri (Carlito) and Arial/Times (Liberation).
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-impress poppler-utils fonts-crosextra-carlito fonts-liberation fonts-dejavu-core wget ca-certificates && rm -rf /var/lib/apt/lists/* && command -v soffice && command -v pdftoppm
WORKDIR /app
# Files stay root-owned (read-only for the app user); the app writes only to /tmp
# (slide conversion scratch space, removed after each upload).
COPY --from=build-backend /src/backend/dist/package.json ./package.json
COPY --from=build-backend /src/backend/dist ./dist
COPY --from=build-frontend /src/frontend/build/client ./public
USER bun
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/health" || exit 1
CMD ["bun", "dist/server.js"]
