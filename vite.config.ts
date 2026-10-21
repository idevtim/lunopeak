import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;
// Tauri's beforeDevCommand sets this so Vite must bind exactly 1420 (the
// devUrl in tauri.conf.json) — the webview can't follow a wandering port.
// Standalone `npm run dev` leaves it unset, so Vite walks to the next free
// port instead of erroring when 1420 is already in use.
const strictPort = process.env.TAURI_DEV_STRICT === "1";

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  build: {
    // Tauri ships the bundle on disk — chunk size is cosmetic, not a
    // network-latency concern. The default 500 KB warning fires for our
    // eager-loaded entry (Dashboard + Settings + Assistant), which is fine.
    chunkSizeWarningLimit: 1024,
  },
  server: {
    port: 1420,
    strictPort,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
