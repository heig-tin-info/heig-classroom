import { defineConfig } from "vitest/config";

/**
 * The tests that require rootful Podman, Forgejo or Keycloak only run
 * if CODESPACE_INTEGRATION=1 (`pnpm test:integration`): the monorepo CI
 * has none of those services. The unit tests run everywhere.
 */
const integration = [
  "src/engine/index.test.ts",
  "src/git/channel.integration.test.ts",
  "src/git/relay.test.ts",
  "src/sessions/sessions.test.ts",
];

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: process.env["CODESPACE_INTEGRATION"] ? [] : integration,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
