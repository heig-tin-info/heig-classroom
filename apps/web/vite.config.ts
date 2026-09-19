import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Standalone dev: the backend stays the sole origin for cookies.
    proxy: {
      "/app": "http://localhost:3000",
      "/healthz": "http://localhost:3000",
    },
  },
  test: {
    // Vitest 4 removed `environmentMatchGlobs`; test projects are its
    // replacement. Two of them, so the pure-logic suite keeps running in
    // `node` (fast, no DOM to boot) while the component suite gets jsdom,
    // and the jsdom setup file never runs for the node tests.
    // `extends: true` reuses this very file, plugins included, so React and
    // `import.meta.glob` (help.tsx) transform the same way in both.
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["./src/test/setup.ts"],
          // Every test gets a clean fetch stub and clean spies.
          restoreMocks: true,
        },
      },
    ],
  },
});
