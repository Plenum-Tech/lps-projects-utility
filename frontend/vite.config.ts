import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  resolve: {
    tsconfigPaths: true,
  },
  // `react-router build` (SPA mode) pre-renders index.html through a temporary
  // preview server; bind it to IPv4 so the build also works in containers where
  // "localhost" resolves to ::1 first.
  preview: {
    host: "127.0.0.1",
  },
});
