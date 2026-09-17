import { defineConfig } from "drizzle-kit";

/**
 * Migrations SQLite. `pnpm --filter @codespace/portal exec drizzle-kit generate`
 * écrit dans `drizzle/` ; `db/client.ts` les applique à l'ouverture.
 */
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env["DATABASE_PATH"] ?? "./var/codespace.sqlite",
  },
});
