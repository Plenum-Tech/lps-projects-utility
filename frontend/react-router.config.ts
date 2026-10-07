import type { Config } from "@react-router/dev/config";

export default {
  // SPA mode: `react-router build` emits static files (build/client) that the
  // Express API serves from the same origin (see the root Dockerfile and
  // DEPLOY-AZURE.md). Route data loads in the browser (clientLoader / TanStack Query).
  ssr: false,
} satisfies Config;
