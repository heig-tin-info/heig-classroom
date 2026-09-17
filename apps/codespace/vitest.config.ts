import { defineConfig } from "vitest/config";

/**
 * Les tests qui exigent Podman rootful, Forgejo ou Keycloak ne tournent que
 * si CODESPACE_INTEGRATION=1 (`pnpm test:integration`) : le CI du monorepo
 * n'a aucun de ces services. Les tests unitaires tournent partout.
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
