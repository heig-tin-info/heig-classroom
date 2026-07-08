import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Standalone dev: the backend stays the sole origin for cookies.
    proxy: {
      "/app": "http://localhost:3000",
      "/healthz": "http://localhost:3000",
    },
  },
});
