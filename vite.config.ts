import { defineConfig } from "vite";

// Relative base so the same build works on GitHub Pages (/gizmocad/) and inside Tauri.
export default defineConfig({
  base: "./",
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  worker: { format: "es" },
  build: { target: "es2022" },
});
