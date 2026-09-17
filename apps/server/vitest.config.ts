import { defineConfig } from "vitest/config";

/**
 * Every `*.db.test.ts` file boots its own PGlite and replays the whole
 * Drizzle migration chain (test/db.ts). That is seconds of work per file, run
 * in parallel across the pool, so the 5 s default timeout of vitest is a
 * measure of machine load, not of the code under test — a new test file used
 * to push unrelated files over the edge. Same posture as
 * apps/codespace/vitest.config.ts.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
