import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react()],
  build: {
    outDir: resolve(here, "dist"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // In dev the API runs as a separate process; in production the same Node
    // server serves both, so the frontend always talks to a same-origin /api.
    proxy: {
      "/api": {
        target: "http://localhost:5545",
        changeOrigin: true,
      },
    },
  },
});
