import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  optimizeDeps: { entries: ["index.html"] },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Cargo owns native rebuilds; watching its locked Windows binaries crashes Vite.
      ignored: ["**/src-tauri/**", "**/release/**", "**/audits/**", "**/tmp/**", "**/bench/generated/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
});
