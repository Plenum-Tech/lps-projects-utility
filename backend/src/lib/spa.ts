import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";

// ---------------------------------------------------------------------------
// Serves the built React Router SPA (frontend/build/client) from the API
// process — the production container layout (one origin, no CORS).
//
//   /assets/*  content-hashed → Cache-Control: public, max-age=31536000, immutable
//   other files (favicon, manifest …) → 1 hour
//   index.html and the SPA fallback (any non-/api GET that accepts HTML) → no-cache
//
// Enabled when STATIC_DIR (default ./public, relative to the working dir)
// contains index.html — i.e. never in local dev, where Vite serves the UI.
// ---------------------------------------------------------------------------

export interface SpaBundle {
  dir: string;
  /** CSP source expressions ('sha256-…') for the inline <script>s React Router emits in index.html. */
  inlineScriptHashes: string[];
  router: express.Router;
}

function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  for (let match = re.exec(html); match; match = re.exec(html)) {
    const body = match[1] ?? "";
    if (!body.trim()) continue;
    hashes.add(`'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`);
  }
  return [...hashes];
}

export function loadSpa(): SpaBundle | null {
  if (process.env.SERVE_STATIC?.trim().toLowerCase() === "false") return null;
  const dir = path.resolve(process.env.STATIC_DIR?.trim() || "public");
  const indexPath = path.join(dir, "index.html");
  if (!existsSync(indexPath)) return null;

  const indexHtml = readFileSync(indexPath);
  const router = express.Router();

  router.use(
    express.static(dir, {
      index: false, // index.html goes through the fallback below (no-cache)
      redirect: false,
      setHeaders(res, filePath) {
        const rel = path.relative(dir, filePath).split(path.sep).join("/");
        res.setHeader(
          "Cache-Control",
          rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "public, max-age=3600"
        );
      },
    })
  );

  // SPA fallback: client-side routes (/dashboard, /tasks?task=…) get index.html.
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path === "/api" || req.path.startsWith("/api/")) return next();
    // A missing hashed asset must 404, not return HTML (stale tab after a deploy).
    if (req.path.startsWith("/assets/") || !req.accepts("html")) return next();
    res.setHeader("Cache-Control", "no-cache");
    res.type("html").send(indexHtml);
  });

  return { dir, inlineScriptHashes: inlineScriptHashes(indexHtml.toString("utf8")), router };
}
