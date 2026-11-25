// Raxorin Studio Lite (versión de navegador): npm run lite:dev / npm run lite:build → dist-lite/
// El intérprete de Slint (WebAssembly) se descarga a public-lite/slint/ con scripts/lite-slint.mjs.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  publicDir: "public-lite",
  build: {
    outDir: "dist-lite",
    emptyOutDir: true,
    rollupOptions: { input: { index: resolve(__dirname, "lite.html") } },
  },
  server: { port: 1440, strictPort: true },
});
