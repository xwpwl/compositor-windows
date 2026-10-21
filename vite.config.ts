import { defineConfig } from "vite";
export default defineConfig({
  base: "./",
  build: { chunkSizeWarningLimit: 1400 },
  server: { port: 5173, strictPort: true },
});
